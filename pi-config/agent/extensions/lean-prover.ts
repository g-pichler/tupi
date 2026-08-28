/**
 * Lean Mentor/Prover orchestration extension.
 *
 * Workflow (per the design):
 *   1. Detect the Lean/Lake workspace and pick a "prover" model P and a
 *      "mentor" model M (may be the same).
 *   2. P produces a proof plan.
 *   3. P attempts the proof by editing the workspace and running `lake build`.
 *   4. Robust verification: `lake build` succeeds AND the named theorem does
 *      not depend on `sorryAx` (Lean-native, single-declaration check).
 *      The theorem must be named; it must exist; and it must still contain a
 *      sorry at the start (pre-flight) or the command fails fast.
 *   5. M reviews P's state / Lean errors and either guides P, declares no
 *      progress (b), or requests user interaction (c).
 *   6. Loop until: (a) proved without sorryAx, (b) M declares no progress,
 *      (c) M requests the user.
 *
 * Both P and M run as isolated `pi --mode json` subprocesses (the pattern from
 * examples/extensions/subagent/), each with its own context + model, all
 * acting on the shared Lean workspace via the normal file/bash tools.
 *
 * Progress: a live TUI widget reports the current phase, round progress (as a
 * percentage of MAX_ROUNDS), running token/cost totals, and a short tail of the
 * model's latest output.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  detectWorkspace,
  verifyWorkspace,
  type DetectedWorkspace,
} from "/pi-config/src/lean-workspace.ts";

const MAX_ROUNDS = 12;
const WIDGET = "lean-prover";

// ---------------------------------------------------------------------------
// Token / cost formatting
// ---------------------------------------------------------------------------

function fmtTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}

interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

const ZERO_USAGE: UsageTotals = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: 0,
};

function mergeUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		totalTokens: a.totalTokens + b.totalTokens,
		cost: a.cost + b.cost,
	};
}

// ---------------------------------------------------------------------------
// Subprocess helpers (mirror the subagent example)
// ---------------------------------------------------------------------------

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const bin = process.env.PI_BIN || "pi";
	return { command: bin, args };
}

/** Collect the final assistant text from a `pi --mode json` stream. */
function getFinalOutput(messages: any[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m && (m.role === "assistant" || m.customType === "assistant") && m.content) {
			const text = (Array.isArray(m.content) ? m.content : [])
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("\n")
				.trim();
			if (text) return text;
		}
	}
	return "";
}

async function writePromptToTempFile(name: string, prompt: string) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lean-${name}-`));
	const filePath = path.join(dir, "prompt.md");
	fs.writeFileSync(filePath, prompt);
	return { dir, filePath };
}

export interface PiRunResult {
	exitCode: number;
	output: string;
	stderr: string;
	usage: UsageTotals;
}

export interface ProgressSnapshot {
	/** Tail of the model's latest assistant text (streamed). */
	text: string;
	/** Incremental usage since the previous snapshot (safe to sum). */
	usage: UsageTotals;
}

type OnProgress = (p: ProgressSnapshot) => void;

/**
 * Run one participant (prover or mentor) as a pi JSON subprocess.
 * `model`: "provider/model-id". `tools`: set of built-in tool names.
 * `systemPrompt`: appended via --append-system-prompt so it is stable per role.
 * `onProgress`: called with streamed text + running usage as messages arrive.
 */
async function runPi({
	model,
	tools,
	systemPrompt,
	task,
	cwd,
	onProgress,
}: {
	model: string;
	tools: string[];
	systemPrompt: string;
	task: string;
	cwd: string;
	onProgress?: OnProgress;
}): Promise<PiRunResult> {
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	args.push("--model", model);
	if (tools.length) args.push("--tools", tools.join(","));

	let tmpDir: string | null = null;
	if (systemPrompt.trim()) {
		const tmp = await writePromptToTempFile("role", systemPrompt);
		tmpDir = tmp.dir;
		args.push("--append-system-prompt", tmp.filePath);
	}
	args.push(`Task: ${task}`);

	const { command, args: finalArgs } = getPiInvocation(args);
	const messages: any[] = [];
	let usage = { ...ZERO_USAGE };
	let lastEmitted = { ...ZERO_USAGE };
	let streamText = "";

	// Emit only the *delta* since the last snapshot, so downstream code can sum
	// snapshots without double-counting.
	const emitProgress = () => {
		const delta: UsageTotals = {
			input: usage.input - lastEmitted.input,
			output: usage.output - lastEmitted.output,
			cacheRead: usage.cacheRead - lastEmitted.cacheRead,
			cacheWrite: usage.cacheWrite - lastEmitted.cacheWrite,
			totalTokens: usage.totalTokens - lastEmitted.totalTokens,
			cost: usage.cost - lastEmitted.cost,
		};
		lastEmitted = { ...usage };
		onProgress?.({ text: streamText, usage: delta });
	};

	const exitCode = await new Promise<number>((resolve) => {
		let proc: ReturnType<typeof spawn>;
		// spawn() throws synchronously for arg/env-size overflow (spawn E2BIG);
		// wrap it so that path degrades to a failed run instead of crashing the
		// whole extension.
		try {
			proc = spawn(command, finalArgs, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let buffer = "";
		proc.stdout.on("data", (d) => {
			buffer += d.toString();
			let idx: number;
			while ((idx = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, idx).trim();
				buffer = buffer.slice(idx + 1);
				if (!line) continue;
				let evt: any;
				try {
					evt = JSON.parse(line);
				} catch {
					continue;
				}
				if (evt.type === "message_update") {
					const t = evt.assistantMessageEvent?.type;
					if (t === "text_delta") streamText += evt.assistantMessageEvent.delta ?? "";
				}
				if (evt.type === "message_end" && evt.message) {
					messages.push(evt.message);
					// Assistant messages carry usage; sum them across turns.
					const u = evt.message.usage;
					if (u) {
						usage = mergeUsage(usage, {
							input: u.input ?? 0,
							output: u.output ?? 0,
							cacheRead: u.cacheRead ?? 0,
							cacheWrite: u.cacheWrite ?? 0,
							totalTokens: u.totalTokens ?? 0,
							cost: u.cost?.total ?? 0,
						});
						emitProgress();
					}
				}
			}
		});
		proc.on("close", (code) => resolve(code ?? 0));
		proc.on("error", (err) => {
			console.error("spawn error:", err);
			resolve(1);
		});
		} catch (err) {
			console.error("spawn failed:", err);
			resolve(1);
		}
	});
	if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });

	return {
		exitCode,
		output: getFinalOutput(messages),
		stderr: "",
		usage,
	};
}

// ---------------------------------------------------------------------------
// Prompt constants
// ---------------------------------------------------------------------------

const PROVER_SYSTEM = `You are the PROVER in a Lean 4 proving assistant. You have full access to a
Lean/Lake workspace. Use the edit/write/bash/read tools: edit the .lean files
and run 'lake build' (and 'lake env lean <file>' to elaborate a single file) to
check your work. Your goal: produce a COMPLETE proof with NO uses of 'sorry',
'admit', or 'sorryAx' anywhere in the workspace. Iterate: edit, build, read the
errors, fix. Prefer structured 'have'/'calc'/'by' proofs. When the workspace
builds cleanly with no remaining sorry/sorryAx, reply with a short summary and
the final proof.`;

const MENTOR_SYSTEM = `You are the MENTOR in a Lean 4 proving assistant. You may only READ files and
run read-only bash. The PROVER is trying to prove a theorem. You review the
prover's latest plan/proof, the current Lean source, and any build errors, then
give strategic guidance (lemmas, restructuring, simpler path).

IMPORTANT: Be reluctant to declare "stuck". Difficult conjectures require
persistent exploration. Encourage honest tries, even if they fail — failed
attempts often reveal useful structure. Partial progress is valuable and
acceptable. Only declare "stuck" after genuine exhaustion of reasonable
approaches.

Rate the current state (partial or final) on this scale:
- A: Complete; Lean verified (no sorry/admit/sorryAx)
- B1-B10: Paper proof done; 1-10 indicates formalization progress in Lean
- C1-C10: Numerically verified or partially on-paper; 1-10 indicates confidence
- D: Guess (no substantial evidence)

Label sub-results and partial results with this rating scale in your "reason"
field (e.g., "Lemma X: B7, Lemma Y: C4, Main theorem: C2").

Reply with STRICT JSON only, no prose before/after:

{"status":"continue"|"stuck"|"need_user","rating":"A"|"B1"-"B10"|"C1"-"C10"|"D","advice":"...","reason":"..."}

status meanings:
- "continue": give "advice" for the next prover round.
- "stuck": no progress can be made (terminate work; use sparingly).
- "need_user": human input required; put your question in "advice".`;

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerCommand("prove", {
		description: "Run the mentor/prover loop against a Lean theorem in the workspace.",
		handler: async (args, ctx) => {
			// The theorem to prove is REQUIRED (no more "prove everything").
			const theorem = (args || "").trim();
			if (!theorem) {
				ctx.ui.notify("No theorem named. Usage: /prove <theorem-name>", "error");
				return;
			}

			// 0. Detect + validate the Lean workspace.
			let ws: DetectedWorkspace;
			try {
				ws = await detectWorkspace(ctx.cwd);
			} catch (e) {
				ctx.ui.notify((e as Error).message, "error");
				return;
			}
			ctx.ui.notify(`Workspace OK: ${ws.root}`, "info");

			// 1. Pick prover + mentor models (may be the same).
			const available = await ctx.modelRegistry.getAvailable();
			const options = available.map((m) => `${m.provider}/${m.id}`);
			if (!options.length) {
				ctx.ui.notify("No models available. Configure a provider first.", "error");
				return;
			}
			const proverModel = await ctx.ui.select("Select PROVER model P:", options);
			if (!proverModel) return;
			const mentorModel = await ctx.ui.select("Select MENTOR model M:", [proverModel, ...options]);
			if (!mentorModel) return;

			const proverTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];
			const mentorTools = ["read", "bash", "grep", "find", "ls"];
			const cwd = ws.root;

			// Running totals across the whole command + per-round tracking.
			let grandUsage: UsageTotals = { ...ZERO_USAGE };
			let currentPhase = "starting";
			let currentRound = 0;
			let lastSnippet = "";
			let roundsProvedIn = 0;

			// Fallback denominator so a token percentage is always shown even if a
			// provider reports zero usage.
			const TOKEN_BUDGET = 2_000_000;

			const roundPercent = () =>
				Math.round((currentRound / MAX_ROUNDS) * 100);

			const tokenPercent = () =>
				Math.min(100, Math.round((grandUsage.totalTokens / TOKEN_BUDGET) * 100));

			const bar = (pct: number, width = 10) => {
				const filled = Math.round((pct / 100) * width);
				return "█".repeat(filled) + "░".repeat(width - filled);
			};

			const renderWidget = () => {
				ctx.ui.setWidget(WIDGET, [
					`M: ${mentorModel}   P: ${proverModel}`,
					`phase : ${currentPhase}`,
					`rounds: ${currentRound}/${MAX_ROUNDS}  ${bar(roundPercent())} ${roundPercent()}%`,
					`tokens: ${fmtTokens(grandUsage.totalTokens)} used  ${bar(tokenPercent())} ${tokenPercent()}%  ` +
						`(${fmtTokens(grandUsage.input)} in / ${fmtTokens(grandUsage.output)} out)`,
					`cost  : $${grandUsage.cost.toFixed(4)}`,
					lastSnippet ? `last  : ${lastSnippet}` : "",
				].filter(Boolean));
			};

			// Ensure the widget is torn down on every exit path.
			// On first call we do plan; subsequent calls do proving. Merge usage is
			// handled centrally so snapshots (deltas) sum correctly.
			const runParticipant = async (opts: Omit<Parameters<typeof runPi>[0], "onProgress">) => {
				const r = await runPi({
					...opts,
					onProgress: (p) => {
						lastSnippet = p.text.trim().split(/\s+/).slice(-14).join(" ") || lastSnippet;
						grandUsage = mergeUsage(grandUsage, p.usage);
						renderWidget();
					},
				});
				return r;
			};

			// 1.5 Pre-flight: the named theorem must exist and still contain a
			// sorry. Fail fast otherwise (before spending any tokens on P/M).
			currentPhase = "verify: pre-flight";
			renderWidget();
			const preflight = await verifyWorkspace(ws, theorem);
			if (preflight.status === "not-found") {
				ctx.ui.setWidget(WIDGET, []);
				ctx.ui.notify(
					`Theorem "${theorem}" was not found in the built workspace. Aborting.`,
					"error",
				);
				return;
			}
			if (preflight.status === "proved") {
				ctx.ui.setWidget(WIDGET, []);
				ctx.ui.notify(
					`Theorem "${theorem}" has no sorry left — nothing to prove. Aborting.`,
					"error",
				);
				return;
			}
			if (preflight.status !== "unproved") {
				ctx.ui.setWidget(WIDGET, []);
				ctx.ui.notify(`Pre-flight check failed: ${preflight.detail}`, "error");
				return;
			}
			ctx.ui.notify(
				`Pre-flight OK: "${theorem}" exists and is unproved (has sorry). Proving...`,
				"info",
			);

			// 2. Initial task: P produces a PLAN first (per spec).
			ctx.ui.setStatus("lean-prover", `${mentorModel} / ${proverModel}`);
			currentPhase = "P: planning";
			renderWidget();
			const initialPlan = await runParticipant({
				model: proverModel,
				tools: proverTools,
				systemPrompt: PROVER_SYSTEM,
				task:
					`Produce a step-by-step PLAN to prove:\n\n${theorem}\n\n` +
					`Explore the workspace: list the .lean files, open the ones relevant to this ` +
					`theorem, and see what's already defined. Output only the plan plus the lemmas ` +
					`you expect to need. Do not edit any files yet.`,
				cwd,
			});
			const planShort = initialPlan.output.trim().split(/\s+/).slice(0, 20).join(" ") || "(no text)";
			lastSnippet = planShort;

			let plan = initialPlan.output;
			const planFile = path.join(cwd, "prove-plan.md");
			// Persist the plan to the workspace so it can be read standalone while
			// /prove runs (and survives a terminal/extension crash). Updated every
			// time the plan changes (mentor/user guidance replaces it).
			const savePlan = () => {
				try {
					fs.writeFileSync(planFile, `# Proof plan\n\n${plan}\n`);
				} catch (e) {
					console.error("lean-prover: failed to persist plan:", e);
				}
			};
			savePlan();
			let lastProof = "";
			let finalVerify: Awaited<ReturnType<typeof verifyWorkspace>> | null = null;
			let outcome: "proved" | "mentor-stuck" | "mentor-wants-user" | "rounds-exhausted" =
				"rounds-exhausted";

			while (currentRound < MAX_ROUNDS) {
				currentRound++;
				renderWidget();

				// 3. P attempts the proof.
				currentPhase = `P: proving (round ${currentRound})`;
				renderWidget();
				const proverRun = await runParticipant({
					model: proverModel,
					tools: proverTools,
					systemPrompt: PROVER_SYSTEM,
					task:
						`Prove:\n\n${theorem}\n\n` +
						`Plan (from prior round):\n${plan}\n\n` +
						`Find and read the relevant .lean files in the workspace, then edit them and ` +
						`iterate with 'lake build' until the workspace compiles with no sorry/sorryAx/admit ` +
						`anywhere. Then summarize your final proof.`,
					cwd,
				});
				lastProof = proverRun.output;

				// 4. Robust verification.
				currentPhase = "verify: lake build + sorryAx scan";
				renderWidget();
				finalVerify = await verifyWorkspace(ws, theorem);
				if (finalVerify.status === "proved") {
					outcome = "proved";
					roundsProvedIn = currentRound;
					break;
				}
				if (finalVerify.status !== "unproved") {
					ctx.ui.notify(`Verify: ${finalVerify.status}`, "warning");
				}

				const leanState =
					`Robust check: ${finalVerify.status} — ${finalVerify.detail}. ` +
					`Inspect the workspace .lean files yourself to review the prover's work.`;

				// 5. M reviews and decides.
				currentPhase = `M: reviewing (round ${currentRound})`;
				renderWidget();
				const mentorRun = await runParticipant({
					model: mentorModel,
					tools: mentorTools,
					systemPrompt: MENTOR_SYSTEM,
					task:
						`Theorem to prove:\n${theorem || "(all workspace theorems)"}\n\n` +
						`Prover's latest plan:\n${plan}\n\n` +
						`Prover's latest proof attempt summary:\n${lastProof}\n\n` +
						`Current workspace state:\n${leanState}\n\n` +
						`Reply with strict JSON: {"status":"continue"|"stuck"|"need_user","advice":"...","reason":"..."}`,
					cwd,
				});

				let status = "continue";
				let rating: string | null = null;
				let advice = mentorRun.output;
				try {
					const parsed = JSON.parse(mentorRun.output.trim());
					status = parsed.status || "continue";
					rating = parsed.rating || null;
					advice = parsed.advice || parsed.reason || "";
				} catch {
					status = "continue";
				}
				if (rating) ctx.ui.notify(`Mentor rating: ${rating}`, "info");

				if (status === "stuck") {
					outcome = "mentor-stuck";
					break;
				}
				if (status === "need_user") {
					const answer = await ctx.ui.input(
						"Mentor requests input",
						advice || "What should the prover do?",
					);
					plan = `Mentor asked the user. User guidance:\n${answer}\n\nMentor advice:\n${advice}`;
					savePlan();
					continue;
				}

				plan = `Mentor guidance for round ${currentRound + 1}:\n${advice}`;
				savePlan();
			}

			const details = finalVerify && finalVerify.detail ? `\n${finalVerify.detail}` : "";
			const messages: Record<"proved" | "mentor-stuck" | "mentor-wants-user" | "rounds-exhausted", string> = {
				proved: `Proved in ${roundsProvedIn} round(s) — no sorry/sorryAx remaining. ✅${details}`,
				"mentor-stuck": "Mentor declared no further progress can be made. ⏸",
				"mentor-wants-user": "Mentor requested user interaction. ❓",
				"rounds-exhausted": `Did not prove within ${MAX_ROUNDS} rounds. Last check: ${finalVerify?.status ?? "n/a"}`,
			};
			ctx.ui.setStatus("lean-prover", "");
			ctx.ui.setWidget(WIDGET, []);
			ctx.ui.notify(
				`${messages[outcome]}  •  ${fmtTokens(grandUsage.totalTokens)} tokens, $${grandUsage.cost.toFixed(4)}`,
				outcome === "proved" ? "info" : "warning",
			);
		},
	});
}
