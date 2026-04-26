#!/usr/bin/env node

/**
 * spfx-foundry-deploy — single-binary dispatcher.
 *
 * Subcommands:
 *   deploy        Provision (or reconcile) a Foundry-backed Function App proxy.
 *   setup         Re-wire serve.json from .deploy-output.json (no Azure calls).
 *   teardown      Delete the resource group + purge AI Services soft-delete.
 *   setup-local   Generate backend/local.settings.json for local `func start`.
 *
 * `--config` is optional. When omitted, the deployer infers `slug` from your
 * package.json `name` and defaults `profile` to "chat-completions". Pass
 * `--config ./deploy.config.json` only when you want to commit defaults.
 *
 * Examples:
 *   npx github:ferrarirosso/spfx-foundry-deploy deploy
 *   npx github:ferrarirosso/spfx-foundry-deploy deploy --config ./deploy.config.json
 *   npx github:ferrarirosso/spfx-foundry-deploy teardown
 *
 * After `npm install --save-dev @ferrarirosso/spfx-foundry-deploy`:
 *   spfx-foundry-deploy deploy
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SUBCOMMANDS = {
  deploy: "./deploy.mjs",
  setup: "./setup.mjs",
  teardown: "./teardown.mjs",
  "setup-local": "./setup-local.mjs",
};

function help() {
  console.log(
    [
      "spfx-foundry-deploy — provision a protected, Foundry-backed Function App proxy for SPFx.",
      "",
      "Usage:  spfx-foundry-deploy <subcommand> [flags]",
      "",
      "Subcommands:",
      "  deploy         Provision Azure resources, configure Easy Auth, deploy the proxy.",
      "  setup          Re-wire the calling webpart's serve.json from .deploy-output.json.",
      "  teardown       Delete the resource group + purge AI Services soft-delete + Entra app.",
      "  setup-local    Generate backend/local.settings.json for local `func start`.",
      "",
      "Common flags:",
      "  --config <path>     Path to deploy.config.json. Optional — when omitted, slug",
      "                      is inferred from package.json and profile defaults to",
      "                      \"chat-completions\".",
      "  --dry-run           Render the form, print the plan, skip Azure calls (deploy only).",
      "  --no-wire           Skip the serve.json patch step (deploy only).",
      "  --keep-app          Keep the Backend API Entra app registration (teardown).",
      "  --no-purge          Skip the AI Services soft-delete purge (teardown).",
      "  --keep-rg           Don't delete the resource group (teardown).",
      "  --yes               Skip the type-the-name confirmation gate (teardown, CI use).",
      "",
      "Docs: https://github.com/ferrarirosso/spfx-foundry-deploy",
    ].join("\n")
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const sub = argv[0];

  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    help();
    process.exit(sub ? 0 : 1);
  }

  const target = SUBCOMMANDS[sub];
  if (!target) {
    console.error(`Unknown subcommand: ${sub}`);
    console.error(`Try: spfx-foundry-deploy --help`);
    process.exit(2);
  }

  // Forward the rest of argv to the subcommand by mutating process.argv.
  // The subcommand modules read process.argv.slice(2) and parse their own flags.
  process.argv = [process.argv[0], process.argv[1], ...argv.slice(1)];

  const here = dirname(fileURLToPath(import.meta.url));
  await import(resolve(here, target));
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
