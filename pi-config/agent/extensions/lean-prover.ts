/**
 * Lean Mentor/Prover orchestration extension.
 *
 * Workflow (per the design):
 *   1. Detect the Lean/Lake workspace and pick a "prover" model P and a
 *      "mentor" model M (may be the same).
 *   2. P produces a proof plan.
 *   3. P attempts the proof by editing the workspace and running `lake build`.
 *   4. Robust verification: `lake build` succeeds AND the named theorem does
 *      not depend on `sorryAx` (Lean-native, single-declaration check), and
 *      leans on no axioms beyond Lean's own.
 *      The theorem must be named; it must exist; and it must still contain a
 *      sorry at the start (pre-flight) or the command fails fast.
 *   5. M reviews P's state / Lean errors and either guides P, declares no
 *      progress (b), or requests user interaction (c).
 *   6. Loop until: (a) proved without sorryAx, (b) M declares no progress,
 *      (c) M requests the user.
 *
 * Both P and M run as isolated agent subprocesses, each with its own context +
 * model, all acting on the shared Lean workspace via the normal file/bash
 * tools. Two backends are supported and may be mixed freely:
 *
 *   - "pi"     — `pi --mode json` (the pattern from examples/extensions/subagent/)
 *   - "claude" — `claude -p --output-format stream-json`
 *
 * Directions: /prove T goes for T, /prove --refute T goes for ¬T (a sibling
 * declaration whose type must be definitionally `Not T`), /prove --either T
 * lets the prover pick and wins on whichever lands first.
 *
 * PROVER_BACKEND (default "pi") picks the prover's backend; MENTOR_BACKEND
 * defaults to PROVER_BACKEND. Binaries: PI_BIN / CLAUDE_BIN. Extra claude
 * flags: CLAUDE_EXTRA_ARGS.
 *
 * Progress: a live TUI widget reports the current phase, round progress (as a
 * percentage of MAX_ROUNDS), running token/cost totals, and a short tail of the
 * model's latest output.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  detectWorkspace,
  discoverWorkspaces,
  verifyWorkspace,
  type DetectedWorkspace,
  type VerifyResult,
} from "/pi-config/src/lean-workspace.ts";

const MAX_ROUNDS = 12;
const WIDGET = "lean-prover";

/** What the prover is chasing this run. */
export type Direction = "prove" | "refute" | "either";

/**
 * Default name for the refutation of `A.B.thm` -> `A.B.not_thm`. The
 * declaration's *type* is what actually gets checked (definitionally `Not T`),
 * so the name is only a convention.
 */
function defaultNegName(theorem: string): string {
	const parts = theorem.split(".");
	const last = parts.pop() ?? theorem;
	// A French-quoted component keeps the prefix inside the quotes: «not_x», as
	// `not_«x»` is not a legal Lean identifier.
	const negated =
		last.startsWith("«") && last.endsWith("»")
			? `«not_${last.slice(1, -1)}»`
			: `not_${last}`;
	return [...parts, negated].join(".");
}

/** Which agent CLI drives a participant. */
export type Backend = "pi" | "claude";

function resolveBackend(value: string | undefined, fallback: Backend): Backend {
	const v = (value || "").trim().toLowerCase();
	if (v === "claude") return "claude";
	if (v === "pi") return "pi";
	return fallback;
}

/**
 * Claude Code takes model aliases or full IDs — there is no registry to query,
 * so offer a fixed menu (any `--model` string works if edited by hand).
 */
const CLAUDE_MODELS = [
	"opus",
	"sonnet",
	"haiku",
	"fable",
	"claude-opus-5",
	"claude-sonnet-5",
	"claude-haiku-4-5",
];

/** pi tool names -> Claude Code tool names. */
const CLAUDE_TOOL_MAP: Record<string, string> = {
	read: "Read",
	bash: "Bash",
	edit: "Edit",
	write: "Write",
	grep: "Grep",
	find: "Glob",
	ls: "Glob",
};

function toClaudeTools(tools: string[]): string[] {
	const out = new Set<string>();
	for (const t of tools) out.add(CLAUDE_TOOL_MAP[t] ?? t);
	return [...out];
}

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

function getClaudeInvocation(args: string[]): { command: string; args: string[] } {
	const bin = process.env.CLAUDE_BIN || "claude";
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

export interface RunOpts {
	/** Backend-specific model string ("provider/id" for pi, alias/ID for claude). */
	model: string;
	/** pi-style tool names; mapped for other backends. */
	tools: string[];
	systemPrompt: string;
	task: string;
	cwd: string;
	/** Structured-output schema. Honoured by the claude backend, ignored by pi. */
	jsonSchema?: Record<string, unknown>;
	onProgress?: OnProgress;
}

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
}: RunOpts): Promise<PiRunResult> {
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

/**
 * Run one participant as a `claude -p --output-format stream-json` subprocess.
 * Same contract as runPi(); only the flags and the event shapes differ.
 *
 * Notes on the flags:
 *   --verbose                  required for stream-json under -p
 *   --include-partial-messages gives text deltas for the progress widget
 *   --strict-mcp-config        don't inherit the host's MCP servers (token bloat)
 *   --permission-mode          the prover must edit + run lake without prompting
 *   --session-id               a fresh session per run (pi's --no-session)
 */
async function runClaude({
	model,
	tools,
	systemPrompt,
	task,
	cwd,
	jsonSchema,
	onProgress,
}: RunOpts): Promise<PiRunResult> {
	const args: string[] = [
		"-p",
		"--output-format",
		"stream-json",
		"--verbose",
		"--include-partial-messages",
		"--strict-mcp-config",
		"--permission-mode",
		"bypassPermissions",
		"--session-id",
		randomUUID(),
		"--model",
		model,
	];
	// Comma-separated, not space-separated: the variadic form would swallow the
	// trailing prompt argument.
	if (tools.length) args.push("--allowedTools", toClaudeTools(tools).join(","));
	if (systemPrompt.trim()) args.push("--append-system-prompt", systemPrompt);
	if (jsonSchema) args.push("--json-schema", JSON.stringify(jsonSchema));
	// Escape hatch: the subprocess still inherits the host's user-level settings
	// (hooks, output style, ...). CLAUDE_EXTRA_ARGS="--safe-mode" or a
	// "--settings <file>" pair strips them.
	const extra = (process.env.CLAUDE_EXTRA_ARGS || "").trim();
	if (extra) args.push(...extra.split(/\s+/));
	args.push(`Task: ${task}`);

	const { command, args: finalArgs } = getClaudeInvocation(args);
	const messages: any[] = [];
	let usage = { ...ZERO_USAGE };
	let lastEmitted = { ...ZERO_USAGE };
	let streamText = "";
	let resultText = "";
	let stderr = "";
	let lastRender = 0;

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
		lastRender = Date.now();
		onProgress?.({ text: streamText, usage: delta });
	};

	const exitCode = await new Promise<number>((resolve) => {
		let proc: ReturnType<typeof spawn>;
		try {
			proc = spawn(command, finalArgs, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";
			proc.stderr.on("data", (d) => (stderr += d.toString()));
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
					// Raw Anthropic stream events (text deltas). Throttled, since
					// re-rendering the widget per token is wasteful.
					if (evt.type === "stream_event") {
						const inner = evt.event;
						if (inner?.type === "content_block_delta" && inner.delta?.type === "text_delta") {
							streamText += inner.delta.text ?? "";
							if (Date.now() - lastRender > 250) emitProgress();
						}
						continue;
					}
					if (evt.type === "assistant" && evt.message) {
						messages.push(evt.message);
						const u = evt.message.usage;
						if (u) {
							const input = u.input_tokens ?? 0;
							const output = u.output_tokens ?? 0;
							const cacheWrite = u.cache_creation_input_tokens ?? 0;
							usage = mergeUsage(usage, {
								input,
								output,
								cacheRead: u.cache_read_input_tokens ?? 0,
								cacheWrite,
								// Fresh tokens only: cache reads are re-reads of the same
								// prefix and would inflate the total on every turn.
								totalTokens: input + output + cacheWrite,
								cost: 0,
							});
							emitProgress();
						}
					}
					// The terminal event carries the final text and the run's cost.
					// Match defensively: the field name is "result" but the cost field
					// is the reliable marker.
					if (evt.type === "result" || typeof evt.total_cost_usd === "number") {
						if (typeof evt.result === "string" && !evt.is_error) resultText = evt.result;
						if (typeof evt.total_cost_usd === "number") usage.cost = evt.total_cost_usd;
						emitProgress();
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

	return {
		exitCode,
		output: resultText.trim() || getFinalOutput(messages),
		stderr,
		usage,
	};
}

/** Dispatch a participant run to the configured backend. */
function runAgent(backend: Backend, opts: RunOpts): Promise<PiRunResult> {
	return backend === "claude" ? runClaude(opts) : runPi(opts);
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

const REFUTER_SYSTEM = `You are the REFUTER in a Lean 4 proving assistant. Your goal is to DISPROVE a
theorem T: produce a complete, sorry-free proof of its negation.

Hard requirements, all machine-checked:
  - Put the declaration in a module Lake actually builds: either an existing
    module, or a new file imported from the library root. 'lake build' happily
    succeeds while ignoring a file no lean_lib reaches, and then your
    refutation does not exist as far as the checker is concerned.
  - Add a declaration whose type is definitionally 'Not T' — i.e. literally
    'theorem <negName> : ¬ (<the exact statement of T>) := ...'. Copy T's
    statement verbatim; a weakened or altered claim is rejected as
    STATEMENT_MISMATCH and counts for nothing.
  - Do NOT edit T's own statement. Rewriting T to suit you is detected.
  - No 'sorry'/'admit'/'sorryAx' in your refutation.
  - No new 'axiom' declarations and no 'native_decide': the checker rejects any
    axiom outside propext / Classical.choice / Quot.sound.

Tactics that tend to pay off: exhibit an explicit counterexample and close the
goal with 'decide', 'omega', 'norm_num', or 'simp'; for a '∀' statement,
'intro h' then instantiate h at the witness and derive False. Explore small
cases with '#eval' before committing. Note that '∃ x, ¬P x' is NOT the required
shape — derive '¬ ∀ x, P x' from it.

Iterate: edit, 'lake build', read the errors, fix. When it compiles cleanly,
reply with a short summary and the final refutation.`;

const EITHER_SYSTEM = `You are the PROVER/REFUTER in a Lean 4 proving assistant. You decide which way
a theorem T goes, then prove it that way.

Either produce a complete sorry-free proof of T, or add a separate declaration
whose type is definitionally 'Not T' ('theorem <negName> : ¬ (<T's exact
statement>) := ...'), placed in a module Lake builds — a file no lean_lib
reaches is silently skipped by 'lake build' and your declaration will not
exist. Both directions are machine-checked: no
sorry/admit/sorryAx, no new 'axiom', no 'native_decide', and T's own statement
must not be edited. A negation of a weakened claim is rejected.

Spend your first effort deciding the direction — test small cases with '#eval',
look for a counterexample — then commit and iterate: edit, 'lake build', read
the errors, fix. Say clearly which direction you took in your summary.`;

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

/** Same shape as MENTOR_SYSTEM asks for; enforced via --json-schema on claude. */
const MENTOR_SCHEMA: Record<string, unknown> = {
	type: "object",
	properties: {
		status: { type: "string", enum: ["continue", "stuck", "need_user"] },
		rating: { type: "string" },
		advice: { type: "string" },
		reason: { type: "string" },
	},
	required: ["status", "advice", "reason"],
	additionalProperties: false,
};

export const PROVE_USAGE =
	"Usage: /prove [--refute|--either] [--neg-name=<name>] [--workspace=<dir>] <[dir/]theorem-name>";

export interface ProveArgs {
	direction: Direction;
	/** Fully-qualified Lean declaration name. */
	theorem: string;
	negName: string;
	/** Workspace directory, relative to the session cwd, or null to auto-detect. */
	workspace: string | null;
}

/**
 * Parse the /prove argument string.
 *
 * A Lean declaration name is dot-separated and cannot contain '/', so
 * `formal/proj/My.Thm` needs no flag: everything up to the last '/' is the
 * workspace directory, the rest is the theorem. The one exception is a
 * French-quoted name (`«a/b»`), which may contain anything: a token containing
 * '«' is never split, so it is taken as the theorem name as-is and the
 * workspace comes from --workspace= or auto-detection.
 */
export function parseProveArgs(raw: string): ProveArgs | { error: string } {
	let direction: Direction = "prove";
	let negNameOverride: string | null = null;
	let workspace: string | null = null;
	const positional: string[] = [];
	for (const tok of (raw || "").trim().split(/\s+/).filter(Boolean)) {
		if (tok === "--refute") direction = "refute";
		else if (tok === "--either") direction = "either";
		else if (tok.startsWith("--neg-name=")) negNameOverride = tok.slice("--neg-name=".length);
		else if (tok.startsWith("--workspace=")) workspace = tok.slice("--workspace=".length);
		else if (tok.startsWith("--")) return { error: `Unknown flag "${tok}". ${PROVE_USAGE}` };
		else positional.push(tok);
	}
	if (positional.length !== 1) {
		if (positional.length > 1 && positional.some((t) => t.includes("«"))) {
			return {
				error:
					`A '«...»' name containing a space is not supported (arguments are split on ` +
					`whitespace). ${PROVE_USAGE}`,
			};
		}
		return {
			error: positional.length
				? `Name exactly one theorem. ${PROVE_USAGE}`
				: `No theorem named. ${PROVE_USAGE}`,
		};
	}
	let theorem = positional[0];
	const cut = theorem.lastIndexOf("/");
	if (cut >= 0 && !theorem.includes("«")) {
		const dir = theorem.slice(0, cut);
		const name = theorem.slice(cut + 1);
		if (!name) return { error: `No theorem name after "${dir}/". ${PROVE_USAGE}` };
		if (workspace && workspace !== dir) {
			return {
				error:
					`Two different workspaces given: --workspace=${workspace} and "${dir}/" in the ` +
					`theorem. Give the directory once.`,
			};
		}
		// A leading '/' makes the path absolute, which path.resolve handles.
		workspace = dir || "/";
		theorem = name;
	}
	return { direction, theorem, negName: negNameOverride || defaultNegName(theorem), workspace };
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerCommand("prove", {
		description:
			"Run the mentor/prover loop against a Lean theorem (<dir>/<thm> to pin the workspace): prove it, refute it (--refute), or either (--either).",
		handler: async (args, ctx) => {
			// The theorem is REQUIRED (no more "prove everything"); flags pick the
			// direction, and `<dir>/<thm>` pins the workspace without a flag.
			const parsed = parseProveArgs(args || "");
			if ("error" in parsed) {
				ctx.ui.notify(parsed.error, "error");
				return;
			}
			const { direction, theorem, negName, workspace: workspaceOverride } = parsed;
			// What the prover is asked for, and which system prompt frames it.
			const proverSystem =
				direction === "refute"
					? REFUTER_SYSTEM
					: direction === "either"
						? EITHER_SYSTEM
						: PROVER_SYSTEM;
			const goalText =
				direction === "refute"
					? `¬ (${theorem}), as a new declaration '${negName}'`
					: direction === "either"
						? `${theorem} — either prove it, or refute it as a new declaration '${negName}'`
						: theorem;

			// 0. Detect + validate the Lean workspace. It may sit in a
			// subdirectory (formal/, lean/, proofs/, ...): detectWorkspace looks
			// up first, then down. --workspace=<dir> / LEAN_WORKSPACE pin it, and
			// an ambiguous tree is resolved by asking.
			const wsRaw = workspaceOverride || process.env.LEAN_WORKSPACE || null;
			const wsOverride = wsRaw ? path.resolve(ctx.cwd, wsRaw) : null;
			let ws: DetectedWorkspace | null = null;
			try {
				ws = await detectWorkspace(ctx.cwd, wsOverride ? { root: wsOverride } : {});
			} catch (e) {
				const candidates = wsOverride ? [] : discoverWorkspaces(ctx.cwd);
				if (candidates.length < 2) {
					ctx.ui.notify((e as Error).message, "error");
					return;
				}
				const labels = candidates.map((c) => path.relative(ctx.cwd, c.root) || ".");
				const pick = await ctx.ui.select("Select the Lean workspace:", labels);
				if (!pick) return;
				try {
					ws = await detectWorkspace(ctx.cwd, { root: candidates[labels.indexOf(pick)].root });
				} catch (e2) {
					ctx.ui.notify((e2 as Error).message, "error");
					return;
				}
			}
			if (!ws) return;
			ctx.ui.notify(`Workspace OK: ${ws.root}`, "info");

			// 1. Pick the backends (env) and then the models they offer.
			const proverBackend = resolveBackend(process.env.PROVER_BACKEND, "pi");
			const mentorBackend = resolveBackend(process.env.MENTOR_BACKEND, proverBackend);
			ctx.ui.notify(`Backends — P: ${proverBackend}, M: ${mentorBackend}`, "info");

			let piModels: string[] | null = null;
			const modelsFor = async (b: Backend): Promise<string[]> => {
				if (b === "claude") return [...CLAUDE_MODELS];
				if (!piModels) {
					const available = await ctx.modelRegistry.getAvailable();
					piModels = available.map((m) => `${m.provider}/${m.id}`);
				}
				return piModels;
			};

			const proverOptions = await modelsFor(proverBackend);
			if (!proverOptions.length) {
				ctx.ui.notify("No models available. Configure a provider first.", "error");
				return;
			}
			const proverModel = await ctx.ui.select(
				`Select PROVER model P (${proverBackend}):`,
				proverOptions,
			);
			if (!proverModel) return;
			const mentorOptions = await modelsFor(mentorBackend);
			if (!mentorOptions.length) {
				ctx.ui.notify("No models available. Configure a provider first.", "error");
				return;
			}
			const mentorModel = await ctx.ui.select(
				`Select MENTOR model M (${mentorBackend}):`,
				mentorBackend === proverBackend ? [proverModel, ...mentorOptions] : mentorOptions,
			);
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
					`M: ${mentorBackend}:${mentorModel}   P: ${proverBackend}:${proverModel}`,
					`goal  : ${direction === "refute" ? `¬ ${theorem}` : direction === "either" ? `${theorem} or ¬ ${theorem}` : theorem}`,
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
			const runParticipant = async (
				backend: Backend,
				opts: Omit<RunOpts, "onProgress">,
			) => {
				const r = await runAgent(backend, {
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
					direction === "prove"
						? `Theorem "${theorem}" has no sorry left — nothing to prove. Aborting.`
						: `Theorem "${theorem}" is already proved sorry-free; a refutation would make ` +
								`the workspace inconsistent. Aborting.`,
					"error",
				);
				return;
			}
			if (preflight.status !== "unproved") {
				ctx.ui.setWidget(WIDGET, []);
				ctx.ui.notify(`Pre-flight check failed: ${preflight.detail}`, "error");
				return;
			}
			// Pin T's statement now: a "proof" of a T edited mid-run proves nothing.
			const baselineFingerprint = preflight.fingerprint;

			// The refutation target legitimately does not exist yet — the prover
			// creates it. Only an already-finished refutation aborts the run.
			if (direction !== "prove") {
				const negPre = await verifyWorkspace(ws, negName, { negationOf: theorem });
				if (negPre.status === "proved") {
					ctx.ui.setWidget(WIDGET, []);
					ctx.ui.notify(
						`"${negName}" already refutes "${theorem}" sorry-free — nothing to do. Aborting.`,
						"error",
					);
					return;
				}
				if (negPre.status === "statement-mismatch") {
					ctx.ui.notify(
						`Note: "${negName}" exists but is not ¬ (${theorem}); the prover must fix its statement.`,
						"warning",
					);
				}
			}
			ctx.ui.notify(
				`Pre-flight OK: "${theorem}" exists and is unproved (has sorry). ` +
					`Direction: ${direction}. Working on ${goalText}...`,
				"info",
			);

			// 2. Initial task: P produces a PLAN first (per spec).
			ctx.ui.setStatus("lean-prover", `${mentorModel} / ${proverModel}`);
			currentPhase = "P: planning";
			renderWidget();
			const initialPlan = await runParticipant(proverBackend, {
				model: proverModel,
				tools: proverTools,
				systemPrompt: proverSystem,
				task:
					`Produce a step-by-step PLAN to settle:\n\n${goalText}\n\n` +
					`Explore the workspace: list the .lean files, open the ones relevant to this ` +
					`theorem, and see what's already defined. Output only the plan plus the lemmas ` +
					`you expect to need` +
					(direction === "either"
						? `, and state which direction you intend to take and why`
						: ``) +
					`. Do not edit any files yet.`,
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
			let finalVerify: VerifyResult | null = null;
			let negVerify: VerifyResult | null = null;
			let statementDrifted = false;
			type Outcome =
				| "proved"
				| "refuted"
				| "inconsistent"
				| "mentor-stuck"
				| "mentor-wants-user"
				| "rounds-exhausted";
			let outcome: Outcome = "rounds-exhausted";

			while (currentRound < MAX_ROUNDS) {
				currentRound++;
				renderWidget();

				// 3. P attempts the proof.
				currentPhase = `P: proving (round ${currentRound})`;
				renderWidget();
				const proverRun = await runParticipant(proverBackend, {
					model: proverModel,
					tools: proverTools,
					systemPrompt: proverSystem,
					task:
						`Settle:\n\n${goalText}\n\n` +
						`Plan (from prior round):\n${plan}\n\n` +
						`Find and read the relevant .lean files in the workspace, then edit them and ` +
						`iterate with 'lake build' until the workspace compiles with no sorry/sorryAx/admit ` +
						`in the declaration you are proving. Do not edit the statement of '${theorem}'. ` +
						`Then summarize your final proof.`,
					cwd,
				});
				lastProof = proverRun.output;

				// 4. Robust verification — both directions whenever either can win.
				currentPhase = "verify: lake build + axiom scan";
				renderWidget();
				finalVerify = await verifyWorkspace(ws, theorem);
				negVerify =
					direction === "prove"
						? null
						: await verifyWorkspace(ws, negName, { negationOf: theorem });

				// T's statement must not drift: a proof of a weakened T is not a
				// proof of T. Warn rather than abort — renaming a bound variable
				// moves the fingerprint without weakening anything.
				const fp = finalVerify.fingerprint ?? negVerify?.fingerprint;
				if (baselineFingerprint && fp && fp !== baselineFingerprint && !statementDrifted) {
					statementDrifted = true;
					ctx.ui.notify(
						`WARNING: the statement of '${theorem}' changed since pre-flight — ` +
							`any result may be about a different claim.`,
						"warning",
					);
				}

				const provedT = finalVerify.status === "proved";
				const refutedT = negVerify?.status === "proved";
				if (provedT || refutedT) {
					// Both at once means contradictory definitions or an axiom the
					// whitelist missed — a finding, not a win.
					outcome = provedT && refutedT ? "inconsistent" : provedT ? "proved" : "refuted";
					roundsProvedIn = currentRound;
					break;
				}
				if (finalVerify.status !== "unproved") {
					ctx.ui.notify(`Verify ${theorem}: ${finalVerify.status}`, "warning");
				}
				if (negVerify && !["unproved", "not-found"].includes(negVerify.status)) {
					ctx.ui.notify(`Verify ${negName}: ${negVerify.status}`, "warning");
				}

				const leanState =
					`Check of '${theorem}': ${finalVerify.status} — ${finalVerify.detail}\n` +
					(negVerify
						? `Check of '${negName}' (must be definitionally ¬ ${theorem}): ` +
							`${negVerify.status} — ${negVerify.detail}\n`
						: ``) +
					(statementDrifted
						? `WARNING: the statement of '${theorem}' was edited since pre-flight.\n`
						: ``) +
					`Inspect the workspace .lean files yourself to review the prover's work.`;

				// 5. M reviews and decides.
				currentPhase = `M: reviewing (round ${currentRound})`;
				renderWidget();
				const mentorRun = await runParticipant(mentorBackend, {
					model: mentorModel,
					tools: mentorTools,
					systemPrompt: MENTOR_SYSTEM,
					task:
						`Goal under review:\n${goalText}\n\n` +
						(direction === "either"
							? `The prover may switch direction between rounds; if you think the other ` +
								`direction is right, say so in "advice" with a concrete reason ` +
								`(e.g. a candidate counterexample).\n\n`
							: ``) +
						`Prover's latest plan:\n${plan}\n\n` +
						`Prover's latest proof attempt summary:\n${lastProof}\n\n` +
						`Current workspace state:\n${leanState}\n\n` +
						`Reply with strict JSON: {"status":"continue"|"stuck"|"need_user","advice":"...","reason":"..."}`,
					cwd,
					jsonSchema: MENTOR_SCHEMA,
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
			const negDetails = negVerify && negVerify.detail ? `\n${negVerify.detail}` : "";
			const drift = statementDrifted
				? `\nWARNING: '${theorem}' was edited during the run — re-read its statement before trusting this.`
				: "";
			const messages: Record<Outcome, string> = {
				proved: `Proved in ${roundsProvedIn} round(s) — no sorry/sorryAx remaining. ✅${details}${drift}`,
				refuted: `REFUTED in ${roundsProvedIn} round(s) — '${negName}' proves ¬ ${theorem}, sorry-free. ❌${negDetails}${drift}`,
				inconsistent:
					`INCONSISTENT: both '${theorem}' and '${negName}' verify sorry-free. The workspace ` +
					`proves False — contradictory definitions, or a trusted axiom the whitelist misses. 🚨` +
					`${details}${negDetails}${drift}`,
				"mentor-stuck": "Mentor declared no further progress can be made. ⏸",
				"mentor-wants-user": "Mentor requested user interaction. ❓",
				"rounds-exhausted":
					`Did not settle within ${MAX_ROUNDS} rounds. Last check: ${finalVerify?.status ?? "n/a"}` +
					(negVerify ? ` / ${negVerify.status} (¬)` : ``),
			};
			ctx.ui.setStatus("lean-prover", "");
			ctx.ui.setWidget(WIDGET, []);
			ctx.ui.notify(
				`${messages[outcome]}  •  ${fmtTokens(grandUsage.totalTokens)} tokens, $${grandUsage.cost.toFixed(4)}`,
				outcome === "proved" || outcome === "refuted" ? "info" : "warning",
			);
		},
	});
}
