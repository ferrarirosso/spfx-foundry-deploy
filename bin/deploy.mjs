#!/usr/bin/env node

/**
 * spfx-foundry-deploy
 *
 * Provisions a Foundry-backed Function App proxy + SPFx-grant + Easy Auth, then
 * (optionally) wires the calling webpart's serve.json so `npm start` opens the
 * SharePoint workbench with the property pane pre-filled.
 *
 * Usage from a webpart:
 *   spfx-foundry-deploy deploy
 *
 * Flags:
 *   --config <path>       Path to deploy.config.json. Optional — when omitted,
 *                         slug is inferred from package.json and profile
 *                         defaults to "chat-completions".
 *   --dry-run             Run prompts and print plan; do not call Azure.
 *   --no-wire             Skip the serve.json patch step.
 *   --harden-existing     Also apply create-only hardening (disable Foundry key
 *                         auth, storage TLS/no-public-blob) to resources that
 *                         already exist. Off by default.
 *   --webpart <path>      Override the webpart dir (defaults to dirname(--config) or cwd).
 */

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { run, parseJsonOutput, requireCommand } from "../src/lib/exec.mjs";
import {
  banner,
  log,
  logOk,
  logFail,
  logInfo,
  colors,
} from "../src/lib/log.mjs";
import { ask, closePrompt } from "../src/lib/ask.mjs";
import { loadOrInferConfig, findRepoRoot, parseArgs } from "../src/lib/config.mjs";
import { validateDeployConfig } from "../src/lib/validate.mjs";
import { pickSubscription } from "../src/prompts/pickSubscription.mjs";
import { suggestSharePointOrigin } from "../src/prompts/pickSharePointOrigin.mjs";
import { listModelsInRegion } from "../src/prompts/pickModel.mjs";
import { deployChatCompletionsBackend } from "../src/profile/chat-completions.mjs";
import { deployMultiModelBackend } from "../src/profile/multi-model.mjs";
import { writeDeployOutput, readDeployOutput } from "../src/wiring/deployOutput.mjs";
import { patchServeJson } from "../src/wiring/serveJson.mjs";
import { patchPackageSolution } from "../src/wiring/packageSolution.mjs";
import { resolveServeProperties } from "../src/wiring/serveProperties.mjs";
import { runReviewForm, runMultiModelReviewForm, buildPlanSummary } from "../src/ui/reviewForm.mjs";
import { deriveNames, inferPrefixFromConfig } from "../src/lib/naming.mjs";

const PROFILES = {
  "chat-completions": deployChatCompletionsBackend,
  "multi-model": deployMultiModelBackend,
};

function help() {
  console.log(`spfx-foundry-deploy
Usage: spfx-foundry-deploy deploy --config <path> [--dry-run] [--no-wire]
`);
}

async function pickInitialModel(location, configModelName) {
  // Try to find the requested model in the region. If unavailable (or none
  // requested), fall back to the first available chat model.
  const models = await listModelsInRegion(location);
  if (models.length === 0) {
    // Region has no OpenAI models — let the form deal with it (user can
    // change region; if they don't, deploy will fail with a clear error).
    return {
      modelName: configModelName || "gpt-5-mini",
      modelVersion: "auto",
      skuName: "GlobalStandard",
      skuCapacity: 40,
    };
  }
  if (configModelName) {
    const match = models.find((m) => m.modelName === configModelName);
    if (match) return match;
  }
  return models.find((m) => m.modelName === "gpt-5-mini") || models[0];
}

// Multi-model flow: explicit config.models[], no model picker / review form.
// Mirrors the single-model tail (deploy output + serve.json wiring + property
// echo) so multi-model consumers get the same operator experience.
async function runMultiModel({ config, args, account, sub, repoRoot, webpartDir, backendDir, isDryRun, hardenExisting }) {
  if (!Array.isArray(config.models) || config.models.length === 0) {
    logFail("Profile 'multi-model' requires a non-empty 'models' array in deploy.config.json.");
    process.exit(1);
  }

  const namePrefix = inferPrefixFromConfig(config);
  const derived = deriveNames(namePrefix, namePrefix);

  // Editable one-screen review form (same UX as single-model), minus the
  // model picker — deployments are declared in config.models[].
  const state = {
    subscriptionId: sub.subscriptionId,
    tenantId: sub.tenantId,
    subscriptionName: sub.name,
    subscriptionLabel: `${sub.name}  ${sub.subscriptionId}`,
    namePrefix,
    location: config.location || "swedencentral",
    regionLabel: config.location || "swedencentral",
    resourceGroup: derived.resourceGroup,
    aiServicesName: derived.aiServicesName,
    functionAppName: derived.functionAppName,
    storageName: derived.storageName,
    backendApiAppDisplayName: derived.backendApiAppDisplayName,
    sharepointOrigin: config.sharepointOrigin || (await suggestSharePointOrigin()),
  };

  const wantDeploy = await runMultiModelReviewForm(state, {
    models: config.models,
    requestLimits: config.requestLimits,
  });
  if (!wantDeploy) {
    log("\n  Cancelled.", colors.yellow);
    closePrompt();
    process.exit(0);
  }

  const resolved = {
    namePrefix: state.namePrefix,
    resourceGroup: state.resourceGroup,
    location: state.location,
    aiServicesName: state.aiServicesName,
    functionAppName: state.functionAppName,
    storageName: state.storageName,
    backendApiAppDisplayName: state.backendApiAppDisplayName,
    sharepointOrigin: state.sharepointOrigin,
  };

  const cachedDeployOutput = readDeployOutput(repoRoot)[config.slug] || {};
  const resolvedServeProperties = await resolveServeProperties(
    config.serveProperties,
    cachedDeployOutput.serveProperties
  );

  if (isDryRun) {
    logOk("Dry-run: would now provision the resources above.");
    closePrompt();
    return;
  }

  log("");
  log("  ⚠  This creates billable Azure resources.", colors.yellow);
  const typed = (await ask("Type 'deploy' to confirm", "")).trim().toLowerCase();
  closePrompt();
  if (typed !== "deploy") {
    log("\n  Cancelled.", colors.yellow);
    process.exit(0);
  }

  const result = await PROFILES["multi-model"]({
    config,
    resolved,
    account: { subscriptionId: state.subscriptionId, tenantId: state.tenantId, name: account.user?.name },
    backendDir,
    hardenExisting,
  });

  const outputPath = writeDeployOutput(repoRoot, config.slug, {
    backendUrl: result.proxyUrl,
    backendApiResource: result.backendApiResource,
    backendApiAppId: result.backendApiAppId,
    backendApiAppDisplayName: result.backendApiAppDisplayName,
    namePrefix: resolved.namePrefix,
    resourceGroup: result.resourceGroup,
    location: result.location,
    aiServicesName: result.aiServicesName,
    functionAppName: result.functionAppName,
    deployments: result.deployments,
    profile: config.profile,
    serveProperties: resolvedServeProperties,
  });
  logOk(`Saved deploy output: ${outputPath}`);

  if (args["no-wire"]) {
    logInfo("--no-wire: skipping serve.json + package-solution.json patches.");
  } else {
    try {
      const { servePath } = patchServeJson(webpartDir, {});
      logOk(`Cleaned ${servePath.replace(repoRoot + "/", "")}`);
    } catch (error) {
      logFail(`Could not patch serve.json: ${error.message}`);
      logInfo("Re-run any time with: npm run setup");
    }
    try {
      const { path: pkgPath, action } = patchPackageSolution(
        webpartDir,
        result.backendApiAppDisplayName
      );
      const verb = action === "unchanged" ? "verified" : action;
      logOk(`Wired ${pkgPath.replace(repoRoot + "/", "")}  (webApiPermissionRequests ${verb})`);
    } catch (error) {
      logFail(`Could not patch package-solution.json: ${error.message}`);
      logInfo("Re-run any time with: npm run setup");
    }
  }
  closePrompt();

  const paneProps = {
    backendUrl: result.proxyUrl,
    backendApiResource: result.backendApiResource,
    ...resolvedServeProperties,
  };
  const paneKeys = Object.keys(paneProps);
  log(`\n  Set these in the property pane / extension properties on first use:\n`, colors.bold);
  const maxKeyLen = Math.max(...paneKeys.map((k) => k.length));
  for (const key of paneKeys) {
    const value = paneProps[key];
    const display = value === undefined || value === null || value === ""
      ? `${colors.dim}(empty — fill in the property pane)${colors.reset}`
      : value;
    log(`    ${key.padEnd(maxKeyLen)}  =  ${display}`);
  }
  log("");
  logInfo("Easy Auth gates the proxy via the SPFx-acquired Entra token.");
  logInfo("Tear down with 'npm run teardown' when you're done.");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    help();
    process.exit(0);
  }

  // npm consumes --dry-run after `npm run <script>`, but exposes it as
  // npm_config_dry_run=true. Honour it so `npm run deploy --dry-run` works
  // even though npm strips the flag before our argv sees it.
  const isDryRun =
    Boolean(args["dry-run"]) || process.env.npm_config_dry_run === "true";

  // Opt-in: also apply create-only hardening (disableLocalAuth on Foundry,
  // storage TLS/no-public-blob) to resources that already exist. Off by
  // default so a routine redeploy never silently flips a running resource.
  const hardenExisting = Boolean(args["harden-existing"]);

  const { config, configDir, configPath, inferred, slugSource, profileSource } =
    loadOrInferConfig(args.config);
  const profile = PROFILES[config.profile];
  if (!profile) {
    logFail(`Unknown profile: ${config.profile}. Known: ${Object.keys(PROFILES).join(", ")}`);
    process.exit(1);
  }

  // Defense-in-depth: reject malformed config before any Azure work. (Command
  // execution is already shell-free via execFile, so this is hygiene, not the
  // security boundary.)
  try {
    validateDeployConfig(config);
  } catch (error) {
    logFail(error.message);
    process.exit(1);
  }

  const webpartDir = args.webpart ? resolve(args.webpart) : configDir;
  const repoRoot = findRepoRoot(webpartDir);
  // Most repos keep the proxy at <webpart>/backend. Repos that split the SPFx
  // solution and the Function backend (e.g. spfx/ + backend/) can set
  // config.backendPath (relative to the config file) to point at it.
  const backendDir = config.backendPath
    ? resolve(configDir, config.backendPath)
    : resolve(webpartDir, "backend");
  if (!existsSync(backendDir)) {
    logFail(`Backend directory not found: ${backendDir}`);
    logInfo("Expected '<webpart>/backend' or the path in config.backendPath.");
    process.exit(1);
  }

  banner(`spfx-foundry-deploy — ${config.slug}`);
  if (inferred) {
    logInfo(
      `No deploy.config.json found — using slug="${config.slug}" (from ${slugSource}), profile="${config.profile}" (default).`
    );
  } else {
    logInfo(`Config:    ${configPath.replace(repoRoot + "/", "")}`);
    if (slugSource !== "config file") {
      logInfo(`           slug="${config.slug}" (from ${slugSource})`);
    }
    if (profileSource !== "config file") {
      logInfo(`           profile="${config.profile}" (default)`);
    }
  }
  logInfo(`Webpart:   ${webpartDir.replace(repoRoot + "/", "")}`);
  logInfo(`Repo root: ${repoRoot}  ${colors.dim}(.deploy-output.json lives here)${colors.reset}`);

  // ── Prereqs (silent unless missing) ─────────────────────────
  requireCommand("node", "https://nodejs.org");
  requireCommand("az", "https://learn.microsoft.com/cli/azure/install-azure-cli");
  if (!isDryRun) {
    requireCommand(
      "func",
      "https://learn.microsoft.com/azure/azure-functions/functions-run-local"
    );
  }

  // ── Azure login (interactive only if not already logged in) ─
  let account = parseJsonOutput(
    await run("az", ["account", "show", "--output", "json"], { silent: true, ignoreError: true })
  );
  if (!account) {
    if (isDryRun) {
      logFail("Not logged in to Azure. Run 'az login' first (required even for --dry-run).");
      process.exit(1);
    }
    logInfo("Not logged in. Opening browser for Azure login…");
    await run("az", ["login", "--output", "none"]);
    account = parseJsonOutput(await run("az", ["account", "show", "--output", "json"], { silent: true }));
  }
  if (!account) {
    logFail("Could not detect Azure login.");
    process.exit(1);
  }
  logOk(`Logged in as: ${account.user?.name || "unknown"}`);

  // ── Subscription pick (auto-skips if only 1) ────────────────
  const sub = await pickSubscription();

  // ── Multi-model route ───────────────────────────────────────
  // The single-model flow below (picker → review form → resolved.model) is
  // deeply single-model. multi-model is a separate recipe: explicit
  // config.models[], no picker. Branch here so the single-model path stays
  // byte-for-byte unchanged for existing chat-completions consumers.
  if (config.profile === "multi-model") {
    await runMultiModel({
      config, args, account, sub, repoRoot, webpartDir, backendDir, isDryRun, hardenExisting,
    });
    return;
  }

  // ── Build initial state for the review form ─────────────────
  const namePrefix = inferPrefixFromConfig(config);
  const initialLocation = config.location || "swedencentral";
  const initialModel = await pickInitialModel(initialLocation, config.model?.name);
  const derivedNames = deriveNames(namePrefix, initialModel.modelName);

  const state = {
    subscriptionId: sub.subscriptionId,
    tenantId: sub.tenantId,
    subscriptionName: sub.name,
    subscriptionLabel: `${sub.name}  ${sub.subscriptionId}`,
    namePrefix,
    location: initialLocation,
    regionLabel: initialLocation,
    modelName: initialModel.modelName,
    modelVersion: initialModel.modelVersion,
    skuName: initialModel.skuName,
    skuCapacity: initialModel.skuCapacity,
    resourceGroup: derivedNames.resourceGroup,
    aiServicesName: derivedNames.aiServicesName,
    functionAppName: derivedNames.functionAppName,
    storageName: derivedNames.storageName,
    deploymentName: derivedNames.deploymentName,
    backendApiAppDisplayName: derivedNames.backendApiAppDisplayName,
    sharepointOrigin: await suggestSharePointOrigin(),
  };

  const formCtx = {
    slug: config.slug,
    requestLimits: config.requestLimits,
    planSummary: buildPlanSummary(),
  };

  const wantDeploy = await runReviewForm(state, formCtx);
  if (!wantDeploy) {
    log("\n  Cancelled.", colors.yellow);
    closePrompt();
    process.exit(0);
  }

  // Prompt for any serveProperties left empty in deploy.config.json — the
  // empty-string contract means "ask me at deploy time, don't bake the value
  // into the file". Resolved values are wired into serve.json only.
  // Cached values from a previous deploy (if any) become prompt defaults so
  // the operator doesn't have to retype tenant GUIDs on every redeploy.
  const cachedDeployOutput = readDeployOutput(repoRoot)[config.slug] || {};
  const resolvedServeProperties = await resolveServeProperties(
    config.serveProperties,
    cachedDeployOutput.serveProperties
  );

  if (isDryRun) {
    logOk("Dry-run: would now proceed with the deployment steps against the values above.");
    closePrompt();
    return;
  }

  // ── Final type-the-word safety gate ─────────────────────────
  log("");
  log("  ⚠  This creates billable Azure resources.", colors.yellow);
  const typed = (await ask("Type 'deploy' to confirm", "")).trim().toLowerCase();
  closePrompt();
  if (typed !== "deploy") {
    log("\n  Cancelled.", colors.yellow);
    process.exit(0);
  }

  const resolved = {
    namePrefix: state.namePrefix,
    resourceGroup: state.resourceGroup,
    location: state.location,
    aiServicesName: state.aiServicesName,
    functionAppName: state.functionAppName,
    storageName: state.storageName,
    sharepointOrigin: state.sharepointOrigin,
    deploymentName: state.deploymentName,
    backendApiAppDisplayName: state.backendApiAppDisplayName,
    model: {
      name: state.modelName,
      version: state.modelVersion,
      skuName: state.skuName,
      skuCapacity: state.skuCapacity,
    },
  };
  const subscriptionId = state.subscriptionId;
  const tenantId = state.tenantId;

  // ── Steps 4-15 happen inside the profile ────────────────────
  const result = await profile({
    config,
    resolved,
    account: { subscriptionId, tenantId, name: account.user?.name },
    backendDir,
    hardenExisting,
  });

  // ── Persist deploy output (always) ──────────────────────────
  // No secrets — Easy Auth handles browser auth via the SPFx-acquired bearer
  // token. Function keys are deliberately not part of this flow.
  // serveProperties are persisted so `setup` can restore them on a fresh
  // clone without re-prompting the operator for per-tenant GUIDs.
  const outputPath = writeDeployOutput(repoRoot, config.slug, {
    backendUrl: result.proxyUrl,
    backendApiResource: result.backendApiResource,
    backendApiAppId: result.backendApiAppId,
    backendApiAppDisplayName: result.backendApiAppDisplayName,
    namePrefix: state.namePrefix,
    resourceGroup: result.resourceGroup,
    location: result.location,
    aiServicesName: result.aiServicesName,
    functionAppName: result.functionAppName,
    modelName: result.modelName,
    deploymentName: result.deploymentName,
    profile: config.profile,
    serveProperties: resolvedServeProperties,
  });
  logOk(`Saved deploy output: ${outputPath}`);

  // ── Wire serve.json + package-solution.json (always, unless --no-wire) ──
  if (args["no-wire"]) {
    logInfo("--no-wire: skipping serve.json + package-solution.json patches.");
  } else {
    try {
      // serve.json gets cleaned to its minimal schema-valid shape (port, https,
      // initialPage). The webpart property values live in the deploy summary
      // and in .deploy-output.json; SPFx has no source-controlled mechanism
      // to inject them into the workbench property pane.
      const { servePath } = patchServeJson(webpartDir, {});
      logOk(`Cleaned ${servePath.replace(repoRoot + "/", "")}`);
    } catch (error) {
      logFail(`Could not patch serve.json: ${error.message}`);
      logInfo("Re-run any time with: npm run setup");
    }
    try {
      const { path: pkgPath, action } = patchPackageSolution(
        webpartDir,
        result.backendApiAppDisplayName
      );
      const verb = action === "unchanged" ? "verified" : action;
      logOk(`Wired ${pkgPath.replace(repoRoot + "/", "")}  (webApiPermissionRequests ${verb})`);
    } catch (error) {
      logFail(`Could not patch package-solution.json: ${error.message}`);
      logInfo("Re-run any time with: npm run setup");
    }
  }
  closePrompt();

  const wpRel = webpartDir.replace(repoRoot + "/", "");
  log("\n  Next — package and deploy the webpart:\n", colors.bold);
  logInfo(`1. cd ${wpRel}`);
  logInfo("2. npm run build                # produces sharepoint/solution/<name>.sppkg");
  logInfo("3. Upload the .sppkg to your tenant's App Catalog");
  logInfo("4. SharePoint Admin Center → API access → approve any pending requests");
  logInfo("5. Add the web part to a SharePoint page");
  log("");
  // Echo every value the operator needs in the SPFx property pane on first
  // workbench session. SPFx doesn't support pre-populating webpart properties
  // via serve.json (the schema doesn't allow it) — these are paste-once on
  // first workbench load; the workbench persists them in browser storage
  // thereafter. On a real SharePoint page, set them once when adding the
  // webpart; the page persists them permanently.
  const paneProps = {
    backendUrl: result.proxyUrl,
    backendApiResource: result.backendApiResource,
    ...resolvedServeProperties,
  };
  const paneKeys = Object.keys(paneProps);
  log(`\n  Set these in the property pane on first use:\n`, colors.bold);
  const maxKeyLen = Math.max(...paneKeys.map((k) => k.length));
  for (const key of paneKeys) {
    const value = paneProps[key];
    const display = value === undefined || value === null || value === ""
      ? `${colors.dim}(empty — fill in the property pane)${colors.reset}`
      : value;
    log(`    ${key.padEnd(maxKeyLen)}  =  ${display}`);
  }
  log("");
  logInfo("Easy Auth gates the proxy via the SPFx-acquired Entra token.");
  logInfo("Tear down with 'npm run teardown' when you're done.");
  if (configPath) {
    log(`\n  Config: ${configPath}`, colors.dim);
  }
}

main().catch((error) => {
  logFail(error.message);
  closePrompt();
  process.exit(1);
});
