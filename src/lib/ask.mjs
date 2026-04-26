import { createInterface } from "node:readline";

let rlInstance = null;

function getRL() {
  if (!rlInstance) {
    rlInstance = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }
  return rlInstance;
}

// DECSCUSR sequences: "5 q" = blinking bar, "0 q" = restore terminal default.
// Forced while waiting for input so the affordance is unmistakable on
// terminals that default to steady-block or invisible cursors.
const CURSOR_BLINK = "\x1b[5 q";
const CURSOR_RESET = "\x1b[0 q";

export function ask(question, defaultValue = "") {
  return new Promise((resolve) => {
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    process.stdout.write(CURSOR_BLINK);
    getRL().question(`  ${question}${suffix}: `, (answer) => {
      process.stdout.write(CURSOR_RESET);
      resolve(answer.trim() || defaultValue);
    });
  });
}

// Raw prompt — no leading "  ", no trailing ": ", no default-value bracket.
// Use for command-style prompts (e.g. the review form's `> _`).
export function prompt(label) {
  return new Promise((resolve) => {
    process.stdout.write(CURSOR_BLINK);
    getRL().question(label, (answer) => {
      process.stdout.write(CURSOR_RESET);
      resolve(answer.trim());
    });
  });
}

export async function askSecret(question) {
  return ask(question);
}

export async function confirm(question, defaultYes = true) {
  const def = defaultYes ? "yes" : "no";
  const answer = (await ask(`${question} (yes/no)`, def)).toLowerCase();
  return answer === "yes" || answer === "y";
}

export function closePrompt() {
  if (rlInstance) {
    rlInstance.close();
    rlInstance = null;
  }
}
