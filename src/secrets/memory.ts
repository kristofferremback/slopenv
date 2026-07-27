import { accountFor, type SecretStore } from "./index.ts";

/** In-memory SecretStore for tests. Records reads so tests can assert on caching. */
export class MemorySecretStore implements SecretStore {
  readonly kind = "memory";
  readonly entries = new Map<string, string>();
  readonly reads: string[] = [];

  constructor(initial: Record<string, string> = {}) {
    for (const [account, value] of Object.entries(initial)) this.entries.set(account, value);
  }

  get(dir: string, name: string): string | null {
    const account = accountFor(dir, name);
    this.reads.push(account);
    return this.entries.get(account) ?? null;
  }

  set(dir: string, name: string, value: string): void {
    this.entries.set(accountFor(dir, name), value);
  }

  remove(dir: string, name: string): void {
    this.entries.delete(accountFor(dir, name));
  }
}
