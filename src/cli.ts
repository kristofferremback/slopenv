import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { createContext, type Context } from "./context.ts";
import { legacyRulesFilePath } from "./paths.ts";
import { SlopenvError } from "./errors.ts";
import { cmdCompletions } from "./commands/completions.ts";
import { cmdEdit } from "./commands/edit.ts";
import { cmdExport } from "./commands/export.ts";
import { cmdHook } from "./commands/hook.ts";
import { cmdDoctor, cmdList, cmdStatus } from "./commands/inspect.ts";
import { cmdLink, cmdRm, cmdSet } from "./commands/mutate.ts";
import { cmdPull } from "./commands/pull.ts";
import { cmdOff, cmdOn } from "./commands/session.ts";
import { cmdUpdate } from "./commands/update.ts";
import { VERSION } from "./version.ts";

export { VERSION } from "./version.ts";

const HELP = `slopenv ${VERSION} — directory-scoped environment variables, with secrets in the OS keychain

usage: slopenv <command> [args]

  set NAME[=VALUE] [DIR]          add a rule for a non-secret value, in the rules
                                  file (asks first if it looks like a credential)
  set --secret NAME[=VALUE] [DIR] store the value in the keychain instead
                                  (omit =VALUE to be prompted, hidden, off the record)
  link NAME --from SRCDIR [DIR]   apply a value you already have in SRCDIR to
                                  another directory, without copying it
  pull NAME --ref REF [DIR]       fetch a value from 1Password and cache it in the
                                  keychain (\`pull --all\` re-fetches every one;
                                  \`--plain\` keeps it in the rules file instead)
  rm NAME [DIR]                   remove a rule, and its keychain entry if it had one
  off                             unload slopenv's variables in this shell only,
                                  until you \`slopenv on\` or leave the directory
  on                              load them again without waiting to leave
  list                            show every rule (secret values are masked)
  status [DIR]                    show what applies in a directory and which rule wins
  doctor                          check the hook, the rules file and the keychain
  update [--check]                update to the latest release from GitHub
  edit                            open the rules file in $EDITOR
  hook <zsh|bash> [--simple]      print the shell hook
  completions <zsh|bash>          print the shell completion script
  export [DIR]                    internal: print the export/unset statements to eval

common flags:
  --dir DIR       the directory a rule applies to (defaults to the current one)
  --value VALUE   pass a value that would otherwise be misread
  --from DIR      the directory \`link\` borrows a value from
  --ref REF       a secret reference, e.g. "op://Work/Claude Code/credential"
  --ttl 30d       how long before \`pull\` says a cached value is overdue
  --plain         keep the value in the rules file, in the clear
  --secret        keep it in the keychain instead
                  (\`set\` defaults to --plain, \`pull\` to --secret)
  --alias TEXT    a human label shown by \`list\`, e.g. "Claude Code for work"
  --yes, -y       skip the confirmation when \`set\` thinks a value is a credential
                  (--force / -f do the same thing; \`rm --force\` removes links too)
  --json          machine-readable output (\`list\`; never includes secret values)
  --names/--dirs  plain one-per-line output (\`list\`), for scripts and completion

examples:
  slopenv set --secret CLAUDE_CODE_OAUTH_TOKEN ./ --alias "Claude Code for work"
  slopenv set NODE_ENV=development ./
  slopenv set --secret GITHUB_TOKEN=ghp_xxx ~/dev/oss
  slopenv set "FULL_NAME=Kristoffer Remback"     # quote values containing spaces
  slopenv set FULL_NAME="Kristoffer Remback"     # equivalent — your shell does the work
  slopenv link GITHUB_TOKEN --from ~/dev/oss     # same value, one more directory
  slopenv off                                    # this shell only, ends when you leave
  slopenv pull GITHUB_TOKEN --ref "op://Work/GitHub/token"
  slopenv pull --all                             # rebuild the keychain on a new machine
  slopenv pull NOTION_USER --ref "op://Employee/Notion/Username" --plain

DIR covers itself and everything under it. When two rules define the same
variable, the deeper directory wins.

\`link\` borrows rather than copies: the value stays in one place, so changing it
there changes it everywhere it is linked.

\`pull\` keeps the reference in the rules file and the value in the keychain, so the
vault is never consulted on a \`cd\` — only when you pull. Not everything in a
vault is a secret, so \`--plain\` keeps the value in the rules file instead, in the
clear, and asks first if it looks like a credential.

\`off\` changes no rules and no other terminal. It ends when you \`slopenv on\` or
when you leave the directory it was pinned to, which it tells you about.

environment:
  SLOPENV_CONFIG   path to the rules file (default ~/.slopenv/rules.json)
  SLOPENV_LOG=1    trace what slopenv is doing, on stderr
`;

type CommandFn = (argv: readonly string[], ctx: Context) => number | Promise<number>;

const COMMANDS: Record<string, CommandFn> = {
  set: cmdSet,
  link: cmdLink,
  rm: cmdRm,
  pull: cmdPull,
  off: cmdOff,
  on: cmdOn,
  list: cmdList,
  status: cmdStatus,
  doctor: cmdDoctor,
  edit: cmdEdit,
  hook: cmdHook,
  completions: cmdCompletions,
  update: cmdUpdate,
  export: cmdExport,
};

/** Commands that were replaced, and what replaced them. */
const RENAMED: Record<string, string> = {
  "set-secret": "set --secret",
};

/**
 * rules.json used to live under ~/.config. Say so once rather than starting from
 * an empty rule set and letting someone wonder where their rules went.
 *
 * Never called from `export` — that runs on every `cd`, must stay silent, and
 * must never be slowed down by a stat for a file that is almost never there.
 */
function warnAboutLegacyConfig(ctx: Context): void {
  if (ctx.env.SLOPENV_CONFIG) return;

  const legacy = legacyRulesFilePath(ctx.env);
  if (legacy === ctx.rulesPath || existsSync(ctx.rulesPath) || !existsSync(legacy)) return;

  ctx.err(`slopenv: found rules at ${legacy}, which is the old location.\n`);
  ctx.err(`  slopenv now uses ${ctx.rulesPath}. To keep them:\n`);
  ctx.err(`      mkdir -p ${dirname(ctx.rulesPath)} && mv ${legacy} ${ctx.rulesPath}\n`);
}

export function run(argv: readonly string[], ctx: Context): number | Promise<number> {
  const command = argv[0];

  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    ctx.out(HELP);
    return command === undefined ? 1 : 0;
  }
  if (command === "--version" || command === "-v") {
    ctx.out(`${VERSION}\n`);
    return 0;
  }

  const fn = COMMANDS[command];
  if (!fn) {
    // A command that used to exist deserves better than "unknown". The typing
    // muscle memory is real, and so is the shell history it lives in.
    const replacement = RENAMED[command];
    if (replacement) {
      ctx.err(`slopenv: \`${command}\` is now \`${replacement}\`.\n`);
      ctx.err(`  Same behaviour, one spelling: the value goes to the keychain either way.\n`);
      return 1;
    }
    ctx.err(`slopenv: unknown command ${JSON.stringify(command)}\n`);
    ctx.err(`Run \`slopenv --help\` for usage.\n`);
    return 1;
  }

  // `export` is the hot path and its stdout is evaluated by the shell; `hook`
  // just prints a snippet. Neither should stat anything it does not have to.
  if (command !== "export" && command !== "hook") warnAboutLegacyConfig(ctx);

  return fn(argv.slice(1), ctx);
}

/**
 * Errors never reach stdout. `slopenv export` is `eval`d by the shell, so a
 * diagnostic printed on stdout would be executed; a non-zero exit tells the hook
 * to skip the eval entirely.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const ctx = createContext();
  try {
    return await run(argv, ctx);
  } catch (err) {
    if (err instanceof SlopenvError) {
      ctx.err(`slopenv: ${err.message}\n`);
      return 1;
    }
    ctx.err(`slopenv: unexpected error\n${(err as Error).stack ?? String(err)}\n`);
    return 1;
  }
}

if (import.meta.main) {
  // Not top-level await: `bun build --compile --bytecode` rejects it.
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`slopenv: unexpected error\n${(err as Error).stack ?? String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
