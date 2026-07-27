import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "../context.ts";
import { fail } from "../errors.ts";
import { withLock } from "../lock.ts";
import { emptyRulesFile, fingerprint, parseRules, serializeRules, writeRulesAtomic } from "../rules.ts";

/**
 * Edit rules.json in $EDITOR.
 *
 * The editor runs on a copy, and the lock is only taken for the final write —
 * holding it across an editor session would block every other terminal for as
 * long as the file is open. The fingerprint check closes the gap that opens up:
 * if someone else changed the rules while you were editing, we refuse rather than
 * overwrite their change, and tell you where your edits are.
 */
export function cmdEdit(_argv: readonly string[], ctx: Context): number {
  const editor = ctx.env.VISUAL || ctx.env.EDITOR;
  if (!editor) fail("no $EDITOR (or $VISUAL) set");

  const before = fingerprint(ctx.rulesPath);
  const scratch = join(tmpdir(), `slopenv-edit-${process.pid}.json`);

  if (existsSync(ctx.rulesPath)) copyFileSync(ctx.rulesPath, scratch);
  else writeFileSync(scratch, serializeRules(emptyRulesFile()), { mode: 0o600 });

  const result = Bun.spawnSync(["/bin/sh", "-c", `${editor} "$1"`, "sh", scratch], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) fail(`editor exited with status ${result.exitCode} — rules.json left unchanged`);

  const edited = readFileSync(scratch, "utf8");

  let parsed;
  try {
    parsed = parseRules(edited);
  } catch (err) {
    fail(`${(err as Error).message}\n  Your edits are still at ${scratch} — rules.json was left unchanged.`);
  }

  withLock(ctx.rulesPath, () => {
    const now = fingerprint(ctx.rulesPath);
    if (now !== before) {
      fail(
        `rules.json changed while you were editing (another terminal?) — refusing to overwrite it.\n` +
          `  Your edits are at ${scratch}`,
      );
    }
    writeRulesAtomic(ctx.rulesPath, parsed);
  });

  ctx.out(`saved ${parsed.rules.length} rule${parsed.rules.length === 1 ? "" : "s"}\n`);
  return 0;
}
