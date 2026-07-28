import { rulesFilePath } from "./paths.ts";
import { defaultSecretStore, type SecretStore } from "./secrets/index.ts";

export interface Context {
  rulesPath: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** stdout. Only `export` writes anything the shell will evaluate. */
  out(text: string): void;
  /** stderr. Everything diagnostic. */
  err(text: string): void;
  /**
   * True when stdout is a terminal — i.e. nothing is capturing it. `off` and `on`
   * only mean anything when a shell is evaluating what they print, and this is how
   * they tell that nobody is.
   */
  stdoutIsTty: boolean;
  /** Lazy so commands that never touch secrets work on unsupported platforms. */
  secretStore(): SecretStore;
}

export interface ContextOverrides {
  rulesPath?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  out?(text: string): void;
  err?(text: string): void;
  stdoutIsTty?: boolean;
  store?: SecretStore;
}

export function createContext(overrides: ContextOverrides = {}): Context {
  const env = overrides.env ?? process.env;
  let cached: SecretStore | undefined = overrides.store;

  return {
    rulesPath: overrides.rulesPath ?? rulesFilePath(env),
    env,
    cwd: overrides.cwd ?? process.cwd(),
    out: overrides.out ?? ((text) => process.stdout.write(text)),
    err: overrides.err ?? ((text) => process.stderr.write(text)),
    stdoutIsTty: overrides.stdoutIsTty ?? process.stdout.isTTY === true,
    secretStore() {
      cached ??= defaultSecretStore();
      return cached;
    },
  };
}
