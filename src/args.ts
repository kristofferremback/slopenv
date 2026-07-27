import { fail } from "./errors.ts";

export interface ArgSpec {
  /** Flags that take a value: `--dir X` or `--dir=X`. */
  value?: readonly string[];
  /** Flags that are present or absent. */
  boolean?: readonly string[];
  /** Single-letter aliases, e.g. `{ y: "yes" }`. Not bundled: `-yf` is not `-y -f`. */
  short?: Readonly<Record<string, string>>;
}

export interface ParsedArgs {
  positional: string[];
  values: Record<string, string>;
  flags: Set<string>;
}

/**
 * Small hand-rolled parser — no dependency, and predictable about the one thing
 * that matters here: `--` stops flag parsing, so a value that looks like a flag
 * can always be passed.
 */
export function parseArgs(argv: readonly string[], spec: ArgSpec = {}): ParsedArgs {
  const valueFlags = new Set(spec.value ?? []);
  const boolFlags = new Set(spec.boolean ?? []);

  const positional: string[] = [];
  const values: Record<string, string> = {};
  const flags = new Set<string>();

  let i = 0;
  for (; i < argv.length; i++) {
    const arg = argv[i] as string;

    if (arg === "--") {
      i++;
      break;
    }

    // A single-dash token is only a flag if we recognise the letter. Anything
    // else — `-5`, a value that starts with a dash — stays a positional, which
    // is what it would have been before short flags existed.
    const shortName = arg.length === 2 && arg[0] === "-" && arg[1] !== "-" ? spec.short?.[arg[1] as string] : undefined;
    if (shortName !== undefined) {
      if (boolFlags.has(shortName)) {
        flags.add(shortName);
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined) fail(`-${arg[1]} needs a value`);
      values[shortName] = next;
      i++;
      continue;
    }

    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const eq = arg.indexOf("=");
    const name = (eq === -1 ? arg.slice(2) : arg.slice(2, eq)) as string;

    if (boolFlags.has(name)) {
      if (eq !== -1) fail(`--${name} does not take a value`);
      flags.add(name);
      continue;
    }

    if (valueFlags.has(name)) {
      if (eq !== -1) {
        values[name] = arg.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined) fail(`--${name} needs a value`);
      values[name] = next;
      i++;
      continue;
    }

    fail(`unknown flag --${name}`);
  }

  for (; i < argv.length; i++) positional.push(argv[i] as string);

  return { positional, values, flags };
}
