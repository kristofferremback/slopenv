import { fail } from "../errors.ts";
import { debug } from "../log.ts";
import { accountFor, SERVICE, type SecretStore } from "./index.ts";

const SECURITY = "/usr/bin/security";

/**
 * Read output of `security find-generic-password -g`, which puts the password on
 * stderr in one of two shapes:
 *
 *   password: "plain-ascii-value"
 *   password: 0x68C3A96C6C6F  "h\303\251llo"
 *
 * The hex form appears for anything that would need escaping — non-ASCII, control
 * characters, quotes, backslashes — so when it is present it is authoritative, and
 * when it is absent the quoted form is guaranteed to contain no escapes.
 *
 * This is why reads use `-g` and not `-w`: `-w` prints bare, unprefixed lowercase
 * hex for those same values, which is indistinguishable from a secret that just
 * happens to look like hex.
 */
export function parseSecurityPassword(stderr: string): string | null {
  for (const line of stderr.split("\n")) {
    const hex = /^password: 0x([0-9A-Fa-f]*)\s/.exec(line);
    if (hex) return Buffer.from(hex[1] ?? "", "hex").toString("utf8");

    const literal = /^password: "([\s\S]*)"$/.exec(line);
    if (literal) return literal[1] ?? "";
  }
  return null;
}

function isNotFound(stderr: string): boolean {
  return stderr.includes("could not be found") || stderr.includes("SecKeychainSearchCopyNext");
}

/** Quote a token for `security -i`, whose tokeniser understands \\ and \". */
export function quoteForSecurityStdin(value: string): string {
  return `"${value.split("\\").join("\\\\").split('"').join('\\"')}"`;
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], stdin?: string): RunResult {
  const proc = Bun.spawnSync([SECURITY, ...args], {
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    status: proc.exitCode ?? -1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

export class MacosKeychainStore implements SecretStore {
  readonly kind = "macos-keychain";

  get(dir: string, name: string): string | null {
    const account = accountFor(dir, name);
    const result = run(["find-generic-password", "-g", "-s", SERVICE, "-a", account]);

    if (result.status !== 0) {
      if (isNotFound(result.stderr)) {
        debug(`keychain miss for ${account}`);
        return null;
      }
      fail(`keychain read failed for ${name} (${dir}): ${firstLine(result.stderr) || `exit ${result.status}`}`);
    }

    const value = parseSecurityPassword(result.stderr);
    if (value === null) {
      fail(`could not parse keychain output for ${name} (${dir}) — unexpected \`security\` format`);
    }
    debug(`keychain hit for ${account}`);
    return value;
  }

  set(dir: string, name: string, value: string): void {
    const account = accountFor(dir, name);

    // Preferred path: the value goes in on stdin, so it never appears in this
    // process's argv (where `ps` could see it). `security -i` is line-based, so a
    // value containing a newline has to fall back to argv.
    const canUseStdin = !/[\n\r]/.test(value);
    if (canUseStdin) {
      this.#writeViaStdin(account, dir, name, value);
      if (this.get(dir, name) === value) return;
      debug(`stdin write for ${account} did not round-trip; retrying via argv`);
    }

    this.#writeViaArgv(account, dir, name, value);

    // Never trust a write we did not read back — a silently mangled secret is the
    // one failure mode that would be invisible until something else broke.
    if (this.get(dir, name) !== value) {
      fail(
        `keychain refused to store ${name} (${dir}) exactly — the value read back does not match what was written. ` +
          `The entry may now be wrong; remove it with: slopenv rm ${name} ${dir}`,
      );
    }
  }

  remove(dir: string, name: string): void {
    const account = accountFor(dir, name);
    const result = run(["delete-generic-password", "-s", SERVICE, "-a", account]);
    if (result.status !== 0 && !isNotFound(result.stderr)) {
      fail(`keychain delete failed for ${name} (${dir}): ${firstLine(result.stderr) || `exit ${result.status}`}`);
    }
  }

  #label(dir: string, name: string): string {
    return `slopenv: ${name} (${dir})`;
  }

  #writeViaStdin(account: string, dir: string, name: string, value: string): void {
    const q = quoteForSecurityStdin;
    const command =
      `add-generic-password -U -s ${q(SERVICE)} -a ${q(account)} ` +
      `-l ${q(this.#label(dir, name))} -D ${q("slopenv environment variable")} -w ${q(value)}\n`;
    run(["-i"], command);
  }

  #writeViaArgv(account: string, dir: string, name: string, value: string): void {
    const result = run([
      "add-generic-password",
      "-U",
      "-s",
      SERVICE,
      "-a",
      account,
      "-l",
      this.#label(dir, name),
      "-D",
      "slopenv environment variable",
      "-w",
      value,
    ]);
    if (result.status !== 0) {
      fail(`keychain write failed for ${name} (${dir}): ${firstLine(result.stderr) || `exit ${result.status}`}`);
    }
  }
}

function firstLine(text: string): string {
  return text.split("\n")[0]?.trim() ?? "";
}
