import { beforeEach, describe, expect, test } from "bun:test";
import { computePlan } from "../src/engine.ts";
import type { Rule } from "../src/rules.ts";
import { MemorySecretStore } from "../src/secrets/memory.ts";
import { accountFor } from "../src/secrets/index.ts";
import { decodeState, emptyState, encodeState, STATE_VAR, type State } from "../src/state.ts";
import { applyStatements } from "./helpers.ts";

const WORK = "/dev/threa";
const APPS = "/dev/threa/apps";

function plain(dir: string, name: string, value: string): Rule {
  return { dir, name, source: "plain", value };
}
function secret(dir: string, name: string): Rule {
  return { dir, name, source: "keychain" };
}

/**
 * A tiny shell: holds an environment, and `cd` runs the same plan/apply cycle the
 * real hook does, threading SLOPENV_STATE through exactly as the shell would.
 */
class FakeShell {
  env: Record<string, string | undefined> = {};
  lastStatements: string[] = [];
  lastWarnings: string[] = [];

  constructor(
    private rules: Rule[],
    private store: MemorySecretStore,
    private rev = "rev-1",
  ) {}

  setRules(rules: Rule[], rev: string): void {
    this.rules = rules;
    this.rev = rev;
  }

  cd(pwd: string): void {
    const plan = computePlan({
      rules: this.rules,
      pwd,
      prevState: decodeState(this.env[STATE_VAR]),
      env: this.env,
      store: this.store,
      rev: this.rev,
    });
    this.lastStatements = plan.statements;
    this.lastWarnings = plan.warnings;
    applyStatements(this.env, plan.statements);
    this.env[STATE_VAR] = encodeState(plan.state);
  }

  get state(): State {
    return decodeState(this.env[STATE_VAR]);
  }
}

describe("inject and eject", () => {
  let store: MemorySecretStore;

  beforeEach(() => {
    store = new MemorySecretStore({ [accountFor(WORK, "TOKEN")]: "work-token" });
  });

  test("entering exports, leaving unsets", () => {
    const shell = new FakeShell([secret(WORK, "TOKEN")], store);

    shell.cd("/dev");
    expect(shell.env.TOKEN).toBeUndefined();

    shell.cd(WORK);
    expect(shell.env.TOKEN).toBe("work-token");

    shell.cd("/dev");
    expect(shell.env.TOKEN).toBeUndefined();
    expect(shell.lastStatements).toEqual(["unset TOKEN"]);
  });

  test("a subdirectory inherits without re-reading the keychain", () => {
    const shell = new FakeShell([secret(WORK, "TOKEN")], store);

    shell.cd(WORK);
    expect(store.reads.length).toBe(1);

    shell.cd(APPS);
    expect(shell.env.TOKEN).toBe("work-token");
    expect(shell.lastStatements).toEqual([]);
    // The whole point of caching in SLOPENV_STATE: no keychain call on this cd.
    expect(store.reads.length).toBe(1);

    shell.cd(`${APPS}/web/src`);
    expect(store.reads.length).toBe(1);
  });

  test("re-entering after leaving reads the keychain again", () => {
    const shell = new FakeShell([secret(WORK, "TOKEN")], store);
    shell.cd(WORK);
    shell.cd("/dev");
    shell.cd(WORK);
    expect(shell.env.TOKEN).toBe("work-token");
    expect(store.reads.length).toBe(2);
  });

  test("a nested rule overrides its ancestor, and the ancestor comes back on the way out", () => {
    store.set(APPS, "TOKEN", "apps-token");
    const shell = new FakeShell([secret(WORK, "TOKEN"), secret(APPS, "TOKEN")], store);

    shell.cd(WORK);
    expect(shell.env.TOKEN).toBe("work-token");

    shell.cd(APPS);
    expect(shell.env.TOKEN).toBe("apps-token");
    expect(shell.state.active.TOKEN?.dir).toBe(APPS);

    shell.cd(WORK);
    expect(shell.env.TOKEN).toBe("work-token");

    shell.cd("/dev");
    expect(shell.env.TOKEN).toBeUndefined();
  });

  test("a pre-existing shell value is remembered and restored on leave", () => {
    const shell = new FakeShell([secret(WORK, "TOKEN")], store);
    shell.env.TOKEN = "value-from-my-zshrc";

    shell.cd(WORK);
    expect(shell.env.TOKEN).toBe("work-token");
    expect(shell.state.active.TOKEN?.prev).toBe("value-from-my-zshrc");

    shell.cd(APPS);
    // Still ours; the remembered original must not be overwritten with our value.
    expect(shell.state.active.TOKEN?.prev).toBe("value-from-my-zshrc");

    shell.cd("/dev");
    expect(shell.env.TOKEN).toBe("value-from-my-zshrc");
    expect(shell.lastStatements).toEqual([`export TOKEN='value-from-my-zshrc'`]);
  });

  test("the pre-existing value survives a nested override", () => {
    store.set(APPS, "TOKEN", "apps-token");
    const shell = new FakeShell([secret(WORK, "TOKEN"), secret(APPS, "TOKEN")], store);
    shell.env.TOKEN = "original";

    shell.cd(WORK);
    shell.cd(APPS);
    expect(shell.env.TOKEN).toBe("apps-token");
    shell.cd("/tmp");
    expect(shell.env.TOKEN).toBe("original");
  });

  test("an empty pre-existing value is not confused with an absent one", () => {
    const shell = new FakeShell([secret(WORK, "TOKEN")], store);
    shell.env.TOKEN = "";

    shell.cd(WORK);
    expect(shell.state.active.TOKEN?.prev).toBe("");
    shell.cd("/dev");
    expect(shell.env.TOKEN).toBe("");
    expect(shell.lastStatements).toEqual([`export TOKEN=''`]);
  });

  test("several variables activate and deactivate independently", () => {
    const shell = new FakeShell(
      [secret(WORK, "TOKEN"), plain(WORK, "NODE_ENV", "development"), plain(APPS, "PORT", "3000")],
      store,
    );

    shell.cd(WORK);
    expect(shell.env.TOKEN).toBe("work-token");
    expect(shell.env.NODE_ENV).toBe("development");
    expect(shell.env.PORT).toBeUndefined();

    shell.cd(APPS);
    expect(shell.lastStatements).toEqual([`export PORT='3000'`]);

    shell.cd("/dev");
    expect(shell.lastStatements).toEqual(["unset NODE_ENV", "unset PORT", "unset TOKEN"]);
  });
});

describe("keychain misses", () => {
  test("a rule with no keychain entry warns and is skipped, not left half-applied", () => {
    const store = new MemorySecretStore();
    const shell = new FakeShell([secret(WORK, "TOKEN")], store);

    shell.cd(WORK);
    expect(shell.env.TOKEN).toBeUndefined();
    expect(shell.lastStatements).toEqual([]);
    expect(shell.lastWarnings[0]).toContain("no keychain entry for TOKEN");
  });

  test("a secret that disappears while active is ejected rather than left stale", () => {
    const store = new MemorySecretStore({ [accountFor(WORK, "TOKEN")]: "work-token" });
    const shell = new FakeShell([secret(WORK, "TOKEN")], store);

    shell.cd(WORK);
    expect(shell.env.TOKEN).toBe("work-token");

    store.remove(WORK, "TOKEN");
    shell.setRules([secret(WORK, "TOKEN")], "rev-2"); // rules changed -> re-resolve

    shell.cd(APPS);
    expect(shell.env.TOKEN).toBeUndefined();
    expect(shell.lastWarnings[0]).toContain("no keychain entry");
  });
});

describe("rules changing underneath a live shell", () => {
  test("a new rev re-resolves values that are already active", () => {
    const store = new MemorySecretStore({ [accountFor(WORK, "TOKEN")]: "old" });
    const shell = new FakeShell([secret(WORK, "TOKEN")], store);

    shell.cd(WORK);
    expect(shell.env.TOKEN).toBe("old");

    // Another terminal changes the secret and touches the rules file.
    store.set(WORK, "TOKEN", "new");
    shell.setRules([secret(WORK, "TOKEN")], "rev-2");

    shell.cd(WORK);
    expect(shell.env.TOKEN).toBe("new");
  });

  test("a rule removed elsewhere is ejected on the next hook run", () => {
    const store = new MemorySecretStore({ [accountFor(WORK, "TOKEN")]: "v" });
    const shell = new FakeShell([secret(WORK, "TOKEN")], store);
    shell.cd(WORK);
    expect(shell.env.TOKEN).toBe("v");

    shell.setRules([], "rev-2");
    shell.cd(WORK);
    expect(shell.env.TOKEN).toBeUndefined();
  });

  test("an unchanged rev keeps the fast path even for plain rules", () => {
    const store = new MemorySecretStore();
    const shell = new FakeShell([plain(WORK, "NODE_ENV", "development")], store);
    shell.cd(WORK);
    shell.cd(APPS);
    expect(shell.lastStatements).toEqual([]);
  });
});

describe("state", () => {
  test("round-trips through base64", () => {
    const state: State = {
      ...emptyState(),
      rev: "1:2:3",
      active: { TOKEN: { prev: "before", dir: WORK, src: "keychain" } },
    };
    expect(decodeState(encodeState(state))).toEqual(state);
  });

  test("survives values that would upset a shell", () => {
    const state: State = {
      ...emptyState(),
      rev: "r",
      active: { A: { prev: "it's \n$(x)`y`", dir: "/a b/c'd", src: "plain" } },
    };
    expect(decodeState(encodeState(state))).toEqual(state);
  });

  test("garbage decodes to empty rather than throwing", () => {
    expect(decodeState("not-base64!!!").active).toEqual({});
    expect(decodeState(Buffer.from("[]").toString("base64")).active).toEqual({});
    expect(decodeState(Buffer.from('{"v":99,"active":{}}').toString("base64")).active).toEqual({});
    expect(decodeState(undefined).active).toEqual({});
    expect(decodeState("").active).toEqual({});
  });

  test("malformed entries are dropped, good ones kept", () => {
    const encoded = Buffer.from(
      JSON.stringify({ v: 1, rev: "r", active: { GOOD: { prev: null, dir: "/a", src: "plain" }, BAD: { prev: 5 } } }),
    ).toString("base64");
    const state = decodeState(encoded);
    expect(Object.keys(state.active)).toEqual(["GOOD"]);
  });
});
