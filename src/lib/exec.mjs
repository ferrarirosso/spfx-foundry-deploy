import { exec as cpExec, execSync } from "node:child_process";
import { promisify } from "node:util";
import { logFail, logInfo, logOk } from "./log.mjs";

const execP = promisify(cpExec);

// Async exec — keeps the Node event loop free so setInterval-driven
// animations (e.g. the step-list spinner) can keep ticking while the
// child process runs.
export async function exec(cmd, options = {}) {
  try {
    const { stdout } = await execP(cmd, {
      encoding: "utf-8",
      timeout: options.timeout || 120_000,
      maxBuffer: 32 * 1024 * 1024,
      ...options,
    });
    return String(stdout).trim();
  } catch (error) {
    if (options.ignoreError) return "";
    const stderr = (error.stderr || "").toString().trim() || error.message;
    throw new Error(`Command failed: ${cmd}\n${stderr}`);
  }
}

// Sync exec for places where async would be a refactor headache and the
// command is fast (command-presence checks at startup).
export function execSyncCmd(cmd, options = {}) {
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      stdio: options.silent ? "pipe" : ["pipe", "pipe", "pipe"],
      timeout: options.timeout || 120_000,
      ...options,
    }).trim();
  } catch (error) {
    if (options.ignoreError) return "";
    const stderr = error.stderr?.toString().trim() || error.message;
    throw new Error(`Command failed: ${cmd}\n${stderr}`);
  }
}

export function execLive(cmd) {
  execSync(cmd, { stdio: "inherit", encoding: "utf-8" });
}

export function checkCommand(name) {
  try {
    const version = execSyncCmd(`${name} --version`, { silent: true });
    return version.split("\n")[0];
  } catch {
    return null;
  }
}

export function requireCommand(name, installUrl = "") {
  const version = checkCommand(name);
  if (!version) {
    logFail(`'${name}' is not installed.`);
    if (installUrl) logInfo(`Install: ${installUrl}`);
    process.exit(1);
  }
  logOk(`${name}: ${version}`);
  return version;
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

export function parseJsonOutput(value, fallback = null) {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed === "null") return fallback;
  return JSON.parse(trimmed);
}
