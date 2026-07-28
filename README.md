# slopenv

[![CI](https://github.com/kristofferremback/slopenv/actions/workflows/ci.yml/badge.svg)](https://github.com/kristofferremback/slopenv/actions/workflows/ci.yml)

Directory-scoped environment variables. Like direnv, except the config lives outside the repo, so there is no `.envrc` to accidentally commit, and secret values go to the macOS Keychain instead of to disk.

```sh
cd ~/dev/threa
echo $CLAUDE_CODE_OAUTH_TOKEN    # sk-ant-oat01-...-work

cd apps
echo $CLAUDE_CODE_OAUTH_TOKEN    # sk-ant-oat01-...-work   (inherited)

cd ~/dev
echo $CLAUDE_CODE_OAUTH_TOKEN    #                          (ejected on leave)
```

## Install

macOS only. Secrets live in the Keychain and there is no backend for anything else yet.

### From a release

```sh
# Apple Silicon (swap arm64 for x64 on Intel)
curl -fsSL https://github.com/kristofferremback/slopenv/releases/latest/download/slopenv-darwin-arm64.tar.gz | tar xz
mv slopenv-darwin-arm64 ~/.local/bin/slopenv     # or anywhere on your PATH
```

### From source

Requires [Bun](https://bun.sh).

```sh
git clone https://github.com/kristofferremback/slopenv.git && cd slopenv
bun install
bun run build                                    # produces ./slopenv
ln -sf "$PWD/slopenv" ~/.local/bin/slopenv       # symlink, so rebuilds are live
```

### Then

Add one line to `~/.zshrc`:

```sh
eval "$(slopenv hook zsh)"
```

Open a new shell, then check everything is wired up:

```sh
slopenv doctor
```

`slopenv doctor` is the thing to run when a rule exists but nothing is being injected. Installing the binary and adding the hook line are two separate steps, and doing only the first leaves `slopenv list` showing rules that never take effect.

That one line also sets up tab completion. See [Completion](#completion).

## Usage

```sh
# Store a secret. Prompts with echo off, so it never reaches shell history.
slopenv set-secret CLAUDE_CODE_OAUTH_TOKEN ./ --alias "Claude Code for work"

# Or inline, if you don't mind it in your history.
slopenv set-secret GITHUB_TOKEN=ghp_xxxxxxxx ~/dev/oss

# Or from a pipe, which keeps it out of history and out of argv.
cat token.txt | slopenv set-secret CLAUDE_CODE_OAUTH_TOKEN ./

# Non-secrets go in the rules file in plain text.
slopenv set NODE_ENV=development ./
slopenv set NODE_ENV ./              # prompts, echo on

# Apply a value you already have to a second directory, without copying it.
slopenv link CLAUDE_CODE_OAUTH_TOKEN --from ~/dev/threa

slopenv list      # every rule; secret values shown as •••1234
slopenv status    # what applies right here, and which rule won
slopenv rm CLAUDE_CODE_OAUTH_TOKEN ./
slopenv edit      # open rules.json in $EDITOR
slopenv doctor    # check hook, rules file, and keychain
```

`slopenv list`:

```
DIRECTORY          VARIABLE                 SOURCE    VALUE    ALIAS
~/dev/oss          CLAUDE_CODE_OAUTH_TOKEN  keychain  •••pers  Claude Code personal
~/dev/threa        CLAUDE_CODE_OAUTH_TOKEN  keychain  •••work  Claude Code for work
~/dev/threa        NODE_ENV                 plain     development
~/dev/threa/apps   PORT                     plain     3000
```

### One value, several directories

A second repo that belongs to the same project usually wants the same token. `link` gives it that token without giving it a second copy:

```sh
cd ~/dev/threa-web
slopenv link CLAUDE_CODE_OAUTH_TOKEN --from ~/dev/threa
```

The rule that lands in `~/dev/threa-web` holds no value of its own. It borrows the one in `~/dev/threa`, so rotating the token there rotates it everywhere it is linked, and a secret still exists exactly once in your keychain.

```
DIRECTORY        VARIABLE                 SOURCE    BORROWS FROM  VALUE    ALIAS
~/dev/threa      CLAUDE_CODE_OAUTH_TOKEN  keychain                •••work  Claude Code for work
~/dev/threa-web  CLAUDE_CODE_OAUTH_TOKEN  link      ~/dev/threa   •••work  Claude Code for work
```

`--from` takes any directory the source rule covers, not only the directory it is registered for, so `--from ~/dev/threa/apps` finds the rule at `~/dev/threa` and records that. A trailing `DIR` argument works the way it does on `set`: `slopenv link TOKEN --from ~/dev/threa ./packages/api` links a subdirectory instead of the current one.

Links never chain. Linking to something that is itself a link resolves to the real rule at the moment you create it, which is also why a cycle cannot be built. A link is one hop, always.

Because a link is only meaningful next to the value it borrows, removing that value is refused rather than silently breaking it:

```
$ slopenv rm CLAUDE_CODE_OAUTH_TOKEN ~/dev/threa
slopenv: 1 rule links to CLAUDE_CODE_OAUTH_TOKEN in /Users/you/dev/threa:
      /Users/you/dev/threa-web
  Remove them first, or remove all of them together with: slopenv rm CLAUDE_CODE_OAUTH_TOKEN /Users/you/dev/threa --force
```

Removing the link itself (`slopenv rm CLAUDE_CODE_OAUTH_TOKEN ~/dev/threa-web`) never touches the value or the keychain. Giving a linked directory its own value with `set` or `set-secret` replaces the link, and says so.

### Staying up to date

```sh
slopenv update           # download the latest release and replace the binary
slopenv update --check   # report only, change nothing
```

The download is verified against the release's `SHA256SUMS` before it is unpacked, and the new binary is run and asked its version before the old one is overwritten. If either check fails, the binary you have keeps working. The swap itself is a `rename` inside the target's own directory, so there is never a half-written binary on your PATH.

It refuses rather than guessing when the install is not its to replace: running from source under Bun, a build sitting inside a clone of this repo, or a directory you cannot write to. Each case says what to do instead.

### Completion

`eval "$(slopenv hook zsh)"` installs completion along with the hook, so there is nothing else to add. `slopenv completions zsh` prints it on its own if you would rather keep the two separate, and `slopenv completions bash` does the same for bash.

It completes your own rules, not just the command names:

```
$ slopenv rm <TAB>
FULL_NAME  NODE_ENV  PORT              # the variables you have registered

$ slopenv rm PO<TAB>
$ slopenv rm PORT

$ slopenv set NODE_ENV <TAB>
~/dev/threa  ~/dev/threa/apps          # directories those rules cover, then any directory

$ slopenv link TOKEN --from <TAB>
~/dev/threa  ~/dev/threa/apps          # the same list, for the directory to borrow from
```

The candidates come from `slopenv list --names` and `slopenv list --dirs`, which print one item per line and never read the keychain, so they are cheap enough to sit behind a TAB press. Both are also useful on their own for scripting.

### Argument grammar

| Form | Meaning |
| --- | --- |
| `slopenv set NAME=VALUE [DIR]` | set the value inline |
| `slopenv set NAME [DIR]` | prompt for the value |
| `slopenv set NAME VALUE DIR` | three-positional form, also accepted |
| `slopenv link NAME --from SRCDIR [DIR]` | borrow the value that is already registered in `SRCDIR` |
| `--dir DIR` / `--value VALUE` | for anything that would otherwise be misread |
| `--yes` / `-y` (or `--force` / `-f`) | skip the credential confirmation described below |
| `--force` / `-f` on `rm` | also remove the rules that link to the one being removed |
| `--names` / `--dirs` on `list` | one variable name or rule directory per line |

With a bare `NAME`, a second positional is always a directory. `DIR` defaults to the current directory. Trailing newlines are trimmed from prompted and piped values.

### Values with spaces

Quoting is your shell's job, and both obvious ways of doing it work. By the time slopenv sees them they are the same single argument:

```sh
slopenv set "FULL_NAME=Kristoffer Remback"
slopenv set FULL_NAME="Kristoffer Remback"
slopenv set FULL_NAME --value "Kristoffer Remback"
```

Forget the quotes and it fails, and says why:

```
$ slopenv set FULL_NAME=Kristoffer Remback
slopenv: "Remback" is not a directory.
  If the value has spaces in it, quote it. Either way works:
      slopenv set "FULL_NAME=Kristoffer Remback"
      slopenv set FULL_NAME="Kristoffer Remback"
  Or pass it separately:  slopenv set FULL_NAME --value "Kristoffer Remback"
```

An argument that looks like a path (`./typo`, `/some/where`) gets a plain "directory does not exist" instead, since it was clearly meant as a path.

Quote characters that reach slopenv are kept, never stripped. `slopenv set 'JSON={"a": "b"}'` stores `{"a": "b"}` verbatim.

### The plain-text guard

`set` writes to a plain-text file, so it checks whether you are about to put a credential in one and asks first:

```
$ slopenv set OPENAI_API_KEY=sk-proj-AbCdEf1234567890abcdefghij
slopenv: OPENAI_API_KEY: that value looks like an OpenAI project key.
  `set` writes it to ~/.slopenv/rules.json in plain text.
  To put it in the keychain instead:  slopenv set-secret OPENAI_API_KEY /Users/you/dev/app
  Store it in plain text anyway? [y/N]
```

The default is no. `--yes` / `-y` (or `--force` / `-f`) skips the question. When there is nobody to ask, in a script or with stdin piped, it refuses instead of hanging on a prompt you cannot see. Pass `--yes` if you mean it.

Two things trigger it. One is the value's shape: around 30 known credential formats, including `sk-ant-`, `sk-proj-`, `ghp_`, `glpat-`, `xoxb-`, `AKIA`, `AIza`, `SG.`, `npm_`, `hf_`, `gsk_`, a JWT, a PEM private key block, and a URL with an embedded password. That fires whatever the variable is called. The other is the variable's name: `*_SECRET`, `*_PASSWORD`, `*_TOKEN`, `*_API_KEY`, `*_PRIVATE_KEY`, `CLIENT_SECRET` and friends, unless the value is plainly harmless (a path, a number, a boolean, prose, anything under 8 characters).

It is deliberately quiet. `TOKEN_TTL=3600`, `SSH_KEY_PATH=~/.ssh/id_ed25519`, `AUTH_URL=https://…`, `PUBLIC_KEY=ssh-ed25519 …` and `DATABASE_URL=postgres://host/db` all pass without comment. A check that fires too often gets dismissed unread, and then it protects nothing.

`slopenv doctor` runs the same check over the whole rules file, which catches anything that got in through `slopenv edit` or a hand edit.

### Matching

A rule covers its directory and everything beneath it. Matching is on whole path segments, so `~/dev/threa` never matches `~/dev/threa-2`. Directories are stored symlink-resolved, so entering through a symlink still matches.

When two rules define the same variable, the deeper directory wins:

```
~/dev/threa        TOKEN=work    ->  in ~/dev/threa/apps you get "apps"
~/dev/threa/apps   TOKEN=apps        and "work" again when you cd back up
```

On leaving, a variable is unset. If your shell already had a value for it before slopenv touched it, that value is restored instead.

A link takes part in this like any other rule. It is matched by its own directory and can be shadowed by a deeper rule in the usual way; only the value comes from somewhere else.

## Where things are stored

| What | Where | Notes |
| --- | --- | --- |
| Rules (directories, variable names, aliases, links) | `~/.slopenv/rules.json` | mode `0600`, in a `0700` directory. Override the whole path with `$SLOPENV_CONFIG`. |
| Non-secret values (`slopenv set`) | the same file, in plain text | This is what `set` means. Use `set-secret` for anything you care about. |
| Secret values (`slopenv set-secret`) | macOS Keychain | Service `slopenv`, account `<dir>::<VAR_NAME>`. Never written to disk by slopenv. |
| Per-shell state | `$SLOPENV_STATE` in your environment | Base64 JSON. No temp files, nothing shared between shells. |

Nothing is ever written inside your project. There is no `.envrc` equivalent, so there is nothing to `.gitignore` and nothing to leak in a commit.

`rules.json` carries a version, and the file is only written as version 2 once it actually contains a link. A rules file without links stays readable by an older slopenv; one with links tells an older build to update rather than complaining about a rule shape it does not know.

## Security notes

### What is protected

Secret values never touch disk in plaintext, never appear in `rules.json`, and never appear in `slopenv list`, `status`, `doctor` or `--json` output. Those show `•••` plus the last four characters, enough to tell two tokens apart and not enough to use one.

### Shell history

`slopenv set-secret NAME ./` prompts with echo off, and piping (`cat token.txt | slopenv set-secret NAME ./`) also keeps the value out of history. The inline `NAME=VALUE` form does not, which is the trade-off you make by using it.

### Process arguments

slopenv writes to the keychain by feeding commands to `security -i` on stdin, so the secret does not appear in any process's argument list. The exception is a value containing a literal newline: `security -i` is line-based, so those fall back to passing the value as an argument, where `ps` could see it for a few milliseconds. macOS only shows argument lists to the same user, and to root.

### `$SLOPENV_STATE` holds secrets

To restore what your shell had before slopenv touched a variable, that previous value has to be remembered somewhere, and it lives in `$SLOPENV_STATE`. It is per-shell and never written to disk, but it is in your environment, as is the injected variable itself. Anything that can read your environment can read your injected secrets. The same is true of direnv and of plain `export`.

### Keychain access

slopenv shells out to `/usr/bin/security` rather than using an in-process keychain API. This was measured rather than assumed. macOS binds a keychain item's ACL to the *creating binary's code signature*, and a self-compiled `slopenv` is ad-hoc signed, so its identity changes on every build.

Writing a secret with `Bun.secrets` from one build and reading it from the next produces `errSecUserCanceled (-128)`, which is a modal permission dialog. Running the same code with `bun run` instead of the compiled binary hangs on that dialog indefinitely. For something invoked on `cd`, that means a popup blocking your shell after every `bun run build`. `/usr/bin/security` is Apple-signed and stable, so slopenv's entries stay readable across rebuilds without prompting.

If slopenv were ever signed with a stable Developer ID, an in-process API would become the better choice: faster, byte-exact, and cross-platform for free.

### Other platforms

There is no Linux backend yet. Rather than fall back to plaintext, `set-secret` fails with `no keychain backend for this platform`. `Bun.secrets` would be a good fit there, since Linux uses libsecret, which has no per-binary ACL and so none of the problem above. It can drop into the `SecretStore` interface.

## How it works

A child process cannot change its parent shell's environment, so slopenv is two pieces, direnv-style:

1. The CLI manages `rules.json` and keychain entries.
2. The shell hook runs `slopenv export "$PWD"` on `cd` and `eval`s its output, a series of `export` and `unset` statements.

On each run, slopenv works out what should be active for `$PWD`, diffs it against what `$SLOPENV_STATE` says is active, and emits only the difference. The keychain is read when a variable newly activates, rather than on every `cd`.

### The fast path

The generated zsh hook does not call slopenv on most `cd`s at all. What slopenv would export is a pure function of *(rules file, `$PWD`)*, so the hook keeps a fingerprint of the rules file and the list of rule directories in shell variables and checks both in pure zsh. `zstat` is a builtin and `${PWD:P}` resolves symlinks in-process, so nothing forks:

```
cd work; cd apps; cd apps; cd work          ->  4 slopenv invocations
cd apps; cd deep; deeper; deepest; ..; ..   ->  2 slopenv invocations
```

The fingerprint is `inode:mtime:size`. The inode does the real work, since every write lands via `rename(2)` onto a fresh temp file, so any change to the rules file changes its inode. That is also what makes a `slopenv set` in one terminal show up in another: the hook is registered on `precmd` as well as `chpwd`, so the next prompt picks it up without a `cd`.

If you would rather have no shell-side caching, `slopenv hook zsh --simple` prints a hook that calls slopenv on every `cd`.

Measured on an Apple M3 Pro (macOS 14.7):

| | |
| --- | --- |
| `slopenv export`, nothing to activate | ~16 ms |
| `slopenv export`, activating a keychain secret | ~31 ms |
| a `cd` the fast path skips | no process spawned |

### Concurrent writes

Two terminals running `slopenv set` at the same instant would each read the old rules file, and the second write would silently erase the first one's rule. So every read-modify-write happens under an `O_EXCL` lock file (with owner-PID and stale-lock detection), and the write itself is temp file, `fsync`, `rename`. Readers never lock and never see a torn file.

The test suite runs 16 concurrent writers and checks that all 16 rules survive.

## Development

```sh
bun test                          # 298 tests
SLOPENV_KEYCHAIN_IT=1 bun test    # 308, incl. 10 against your real login keychain
bunx tsc --noEmit
bun run build
```

`SLOPENV_LOG=1` traces to stderr: which rule won, whether the keychain was hit.

CI runs the suite, a typecheck and a binary smoke test on macOS for every push. Pushing a `v*` tag builds both macOS architectures and attaches them to a GitHub release with `SHA256SUMS`. The workflow refuses to publish if the tag and `package.json` version disagree, since `slopenv --version` reads the latter.

The suite covers path matching (nesting, sibling prefixes, symlinks), the diff and restore semantics (enter, leave, re-enter, nested override, pre-existing value), shell quoting of 19 hostile values against real zsh and real bash, the rules-file round trip, lock behaviour, and an end-to-end zsh session that `cd`s around and reads the environment back, including checks on how many times the binary was spawned. Completion is tested by driving an interactive zsh through a pty and pressing TAB, since a completion script that loads is not the same as one that works. `update` is tested end to end against a fake release served from a local HTTP server, including a corrupted download and a missing checksum file, so the failure paths are exercised without the network.

## Uninstall

```sh
# Delete every keychain entry and rule slopenv owns.
slopenv list --json | grep -o '"name": "[^"]*"'   # review first
slopenv rm NAME DIR                               # per rule, deletes the keychain entry too

rm -rf ~/.slopenv
rm ~/.local/bin/slopenv
```

Then remove the `eval "$(slopenv hook zsh)"` line from `~/.zshrc`. Any leftover keychain entries live under the service name `slopenv` and can be found in Keychain Access by searching for it.
