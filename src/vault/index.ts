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
 * **Never on the hot path.** Measured against `op` 2.35 on an M3 Pro: 6.1s for the
 * first read of a terminal session (that one includes approving it with a
 * fingerprint), then ~1.17s for every read after — it is a network round trip,
 * and it does not get cheaper. `slopenv export` runs on every `cd` and costs 42ms,
 * so it must never reach this module; it reads the cached value out of the
 * keychain like any other secret. Only `slopenv pull` comes here, because you
 * typed it.
 *
 * 1Password authorises per *terminal session* — terminal identity plus start time,
 * expiring after 10 minutes of inactivity and whenever the app locks — so a whole
 * `pull --all` costs one approval, not one per secret.
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

    // These four are quoted from `op` 2.35 rather than guessed at, and pinned by
    // a test, because a hint that fires on the wrong failure is worse than none.
    if (text.includes("invalid secret reference")) {
      return `a reference needs all three parts:  op://VAULT/ITEM/FIELD`;
    }
    if (text.includes("does not have a field")) {
      return `the item is there but the field is not. \`op item get "ITEM" --format json\` lists its fields.`;
    }
    if (text.includes("isn't a vault")) {
      return `\`op vault list\` shows the vaults this account can see.`;
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

/**
 * How many references to resolve at once.
 *
 * `op read` is ~1.2s of network round trip even fully warm, so the only way to
 * make many of them bearable is to overlap them. Four rather than "all of them"
 * because the far end is somebody's rate-limited API, and because the first
 * failure should not arrive alongside nineteen others.
 */
export const VAULT_CONCURRENCY = 4;

export interface ResolveOptions {
  /** Passed to the child, and used to find the binary — so tests can supply their own. */
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface Resolved {
  ref: string;
  /** Present when the read succeeded. */
  value?: string;
  /** Present when it did not. Already carries the CLI's own message and any advice. */
  error?: SlopenvError;
}

function locate(engine: VaultEngine, options: ResolveOptions): string {
  const found = Bun.which(engine.binary, { PATH: options.env.PATH ?? "" });
  if (!found) {
    fail(
      `${engine.binary} is not installed (needed for ${engine.label} references).\n` +
        `  Install it with:  ${engine.install}`,
    );
  }
  return found;
}

/**
 * One reference, one invocation of the vault CLI.
 *
 * `interactive` decides whether the child gets this terminal's stdin. The first
 * read of a run does, because it is the one that may have to talk to you — a
 * sign-in, or a biometric approval. The ones that follow do not, so that four
 * concurrent children cannot end up fighting over the same terminal.
 */
async function readOne(
  engine: VaultEngine,
  binary: string,
  ref: string,
  options: ResolveOptions,
  interactive: boolean,
): Promise<Resolved> {
  const args = engine.args(ref);
  const timeoutMs = options.timeoutMs ?? VAULT_TIMEOUT_MS;
  debug(`vault: ${binary} ${args.join(" ")}`);

  const started = Date.now();
  const proc = Bun.spawn([binary, ...args], {
    stdin: interactive ? "inherit" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: options.env as Record<string, string>,
    timeout: timeoutMs,
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  // Bun reports an async timeout as a signal rather than a flag, so the elapsed
  // time is what tells the two apart. Saying "killed" for a genuine external
  // SIGTERM would be wrong; saying "timed out" for one is merely imprecise.
  if (proc.signalCode !== null && Date.now() - started >= timeoutMs) {
    return {
      ref,
      error: new SlopenvError(
        `${engine.binary} did not answer within ${Math.round(timeoutMs / 1000)}s — giving up rather than hanging.`,
      ),
    };
  }

  if (exitCode !== 0) {
    const hint = engine.hint(stderr);
    const detail = stderr.trim() === "" ? `exit ${exitCode}` : stderr.trim();
    return {
      ref,
      error: new SlopenvError(
        `${engine.label} could not read ${ref}\n` +
          detail
            .split("\n")
            .map((line) => `  ${engine.binary}: ${line}`)
            .join("\n") +
          (hint ? `\n  ${hint}` : ""),
      ),
    };
  }

  const value = trimOneNewline(stdout);
  if (value === "") {
    return {
      ref,
      error: new SlopenvError(
        `${engine.label} returned an empty value for ${ref} — refusing to cache it.\n` +
          `  That usually means the field exists but is blank, or the reference names the wrong field.`,
      ),
    };
  }
  return { ref, value };
}

/**
 * Run the vault CLI and return the secret. Throws on anything short of a clean
 * read — an empty value included, because caching one would turn a wrong
 * reference into a variable that is silently blank for weeks.
 */
export async function resolveRef(engine: VaultEngine, ref: string, options: ResolveOptions): Promise<string> {
  const resolved = await readOne(engine, locate(engine, options), ref, options, true);
  if (resolved.error) throw resolved.error;
  return resolved.value as string;
}

/**
 * Resolve many references, overlapping the waiting.
 *
 * The first one runs alone. 1Password authorises per *terminal session*, so the
 * first read of a session is the one that may raise a biometric prompt, and
 * launching four of those at once would be a race over one dialog. Once it comes
 * back the session is authorised and the rest are just network latency, which
 * overlaps happily.
 *
 * Never throws: each reference gets its own result, so one bad reference cannot
 * cost you the nineteen good ones.
 */
export async function resolveMany(
  engine: VaultEngine,
  refs: readonly string[],
  options: ResolveOptions,
): Promise<Resolved[]> {
  if (refs.length === 0) return [];
  const binary = locate(engine, options);

  const results: Resolved[] = [await readOne(engine, binary, refs[0] as string, options, true)];

  const rest = refs.slice(1);
  for (let i = 0; i < rest.length; i += VAULT_CONCURRENCY) {
    const batch = rest.slice(i, i + VAULT_CONCURRENCY);
    results.push(...(await Promise.all(batch.map((ref) => readOne(engine, binary, ref, options, false)))));
  }
  return results;
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
