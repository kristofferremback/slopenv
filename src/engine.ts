import { dirCovers, resolveRules } from "./match.ts";
import { effectiveRule, holdsValueInFile, type Rule } from "./rules.ts";
import { describeAge } from "./duration.ts";
import type { SecretStore } from "./secrets/index.ts";
import { exportStatement, unsetStatement } from "./shell.ts";
import { emptyState, type ActiveEntry, type State } from "./state.ts";

export interface PlanInput {
  rules: readonly Rule[];
  /** Absolute, symlink-resolved. */
  pwd: string;
  prevState: State;
  /** The shell's environment, used to remember a pre-existing value on activation. */
  env: Record<string, string | undefined>;
  store: SecretStore;
  /** Fingerprint of the rules file backing `rules`. */
  rev: string;
  /** Injected so the staleness check is testable. */
  now?: number;
}

export interface Plan {
  /** Shell statements, deactivations first. Safe to `eval` as a unit. */
  statements: string[];
  state: State;
  /** Non-fatal problems for stderr, e.g. a rule whose keychain entry is missing. */
  warnings: string[];
  /** The directory a pause was pinned to, on the run that ends it. */
  resumedFrom: string | null;
}

/**
 * A cached vault value that is past its refresh window.
 *
 * Deliberately a warning and not a refusal: the alternative is either blocking the
 * prompt on a network call or leaving you with no value at all, and both are worse
 * than an old token plus a line telling you it is old.
 */
function pullOverdue(rule: Rule, now: number): string | null {
  if (rule.ttl === undefined || rule.fetched === undefined) return null;
  const fetched = Date.parse(rule.fetched);
  if (Number.isNaN(fetched)) return null;
  if (now - fetched <= rule.ttl * 1000) return null;

  return (
    `${rule.name} (${rule.dir}) was pulled ${describeAge(rule.fetched, now)} and its refresh window has passed — ` +
    `using the cached value. Refresh it with: slopenv pull ${rule.name} ${rule.dir}`
  );
}

/**
 * Diff what should be active in `pwd` against what the shell says is active, and
 * emit only the difference.
 *
 * The state carries each active variable's winning rule directory and source, so
 * three distinct situations are told apart: nothing changed (emit nothing, and
 * crucially do not touch the keychain), the winning rule changed because a nested
 * directory overrides an ancestor (re-export), and the variable left scope
 * (restore whatever the shell had before slopenv, direnv-style).
 *
 * A pause (`slopenv off`) is a fourth situation, and it reuses the third: while it
 * holds nothing is desired, so everything active takes the ordinary leave-scope
 * path and the shell's own values come back. Leaving the paused directory ends it.
 */
export function computePlan(input: PlanInput): Plan {
  const { rules, pwd, prevState, env, store, rev } = input;
  const now = input.now ?? Date.now();

  // The pause is pinned to a directory rather than to the shell alone, so that
  // walking out of the project is enough to end it — the exit you cannot forget
  // to take, unlike `slopenv on`.
  const paused = prevState.paused !== null && dirCovers(prevState.paused, pwd) ? prevState.paused : null;
  const resumedFrom = prevState.paused !== null && paused === null ? prevState.paused : null;

  const desired = paused === null ? resolveRules(rules, pwd) : new Map<string, Rule>();
  const warnings: string[] = [];
  const nextActive: Record<string, ActiveEntry> = {};
  const activations: string[] = [];

  // A stale rev means the rules file changed under us (another terminal, or a
  // hand edit), so nothing cached can be trusted and everything is re-resolved.
  const revIsCurrent = prevState.rev === rev;

  for (const [name, rule] of [...desired].sort(([a], [b]) => a.localeCompare(b))) {
    const previous = prevState.active[name];
    const unchanged = revIsCurrent && previous !== undefined && previous.dir === rule.dir && previous.src === rule.source;

    if (unchanged) {
      // Already correct in this shell. No statement, and no keychain round-trip.
      nextActive[name] = previous;
      continue;
    }

    // A link holds no value of its own; the rule it points at does.
    const holder = effectiveRule(rules, rule);
    if (holder === undefined) {
      warnings.push(
        `${name} (${rule.dir}) links to ${rule.target}, where there is no rule for it — skipping. ` +
          `Fix it with: slopenv rm ${name} ${rule.dir}`,
      );
      continue;
    }

    let value: string | null;
    if (holdsValueInFile(holder)) {
      // In the rules file: a plain rule, or a vault reference you told to keep its
      // value in the open with `pull --plain`. Either way, no keychain round trip.
      value = holder.value ?? "";
      if (holder.source === "vault") {
        const overdue = pullOverdue(holder, now);
        if (overdue !== null) warnings.push(overdue);
      }
    } else {
      // A vault rule reads from the keychain like any other secret. The vault CLI
      // itself is never invoked here: it costs hundreds of milliseconds, needs the
      // network, and can raise a biometric prompt — none of which belongs on a
      // path that runs on every `cd`. `slopenv pull` is what fills this cache.
      value = store.get(holder.dir, name);
      if (value === null) {
        warnings.push(
          holder.source === "vault"
            ? `${name} (${holder.dir}) has no cached value yet — skipping. ` +
                `Pull it with: slopenv pull ${name} ${holder.dir}`
            : `no keychain entry for ${name} (${holder.dir}) — skipping. ` +
                `Re-add it with: slopenv set-secret ${name} ${holder.dir}`,
        );
        // Fall through to deactivation: better an honest unset than a stale value.
        continue;
      }
      if (holder.source === "vault") {
        const overdue = pullOverdue(holder, now);
        if (overdue !== null) warnings.push(overdue);
      }
    }

    // `prev` is only ever captured the first time we activate. Once we own the
    // variable, process.env holds *our* value, not the shell's original.
    const prev = previous !== undefined ? previous.prev : (env[name] ?? null);

    nextActive[name] = { prev, dir: rule.dir, src: rule.source };
    activations.push(exportStatement(name, value));
  }

  const deactivations: string[] = [];
  for (const name of Object.keys(prevState.active).sort()) {
    if (name in nextActive) continue;
    const entry = prevState.active[name];
    if (entry === undefined) continue;
    deactivations.push(entry.prev === null ? unsetStatement(name) : exportStatement(name, entry.prev));
  }

  return {
    statements: [...deactivations, ...activations],
    state: { ...emptyState(), rev, active: nextActive, paused },
    warnings,
    resumedFrom,
  };
}
