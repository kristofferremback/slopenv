import { closeSync, openSync, readSync } from "node:fs";
import { fail } from "./errors.ts";

export interface ReadValueOptions {
  /** Turn off terminal echo. True for secrets, false for plain values. */
  hidden: boolean;
}

/**
 * Read a value interactively, so a secret never lands in shell history.
 *
 * Reads from /dev/tty rather than stdin, so redirection can't feed us something
 * by accident — but if stdin is not a terminal we take the value from there
 * instead, which makes `cat token.txt | slopenv set --secret TOKEN` work.
 */
export function readValue(promptText: string, options: ReadValueOptions): string {
  if (!process.stdin.isTTY) return trimTrailingNewlines(readAllStdin());

  let fd: number;
  try {
    fd = openSync("/dev/tty", "r");
  } catch {
    return trimTrailingNewlines(readAllStdin());
  }

  try {
    if (options.hidden) setEcho(false);
    process.stderr.write(promptText);
    const value = readLine(fd);
    if (options.hidden) process.stderr.write("\n");
    return trimTrailingNewlines(value);
  } finally {
    if (options.hidden) setEcho(true);
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
  }
}

/**
 * Trailing newlines are almost always an artefact of how the value got here —
 * a pasted line, or a file that ends in one — not part of the token.
 */
export function trimTrailingNewlines(value: string): string {
  return value.replace(/[\r\n]+$/, "");
}

function setEcho(on: boolean): void {
  Bun.spawnSync(["/bin/stty", on ? "echo" : "-echo"], { stdin: "inherit", stdout: "ignore", stderr: "ignore" });
}

function readLine(fd: number): string {
  const chunks: Buffer[] = [];
  const byte = Buffer.alloc(1);

  for (;;) {
    let read: number;
    try {
      read = readSync(fd, byte, 0, 1, null);
    } catch {
      break;
    }
    if (read === 0) break;
    if (byte[0] === 0x0a) break; // \n
    if (byte[0] === 0x04) break; // ^D
    chunks.push(Buffer.from(byte));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function readAllStdin(): string {
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(64 * 1024);
  for (;;) {
    let read: number;
    try {
      read = readSync(0, buf, 0, buf.length, null);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EAGAIN") continue;
      break;
    }
    if (read === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, read)));
  }

  const value = Buffer.concat(chunks).toString("utf8");
  if (trimTrailingNewlines(value) === "") {
    fail("no value given — pass it as NAME=VALUE, or pipe it on stdin");
  }
  return value;
}

/** Can we ask the user a question at all? */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY);
}

/**
 * A yes/no question, default no. Only ever called after `isInteractive()`, so a
 * script never blocks on a prompt it cannot answer.
 */
export function confirm(question: string): boolean {
  let fd: number;
  try {
    fd = openSync("/dev/tty", "r");
  } catch {
    return false;
  }

  try {
    process.stderr.write(question);
    return /^y(es)?$/i.test(readLine(fd).trim());
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
  }
}

/** `•••` plus the last 4 characters — enough to recognise a value, not to use it. */
export function maskSecret(value: string): string {
  if (value.length <= 4) return "•".repeat(Math.max(value.length, 1));
  return `•••${value.slice(-4)}`;
}
