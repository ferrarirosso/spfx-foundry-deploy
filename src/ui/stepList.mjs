// Visible step list for long-running operations (deploy / teardown).
//
// Prints all steps up front with a checkbox column; ticks them off in place
// as work completes. One in-progress step at a time gets an animated spinner.
//
// Pure ANSI + setInterval. Falls back to line-by-line printing when stdout
// isn't a TTY (CI logs, redirected output) so the output stays sensible.
//
// Important: callers MUST use async exec (lib/exec.mjs) so the event loop
// stays free and setInterval can keep ticking the spinner during az calls.
// Sync exec blocks the loop and the spinner appears frozen.

import { colors } from "../lib/log.mjs";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FALLBACK_FRAMES = ["|", "/", "-", "\\"];
const SPINNER_INTERVAL_MS = 100;

const STATE = {
  PENDING: "pending",
  RUNNING: "running",
  DONE: "done",
  FAIL: "fail",
  SKIP: "skip",
};

function pickFrames() {
  if (process.platform === "win32" && !process.env.WT_SESSION) {
    return FALLBACK_FRAMES;
  }
  return SPINNER_FRAMES;
}

function isInteractive() {
  return Boolean(process.stdout.isTTY);
}

/**
 * @param {Array<{label:string, note?:string}|string>} initial
 * @param {{ title?: string }} [opts]
 */
export function createStepList(initial, opts = {}) {
  const steps = initial.map((s) =>
    typeof s === "string"
      ? { label: s, note: "", state: STATE.PENDING }
      : { label: s.label, note: s.note || "", state: STATE.PENDING }
  );
  const title = opts.title;
  const tty = isInteractive();
  const frames = pickFrames();

  let frame = 0;
  let lastLineCount = 0;
  let timer = null;
  let suspended = false;

  const padNum = (i) => String(i + 1).padStart(2, " ");

  function statusGlyph(s) {
    switch (s.state) {
      case STATE.DONE:
        return `${colors.green}[✓]${colors.reset}`;
      case STATE.FAIL:
        return `${colors.red}[✗]${colors.reset}`;
      case STATE.SKIP:
        return `${colors.dim}[—]${colors.reset}`;
      case STATE.RUNNING:
        return `${colors.cyan}[${frames[frame % frames.length]}]${colors.reset}`;
      default:
        return `${colors.dim}[ ]${colors.reset}`;
    }
  }

  function lineFor(s, i) {
    const labelColor =
      s.state === STATE.DONE
        ? colors.green
        : s.state === STATE.FAIL
        ? colors.red
        : s.state === STATE.SKIP
        ? colors.dim
        : s.state === STATE.RUNNING
        ? colors.bold
        : "";
    const labelTxt = `${labelColor}${s.label}${colors.reset}`;
    const note = s.note ? `  ${colors.dim}${s.note}${colors.reset}` : "";
    return `  ${statusGlyph(s)} ${padNum(i)}. ${labelTxt}${note}`;
  }

  // Build the block as one screen line per array entry (no embedded \n in
  // any element). The first entry is a blank line above the title so the
  // block has visual breathing room without making the line count lie.
  function buildBlock() {
    const lines = [];
    if (title) {
      lines.push("");
      lines.push(`  ${colors.bold}${title}${colors.reset}`);
    }
    steps.forEach((s, i) => lines.push(lineFor(s, i)));
    return lines;
  }

  // Move cursor up + clear the previously rendered block. After write() of
  // N lines (each ending with \n), the cursor sits N lines below the top of
  // the block; one "up + clear" iteration per line walks back up clearing.
  function clearPrevious() {
    if (lastLineCount === 0) return;
    for (let i = 0; i < lastLineCount; i++) {
      process.stdout.write("\x1b[1A\x1b[2K\r");
    }
  }

  function render() {
    if (!tty || suspended) return;
    clearPrevious();
    const lines = buildBlock();
    lines.forEach((l) => process.stdout.write(l + "\n"));
    lastLineCount = lines.length;
  }

  function ensureSpinning() {
    if (!tty || suspended) return;
    if (timer) return;
    timer = setInterval(() => {
      frame++;
      render();
    }, SPINNER_INTERVAL_MS);
    if (typeof timer.unref === "function") timer.unref();
  }

  function stopSpinning() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function nonTtyLine(prefix, s, i) {
    process.stdout.write(`  ${prefix} ${padNum(i)}. ${s.label}${s.note ? "  — " + s.note : ""}\n`);
  }

  return {
    init() {
      if (!tty) {
        if (title) process.stdout.write(`\n  ${title}\n`);
        steps.forEach((s, i) => nonTtyLine("[ ]", s, i));
        return;
      }
      render();
      ensureSpinning();
    },
    start(i, note) {
      if (steps[i].state === STATE.DONE || steps[i].state === STATE.FAIL) return;
      steps[i].state = STATE.RUNNING;
      if (note !== undefined) steps[i].note = note;
      if (!tty) nonTtyLine("[…]", steps[i], i);
      else {
        ensureSpinning();
        render();
      }
    },
    update(i, note) {
      steps[i].note = note;
      if (!tty) return;
      render();
    },
    done(i, note) {
      steps[i].state = STATE.DONE;
      if (note !== undefined) steps[i].note = note;
      if (!tty) nonTtyLine("[✓]", steps[i], i);
      else render();
    },
    skip(i, note) {
      steps[i].state = STATE.SKIP;
      if (note !== undefined) steps[i].note = note;
      if (!tty) nonTtyLine("[-]", steps[i], i);
      else render();
    },
    fail(i, msg) {
      steps[i].state = STATE.FAIL;
      if (msg !== undefined) steps[i].note = msg;
      if (!tty) nonTtyLine("[✗]", steps[i], i);
      else render();
      stopSpinning();
    },
    // Pause spinner + redraw so an external command (e.g. `func publish`)
    // can take over the terminal without our redraw fighting its output.
    suspend() {
      suspended = true;
      stopSpinning();
      // Leave the current rendered block in place; the next external output
      // will appear below it.
      lastLineCount = 0;
    },
    // Resume rendering. The next render() prints fresh at the current cursor
    // position — so callers usually do `log("")` to leave a separator first.
    resume() {
      suspended = false;
      ensureSpinning();
      render();
    },
    close() {
      stopSpinning();
      if (tty && !suspended) render();
    },
  };
}
