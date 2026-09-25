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
 *      uses Lean's own `Lean.collectAxioms` to test ONE named theorem: does it
 *      transitively depend on the `sorryAx` axiom (covers `sorry`, `admit`,
 *      `by ... gap`, and direct `sorryAx`)?
 *   3. `lake env lean <check>` returns "NOT_FOUND" (no such declaration),
 *      "SORRY" (still depends on sorryAx), or "NO_SORRY" (proved).
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

export interface WorkspaceCandidate {
  root: string;
  lakefile: string;
  /** Directory levels below the starting cwd (0 = cwd itself). */
  depth: number;
}

export interface DetectedWorkspace {
  root: string;
  lakefile: string;
  lakefileIsToml: boolean;
  hasToolchainFile: boolean;
  modules: string[];
  toolchain: LeanToolchain;
}

export type VerifyStatus =
  | "proved"
  | "unproved"
  | "not-found"
  | "not-found-base"
  | "statement-mismatch"
  | "bad-axioms"
  | "build-error"
  | "check-error"
  | "not-workspace";

export interface VerifyResult {
  status: VerifyStatus;
  detail: string;
  offenders: string[];
  hadSorryAx: boolean;
  /**
   * Structural hash (`Expr.hash`) of the pinned statement's type, or undefined
   * when it could not be read. Lets a caller notice the statement itself being
   * edited mid-run — a proof of a weakened `T` is not a proof of `T`.
   */
  fingerprint?: string;
}

/**
 * The axioms Lean's own stdlib is built on. Anything else in a declaration's
 * axiom set is either `sorryAx` or a trusted-but-unchecked escape hatch
 * (`native_decide` adds a generated `._native.native_decide.ax_*` axiom), so it must not pass as a
 * proof here. Refutations attract these far more than proofs do.
 */
export const AXIOM_WHITELIST = ["propext", "Classical.choice", "Quot.sound"];

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

/** The lakefile in `dir`, if any. */
function lakefileIn(dir: string): string | null {
  const toml = path.join(dir, "lakefile.toml");
  if (fs.existsSync(toml)) return toml;
  const lean = path.join(dir, "lakefile.lean");
  if (fs.existsSync(lean)) return lean;
  return null;
}

/**
 * Find Lake workspaces *below* `cwd`, for the common layout where the Lean
 * project is a subdirectory of the repo (`formal/`, `lean/`, `proofs/`, ...).
 *
 * Breadth-first so shallower projects come first; a directory that is itself a
 * workspace is not descended into (its `.lake` deps are not separate projects).
 * `maxDepth` and `limit` keep this from turning into a full-tree scan.
 */
export function discoverWorkspaces(cwd: string, maxDepth = 3, limit = 256): WorkspaceCandidate[] {
  const start = path.resolve(cwd);
  const found: WorkspaceCandidate[] = [];
  let queue: Array<{ dir: string; depth: number }> = [{ dir: start, depth: 0 }];
  let visited = 0;
  while (queue.length && visited < limit) {
    const next: Array<{ dir: string; depth: number }> = [];
    for (const { dir, depth } of queue) {
      if (visited++ >= limit) break;
      const lakefile = lakefileIn(dir);
      if (lakefile) {
        found.push({ root: dir, lakefile, depth });
        continue; // don't descend into a workspace
      }
      if (depth >= maxDepth) continue;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        // isDirectory() is false for symlinks, which also avoids link cycles.
        if (!e.isDirectory() || EXCLUDED_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        next.push({ dir: path.join(dir, e.name), depth: depth + 1 });
      }
    }
    queue = next;
  }
  return found.sort((a, b) => a.depth - b.depth || a.root.localeCompare(b.root));
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

/**
 * Locate and validate the workspace.
 *
 * Resolution order: `opts.root` (explicit, must hold a lakefile) -> nearest
 * ancestor with a lakefile -> single workspace found below `cwd`. Several
 * candidates below `cwd` is not resolved here (this module stays UI-free):
 * the error lists them, and callers that can ask the user should call
 * `discoverWorkspaces()` and pass the choice back as `opts.root`.
 */
export async function detectWorkspace(
  cwd: string,
  opts: { root?: string } = {},
): Promise<DetectedWorkspace> {
  const toolchain = await detectToolchain();
  let found: { root: string; lakefile: string } | null = null;
  if (opts.root) {
    const root = path.resolve(opts.root);
    const lakefile = lakefileIn(root);
    if (!lakefile) {
      throw new Error(
        `No \`lakefile.toml\`/\`lakefile.lean\` in '${root}' — not a Lean/Lake workspace.`,
      );
    }
    found = { root, lakefile };
  } else {
    found = await findProjectRoot(cwd);
  }
  if (!found) {
    const below = discoverWorkspaces(cwd);
    if (below.length === 1) {
      found = { root: below[0].root, lakefile: below[0].lakefile };
    } else if (below.length > 1) {
      throw new Error(
        `Several Lean/Lake workspaces found below this directory:\n` +
          below.map((c) => `  ${path.relative(cwd, c.root) || "."}`).join("\n") +
          `\nPick one explicitly.`,
      );
    }
  }
  if (!found) {
    throw new Error(
      "No Lean/Lake workspace found. Expected a `lakefile.toml` or `lakefile.lean` " +
        "in this directory, an ancestor, or a subdirectory.",
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

/**
 * Check file for ONE declaration.
 *
 * `negationOf` turns this into a refutation check: `target`'s type must be
 * definitionally `Not <base's type>`, so a prover cannot "refute" a weakened
 * cousin of the statement. The trailing #eval fingerprints the pinned
 * statement (the base when refuting, the target otherwise) so the caller can
 * detect the statement being rewritten between rounds.
 */
const CHECK_TEMPLATE = (modules: string[], target: string, negationOf?: string) => {
  const whitelist = AXIOM_WHITELIST.map((a) => `a != \`${a}`).join(" && ");
  const existence = negationOf
    ? `
  let base : Name := \`${negationOf}
  if !(env.constants.contains base) then
    return "RESULT:NOT_FOUND_BASE"
  if !(env.constants.contains n) then
    return "RESULT:NOT_FOUND"
  let bty := (env.constants.find! base).type
  let nty := (env.constants.find! n).type
  let sameStatement ← MetaM.run' (isDefEq nty (mkApp (mkConst \`\`Not) bty))
  if !sameStatement then
    return "RESULT:MISMATCH"`
    : `
  if !(env.constants.contains n) then
    return "RESULT:NOT_FOUND"`;
  return `
import Lean
${modules.map((m) => `import ${m}`).join("\n")}

open Lean Meta

#eval show CoreM String from do
  let env ← getEnv
  let n : Name := \`${target}${existence}
  let axs ← collectAxioms n
  if axs.contains \`sorryAx then
    return "RESULT:SORRY"
  let bad := axs.filter (fun a => ${whitelist})
  if !bad.isEmpty then
    return "RESULT:AXIOMS:" ++ String.intercalate "," (bad.toList.map toString)
  return "RESULT:NO_SORRY"

#eval show CoreM String from do
  let env ← getEnv
  let f : Name := \`${negationOf ?? target}
  if !(env.constants.contains f) then
    return "FP:NONE"
  return "FP:" ++ toString (env.constants.find! f).type.hash
`;
};

interface ParsedCheck {
  status:
    | "proved"
    | "unproved"
    | "not-found"
    | "not-found-base"
    | "statement-mismatch"
    | "bad-axioms"
    | "unknown";
  offenders: string[];
  hadSorryAx: boolean;
  fingerprint?: string;
}

function parseCheckOutput(output: string): ParsedCheck {
  const fp = output.match(/FP:([^\s"]+)/);
  const fingerprint = fp && fp[1] !== "NONE" ? fp[1] : undefined;
  const m = output.match(/RESULT:(NOT_FOUND_BASE|NOT_FOUND|NO_SORRY|SORRY|MISMATCH|AXIOMS:[^\s"]*)/);
  if (!m) return { status: "unknown", offenders: [], hadSorryAx: false, fingerprint };
  const tag = m[1];
  if (tag === "NOT_FOUND_BASE")
    return { status: "not-found-base", offenders: [], hadSorryAx: false, fingerprint };
  if (tag === "NOT_FOUND")
    return { status: "not-found", offenders: [], hadSorryAx: false, fingerprint };
  if (tag === "MISMATCH")
    return { status: "statement-mismatch", offenders: [], hadSorryAx: false, fingerprint };
  if (tag === "SORRY") return { status: "unproved", offenders: [], hadSorryAx: true, fingerprint };
  if (tag.startsWith("AXIOMS:")) {
    const offenders = tag
      .slice("AXIOMS:".length)
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean);
    return { status: "bad-axioms", offenders, hadSorryAx: false, fingerprint };
  }
  return { status: "proved", offenders: [], hadSorryAx: false, fingerprint };
}

/**
 * Verify ONE named declaration in the workspace:
 *  - `lake build` must succeed (whole project compiles so the declaration
 *    exists in the built modules),
 *  - the declaration must exist (NOT_FOUND otherwise),
 *  - with `opts.negationOf`, its type must be definitionally `¬ (base's type)`,
 *  - "unproved" if it still depends on `sorryAx`,
 *  - "bad-axioms" if it is sorry-free but leans on anything outside
 *    AXIOM_WHITELIST (e.g. the axiom `native_decide` generates),
 *  - "proved" otherwise.
 */
export async function verifyWorkspace(
  ws: DetectedWorkspace,
  theorem: string,
  opts: { negationOf?: string } = {},
): Promise<VerifyResult> {
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
  fs.writeFileSync(checkPath, CHECK_TEMPLATE(modules, theorem, opts.negationOf));
  try {
    const r = await runCommand(ws.root, "lake", ["env", "lean", checkPath]);
    const parsed = parseCheckOutput(r.all);
    const fingerprint = parsed.fingerprint;
    const base = opts.negationOf;
    const what = base ? `'${theorem}' (¬ ${base})` : `'${theorem}'`;
    if (parsed.status === "unknown") {
      return {
        status: "check-error",
        detail: r.all.slice(0, 4000) || `lean check produced no RESULT marker (exit ${r.code})`,
        offenders: [],
        hadSorryAx: false,
        fingerprint,
      };
    }
    if (parsed.status === "not-found-base") {
      return {
        status: "not-found-base",
        detail: `Base theorem '${base}' was not found in the built workspace, so '${theorem}' cannot be checked against it.`,
        offenders: [],
        hadSorryAx: false,
        fingerprint,
      };
    }
    if (parsed.status === "not-found") {
      return {
        status: "not-found",
        detail:
          `Theorem '${theorem}' was not found in the built workspace (no such declaration). ` +
          `Note that 'lake build' succeeds while ignoring a .lean file it does not build: a new ` +
          `file must be reachable from a lean_lib root (imported from it, or covered by its globs).`,
        offenders: [],
        hadSorryAx: false,
        fingerprint,
      };
    }
    if (parsed.status === "statement-mismatch") {
      return {
        status: "statement-mismatch",
        detail:
          `'${theorem}' exists but its statement is not definitionally 'Not (${base})'. ` +
          `Either the refutation targets a different (weaker) claim, or the two differ in ` +
          `universe levels / implicit binders. It does not count as a refutation of '${base}'.`,
        offenders: [theorem],
        hadSorryAx: false,
        fingerprint,
      };
    }
    if (parsed.status === "unproved") {
      return {
        status: "unproved",
        detail: `${what} still depends on 'sorryAx' (sorry/admit/gap not yet resolved).`,
        offenders: [theorem],
        hadSorryAx: true,
        fingerprint,
      };
    }
    if (parsed.status === "bad-axioms") {
      return {
        status: "bad-axioms",
        detail:
          `${what} is sorry-free but depends on non-standard axioms: ` +
          `${parsed.offenders.join(", ")}. Allowed: ${AXIOM_WHITELIST.join(", ")}. ` +
          `('native_decide' produces a per-declaration '<decl>._native.native_decide.ax_*' axiom; ` +
          `a hand-written 'axiom' shows up here too.)`,
        offenders: parsed.offenders,
        hadSorryAx: false,
        fingerprint,
      };
    }
    return {
      status: "proved",
      detail: `${what} builds sorry-free, with no axioms beyond ${AXIOM_WHITELIST.join(", ")}.`,
      offenders: [],
      hadSorryAx: false,
      fingerprint,
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
