import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { dirCovers, matchingRules, resolveRules, ruleDirs } from "../src/match.ts";
import { resolvePwd, resolveRuleDir, normalizeDir } from "../src/paths.ts";
import type { Rule } from "../src/rules.ts";
import { cleanup, tempDir } from "./helpers.ts";

const root = tempDir();
afterAll(() => cleanup(root));

function plain(dir: string, name: string, value: string): Rule {
  return { dir, name, source: "plain", value };
}

describe("dirCovers", () => {
  test("covers itself and its descendants", () => {
    expect(dirCovers("/dev/threa", "/dev/threa")).toBe(true);
    expect(dirCovers("/dev/threa", "/dev/threa/apps")).toBe(true);
    expect(dirCovers("/dev/threa", "/dev/threa/apps/web/src")).toBe(true);
  });

  test("does not match a sibling that merely shares a prefix", () => {
    expect(dirCovers("/dev/threa", "/dev/threa-2")).toBe(false);
    expect(dirCovers("/dev/threa", "/dev/threax")).toBe(false);
    expect(dirCovers("/dev/threa", "/dev/threa.old")).toBe(false);
  });

  test("does not match upwards", () => {
    expect(dirCovers("/dev/threa", "/dev")).toBe(false);
    expect(dirCovers("/dev/threa/apps", "/dev/threa")).toBe(false);
  });

  test("root covers everything without producing a double slash", () => {
    expect(dirCovers("/", "/")).toBe(true);
    expect(dirCovers("/", "/anything/at/all")).toBe(true);
  });
});

describe("normalizeDir", () => {
  test("strips trailing slashes but keeps root", () => {
    expect(normalizeDir("/a/b/")).toBe("/a/b");
    expect(normalizeDir("/a/b///")).toBe("/a/b");
    expect(normalizeDir("/")).toBe("/");
  });
});

describe("resolveRules", () => {
  const rules = [
    plain("/dev", "SHARED", "from-dev"),
    plain("/dev", "ONLY_DEV", "dev"),
    plain("/dev/threa", "SHARED", "from-threa"),
    plain("/dev/threa/apps", "SHARED", "from-apps"),
    plain("/dev/threa-2", "SHARED", "from-threa-2"),
  ];

  test("the deepest directory wins", () => {
    expect(resolveRules(rules, "/dev/threa/apps/web").get("SHARED")?.value).toBe("from-apps");
    expect(resolveRules(rules, "/dev/threa").get("SHARED")?.value).toBe("from-threa");
    expect(resolveRules(rules, "/dev").get("SHARED")?.value).toBe("from-dev");
  });

  test("an ancestor rule is still inherited alongside the override", () => {
    const active = resolveRules(rules, "/dev/threa/apps");
    expect(active.get("SHARED")?.value).toBe("from-apps");
    expect(active.get("ONLY_DEV")?.value).toBe("dev");
  });

  test("a sibling directory does not leak in", () => {
    expect(resolveRules(rules, "/dev/threa-2").get("SHARED")?.value).toBe("from-threa-2");
  });

  test("nothing applies outside every rule directory", () => {
    expect(resolveRules(rules, "/tmp").size).toBe(0);
  });

  test("matchingRules is ordered deepest first", () => {
    const dirs = matchingRules(rules, "/dev/threa/apps").map((r) => r.dir);
    expect(dirs[0]).toBe("/dev/threa/apps");
    expect(dirs.at(-1)).toBe("/dev");
  });

  test("ruleDirs is deduplicated and sorted", () => {
    expect(ruleDirs(rules)).toEqual(["/dev", "/dev/threa", "/dev/threa-2", "/dev/threa/apps"]);
  });
});

describe("symlinks", () => {
  const real = join(root, "real-project");
  const link = join(root, "link-to-project");
  mkdirSync(join(real, "nested"), { recursive: true });
  symlinkSync(real, link);

  test("a rule created through a symlink is stored as the real path", () => {
    expect(resolveRuleDir(link)).toBe(resolvePwd(real));
  });

  test("entering through the symlink matches the rule", () => {
    const rules = [plain(resolveRuleDir(real), "TOKEN", "value")];
    expect(resolveRules(rules, resolvePwd(link)).get("TOKEN")?.value).toBe("value");
    expect(resolveRules(rules, resolvePwd(join(link, "nested"))).get("TOKEN")?.value).toBe("value");
  });

  test("a relative directory resolves against the given cwd", () => {
    expect(resolveRuleDir("./nested", real)).toBe(resolvePwd(join(real, "nested")));
    expect(resolveRuleDir(".", real)).toBe(resolvePwd(real));
  });

  test("a directory that does not exist is refused", () => {
    expect(() => resolveRuleDir(join(root, "nope"))).toThrow(/does not exist/);
  });

  test("removal tolerates a directory that is gone", () => {
    const gone = join(root, "gone");
    expect(resolveRuleDir(gone, root, { mustExist: false })).toBe(gone);
  });
});
