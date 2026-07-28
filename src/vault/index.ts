import { fail, SlopenvError } from "../errors.ts";
import { debug } from "../log.ts";

/**
 * Pulling values out of an external secret manager.
 *
 * Two rules shape everything here.
 *
 * **A reference, never a command.** What lands in rules.json is data — an engine
 * name and the vault's own reference string. slopenv builds the argument list
 * itself, from the table below, and there is no shell anywhere in the path. A
 * rules file cannot ask slopenv to run something of its choosing, which is what
 * storing a command string would have meant, on every `cd`, as you.
 *
 * **Never on the hot path.** `op read` costs 200–1000 ms, needs the network, and
 * pops a Touch ID dialog whenever the 1Password app has locked. `slopenv export`
 * runs on every `cd`, so it must never reach this module — it reads the cached
 * value out of the keychain like any other secret. Only `slopenv pull` comes here,
 * and only because you typed it.
 */

export interface VaultEngine {
  /** Stored in rules.json. Stable identifier, not a display name. */
  readonly id: string;
  readonly label: string;
  /** URI scheme of this vault's own reference format, without `://`. */
  readonly scheme: string;
  readonly binary: string;
  readonly install: string;
  /** Arguments after the binary. The reference is passed as one argv element. */
  args(ref: string): string[];
  /** Turn a recognised failure into advice. Unknown output is passed through as-is. */
  hint(stderr: string): string | null;
}

const ONEPASSWORD: VaultEngine = {
  id: "1password",
  label: "1Password",
  scheme: "op",
  binary: "op",
  install: "brew install 1password-cli",
  args(ref) {
    // No --no-newline: it is not in every `op` build, and a missing flag would be
    // an error rather than a fallback. The single trailing newline is trimmed by
    // the caller instead, which is what slopenv already does with piped values.
    return ["read", ref];
  },
  hint(stderr) {
    const text = stderr.toLowerCase();
    if (text.includes("not currently signed in") || text.includes("session expired")) {
      return `you are not signed in to 1Password. Sign in with:  eval $(op signin)`;
    }
    if (text.includes("connecting to desktop app") || text.includes("app integration")) {
      return (
        `the 1Password desktop app is not answering. Open it, unlock it, and turn on\n` +
        `  Settings -> Developer -> Integrate with 1Password CLI.`
      );
    }
    if (text.includes("authorization") && (text.includes("cancel") || text.includes("dismiss"))) {
      return `the 1Password approval prompt was dismissed — run the same command again to retry.`;
    }
    if (text.includes("isn't an item") || text.includes("doesn't exist") || text.includes("not found")) {
      return `check the reference. \`op item list\` shows what you have, and the item's ⌄ menu has "Copy Secret Reference".`;
    }
    return null;
  },
};

export const ENGINES: readonly VaultEngine[] = [ONEPASSWORD];

export function engineById(id: string): VaultEngine | undefined {
  return ENGINES.find((e) => e.id === id);
}

export function engineByScheme(scheme: string): VaultEngine | undefined {
  return ENGINES.find((e) => e.scheme === scheme);
}

/** `op://Work/Item/field` -> the 1Password engine. Unknown schemes are refused. */
export function engineForRef(ref: string): VaultEngine {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.+)$/.exec(ref);
  if (!match) {
    fail(
      `${JSON.stringify(ref)} is not a secret reference.\n` +
        `  Expected something like:  op://Work/Claude Code/credential\n` +
        `  In 1Password, the item's ⌄ menu has "Copy Secret Reference".`,
    );
  }

  const engine = engineByScheme(match[1] as string);
  if (!engine) {
    const known = ENGINES.map((e) => `${e.scheme}:// (${e.label})`).join(", ");
    fail(`no vault engine for ${JSON.stringify(`${match[1]}://`)} references — slopenv knows ${known}`);
  }
  return engine;
}

/**
 * How long to wait for the vault CLI. Generous, because the wait is usually you
 * deciding whether to touch the sensor. It exists so that a wedged `op` reports a
 * timeout rather than hanging a terminal until you notice.
 */
export const VAULT_TIMEOUT_MS = 120_000;

export interface ResolveOptions {
  /** Passed to the child, and used to find the binary — so tests can supply their own. */
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/**
 * Run the vault CLI and return the secret.
 *
 * Throws on anything short of a clean read. An empty value is a failure too: it
 * almost always means the reference points at a field that does not exist, and
 * caching an empty string would turn that into a variable that is silently blank
 * for weeks.
 */
export function resolveRef(engine: VaultEngine, ref: string, options: ResolveOptions): string {
  const found = Bun.which(engine.binary, { PATH: options.env.PATH ?? "" });
  if (!found) {
    fail(
      `${engine.binary} is not installed (needed for ${engine.label} references).\n` +
        `  Install it with:  ${engine.install}`,
    );
  }

  const args = engine.args(ref);
  debug(`vault: ${found} ${args.join(" ")}`);

  const proc = Bun.spawnSync([found, ...args], {
    // stdin stays open: `op` may need a terminal for a sign-in prompt. Nothing is
    // written to it — slopenv never feeds a vault CLI anything.
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
    env: options.env as Record<string, string>,
    timeout: options.timeoutMs ?? VAULT_TIMEOUT_MS,
  });

  if (proc.exitedDueToTimeout) {
    fail(`${engine.binary} did not answer within ${Math.round((options.timeoutMs ?? VAULT_TIMEOUT_MS) / 1000)}s — giving up rather than hanging.`);
  }

  const stderr = proc.stderr.toString();
  if (proc.exitCode !== 0) {
    const hint = engine.hint(stderr);
    const detail = stderr.trim() === "" ? `exit ${proc.exitCode}` : stderr.trim();
    throw new SlopenvError(
      `${engine.label} could not read ${ref}\n` +
        detail
          .split("\n")
          .map((line) => `  ${engine.binary}: ${line}`)
          .join("\n") +
        (hint ? `\n  ${hint}` : ""),
    );
  }

  const value = trimOneNewline(proc.stdout.toString());
  if (value === "") {
    fail(
      `${engine.label} returned an empty value for ${ref} — refusing to cache it.\n` +
        `  That usually means the field exists but is blank, or the reference names the wrong field.`,
    );
  }
  return value;
}

/**
 * Strip exactly one trailing newline, the one the CLI adds when it prints. Only
 * one, and nothing else: a secret is allowed to end in whitespace, and trimming
 * greedily would corrupt it in a way nobody would notice until it failed to
 * authenticate somewhere.
 */
export function trimOneNewline(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}
