import { fail } from "../errors.ts";
import { debug } from "../log.ts";
import { accountFor, SERVICE, type SecretStore } from "./index.ts";

/** The small part of Bun.secrets used here, injectable so the backend is testable. */
export interface BunSecretsApi {
  get(options: { service: string; name: string }): Promise<string | null>;
  set(options: { service: string; name: string; value: string }): Promise<void>;
  delete(options: { service: string; name: string }): Promise<boolean>;
}

function detail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function backendHint(message: string): string {
  if (
    message.includes("org.freedesktop.secrets") ||
    message.includes("Secret Service") ||
    message.includes("secret service")
  ) {
    return (
      "no Secret Service is available in this session. Install and start GNOME Keyring, " +
      "KWallet, or enable KeePassXC's Secret Service integration"
    );
  }
  if (message.includes("Object does not exist") || message.includes("collection/login")) {
    return (
      "the default Secret Service collection does not exist or is not unlocked. " +
      "After installing GNOME Keyring, log out and back in so the login keyring is created and unlocked"
    );
  }
  return message;
}

/** Linux Secret Service backend, accessed through Bun's libsecret integration. */
export class LinuxSecretServiceStore implements SecretStore {
  readonly kind = "linux-secret-service";

  constructor(private readonly secrets: BunSecretsApi = Bun.secrets) {}

  async get(dir: string, name: string): Promise<string | null> {
    const account = accountFor(dir, name);
    try {
      const value = await this.secrets.get({ service: SERVICE, name: account });
      debug(`secret service ${value === null ? "miss" : "hit"} for ${account}`);
      return value;
    } catch (err) {
      return fail(`secret store read failed for ${name} (${dir}): ${backendHint(detail(err))}`);
    }
  }

  async set(dir: string, name: string, value: string): Promise<void> {
    const account = accountFor(dir, name);
    try {
      await this.secrets.set({ service: SERVICE, name: account, value });
    } catch (err) {
      fail(`secret store write failed for ${name} (${dir}): ${backendHint(detail(err))}`);
    }

    // A successful API call is not enough: never leave a rule pointing at a
    // silently truncated or otherwise altered value.
    if ((await this.get(dir, name)) !== value) {
      fail(
        `secret store refused to store ${name} (${dir}) exactly — the value read back does not match what was written. ` +
          `The entry may now be wrong; remove it with: slopenv rm ${name} ${dir}`,
      );
    }
  }

  async remove(dir: string, name: string): Promise<void> {
    const account = accountFor(dir, name);
    try {
      // False means it was already absent, which is the idempotent result wanted.
      await this.secrets.delete({ service: SERVICE, name: account });
    } catch (err) {
      fail(`secret store delete failed for ${name} (${dir}): ${backendHint(detail(err))}`);
    }
  }
}
