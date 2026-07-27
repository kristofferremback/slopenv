import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { fail } from "./errors.ts";
import { debug } from "./log.ts";

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_STALE_MS = 15_000;

export interface LockOptions {
  /** How long to wait for a competing writer before giving up. */
  timeoutMs?: number;
  /** A lock older than this whose owner is gone is broken rather than waited on. */
  staleMs?: number;
}

export function lockPathFor(target: string): string {
  return `${target}.lock`;
}

function ownerIsAlive(pid: number): boolean {
  try {
    // Signal 0 checks for existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A lock is stale if its owner died, or if it is simply too old to be credible
 * (which also covers a lock file we can't parse).
 */
function isStale(lockPath: string, staleMs: number): boolean {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch {
    // Vanished between our failed create and this read — someone released it.
    return false;
  }

  try {
    const parsed = JSON.parse(raw) as { pid?: number; ts?: number };
    if (typeof parsed.pid === "number" && !ownerIsAlive(parsed.pid)) {
      debug(`breaking lock ${lockPath}: owner pid ${parsed.pid} is gone`);
      return true;
    }
    if (typeof parsed.ts === "number" && Date.now() - parsed.ts > staleMs) {
      debug(`breaking lock ${lockPath}: held for >${staleMs}ms`);
      return true;
    }
    return false;
  } catch {
    try {
      const age = Date.now() - statSync(lockPath).mtimeMs;
      if (age > staleMs) {
        debug(`breaking lock ${lockPath}: unparseable and ${Math.round(age)}ms old`);
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }
}

/**
 * Run `fn` while holding an exclusive lock on `target`.
 *
 * The lock is an `O_EXCL` sibling file, which is atomic across processes on any
 * sane filesystem. This exists so that two terminals running `slopenv set` at the
 * same instant don't each read the old rules file and clobber one another —
 * read-modify-write has to be serialised, atomic rename alone is not enough.
 */
export function withLock<T>(target: string, fn: () => T, options: LockOptions = {}): T {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const lockPath = lockPathFor(target);
  const deadline = Date.now() + timeoutMs;

  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });

  let fd: number | undefined;
  for (;;) {
    try {
      fd = openSync(lockPath, "wx", 0o600);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

      if (isStale(lockPath, staleMs)) {
        try {
          unlinkSync(lockPath);
        } catch {
          // Another process broke it first; that's fine, we just retry.
        }
      }

      if (Date.now() >= deadline) {
        fail(
          `another slopenv process is writing ${target} — timed out after ${timeoutMs}ms.\n` +
            `  If no other slopenv is running, remove the stale lock: rm ${lockPath}`,
        );
      }

      // Jittered backoff so competing writers don't retry in lockstep.
      Bun.sleepSync(2 + Math.floor(Math.random() * 8));
    }
  }

  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
  } catch {
    // The lock's contents are only an optimisation for stale detection.
  }

  try {
    return fn();
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
    try {
      unlinkSync(lockPath);
    } catch {
      /* already gone */
    }
  }
}
