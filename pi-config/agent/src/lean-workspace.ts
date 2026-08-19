/**
 * lean-workspace.ts — pure Lean workspace detection + robust proof verification.
 *
 * No pi dependencies on purpose, so this can be:
 *   - imported by the pi extension (jiti),
 *   - imported/run directly by Node (type-stripping) for tests/CLI.
 *
 * Robust verification strategy ("proved without sorryAx"):
 *   1. `lake build` must succeed (whole project compiles).
 *   2. Generate a temporary check file that imports the workspace modules and
 *      runs a whole-module scan using Lean's own `Lean.collectAxioms`, reporting
 *      any declaration that transitively depends on the `sorryAx` axiom
 *      (covers `sorry`, `admit`, `by ... gap`, and direct `sorryAx`).
 *   3. `lake env lean <check>` returns "NO_SORRY" => proved; "SORRY:<names>" =>
 *      still contains a sorry.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface LeanToolchain {
  lean: boolean;
  lake: boolean;
  elan: boolean;
  leanVersion?: string;
  lakeVersion?: string;
}

export interface DetectedWorkspace {
  root: string;
  lakefile: string;
  lakefileIsToml: boolean;
  hasToolchainFile: boolean;
  modules: string[];
  toolchain: LeanToolchain;
}

export interface VerifyResult {
  status: "proved" | "unproved" | "build-error" | "check-error" | "not-workspace";
  detail: string;
  offenders: string[];
  hadSorryAx: boolean;
}

export interface ToolOutput {
  code: number;
  stdout: string;
  all: string; // stdout + stderr
}

export function runCommand(cwd: string, cmd: string, args: string[]): Promise<ToolOutput> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { cwd, shell: false });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.on("close", (code) =>
      resolve({ code: code ?? 0, stdout: out, all: (out + "\n" + err).trim() }),
    );
    proc.on("error", (e) => resolve({ code: -1, stdout: "", all: `spawn error: ${e.message}` }));
  });
}

async function have(name: string): Promise<boolean> {
  const r = await runCommand(process.cwd(), "which", [name]);
  return r.code === 0;
}

export async function detectToolchain(): Promise<LeanToolchain> {
  const lean = (await have("lean"));
  const lake = (await have("lake"));
  const elan = (await have("elan"));
  let leanVersion: string | undefined;
  let lakeVersion: string | undefined;
  if (lean) {
    const lv = await runCommand(process.cwd(), "lean", ["--version"]);
    leanVersion = lv.stdout.trim().split("\n")[0];
  }
  if (lake) {
    const lv = await runCommand(process.cwd(), "lake", ["--version"]);
    lakeVersion = lv.stdout.trim().split("\n")[0];
  }
  return { lean, lake, elan, leanVersion, lakeVersion };
}

const EXCLUDED_DIRS = new Set([".lake", "lake-packages", ".git", "build", "out", "node_modules", ".pi"]);
const EXCLUDED_FILES = new Set(["lakefile.lean", "lakefile.toml", "lean-toolchain"]);

/** Discover the project root by walking up for a lakefile. */
export async function findProjectRoot(cwd: string): Promise<{ root: string; lakefile: string } | null> {
  let dir = path.resolve(cwd);
  for (;;) {
    const toml = path.join(dir, "lakefile.toml");
    const lean = path.join(dir, "lakefile.lean");
    if (fs.existsSync(toml)) return { root: dir, lakefile: toml };
    if (fs.existsSync(lean)) return { root: dir, lakefile: lean };
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Walk .lean files under a directory, mapping to module names relative to the project root. */
export function discoverModules(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (EXCLUDED_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(full, r);
      else if (e.name.endsWith(".lean") && !EXCLUDED_FILES.has(e.name)) {
        const mod = r.slice(0, -".lean".length).replace(/\//g, ".");
        out.push(mod);
      }
    }
  };
  walk(root, "");
  return out.sort();
}

/**
 * Modules that were actually built by Lake, discovered from the build output
 * directory. This is the authoritative set we can `import` in check files
 * (raw source discovery would also pick up non-lib scripts).
 */
export function discoverBuiltModules(root: string): string[] {
  const dir = path.join(root, ".lake", "build", "lib", "lean");
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.name.endsWith(".olean")) out.push(r.slice(0, -".olean".length).replace(/\//g, "."));
    }
  };
  walk(dir, "");
  return out.sort();
}

export async function detectWorkspace(cwd: string): Promise<DetectedWorkspace> {
  const toolchain = await detectToolchain();
  const found = await findProjectRoot(cwd);
  if (!found) {
    throw new Error(
      "No Lean/Lake workspace found. Expected a `lakefile.toml` or `lakefile.lean` " +
        "in this directory or an ancestor.",
    );
  }
  if (!toolchain.lake || !toolchain.lean) {
    throw new Error(
      "Lean toolchain not found on PATH (need `lean` and `lake`, normally via elan). " +
        `lean=${toolchain.lean} lake=${toolchain.lake}`,
    );
  }
  const hasToolchainFile = fs.existsSync(path.join(found.root, "lean-toolchain"));
  return {
    root: found.root,
    lakefile: found.lakefile,
    lakefileIsToml: found.lakefile.endsWith(".toml"),
    hasToolchainFile,
    modules: discoverModules(found.root),
    toolchain,
  };
}

/** Build the whole project. Returns null on success, error text on failure. */
export async function buildWorkspace(ws: DetectedWorkspace): Promise<string | null> {
  const r = await runCommand(ws.root, "lake", ["build"]);
  if (r.code === 0 || /built successfully/i.test(r.all)) return null;
  return r.all || `lake build failed with exit code ${r.code}`;
}

const CHECK_TEMPLATE = (modules: string[]) => `
import Lean
${modules.map((m) => `import ${m}`).join("\n")}

open Lean

#eval show CoreM String from do
  let env ← getEnv
  let mut bad : Array Name := #[]
  for (n, _) in env.constants do
    if n != \`\`sorryAx && (← Lean.collectAxioms n).contains \`\`sorryAx then
      bad := bad.push n
  if bad.isEmpty then
    return "RESULT:NO_SORRY"
  else
    return "RESULT:SORRY:" ++ String.intercalate "," (bad.toList.map (fun n => n.toString))
`;

function parseCheckOutput(output: string): { offenders: string[]; hadSorryAx: boolean } {
  const m = output.match(/RESULT:(?:NO_SORRY|SORRY:(.*))/);
  if (!m) return { offenders: [], hadSorryAx: false };
  if (m[1] === undefined) return { offenders: [], hadSorryAx: false };
  // The #eval prints the String repr (wrapped in quotes); strip them.
  const list = m[1].replace(/"/g, "").trim();
  return { offenders: list.split(",").map((s) => s.trim()).filter(Boolean), hadSorryAx: true };
}

/**
 * Robustly verify that the workspace builds and contains no `sorryAx` usage.
 */
export async function verifyWorkspace(ws: DetectedWorkspace): Promise<VerifyResult> {
  const buildErr = await buildWorkspace(ws);
  if (buildErr) {
    return { status: "build-error", detail: buildErr, offenders: [], hadSorryAx: false };
  }
  const modules = discoverBuiltModules(ws.root);
  if (!modules.length) {
    return {
      status: "not-workspace",
      detail: "No .lean modules were built by Lake (nothing to import/check).",
      offenders: [],
      hadSorryAx: false,
    };
  }
  const checkPath = path.join(
    os.tmpdir(),
    `lean-prover-check-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.lean`,
  );
  fs.writeFileSync(checkPath, CHECK_TEMPLATE(modules));
  try {
    const r = await runCommand(ws.root, "lake", ["env", "lean", checkPath]);
    const parsed = parseCheckOutput(r.all);
    const hasLeanStartupError = /error:/i.test(r.all) && !parsed.hadSorryAx;
    if (hasLeanStartupError) {
      return {
        status: "check-error",
        detail: r.all.slice(0, 4000) || "check file failed unexpectedly",
        offenders: parsed.offenders,
        hadSorryAx: parsed.hadSorryAx,
      };
    }
    return {
      status: parsed.hadSorryAx ? "unproved" : "proved",
      detail: parsed.hadSorryAx
        ? `Still depends on 'sorryAx': ${parsed.offenders.join(", ")}`
        : "Workspace builds cleanly with no 'sorryAx' usage.",
      offenders: parsed.offenders,
      hadSorryAx: parsed.hadSorryAx,
    };
  } finally {
    try {
      fs.rmSync(checkPath, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/** Read the current content of all workspace .lean files (for model context). */
export function gatherProjectLeanFiles(root: string): Record<string, string> {
  const results: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (EXCLUDED_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(full, r);
      else if (e.name.endsWith(".lean")) {
        try {
          results[r] = fs.readFileSync(full, "utf8");
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(root, "");
  return results;
}

export function formatLeanContext(files: Record<string, string>): string {
  return Object.entries(files)
    .map(([name, content]) => `### ${name}\n\`\`\`lean\n${content}\n\`\`\``)
    .join("\n\n");
}
