import { fail } from "../errors.ts";
import { LinuxSecretServiceStore } from "./linux.ts";
import { MacosKeychainStore } from "./macos.ts";

/**
 * Where secret values live: `/usr/bin/security` on macOS and Bun's libsecret
 * integration on Linux. There is deliberately no plaintext-file fallback,
 * because silently writing a secret to disk would be worse than failing.
 */
export interface SecretStore {
  /** Human name for error messages. */
  readonly kind: string;
  /** The stored value, or null if there is no entry. Throws on a real backend error. */
  get(dir: string, name: string): string | null | Promise<string | null>;
  /** Store or replace, then verify the round-trip. */
  set(dir: string, name: string, value: string): void | Promise<void>;
  /** Idempotent — removing an absent entry is not an error. */
  remove(dir: string, name: string): void | Promise<void>;
}

/** Secret-store account for a rule. Service is always `slopenv`. */
export function accountFor(dir: string, name: string): string {
  return `${dir}::${name}`;
}

export const SERVICE = "slopenv";

export function defaultSecretStore(platform: string = process.platform): SecretStore {
  if (platform === "darwin") return new MacosKeychainStore();
  if (platform === "linux") return new LinuxSecretServiceStore();
  return {
    kind: `unsupported:${platform}`,
    get() {
      return fail(`no secret-store backend for this platform (${platform}) — macOS and Linux are supported`);
    },
    set() {
      return fail(`no secret-store backend for this platform (${platform}) — macOS and Linux are supported`);
    },
    remove() {
      return fail(`no secret-store backend for this platform (${platform}) — macOS and Linux are supported`);
    },
  };
}
