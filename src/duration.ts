import { fail } from "./errors.ts";

/**
 * Durations, for the one place slopenv has them: how old a cached vault value is
 * allowed to get before `export` mentions it. Kept away from the vault module so
 * that nothing on the hot path has to import the code that spawns a vault CLI.
 */

const DURATION = /^(\d+)\s*(s|m|h|d|w)?$/;
const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400, w: 604_800 };

/** `30d`, `12h`, `90` (seconds) -> seconds. */
export function parseDuration(input: string): number {
  const match = DURATION.exec(input.trim());
  if (!match) fail(`invalid duration ${JSON.stringify(input)} — expected something like 30d, 12h, 45m or 3600`);
  const amount = Number(match[1]);
  if (amount <= 0) fail(`invalid duration ${JSON.stringify(input)} — must be greater than zero`);
  return amount * (UNIT_SECONDS[match[2] ?? "s"] as number);
}

/** Seconds -> the shortest exact form, for printing back what was stored. */
export function formatDuration(seconds: number): string {
  for (const [unit, size] of [
    ["w", 604_800],
    ["d", 86_400],
    ["h", 3600],
    ["m", 60],
  ] as const) {
    if (seconds % size === 0) return `${seconds / size}${unit}`;
  }
  return `${seconds}s`;
}

/** How long ago, in words, for a human reading `list` or `doctor`. */
export function describeAge(fetchedIso: string, now: number): string {
  const then = Date.parse(fetchedIso);
  if (Number.isNaN(then)) return "at an unknown time";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}
