import { parseArgs } from "../args.ts";
import type { Context } from "../context.ts";
import { matchingRules } from "../match.ts";
import { resolvePwd, tilde } from "../paths.ts";
import { loadRules, type Rule } from "../rules.ts";
import { decodeState, hookInactiveNotice, hookIsActive, STATE_VAR } from "../state.ts";
import { emitPlan } from "./export.ts";

/**
 * `slopenv off` / `slopenv on` — unload this shell's slopenv variables for a
 * while, without touching a single rule.
 *
 * The pause lives in SLOPENV_STATE, which is an environment variable, so it is
 * session-scoped by construction rather than by policy: another terminal has
 * never heard of it, and neither has the next one you open.
 *
 * It is pinned to a *directory*, not just to the shell, so that it ends by itself
 * when you walk out of the project. That is the exit you cannot forget to take —
 * unlike `slopenv on`, which you can.
 */

/**
 * The directory a pause is pinned to: the deepest rule directory covering `pwd`.
 *
 * Deepest rather than shallowest is a deliberate bias towards the pause ending too
 * early rather than too late. Ending early is visible and one word to undo; ending
 * late means standing in an unrelated repo with variables silently missing and
 * nothing to connect that to something you did an hour ago.
 */
export function pauseScope(rules: readonly Rule[], pwd: string): string | null {
  const deepest = matchingRules(rules, pwd)[0];
  return deepest === undefined ? null : deepest.dir;
}

/**
 * Both commands have to be evaluated by the shell to do anything at all, so refuse
 * clearly rather than print a screenful of `export` lines into a terminal.
 *
 * A TTY on stdout means nothing is capturing us, which means no shell function —
 * either the hook is not loaded, or it predates the wrapper.
 */
function refuseIfNotEvaluated(ctx: Context, command: string): number | null {
  if (!hookIsActive(ctx.env)) {
    ctx.err(hookInactiveNotice());
    return 1;
  }
  if (!ctx.stdoutIsTty) return null;

  const shell = (ctx.env.SHELL ?? "").endsWith("bash") ? "bash" : "zsh";
  ctx.err(
    `slopenv: \`${command}\` changes this shell, so it has to run through the shell function that the hook installs.\n` +
      `  This shell does not have that function. Load it here with:  eval "$(slopenv hook ${shell})"\n` +
      `  Nothing in your rc file needs changing — the function is new, the line is the same.\n`,
  );
  return 1;
}

/** Turn slopenv off in this shell until you say otherwise, or leave. */
export function cmdOff(argv: readonly string[], ctx: Context): number {
  const args = parseArgs(argv, {});
  const refusal = refuseIfNotEvaluated(ctx, "off");
  if (refusal !== null) return refusal;

  const pwd = resolvePwd(args.positional[0] ?? ctx.cwd);
  const state = decodeState(ctx.env[STATE_VAR]);

  if (state.paused !== null) {
    ctx.err(`slopenv: already off in this shell, since ${tilde(state.paused)}.\n`);
    ctx.err(`  turn it back on with:  slopenv on\n`);
    return 0;
  }

  const scope = pauseScope(loadRules(ctx.rulesPath).rules, pwd);
  if (scope === null) {
    ctx.err(`slopenv: no rules apply in ${tilde(pwd)}, so there is nothing to turn off.\n`);
    return 0;
  }

  // What is actually in the shell right now, which is what the plan will restore.
  const unloaded = Object.keys(state.active).sort();
  emitPlan(ctx, pwd, { ...state, paused: scope });

  ctx.err(
    unloaded.length > 0
      ? `slopenv: off in this shell — unloaded ${unloaded.join(", ")}.\n`
      : `slopenv: off in this shell — nothing was loaded here to unload.\n`,
  );
  ctx.err(`  back on when you leave ${tilde(scope)}, or now with:  slopenv on\n`);
  return 0;
}

/** Undo `slopenv off` without waiting to leave the directory. */
export function cmdOn(argv: readonly string[], ctx: Context): number {
  const args = parseArgs(argv, {});
  const refusal = refuseIfNotEvaluated(ctx, "on");
  if (refusal !== null) return refusal;

  const pwd = resolvePwd(args.positional[0] ?? ctx.cwd);
  const state = decodeState(ctx.env[STATE_VAR]);

  if (state.paused === null) {
    ctx.err(`slopenv: not off in this shell — nothing to turn back on.\n`);
    return 0;
  }

  const plan = emitPlan(ctx, pwd, { ...state, paused: null });
  const loaded = Object.keys(plan.state.active).sort();

  ctx.err(
    loaded.length > 0
      ? `slopenv: on again — ${loaded.join(", ")}.\n`
      : `slopenv: on again — no rules apply in ${tilde(pwd)}.\n`,
  );
  return 0;
}
