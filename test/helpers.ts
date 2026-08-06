import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.ts";
import { createContext, type Context } from "../src/context.ts";
import { MemorySecretStore } from "../src/secrets/memory.ts";

export function tempDir(prefix = "slopenv-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export interface Harness {
  ctx: Context;
  store: MemorySecretStore;
  stdout(): string;
  stderr(): string;
  reset(): void;
}

export function harness(options: {
  rulesPath: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdoutIsTty?: boolean;
}): Harness {
  let out = "";
  let err = "";
  const store = new MemorySecretStore();
  const ctx = createContext({
    rulesPath: options.rulesPath,
    cwd: options.cwd,
    env: options.env ?? {},
    // A test always captures stdout, so the default has to be false — otherwise
    // running the suite in a terminal and running it in CI test different code.
    stdoutIsTty: options.stdoutIsTty ?? false,
    store,
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
  });
  return {
    ctx,
    store,
    stdout: () => out,
    stderr: () => err,
    reset() {
      out = "";
      err = "";
    },
  };
}

/**
 * Split an emitted script into statements the way a shell parses it: on newlines
 * that are not inside single quotes. SLOPENV_DIRS and SLOPENV_MATCH both hold
 * newline-separated lists, so splitting on "\n" would tear them in half.
 */
export function splitStatements(script: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inQuote = false;

  for (let i = 0; i < script.length; i++) {
    const char = script[i] as string;
    if (!inQuote && char === "\\") {
      current += char + (script[i + 1] ?? "");
      i++;
      continue;
    }
    if (char === "'") {
      inQuote = !inQuote;
      current += char;
      continue;
    }
    if (char === "\n" && !inQuote) {
      if (current !== "") statements.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current !== "") statements.push(current);
  return statements;
}

/**
 * Apply emitted shell statements to a plain object, the way a shell would.
 * Deliberately does its own unquoting so a bug in `shellQuote` shows up as a
 * wrong value rather than being papered over by reusing the same helper.
 */
export function applyStatements(env: Record<string, string | undefined>, statements: readonly string[]): void {
  for (const statement of statements) {
    if (statement.startsWith("unset ")) {
      delete env[statement.slice("unset ".length)];
      continue;
    }
    const match = /^export ([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(statement);
    if (!match) throw new Error(`unrecognised statement: ${statement}`);
    const [, name, quoted] = match as unknown as [string, string, string];
    if (!quoted.startsWith("'") || !quoted.endsWith("'")) throw new Error(`value not single-quoted: ${statement}`);
    env[name] = quoted.slice(1, -1).split(`'\\''`).join("'");
  }
}

/** Run any command through the same async boundary as the real CLI entry point. */
export async function runAsync(argv: readonly string[], ctx: Context): Promise<number> {
  return await run(argv, ctx);
}

/** Keep purely synchronous command tests concise. */
export function runSync(argv: readonly string[], ctx: Context): number {
  const result = run(argv, ctx);
  if (typeof result !== "number") throw new Error(`${argv[0]} returned a promise; use runAsync in the test`);
  return result;
}
