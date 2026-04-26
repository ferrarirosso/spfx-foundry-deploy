import { colors } from "../lib/log.mjs";
import { ask, closePrompt } from "../lib/ask.mjs";

const KEY = {
  UP: "\x1b[A",
  DOWN: "\x1b[B",
  ENTER_R: "\r",
  ENTER_N: "\n",
  CTRL_C: "\x03",
  ESC: "\x1b",
  Q: "q",
};

function isTTY() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function clearLines(count) {
  // Each iteration: cursor up one line + clear that line. Doing exactly
  // `count` iterations from the line below the rendered block leaves the
  // cursor at the top of the (now blank) block, ready to redraw.
  for (let i = 0; i < count; i++) {
    process.stdout.write("\x1b[1A\x1b[2K\r");
  }
}

// Compute how many items we can show without exceeding the terminal viewport.
// Reserve room for the title, two possible "more above/below" indicators,
// the helper line at the bottom, and a couple of breathing-room lines.
function viewportSize(itemCount) {
  const rows = process.stdout.rows || 30;
  const overhead = 6; // title + 2 indicators + helper + 2 cushion
  return Math.max(3, Math.min(itemCount, rows - overhead));
}

// One screen line per buildBlock entry. Windows the items list around the
// current selection so the block always fits the terminal, regardless of
// how many models the user is paging through.
function buildBlock(title, items, label, selected) {
  const total = items.length;
  const viewport = viewportSize(total);
  const halfWindow = Math.floor(viewport / 2);

  let start = Math.max(0, selected - halfWindow);
  let end = Math.min(total, start + viewport);
  // If we hit the bottom edge, slide the window up so it stays full.
  start = Math.max(0, end - viewport);

  const lines = [];
  lines.push(`  ${colors.bold}${title}${colors.reset}`);
  if (start > 0) {
    lines.push(`    ${colors.dim}↑ ${start} more above${colors.reset}`);
  }
  for (let i = start; i < end; i++) {
    const text = label(items[i]);
    if (i === selected) {
      lines.push(`  ${colors.cyan}▸ ${text}${colors.reset}`);
    } else {
      lines.push(`    ${colors.dim}${text}${colors.reset}`);
    }
  }
  if (end < total) {
    lines.push(`    ${colors.dim}↓ ${total - end} more below${colors.reset}`);
  }
  lines.push(
    `  ${colors.cyan}↑/↓${colors.reset} navigate   ` +
      `${colors.cyan}Enter${colors.reset} select   ` +
      `${colors.cyan}Ctrl-C${colors.reset} cancel`
  );
  return lines;
}

async function fallbackPick(title, items, label, defaultIndex) {
  const lines = items.map((item, i) => `    ${i + 1}. ${label(item)}`);
  console.log(`  ${title}`);
  for (const line of lines) console.log(line);
  const def = String(defaultIndex + 1);
  while (true) {
    const answer = await ask(`Pick a number`, def);
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= items.length) {
      return items[n - 1];
    }
    console.log(`  ${colors.red}Out of range; try 1..${items.length}${colors.reset}`);
  }
}

export async function pickFromList({
  title,
  items,
  label = (x) => String(x),
  defaultIndex = 0,
}) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error(`pickFromList(${title}): no items to pick from`);
  }
  if (items.length === 1) {
    console.log(`  ${title}`);
    console.log(`  ${colors.green}▸ ${label(items[0])}${colors.reset} ${colors.dim}(only option)${colors.reset}`);
    return items[0];
  }
  if (!isTTY()) {
    return fallbackPick(title, items, label, defaultIndex);
  }

  closePrompt();

  return new Promise((resolve, reject) => {
    let selected = Math.max(0, Math.min(defaultIndex, items.length - 1));
    let lastLineCount = 0;

    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    const draw = () => {
      if (lastLineCount > 0) clearLines(lastLineCount);
      const lines = buildBlock(title, items, label, selected);
      lines.forEach((l) => process.stdout.write(l + "\n"));
      lastLineCount = lines.length;
    };

    const cleanup = () => {
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stdin.removeListener("data", onData);
    };

    const onData = (data) => {
      if (data === KEY.CTRL_C) {
        cleanup();
        process.stdout.write("\n");
        reject(new Error("User cancelled"));
        process.exit(130);
        return;
      }
      if (data === KEY.UP) {
        selected = (selected - 1 + items.length) % items.length;
        draw();
        return;
      }
      if (data === KEY.DOWN) {
        selected = (selected + 1) % items.length;
        draw();
        return;
      }
      if (data === KEY.ENTER_R || data === KEY.ENTER_N) {
        cleanup();
        process.stdout.write("\n");
        resolve(items[selected]);
        return;
      }
    };

    stdin.on("data", onData);
    draw();
  });
}
