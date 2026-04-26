// Plan view for `npm run teardown`. Shows all 3 cleanup items with their
// current "will do" state; the user can toggle any of them off by typing
// the corresponding number. Same shape as the deploy review form.

import { colors, log } from "../lib/log.mjs";
import { prompt } from "../lib/ask.mjs";

function pad(s, w) {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

function fmtItem(i, item) {
  const glyph = item.skip ? `${colors.dim}[skip]${colors.reset}` : `${colors.cyan}[do]${colors.reset}  `;
  const lbl = item.skip ? colors.dim : "";
  return `    ${glyph} [${i + 1}] ${lbl}${pad(item.label, 20)}${colors.reset}  ${colors.dim}${item.detail}${colors.reset}`;
}

export function renderPlan(items, { slug }) {
  log(`\n  ${colors.bold}This will tear down:${colors.reset}`);
  items.forEach((it, i) => log(fmtItem(i, it)));
  log(
    `\n  ${colors.cyan}[number]${colors.reset} toggle skip   ` +
      `${colors.cyan}[t]${colors.reset} tear down   ` +
      `${colors.cyan}[q]${colors.reset} quit`
  );
}

export async function runTeardownPlan(items, ctx) {
  while (true) {
    renderPlan(items, ctx);
    const choice = (await prompt("  > ")).toLowerCase();
    if (choice === "q" || choice === "quit") return false;
    if (choice === "t" || choice === "teardown") {
      const active = items.filter((it) => !it.skip);
      if (active.length === 0) {
        log(`\n  ${colors.yellow}Nothing to do — every item is skipped.${colors.reset}\n`);
        continue;
      }
      return true;
    }
    if (choice === "" || choice === "?" || choice === "h") continue;
    const n = Number(choice);
    if (!Number.isInteger(n) || n < 1 || n > items.length) {
      log(`\n  ${colors.yellow}Unrecognised input.${colors.reset} Type 1-${items.length}, 't', or 'q'.\n`);
      continue;
    }
    items[n - 1].skip = !items[n - 1].skip;
    log("");
  }
}
