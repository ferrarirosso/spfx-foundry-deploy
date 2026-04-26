// Prefix picker — friendly resource-naming prefix for the deployment.
//
// Offers 3 randomly-generated adjective-adjective-noun combinations from
// curated positive-word lists, plus a "type your own" / re-roll option.
// The chosen prefix cascades through every Azure resource name in the
// review form.
//
// 60 adjectives × 59 distinct adjectives × 60 nouns ≈ 212,400 combos.

import { ask } from "../lib/ask.mjs";
import { colors, log } from "../lib/log.mjs";

const ADJECTIVES = [
  // 4-letter (15)
  "calm", "kind", "wise", "warm", "bold", "cozy", "spry", "keen", "rosy",
  "deft", "neat", "tidy", "snug", "lush", "sage",
  // 5-letter (24)
  "swift", "happy", "brave", "fresh", "quick", "clear", "vivid", "eager",
  "sunny", "agile", "smart", "lucky", "merry", "noble", "crisp", "sleek",
  "hardy", "balmy", "perky", "lithe", "peppy", "suave", "ardent", "chill",
  // 6-letter (18)
  "bright", "gentle", "nimble", "lively", "breezy", "zesty", "jolly", "serene",
  "plucky", "dapper", "snappy", "jaunty", "mellow", "dreamy", "cheery", "blithe",
  "robust", "hearty",
  // 7-letter (3)
  "vibrant", "radiant", "dashing",
];

const NOUNS = [
  // 3-letter (2)
  "bay", "ray",
  // 4-letter (12)
  "dawn", "glen", "isle", "pier", "vale", "mist", "cove", "tide", "peak",
  "dale", "reef", "mesa",
  // 5-letter (26)
  "cloud", "ember", "glade", "grove", "brook", "ridge", "haven", "trail",
  "fjord", "atlas", "comet", "delta", "orbit", "knoll", "shore", "slope",
  "vista", "aspen", "crest", "petal", "spire", "cedar", "maple", "marsh",
  "mound", "oasis",
  // 6-letter (16)
  "falcon", "meadow", "spring", "harbor", "summit", "valley", "breeze",
  "garden", "beacon", "willow", "linden", "canyon", "lagoon", "hollow",
  "aurora", "zenith",
  // 7-letter (4)
  "horizon", "prairie", "juniper", "savanna",
];

// Validation: 5-30 chars, lowercase letters/digits/hyphens, must start with
// a letter and end with letter-or-digit.
const PREFIX_PATTERN = /^[a-z][a-z0-9-]{3,28}[a-z0-9]$/;

function pickRandom(arr, n) {
  const out = [];
  const used = new Set();
  while (out.length < n && out.length < arr.length) {
    const i = Math.floor(Math.random() * arr.length);
    if (used.has(i)) continue;
    used.add(i);
    out.push(arr[i]);
  }
  return out;
}

function generateOption() {
  const [adj1, adj2] = pickRandom(ADJECTIVES, 2);
  const [noun] = pickRandom(NOUNS, 1);
  return `${adj1}-${adj2}-${noun}`;
}

function generateOptions(count = 3) {
  const out = new Set();
  let safety = count * 4;
  while (out.size < count && safety-- > 0) {
    out.add(generateOption());
  }
  return [...out];
}

export function isValidPrefix(value) {
  return PREFIX_PATTERN.test(value);
}

export async function pickPrefix(currentValue) {
  while (true) {
    const options = generateOptions(3);
    log(
      `\n  ${colors.bold}Pick a resource prefix${colors.reset} ` +
        `${colors.dim}(drives RG / AI / Function App / Storage names)${colors.reset}`
    );
    options.forEach((opt, i) => log(`    [${i + 1}] ${opt}`));
    log(`    [4] type your own`);
    log(`    [5] keep current  ${colors.dim}(${currentValue || "<none>"})${colors.reset}`);
    log(`    [6] re-roll`);

    const choice = (await ask("Choice", "1")).trim();
    const n = Number(choice);
    if (n >= 1 && n <= 3) return options[n - 1];
    if (n === 5 && currentValue) return currentValue;
    if (n === 6) continue; // loop redraws with fresh options
    if (n !== 4) {
      log(`  ${colors.yellow}Pick 1-6.${colors.reset}`);
      continue;
    }

    // Custom
    const custom = (await ask(
      "Prefix (lowercase letters, digits, hyphens; 5-30 chars)",
      currentValue
    )).trim().toLowerCase();
    if (!custom) continue;
    if (!isValidPrefix(custom)) {
      log(
        `  ${colors.red}Invalid prefix.${colors.reset} ` +
          `${colors.dim}Must start with a letter, end with a letter or digit, only a-z 0-9 -, 5-30 chars.${colors.reset}`
      );
      continue;
    }
    return custom;
  }
}
