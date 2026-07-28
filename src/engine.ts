import { resolveRules } from "./match.ts";
import { effectiveRule, type Rule } from "./rules.ts";
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
}

export interface Plan {
  /** Shell statements, deactivations first. Safe to `eval` as a unit. */
  statements: string[];
  state: State;
  /** Non-fatal problems for stderr, e.g. a rule whose keychain entry is missing. */
  warnings: string[];
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
 */
export function computePlan(input: PlanInput): Plan {
  const { rules, pwd, prevState, env, store, rev } = input;

  const desired = resolveRules(rules, pwd);
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
    if (holder.source === "plain") {
      value = holder.value ?? "";
    } else {
      value = store.get(holder.dir, name);
      if (value === null) {
        warnings.push(
          `no keychain entry for ${name} (${holder.dir}) — skipping. ` +
            `Re-add it with: slopenv set-secret ${name} ${holder.dir}`,
        );
        // Fall through to deactivation: better an honest unset than a stale value.
        continue;
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
    state: { ...emptyState(), rev, active: nextActive },
    warnings,
  };
}
