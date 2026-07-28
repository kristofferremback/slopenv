import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { computePlan } from "../src/engine.ts";
import { effectiveRule, linksTo, loadRules, parseRules, RULES_VERSION, serializeRules, type Rule } from "../src/rules.ts";
import { accountFor } from "../src/secrets/index.ts";
import { MemorySecretStore } from "../src/secrets/memory.ts";
import { emptyState } from "../src/state.ts";
import { applyStatements, cleanup, harness, runSync, tempDir, type Harness } from "./helpers.ts";

let root: string;
let rulesPath: string;
/** The directory the value really lives in. */
let threa: string;
/** Another repo in the same project, which wants the same value. */
let web: string;
let apps: string;
let h: Harness;

beforeEach(() => {
  root = realpathSync(tempDir());
  rulesPath = join(root, "rules.json");
  threa = join(root, "threa");
  web = join(root, "threa-web");
  apps = join(threa, "apps");
  mkdirSync(apps, { recursive: true });
  mkdirSync(web, { recursive: true });
  h = harness({ rulesPath, cwd: web });
});

afterEach(() => cleanup(root));

function cli(...argv: string[]): number {
  h.reset();
  return runSync(argv, h.ctx);
}

function rules(): Rule[] {
  return loadRules(rulesPath).rules;
}

function ruleFor(dir: string, name: string): Rule | undefined {
  return rules().find((r) => r.dir === dir && r.name === name);
}

describe("slopenv link", () => {
  test("adds a rule in the current directory that borrows from another one", () => {
    cli("set-secret", "TOKEN=s3cret", threa);
    expect(cli("link", "TOKEN", "--from", threa)).toBe(0);

    expect(ruleFor(web, "TOKEN")).toEqual({ dir: web, name: "TOKEN", source: "link", target: threa });
    expect(h.stdout()).toContain(`TOKEN -> ${threa}`);
  });

  test("the value is borrowed, not copied — the keychain gains no second entry", () => {
    cli("set-secret", "TOKEN=s3cret", threa);
    cli("link", "TOKEN", "--from", threa);

    expect([...h.store.entries.keys()]).toEqual([accountFor(threa, "TOKEN")]);
  });

  test("a directory argument works the same way `set` takes one", () => {
    cli("set", "NODE_ENV=development", threa);
    expect(cli("link", "NODE_ENV", "--from", threa, apps)).toBe(0);
    expect(ruleFor(apps, "NODE_ENV")?.source).toBe("link");
  });

  test("--dir is accepted in place of the positional", () => {
    cli("set", "NODE_ENV=development", threa);
    cli("link", "NODE_ENV", "--from", threa, "--dir", apps);
    expect(ruleFor(apps, "NODE_ENV")?.source).toBe("link");
  });

  test("--from takes any directory the source rule covers, and records the rule's own", () => {
    cli("set-secret", "TOKEN=s3cret", threa);
    // The rule lives in threa; apps merely inherits it.
    cli("link", "TOKEN", "--from", apps);
    expect(ruleFor(web, "TOKEN")?.target).toBe(threa);
  });

  test("linking to a link is flattened to the real rule, so links never chain", () => {
    const third = join(root, "threa-docs");
    mkdirSync(third);
    cli("set-secret", "TOKEN=s3cret", threa);
    cli("link", "TOKEN", "--from", threa);
    // web is now a link; borrowing from it must land on threa, not on web.
    cli("link", "TOKEN", "--from", web, third);

    expect(ruleFor(third, "TOKEN")?.target).toBe(threa);
  });

  test("refuses when the source directory has no rule for that variable", () => {
    expect(() => cli("link", "TOKEN", "--from", threa)).toThrow(/no rule for TOKEN/);
  });

  test("refuses without --from rather than guessing", () => {
    cli("set", "TOKEN=v", threa);
    expect(() => cli("link", "TOKEN")).toThrow(/--from/);
  });

  test("refuses to link a directory to a value it already holds", () => {
    cli("set", "TOKEN=v", threa);
    expect(() => cli("link", "TOKEN", "--from", threa, threa)).toThrow(/already lives/);
  });

  test("says so when the source rule already covers the target directory", () => {
    cli("set", "TOKEN=v", threa);
    expect(cli("link", "TOKEN", "--from", threa, apps)).toBe(0);
    expect(h.stderr()).toContain("already covers");
  });

  test("--alias labels the link; without one it shows the borrowed label", () => {
    cli("set-secret", "TOKEN=s3cret", threa, "--alias", "Claude Code for work");
    cli("link", "TOKEN", "--from", threa);
    expect(ruleFor(web, "TOKEN")?.alias).toBeUndefined();

    cli("list");
    expect(h.stdout()).toContain("Claude Code for work");

    cli("link", "TOKEN", "--from", threa, "--alias", "the web one");
    expect(ruleFor(web, "TOKEN")?.alias).toBe("the web one");
  });

  test("replacing a keychain rule with a link deletes the orphaned keychain entry", () => {
    cli("set-secret", "TOKEN=shared", threa);
    cli("set-secret", "TOKEN=its-own", web);
    expect(h.store.entries.has(accountFor(web, "TOKEN"))).toBe(true);

    cli("link", "TOKEN", "--from", threa);
    expect(h.store.entries.has(accountFor(web, "TOKEN"))).toBe(false);
    expect(h.stderr()).toContain("deleted the keychain entry");
  });

  test("refuses to turn a rule other links depend on into a link itself", () => {
    const third = join(root, "threa-docs");
    mkdirSync(third);
    cli("set", "TOKEN=v", threa);
    cli("set", "TOKEN=other", web);
    cli("link", "TOKEN", "--from", web, third);

    // web is what `third` borrows from; it cannot become a borrower.
    expect(() => cli("link", "TOKEN", "--from", threa)).toThrow(/links to TOKEN/);
    expect(ruleFor(web, "TOKEN")?.source).toBe("plain");
  });
});

describe("a link in the shell", () => {
  test("exports the value the target holds", () => {
    cli("set-secret", "TOKEN=s3cret", threa);
    cli("link", "TOKEN", "--from", threa);
    cli("export", web);

    expect(h.stdout()).toContain("export TOKEN='s3cret'");
  });

  test("changing the value at the source changes it everywhere it is linked", () => {
    cli("set-secret", "TOKEN=first", threa);
    cli("link", "TOKEN", "--from", threa);
    cli("set-secret", "TOKEN=second", threa);

    cli("export", web);
    expect(h.stdout()).toContain("export TOKEN='second'");
  });

  test("a deeper rule still wins over a link, and a link over a shallower rule", () => {
    cli("set", "TOKEN=root", root);
    cli("set", "TOKEN=threa", threa);
    cli("link", "TOKEN", "--from", threa, web);
    mkdirSync(join(web, "deep"), { recursive: true });
    cli("set", "TOKEN=deep", join(web, "deep"));

    cli("export", web);
    expect(h.stdout()).toContain("export TOKEN='threa'");
  });

  test("the linked directory is in SLOPENV_DIRS, so the hook's fast path notices it", () => {
    cli("set", "TOKEN=v", threa);
    cli("link", "TOKEN", "--from", threa);
    cli("export", web);

    const dirs = /export SLOPENV_DIRS='([\s\S]*?)'\n/.exec(h.stdout())?.[1];
    expect(dirs?.split("\n")).toContain(web);
  });

  test("moving between a link and its target re-exports rather than going stale", () => {
    cli("set", "TOKEN=shared", threa);
    cli("link", "TOKEN", "--from", threa);

    const env: Record<string, string | undefined> = {};
    const store = new MemorySecretStore();
    const all = rules();
    for (const pwd of [threa, web]) {
      const plan = computePlan({ rules: all, pwd, prevState: emptyState(), env, store, rev: "r1" });
      applyStatements(env, plan.statements);
      expect(env.TOKEN).toBe("shared");
    }
  });

  test("a link whose target vanished warns and unsets rather than exporting a stale value", () => {
    // Only reachable by hand-editing, since the rules file refuses to load in this
    // state and `rm` refuses to create it. The engine still has to cope.
    const dangling: Rule[] = [{ dir: web, name: "TOKEN", source: "link", target: threa }];
    const plan = computePlan({
      rules: dangling,
      pwd: web,
      prevState: emptyState(),
      env: {},
      store: new MemorySecretStore(),
      rev: "r1",
    });

    expect(plan.statements).toEqual([]);
    expect(plan.warnings[0]).toMatch(/links to .*threa, where there is no rule for it/);
  });

  test("a link to a secret that is gone from the keychain names the directory to fix", () => {
    cli("set-secret", "TOKEN=s3cret", threa);
    cli("link", "TOKEN", "--from", threa);
    h.store.entries.clear();

    cli("export", web);
    expect(h.stderr()).toContain(`no keychain entry for TOKEN (${threa})`);
    expect(h.stdout()).not.toContain("export TOKEN=");
  });
});

describe("removing a linked rule", () => {
  test("refuses while something links to it, and names what does", () => {
    cli("set-secret", "TOKEN=s3cret", threa);
    cli("link", "TOKEN", "--from", threa);

    expect(() => cli("rm", "TOKEN", threa)).toThrow(/1 rule links to TOKEN/);
    expect(rules()).toHaveLength(2);
    // The refusal must not have taken the keychain entry with it.
    expect(h.store.entries.has(accountFor(threa, "TOKEN"))).toBe(true);
  });

  test("--force removes the rule and every link to it", () => {
    cli("set-secret", "TOKEN=s3cret", threa);
    cli("link", "TOKEN", "--from", threa);
    cli("link", "TOKEN", "--from", threa, apps);

    expect(cli("rm", "TOKEN", threa, "--force")).toBe(0);
    expect(rules()).toEqual([]);
    expect(h.store.entries.size).toBe(0);
    expect(h.stdout()).toContain("2 links to it");
  });

  test("removing the link leaves the value, and the keychain, alone", () => {
    cli("set-secret", "TOKEN=s3cret", threa);
    cli("link", "TOKEN", "--from", threa);

    expect(cli("rm", "TOKEN", web)).toBe(0);
    expect(rules()).toHaveLength(1);
    expect(h.store.entries.has(accountFor(threa, "TOKEN"))).toBe(true);
  });

  test("giving a linked directory its own value says that the link is gone", () => {
    cli("set", "TOKEN=shared", threa);
    cli("link", "TOKEN", "--from", threa);
    cli("set", "TOKEN=its-own");

    expect(ruleFor(web, "TOKEN")).toEqual({ dir: web, name: "TOKEN", source: "plain", value: "its-own" });
    expect(h.stderr()).toContain(`used to link to ${threa}`);
  });
});

describe("links in the rules file", () => {
  test("a file with a link is written as version 2; one without stays version 1", () => {
    cli("set", "TOKEN=v", threa);
    expect(JSON.parse(readFileSync(rulesPath, "utf8")).version).toBe(1);

    cli("link", "TOKEN", "--from", threa);
    expect(JSON.parse(readFileSync(rulesPath, "utf8")).version).toBe(2);
  });

  test("refuses a link that points nowhere", () => {
    const text = JSON.stringify({
      version: 2,
      rules: [{ dir: "/dev/web", name: "TOKEN", source: "link", target: "/dev/threa" }],
    });
    expect(() => parseRules(text)).toThrow(/links TOKEN to \/dev\/threa, where there is no rule/);
  });

  test("refuses a link that points at a rule for a different variable", () => {
    const text = JSON.stringify({
      version: 2,
      rules: [
        { dir: "/dev/threa", name: "OTHER", source: "plain", value: "v" },
        { dir: "/dev/web", name: "TOKEN", source: "link", target: "/dev/threa" },
      ],
    });
    expect(() => parseRules(text)).toThrow(/where there is no rule for TOKEN/);
  });

  test("refuses a chain of links, which is the only way to build a cycle", () => {
    const text = JSON.stringify({
      version: 2,
      rules: [
        { dir: "/dev/a", name: "TOKEN", source: "plain", value: "v" },
        { dir: "/dev/b", name: "TOKEN", source: "link", target: "/dev/a" },
        { dir: "/dev/c", name: "TOKEN", source: "link", target: "/dev/b" },
      ],
    });
    expect(() => parseRules(text)).toThrow(/itself a link/);
  });

  test("refuses the malformed shapes a link can take", () => {
    const cases: [unknown, RegExp][] = [
      [{ dir: "/a", name: "V", source: "link" }, /target must be a non-empty string/],
      [{ dir: "/a", name: "V", source: "link", target: "rel" }, /target must be an absolute path/],
      [{ dir: "/a", name: "V", source: "link", target: "/a" }, /links to its own directory/],
      [{ dir: "/a", name: "V", source: "link", target: "/b", value: "x" }, /value must not be set/],
      [{ dir: "/a", name: "V", source: "plain", value: "x", target: "/b" }, /target must not be set/],
    ];
    for (const [rule, pattern] of cases) {
      expect(() => parseRules(JSON.stringify({ version: 2, rules: [rule] }))).toThrow(pattern);
    }
  });

  test("a file from a newer slopenv is refused by name, not by a confusing complaint about `source`", () => {
    // Deliberately relative to the current version: this is about what happens
    // when a build meets a file it is too old for, whatever the numbers are.
    const text = JSON.stringify({ version: RULES_VERSION + 1, rules: [] });
    expect(() => parseRules(text)).toThrow(/written by a newer slopenv/);
  });

  test("round-trips a link", () => {
    const file = {
      version: 2,
      rules: [
        { dir: "/dev/threa", name: "TOKEN", source: "keychain" },
        { dir: "/dev/web", name: "TOKEN", source: "link", target: "/dev/threa", alias: "borrowed" },
      ] as Rule[],
    };
    expect(parseRules(serializeRules(file))).toEqual(file);
  });

  test("effectiveRule follows a link and stops at a real rule", () => {
    const token = { dir: "/dev/threa", name: "TOKEN", source: "plain", value: "v" } as Rule;
    const link = { dir: "/dev/web", name: "TOKEN", source: "link", target: "/dev/threa" } as Rule;
    expect(effectiveRule([token, link], link)).toBe(token);
    expect(effectiveRule([token, link], token)).toBe(token);
    expect(effectiveRule([link], link)).toBeUndefined();
    expect(linksTo([token, link], "/dev/threa", "TOKEN")).toEqual([link]);
    expect(linksTo([token, link], "/dev/web", "TOKEN")).toEqual([]);
  });
});

describe("links in the output", () => {
  test("list gains a BORROWS FROM column only when there is a link", () => {
    cli("set-secret", "TOKEN=s3cret", threa);
    cli("list");
    expect(h.stdout()).not.toContain("BORROWS FROM");

    cli("link", "TOKEN", "--from", threa);
    cli("list");
    expect(h.stdout()).toContain("BORROWS FROM");
    // The borrowed value is shown, masked, on the link's row too.
    expect(h.stdout().split("\n").filter((l) => l.includes("•••"))).toHaveLength(2);
  });

  test("status shows where the value comes from", () => {
    cli("set", "TOKEN=shared", threa);
    cli("link", "TOKEN", "--from", threa);
    cli("status", web);

    expect(h.stdout()).toContain("link");
    expect(h.stdout()).toContain(`${web} -> ${threa}`);
    expect(h.stdout()).toContain("shared");
  });

  test("doctor reports each link and what it resolves to", () => {
    cli("set-secret", "TOKEN=s3cret", threa);
    cli("link", "TOKEN", "--from", threa);
    cli("doctor");

    expect(h.stdout()).toContain("links (1)");
    expect(h.stdout()).toContain(`borrows from ${threa} [keychain]`);
  });

  test("list --json carries the target, and still never carries the secret", () => {
    cli("set-secret", "TOKEN=s3cret", threa);
    cli("link", "TOKEN", "--from", threa);
    cli("list", "--json");

    const parsed = JSON.parse(h.stdout());
    expect(parsed.rules).toContainEqual({ dir: web, name: "TOKEN", source: "link", target: threa });
    expect(h.stdout()).not.toContain("s3cret");
  });
});
