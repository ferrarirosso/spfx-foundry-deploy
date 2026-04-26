#!/usr/bin/env node

/**
 * spfx-foundry-teardown
 *
 * Default = full tenant clean: deletes the resource group, purges the
 * AI Services soft-delete (so the name + TPM quota are immediately
 * reusable), and deletes the Backend API Entra app registration.
 *
 * Shows a single-screen plan with all 3 items up front. Type the number
 * of any item to toggle it off (skip). Type 'd' to commit, 'q' to quit.
 *
 * Usage from a webpart:
 *   spfx-foundry-deploy teardown [flags]
 *
 * Flags (all opt-OUT — pre-toggle items off without the form):
 *   --config <path>        Path to deploy.config.json (optional — inferred when omitted).
 *   --keep-app             Skip the Backend API Entra app deletion.
 *   --no-purge             Skip the AI Services soft-delete purge.
 *   --keep-rg              Don't delete the resource group.
 *   --yes                  Skip the form AND the type-the-name gate. CI use only.
 */

import { resolve } from "node:path";
import { exec, execLive, requireCommand } from "../src/lib/exec.mjs";
import { banner, log, logFail, logInfo, logOk, colors } from "../src/lib/log.mjs";
import { ask, closePrompt } from "../src/lib/ask.mjs";
import { loadOrInferConfig, findRepoRoot, parseArgs } from "../src/lib/config.mjs";
import { readDeployOutput, removeDeployOutput } from "../src/wiring/deployOutput.mjs";
import {
  findSoftDeletedAiServices,
  purgeSoftDeletedAiServices,
} from "../src/lib/aiServices.mjs";
import { runTeardownPlan } from "../src/ui/teardownPlan.mjs";
import { createStepList } from "../src/ui/stepList.mjs";

async function rgExists(name) {
  try {
    return (await exec(`az group exists --name ${name}`, { silent: true })) === "true";
  } catch {
    return false;
  }
}

async function countResources(rg) {
  try {
    const json = await exec(
      `az resource list --resource-group ${rg} --query "length(@)" --output tsv`,
      { silent: true }
    );
    return parseInt(json, 10) || 0;
  } catch {
    return 0;
  }
}

async function pollForSoftDelete(name, location, onTick, timeoutMs = 180_000, intervalMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await findSoftDeletedAiServices(name, location);
    if (found) return found;
    if (typeof onTick === "function") {
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      onTick(remaining);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { config, configDir, inferred, slugSource } = loadOrInferConfig(args.config);
  const webpartDir = args.webpart ? resolve(args.webpart) : configDir;
  const repoRoot = findRepoRoot(webpartDir);

  banner(`spfx-foundry-teardown — ${config.slug}`);
  if (inferred) {
    logInfo(
      `No deploy.config.json found — using slug="${config.slug}" (from ${slugSource}).`
    );
  }

  // ── Prereqs ─────────────────────────────────────────────────
  requireCommand("az", "https://learn.microsoft.com/cli/azure/install-azure-cli");
  try {
    await exec("az account show --output none", { silent: true });
  } catch {
    logFail("Not logged in to Azure CLI. Run: az login");
    process.exit(1);
  }

  // ── Build the plan ──────────────────────────────────────────
  const all = readDeployOutput(repoRoot);
  const slugData = all[config.slug] || {};
  const resourceGroup =
    slugData.resourceGroup || config.defaults?.resourceGroup || `rg-${config.slug}`;
  const aiServicesName =
    slugData.aiServicesName ||
    config.defaults?.aiServicesName ||
    `${config.slug.replace(/[^a-z0-9-]/g, "")}-ai`.replace(/--+/g, "-").slice(0, 24);
  const location = slugData.location || config.defaults?.location || "swedencentral";
  const appId = slugData.backendApiAppId || null;
  const appDisplayName =
    slugData.backendApiAppDisplayName ||
    config.defaults?.backendApiAppDisplayName ||
    `${config.slug} Backend API`;

  const rgIsThere = await rgExists(resourceGroup);
  const rgCount = rgIsThere ? await countResources(resourceGroup) : 0;

  const items = [
    {
      key: "rg",
      label: "Resource group",
      detail: rgIsThere
        ? `${resourceGroup}  (${rgCount} resource${rgCount === 1 ? "" : "s"})`
        : `${resourceGroup}  (already gone)`,
      skip: !rgIsThere || Boolean(args["keep-rg"]),
    },
    {
      key: "purge",
      label: "AI Services purge",
      detail: `${aiServicesName} in ${location}  (waits ~3 min then purges)`,
      skip: Boolean(args["no-purge"]),
    },
    {
      key: "app",
      label: "Entra app",
      detail: appId
        ? `${appDisplayName}  (${appId})`
        : `not tracked in .deploy-output.json`,
      skip: Boolean(args["keep-app"]) || !appId,
    },
  ];

  // ── Form (skip entirely with --yes for CI) ──────────────────
  if (!args.yes) {
    const wantTeardown = await runTeardownPlan(items, { slug: config.slug });
    if (!wantTeardown) {
      log("\n  Cancelled.", colors.yellow);
      closePrompt();
      process.exit(0);
    }
  }

  // ── Final type-the-name gate (unless --yes) ─────────────────
  const willDeleteRg = !items[0].skip;
  if (!args.yes && willDeleteRg) {
    log("");
    log("  ⚠  This is permanent.", colors.red);
    const confirmName = await ask(`Type the resource group name to confirm`, "");
    if (confirmName !== resourceGroup) {
      log("\n  Cancelled (name didn't match).", colors.yellow);
      closePrompt();
      process.exit(0);
    }
  }
  closePrompt();

  // ── Execute ─────────────────────────────────────────────────
  const wantPurge = !items[1].skip;
  const stepLabels = items.map((it) => it.label);
  const steps = createStepList(
    stepLabels.map((label, i) => ({ label, note: items[i].skip ? "skipped" : "" })),
    { title: `Tearing down ${config.slug}:` }
  );
  steps.init();

  // Pre-mark skipped items
  items.forEach((it, i) => {
    if (it.skip) steps.skip(i, "skipped");
  });

  // 1. Resource group
  if (!items[0].skip) {
    steps.start(0);
    try {
      // Synchronous if a purge follows (we need the delete to complete);
      // --no-wait otherwise. Both go through async exec so the spinner ticks.
      if (wantPurge) {
        steps.update(0, "deleting (waiting for completion)…");
        await exec(`az group delete --name ${resourceGroup} --yes`, { timeout: 600_000 });
        steps.done(0, "deleted");
      } else {
        steps.update(0, "delete initiated (background)…");
        await exec(`az group delete --name ${resourceGroup} --yes --no-wait`);
        steps.done(0, "delete initiated");
      }
    } catch (error) {
      steps.fail(0, (error.message || String(error)).split("\n").pop());
    }
  }

  // 2. AI Services purge
  if (!items[1].skip) {
    steps.start(1, "waiting for soft-delete record (up to 3 min)…");
    const found = await pollForSoftDelete(aiServicesName, location, (remaining) => {
      steps.update(1, `waiting for soft-delete record  (${remaining}s remaining)…`);
    });
    if (!found) {
      steps.done(1, "no soft-delete record appeared (auto-purge will retry on next deploy)");
    } else {
      try {
        steps.update(1, "purging…");
        await purgeSoftDeletedAiServices(aiServicesName, location, resourceGroup);
        steps.done(1, "purged");
      } catch (error) {
        steps.fail(1, (error.message || String(error)).split("\n").pop());
      }
    }
  }

  // 3. Entra app
  if (!items[2].skip) {
    steps.start(2);
    try {
      await exec(`az ad app delete --id ${appId} --output none`, { silent: true });
      steps.done(2, "deleted");
    } catch (error) {
      steps.fail(2, (error.message || String(error)).split("\n").pop());
    }
  }

  steps.close();

  if (slugData && Object.keys(slugData).length > 0) {
    removeDeployOutput(repoRoot, config.slug);
    logOk(`Removed '${config.slug}' from .deploy-output.json`);
  }

  banner("Tenant clean");
}

main().catch((error) => {
  logFail(error.message);
  closePrompt();
  process.exit(1);
});
