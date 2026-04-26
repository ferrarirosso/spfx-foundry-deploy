const supportsColor =
  process.env.FORCE_COLOR !== "0" &&
  (process.env.FORCE_COLOR || process.stdout.isTTY);

export const colors = {
  reset: supportsColor ? "\x1b[0m" : "",
  green: supportsColor ? "\x1b[32m" : "",
  red: supportsColor ? "\x1b[31m" : "",
  yellow: supportsColor ? "\x1b[33m" : "",
  blue: supportsColor ? "\x1b[34m" : "",
  cyan: supportsColor ? "\x1b[36m" : "",
  dim: supportsColor ? "\x1b[2m" : "",
  bold: supportsColor ? "\x1b[1m" : "",
};

export function log(msg, color = "") {
  console.log(`${color}${msg}${colors.reset}`);
}

export function logStep(step, msg) {
  log(`\n[${"=".repeat(60)}]`, colors.cyan);
  log(`  Step ${step}: ${msg}`, colors.bold);
  log(`[${"=".repeat(60)}]`, colors.cyan);
}

export function logOk(msg) {
  log(`  ✓ ${msg}`, colors.green);
}

export function logSkip(msg) {
  log(`  → ${msg} (already exists, skipping)`, colors.yellow);
}

export function logFail(msg) {
  log(`  ✗ ${msg}`, colors.red);
}

export function logInfo(msg) {
  log(`  ${msg}`, colors.dim);
}

export function banner(title) {
  const line = "═".repeat(60);
  log(`\n╔${line}╗`, colors.cyan);
  log(`║  ${title.padEnd(58)}║`, colors.cyan);
  log(`╚${line}╝\n`, colors.cyan);
}
