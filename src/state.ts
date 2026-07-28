import type { RuleSource } from "./rules.ts";
import { debug } from "./log.ts";
import { tilde } from "./paths.ts";

export const STATE_VAR = "SLOPENV_STATE";
export const STATE_VERSION = 1;

export interface ActiveEntry {
  /**
   * What the variable held before slopenv touched it, or null if the shell had no
   * value. Restored verbatim on leave, direnv-style.
   */
  prev: string | null;
  /** Directory of the rule that won, so a nested override is detected on entry. */
  dir: string;
  src: RuleSource;
}

export interface State {
  v: number;
  /** Fingerprint of the rules file when this state was computed. */
  rev: string;
  active: Record<string, ActiveEntry>;
  /**
   * Set by `slopenv off`: the directory the pause is pinned to, or null when
   * nothing is paused. While $PWD is inside it, nothing is injected; stepping
   * outside it ends the pause.
   *
   * Deliberately *not* a new state version. An older slopenv reading this ignores
   * the field and re-injects, which is the same thing it would do if the version
   * bump made it discard the state — except it also keeps every `prev`, so a
   * mid-session downgrade cannot lose the values it has to restore on leave.
   */
  paused: string | null;
}

/**
 * Is the shell hook wired into this shell? `export` is the only thing that sets
 * SLOPENV_STATE, so its absence means nothing is injecting anything.
 */
export function hookIsActive(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env[STATE_VAR]);
}

/**
 * The failure everyone hits first: the binary is installed, the rule is stored,
 * and nothing happens, because the one line that connects the two is missing.
 * Worth saying at the moment of confusion rather than only in `doctor`.
 */
export function hookInactiveNotice(): string {
  return (
    `slopenv: the shell hook is not active here, so nothing is being injected yet.\n` +
    `  Run this to wire up the shell you are in now:  eval "$(slopenv hook zsh)"\n` +
    `  Add the same line to ~/.zshrc to make it stick.\n`
  );
}

/**
 * Said on the way out of a paused directory. The point is that you asked for
 * something temporary and got it: nothing you have to remember to undo, and no
 * silent reversal either — you are told the moment it stops applying.
 */
export function pauseEndedNotice(dir: string): string {
  return `slopenv: env vars are on again — the pause ended when you left ${tilde(dir)}.\n`;
}

export function emptyState(): State {
  return { v: STATE_VERSION, rev: "", active: {}, paused: null };
}

/**
 * Base64 so the value is safe to pass through the environment and through
 * `export SLOPENV_STATE=...` without any quoting subtleties.
 */
export function encodeState(state: State): string {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64");
}

/**
 * Tolerant by design. State is a cache, not a source of truth: if it is missing or
 * corrupt we start from empty, which costs one extra keychain read and re-exports
 * whatever should be active. Refusing to run would be worse than rebuilding.
 */
export function decodeState(encoded: string | undefined): State {
  if (!encoded) return emptyState();

  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");

    const obj = parsed as Record<string, unknown>;
    if (obj.v !== STATE_VERSION) throw new Error(`unknown state version ${String(obj.v)}`);
    if (typeof obj.active !== "object" || obj.active === null) throw new Error("missing active map");

    const active: Record<string, ActiveEntry> = {};
    for (const [name, raw] of Object.entries(obj.active as Record<string, unknown>)) {
      if (typeof raw !== "object" || raw === null) continue;
      const entry = raw as Record<string, unknown>;
      const prev = entry.prev;
      const dir = entry.dir;
      const src = entry.src;
      if (prev !== null && typeof prev !== "string") continue;
      if (typeof dir !== "string") continue;
      if (src !== "keychain" && src !== "plain" && src !== "link" && src !== "vault") continue;
      active[name] = { prev, dir, src };
    }

    return {
      v: STATE_VERSION,
      rev: typeof obj.rev === "string" ? obj.rev : "",
      active,
      paused: typeof obj.paused === "string" && obj.paused !== "" ? obj.paused : null,
    };
  } catch (err) {
    debug(`discarding unreadable ${STATE_VAR}: ${(err as Error).message}`);
    return emptyState();
  }
}
