import { describe, expect, test } from "bun:test";
import { MacosKeychainStore, parseSecurityPassword, quoteForSecurityStdin } from "../src/secrets/macos.ts";
import { LinuxSecretServiceStore, type BunSecretsApi } from "../src/secrets/linux.ts";
import { accountFor, defaultSecretStore } from "../src/secrets/index.ts";

/**
 * The strings below are real output captured from `security find-generic-password
 * -g` on macOS 14. `security` switches to a hex form for anything that would need
 * escaping, which is the entire reason reads go through `-g` rather than `-w`:
 * `-w` prints the same hex bare and unprefixed, indistinguishable from a secret
 * that happens to look like hex.
 */
describe("parseSecurityPassword", () => {
  test("reads the plain quoted form", () => {
    expect(parseSecurityPassword(`password: "plain-ascii-token"\nkeychain: "/x/login.keychain-db"\n`)).toBe(
      "plain-ascii-token",
    );
  });

  test("prefers the hex form when security escapes the value", () => {
    expect(parseSecurityPassword(`password: 0x68C3A96C6C6F2D77C3B6726C64  "h\\303\\251llo-w\\303\\266rld"\n`)).toBe(
      "héllo-wörld",
    );
  });

  test("recovers values containing quotes and backslashes", () => {
    // 'a"b\c' — the quoted rendering is ambiguous, the hex is not.
    expect(parseSecurityPassword(`password: 0x6122625C63  "a"b\\134c"\n`)).toBe('a"b\\c');
  });

  test("recovers control characters", () => {
    expect(parseSecurityPassword(`password: 0x610A62  "a\\012b"\n`)).toBe("a\nb");
    expect(parseSecurityPassword(`password: 0x610962  "a\\011b"\n`)).toBe("a\tb");
  });

  test("keeps significant whitespace", () => {
    expect(parseSecurityPassword(`password: "  padded  "\n`)).toBe("  padded  ");
  });

  test("handles a single quote, which needs no escaping", () => {
    expect(parseSecurityPassword(`password: "it's"\n`)).toBe("it's");
  });

  test("handles an empty stored value", () => {
    expect(parseSecurityPassword(`password: ""\n`)).toBe("");
  });

  test("returns null when there is no password line", () => {
    expect(parseSecurityPassword(`security: SecKeychainSearchCopyNext: The specified item could not be found.\n`)).toBe(
      null,
    );
    expect(parseSecurityPassword("")).toBe(null);
  });
});

describe("quoteForSecurityStdin", () => {
  test("escapes the two characters the security -i tokeniser cares about", () => {
    expect(quoteForSecurityStdin("plain")).toBe('"plain"');
    expect(quoteForSecurityStdin('a"b')).toBe('"a\\"b"');
    expect(quoteForSecurityStdin("a\\b")).toBe('"a\\\\b"');
    expect(quoteForSecurityStdin("$HOME `x` 'y'")).toBe(`"$HOME \`x\` 'y'"`);
  });
});

describe("account naming", () => {
  test("scopes the entry to the directory as well as the variable", () => {
    expect(accountFor("/dev/threa", "TOKEN")).toBe("/dev/threa::TOKEN");
  });

  test("the same variable in two directories is two entries", () => {
    expect(accountFor("/dev/a", "TOKEN")).not.toBe(accountFor("/dev/b", "TOKEN"));
  });
});

describe("platform gate", () => {
  test("an unsupported platform fails clearly instead of falling back to disk", () => {
    const store = defaultSecretStore("freebsd");
    expect(() => store.get("/a", "T")).toThrow(/no secret-store backend/);
    expect(() => store.set("/a", "T", "v")).toThrow(/no secret-store backend/);
    expect(() => store.remove("/a", "T")).toThrow(/no secret-store backend/);
  });

  test("macOS gets the keychain store", () => {
    expect(defaultSecretStore("darwin").kind).toBe("macos-keychain");
  });

  test("Linux gets the Secret Service store", () => {
    expect(defaultSecretStore("linux").kind).toBe("linux-secret-service");
  });
});

class FakeBunSecrets implements BunSecretsApi {
  readonly entries = new Map<string, string>();
  failWith: Error | undefined;

  async get(options: { service: string; name: string }): Promise<string | null> {
    if (this.failWith) throw this.failWith;
    return this.entries.get(`${options.service}:${options.name}`) ?? null;
  }

  async set(options: { service: string; name: string; value: string }): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.entries.set(`${options.service}:${options.name}`, options.value);
  }

  async delete(options: { service: string; name: string }): Promise<boolean> {
    if (this.failWith) throw this.failWith;
    return this.entries.delete(`${options.service}:${options.name}`);
  }
}

describe("Linux Secret Service", () => {
  test("round-trips, replaces, and removes through Bun.secrets", async () => {
    const api = new FakeBunSecrets();
    const store = new LinuxSecretServiceStore(api);

    expect(await store.get("/dev/a", "TOKEN")).toBeNull();
    await store.set("/dev/a", "TOKEN", "first");
    expect(await store.get("/dev/a", "TOKEN")).toBe("first");
    await store.set("/dev/a", "TOKEN", "second");
    expect(await store.get("/dev/a", "TOKEN")).toBe("second");
    await store.remove("/dev/a", "TOKEN");
    expect(await store.get("/dev/a", "TOKEN")).toBeNull();
    await store.remove("/dev/a", "TOKEN");
  });

  test("identifies a missing Secret Service with setup advice", async () => {
    const api = new FakeBunSecrets();
    api.failWith = new Error("The name org.freedesktop.secrets was not provided by any .service files");
    const store = new LinuxSecretServiceStore(api);

    await expect(store.get("/a", "TOKEN")).rejects.toThrow(/Install and start GNOME Keyring, KWallet/);
  });

  test("explains how to initialize a missing login collection", async () => {
    const api = new FakeBunSecrets();
    api.failWith = new Error("Object does not exist at path /org/freedesktop/secrets/collection/login");
    const store = new LinuxSecretServiceStore(api);

    await expect(store.set("/a", "TOKEN", "v")).rejects.toThrow(/log out and back in/);
  });
});

const linuxIntegration = process.env.SLOPENV_SECRET_STORE_IT === "1" && process.platform === "linux";
describe.if(linuxIntegration)("Linux Secret Service (integration)", () => {
  test("round-trips through the session's real provider", async () => {
    const store = new LinuxSecretServiceStore();
    const dir = `/tmp/slopenv-integration-${process.pid}`;
    const name = "SLOPENV_IT_TOKEN";
    const value = `quotes-'\"-unicode-🔑-${Date.now()}`;
    try {
      await store.set(dir, name, value);
      expect(await store.get(dir, name)).toBe(value);
    } finally {
      await store.remove(dir, name);
    }
    expect(await store.get(dir, name)).toBeNull();
  });
});

/**
 * Touches the real login keychain, so it only runs on request:
 *   SLOPENV_KEYCHAIN_IT=1 bun test
 */
const integration = process.env.SLOPENV_KEYCHAIN_IT === "1" && process.platform === "darwin";
describe.if(integration)("macOS keychain (integration)", () => {
  const store = new MacosKeychainStore();
  const dir = "/tmp/slopenv-integration-test";

  const values: Record<string, string> = {
    typical: "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789",
    long: `sk-${"x".repeat(600)}`,
    quotes: `a"b'c\`d$e`,
    backslashes: "a\\b\\\\c",
    unicode: "héllo-wörld-日本-🔑",
    spaces: "  padded value  ",
    newlines: "-----BEGIN KEY-----\nline2\nline3\n-----END KEY-----",
    tabs: "a\tb",
  };

  for (const [label, value] of Object.entries(values)) {
    test(`round-trips ${label}`, () => {
      const name = `SLOPENV_IT_${label.toUpperCase()}`;
      try {
        store.set(dir, name, value);
        expect(store.get(dir, name)).toBe(value);
      } finally {
        store.remove(dir, name);
      }
    });
  }

  test("a missing entry reads as null, and deleting it is not an error", () => {
    expect(store.get(dir, "SLOPENV_IT_ABSENT")).toBe(null);
    expect(() => store.remove(dir, "SLOPENV_IT_ABSENT")).not.toThrow();
  });

  test("set replaces an existing value", () => {
    const name = "SLOPENV_IT_REPLACE";
    try {
      store.set(dir, name, "first");
      store.set(dir, name, "second");
      expect(store.get(dir, name)).toBe("second");
    } finally {
      store.remove(dir, name);
    }
  });
});
