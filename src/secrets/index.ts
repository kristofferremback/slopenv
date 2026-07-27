import { fail } from "../errors.ts";
import { MacosKeychainStore } from "./macos.ts";

/**
 * Where secret values live. Abstracted so a Linux `secret-tool` backend can drop
 * in later; there is deliberately no plaintext-file fallback, because silently
 * writing a secret to disk would be worse than failing.
 */
export interface SecretStore {
  /** Human name for error messages. */
  readonly kind: string;
  /** The stored value, or null if there is no entry. Throws on a real backend error. */
  get(dir: string, name: string): string | null;
  /** Store or replace, then verify the round-trip. */
  set(dir: string, name: string, value: string): void;
  /** Idempotent — removing an absent entry is not an error. */
  remove(dir: string, name: string): void;
}

/** Keychain account for a rule. Service is always `slopenv`. */
export function accountFor(dir: string, name: string): string {
  return `${dir}::${name}`;
}

export const SERVICE = "slopenv";

export function defaultSecretStore(platform: string = process.platform): SecretStore {
  if (platform === "darwin") return new MacosKeychainStore();
  return {
    kind: `unsupported:${platform}`,
    get() {
      return fail(`no keychain backend for this platform (${platform}) — only macOS is supported today`);
    },
    set() {
      return fail(`no keychain backend for this platform (${platform}) — only macOS is supported today`);
    },
    remove() {
      return fail(`no keychain backend for this platform (${platform}) — only macOS is supported today`);
    },
  };
}
