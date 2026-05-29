#!/usr/bin/env node

/**
 * spfx-foundry-setup-local
 *
 * Generates <webpart>/backend/local.settings.json so you can run the proxy
 * locally with `func start`. Used during proxy development; not needed for
 * the typical SPFx workflow (see `spfx-foundry-setup` for the SPFx side).
 *
 * Usage from a webpart:
 *   spfx-foundry-deploy setup-local
 */

import { resolve } from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import {
  banner,
  logOk,
  logFail,
  logInfo,
  log,
  colors,
} from "../src/lib/log.mjs";
import { ask, askSecret, confirm, closePrompt } from "../src/lib/ask.mjs";
import { loadOrInferConfig, parseArgs } from "../src/lib/config.mjs";

const DEFAULT_API_VERSION = "2025-01-01-preview";
const DEFAULT_REASONING_EFFORT = "low";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { config, configDir, inferred, slugSource } = loadOrInferConfig(args.config);
  const webpartDir = args.webpart ? resolve(args.webpart) : configDir;
  const backendDir = resolve(webpartDir, "backend");
  if (!existsSync(backendDir)) {
    logFail(`Backend directory not found: ${backendDir}`);
    process.exit(1);
  }
  const settingsPath = resolve(backendDir, "local.settings.json");

  banner(`spfx-foundry-setup-local — ${config.slug}`);
  if (inferred) {
    logInfo(
      `No deploy.config.json found — using slug="${config.slug}" (from ${slugSource}).`
    );
  }

  if (existsSync(settingsPath)) {
    log("  local.settings.json already exists.", colors.yellow);
    if (!(await confirm("Overwrite?", false))) {
      log("  Setup cancelled.", colors.yellow);
      closePrompt();
      return;
    }
  }

  log("\n  Configure your local proxy settings:\n", colors.dim);
  logInfo(
    "Foundry accounts provisioned by `deploy` have key auth disabled — leave the"
  );
  logInfo(
    "API key empty and authenticate locally with managed identity (`az login`)."
  );
  logInfo(
    "A key only works against an account that still allows local/key auth."
  );
  log("");
  const endpoint = await ask(
    "Azure OpenAI / Foundry endpoint (e.g. https://<name>.openai.azure.com)",
    ""
  );
  const deploymentName = await ask(
    "Deployment name",
    `${config.slug.replace(/[^a-z0-9-]/g, "")}-gpt5mini`
  );
  const apiKey = await askSecret(
    "API key (leave empty for managed identity — recommended)"
  );
  const allowedOriginRaw = await ask("Allowed local origin", "https://localhost:4322");
  const allowedOrigin = allowedOriginRaw.replace(/\/+$/, "");

  closePrompt();

  const settings = {
    IsEncrypted: false,
    Values: {
      FUNCTIONS_WORKER_RUNTIME: "node",
      AzureWebJobsStorage: "",
      AZURE_OPENAI_ENDPOINT: endpoint,
      AZURE_OPENAI_API_VERSION: DEFAULT_API_VERSION,
      AZURE_OPENAI_DEPLOYMENT: deploymentName,
      AZURE_OPENAI_REASONING_EFFORT: DEFAULT_REASONING_EFFORT,
      ALLOWED_ORIGIN: allowedOrigin,
      ALLOW_PERMISSIVE_LOCAL_CORS: "true",
      REQUESTS_PER_MINUTE: String(config.requestLimits?.perMinute ?? 30),
      REQUESTS_PER_DAY: String(config.requestLimits?.perDay ?? 1000),
    },
  };
  if (apiKey) {
    settings.Values.AZURE_OPENAI_API_KEY = apiKey;
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  logOk(`Created: ${settingsPath}`);

  log("\n  To start the proxy locally:", colors.bold);
  logInfo("cd backend && npm start");
  logInfo("Then test: curl http://localhost:7071/api/health");
  if (apiKey) {
    logInfo("Auth: using API key (only works if the Foundry account allows local/key auth)");
  } else {
    logInfo("Auth: using managed identity (run 'az login' first)");
  }
}

main().catch((error) => {
  logFail(error.message);
  closePrompt();
  process.exit(1);
});
