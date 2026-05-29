import { execFile as cpExecFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { logFail, logInfo, logOk } from "./log.mjs";

const execFileP = promisify(cpExecFile);

// Option keys that belong to *this* wrapper, not to child_process. Stripped
// before the rest is forwarded so execFile never sees them.
const WRAPPER_KEYS = new Set(["silent", "ignoreError"]);

function childOptions(options) {
  const out = {
    encoding: "utf-8",
    timeout: options.timeout || 120_000,
    maxBuffer: 32 * 1024 * 1024,
  };
  for (const [k, v] of Object.entries(options)) {
    if (WRAPPER_KEYS.has(k) || k === "timeout" || k === "maxBuffer" || k === "encoding") continue;
    out[k] = v;
  }
  return out;
}

// Redacted command label for error messages. We deliberately do NOT echo the
// full argument vector: args can carry secrets (e.g. an App Insights
// connection string passed to `appsettings set`). The subcommand verbs are
// enough to locate the failure; the real diagnostics come from stderr.
function redactCommand(file, args) {
  const head = [];
  for (const a of args) {
    if (a.startsWith("-")) break; // stop at the first flag — values follow
    head.push(a);
    if (head.length >= 3) break;
  }
  const suffix = args.length > head.length ? " …" : "";
  return `${file} ${head.join(" ")}${suffix}`.trim();
}

// Safe primitive: run a command with an explicit argument vector via
// execFile. There is NO shell, so nothing in `args` can be interpreted as
// shell syntax (`;`, `$(...)`, backticks, quotes, redirection are all inert).
// This is the only way the codebase invokes external commands — `az`, `func`,
// `node` — so config-derived values can never reach a shell. Returns trimmed
// stdout; honours { silent, ignoreError, timeout, cwd, env }.
export async function run(file, args = [], options = {}) {
  try {
    const { stdout } = await execFileP(file, args, childOptions(options));
    return String(stdout).trim();
  } catch (error) {
    if (options.ignoreError) return "";
    // Surface the child's stderr (where az/func write real diagnostics) but
    // NEVER error.message — execFile sets it to the full command line, which
    // would re-introduce the very arg values (secrets, connection strings) we
    // redact from the label below.
    const stderr = (error.stderr || "").toString().trim();
    let reason = stderr;
    if (!reason) {
      if (typeof error.code === "number") reason = `exited with code ${error.code}`;
      else if (error.code) reason = String(error.code);
      else if (error.signal) reason = `terminated by signal ${error.signal}`;
      else reason = "command failed";
    }
    throw new Error(`Command failed: ${redactCommand(file, args)}\n${reason}`);
  }
}

// Live, inherited-stdio variant for commands that own the terminal (e.g.
// `func azure functionapp publish`, which streams its own build output).
// spawnSync with no shell — same injection-proof guarantee as run().
export function runLive(file, args = [], options = {}) {
  const result = spawnSync(file, args, { stdio: "inherit", encoding: "utf-8", ...options });
  if (result.error) throw result.error;
  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(`Command failed (exit ${result.status}): ${redactCommand(file, args)}`);
  }
}

export function checkCommand(name) {
  try {
    const version = execFileSync(name, ["--version"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120_000,
    });
    return String(version).trim().split("\n")[0];
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

export function parseJsonOutput(value, fallback = null) {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed === "null") return fallback;
  return JSON.parse(trimmed);
}
