import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fail } from "./errors.ts";

export const HOME_DIR_NAME = ".slopenv";

/** Everything slopenv owns lives here: `~/.slopenv`. */
export function slopenvHome(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME || homedir(), HOME_DIR_NAME);
}

/**
 * Where the rules file lives: `~/.slopenv/rules.json`, or wherever
 * `$SLOPENV_CONFIG` points if it is set.
 */
export function rulesFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.SLOPENV_CONFIG;
  if (override) return resolve(override);
  return join(slopenvHome(env), "rules.json");
}

/**
 * Where rules.json used to live. Kept only so that an existing file can be
 * pointed out rather than silently ignored — slopenv never reads or moves it.
 */
export function legacyRulesFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(env.HOME || homedir(), ".config");
  return join(base, "slopenv", "rules.json");
}

/**
 * Strip a trailing slash so `/a/b/` and `/a/b` are the same rule. Root stays `/`.
 */
export function normalizeDir(dir: string): string {
  if (dir.length > 1 && dir.endsWith("/")) return normalizeDir(dir.slice(0, -1));
  return dir;
}

/**
 * Resolve a user-supplied directory to the absolute, symlink-free form we store
 * in rules.json. Refuses to invent a rule for a directory that isn't there —
 * a typo'd path should be an error, not a rule that silently never matches.
 *
 * `mustExist: false` is for removal, where the whole point may be that the
 * directory is gone and its rule is now dead weight.
 */
export function resolveRuleDir(
  input: string,
  cwd: string = process.cwd(),
  { mustExist = true }: { mustExist?: boolean } = {},
): string {
  const absolute = isAbsolute(input) ? input : resolve(cwd, input);
  let real: string;
  try {
    real = realpathSync(absolute);
  } catch {
    if (mustExist) fail(`directory does not exist: ${absolute}`);
    return normalizeDir(absolute);
  }

  // realpath is happy with a file. A rule scoped to a file would simply never
  // match anything, so refuse it rather than store something inert.
  if (mustExist && !isDirectory(real)) fail(`not a directory: ${absolute}`);
  return normalizeDir(real);
}

/** True only for an existing directory (or a symlink to one). */
export function isDirectory(path: string, cwd: string = process.cwd()): boolean {
  try {
    return statSync(isAbsolute(path) ? path : resolve(cwd, path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve $PWD on the hot path. Unlike `resolveRuleDir` this never throws: if the
 * shell is sitting in a deleted directory we still want a clean, empty export
 * rather than a broken hook.
 */
export function resolvePwd(input: string): string {
  try {
    return normalizeDir(realpathSync(isAbsolute(input) ? input : resolve(input)));
  } catch {
    return normalizeDir(isAbsolute(input) ? input : resolve(input));
  }
}
