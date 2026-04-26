// One-screen review form for `npm run deploy`.
//
// Renders all configurable values up front so the user has full visibility
// before any prompts. To edit a field, type its number; this hands off to
// the existing pickers (pickSubscription / pickRegion / askSharePointOrigin /
// pickPrefix / pickModel) or a plain `ask` for the field, then redraws.
//
// Editing the prefix REBUILDS every derived name (RG / AI / Func / Storage /
// Deployment / Backend API app). Editing the region also re-validates that
// the chosen model is available there; if not, auto-picks a fresh one.
//
// Pure ANSI + readline. No new dependencies.

import { colors, log, logInfo } from "../lib/log.mjs";
import { ask, prompt } from "../lib/ask.mjs";
import { pickSubscription } from "../prompts/pickSubscription.mjs";
import { pickRegion } from "../prompts/pickRegion.mjs";
import { askSharePointOrigin } from "../prompts/pickSharePointOrigin.mjs";
import { pickPrefix } from "../prompts/pickPrefix.mjs";
import {
  pickModel,
  isModelAvailableInRegion,
  listModelsInRegion,
} from "../prompts/pickModel.mjs";
import { deriveNames } from "../lib/naming.mjs";

function applyDerivedNames(state) {
  const names = deriveNames(state.namePrefix, state.modelName);
  state.resourceGroup = names.resourceGroup;
  state.aiServicesName = names.aiServicesName;
  state.functionAppName = names.functionAppName;
  state.storageName = names.storageName;
  state.deploymentName = names.deploymentName;
  state.backendApiAppDisplayName = names.backendApiAppDisplayName;
}

const FIELDS = [
  {
    key: "subscriptionLabel",
    label: "Subscription",
    edit: async (state) => {
      const sub = await pickSubscription();
      state.subscriptionId = sub.subscriptionId;
      state.tenantId = sub.tenantId;
      state.subscriptionName = sub.name;
      state.subscriptionLabel = `${sub.name}  ${sub.subscriptionId}`;
    },
  },
  {
    key: "namePrefix",
    label: "Resource prefix",
    edit: async (state) => {
      const newPrefix = await pickPrefix(state.namePrefix);
      state.namePrefix = newPrefix;
      applyDerivedNames(state);
      log(`  ${colors.dim}Re-derived RG / AI / Function App / Storage / Deployment names from new prefix.${colors.reset}`);
    },
  },
  {
    key: "regionLabel",
    label: "Region",
    edit: async (state) => {
      const newLocation = await pickRegion(state.location);
      state.location = newLocation;
      state.regionLabel = newLocation;
      // Cross-check: is the current model still available?
      const stillAvailable = await isModelAvailableInRegion(state.modelName, newLocation);
      if (!stillAvailable) {
        log(`  ${colors.yellow}'${state.modelName}' is not available in ${newLocation}. Re-picking a model…${colors.reset}`);
        const available = await listModelsInRegion(newLocation);
        if (available.length === 0) {
          log(`  ${colors.red}No OpenAI chat models found in ${newLocation}.${colors.reset}`);
          return;
        }
        const chosen = await pickModel(newLocation, available[0].modelName);
        state.modelName = chosen.modelName;
        state.modelVersion = chosen.modelVersion;
        state.skuName = chosen.skuName;
        state.skuCapacity = chosen.skuCapacity;
        applyDerivedNames(state);
      }
    },
  },
  {
    key: "modelLabel",
    label: "Model",
    edit: async (state) => {
      const chosen = await pickModel(state.location, state.modelName);
      state.modelName = chosen.modelName;
      state.modelVersion = chosen.modelVersion;
      state.skuName = chosen.skuName;
      state.skuCapacity = chosen.skuCapacity;
      // Deployment name embeds the model name → re-derive
      applyDerivedNames(state);
    },
  },
  {
    key: "resourceGroup",
    label: "Resource Group",
    edit: async (state) => {
      state.resourceGroup = await ask("Resource Group", state.resourceGroup);
    },
  },
  {
    key: "aiServicesName",
    label: "AI Services",
    edit: async (state) => {
      state.aiServicesName = await ask("AI Services name", state.aiServicesName);
    },
  },
  {
    key: "functionAppName",
    label: "Function App",
    edit: async (state) => {
      state.functionAppName = await ask("Function App name", state.functionAppName);
    },
  },
  {
    key: "storageName",
    label: "Storage",
    edit: async (state) => {
      state.storageName = await ask("Storage Account name", state.storageName);
    },
  },
  {
    key: "sharepointOrigin",
    label: "SharePoint origin",
    edit: async (state) => {
      state.sharepointOrigin = await askSharePointOrigin();
    },
  },
];

function pad(label, width) {
  return label.length >= width ? label : label + " ".repeat(width - label.length);
}

function fmtTpm(capacity) {
  // Azure's capacity unit for Standard / GlobalStandard chat SKUs is
  // thousands of tokens per minute, so capacity 40 == 40K TPM.
  if (!capacity && capacity !== 0) return "?";
  return `${capacity}K tokens/min`;
}

export function renderForm(state, ctx) {
  const requestLimits = ctx.requestLimits;
  log(`\n  ${colors.bold}Configuration:${colors.reset}`);
  FIELDS.forEach((f, i) => {
    let value;
    if (f.key === "regionLabel") value = state.location;
    else if (f.key === "modelLabel") value = state.modelName;
    else value = state[f.key];
    if (!value) value = `${colors.dim}(empty)${colors.reset}`;
    log(`    [${i + 1}] ${pad(f.label, 18)}  ${value}`);
  });

  log(`\n  ${colors.bold}Fixed${colors.reset} ${colors.dim}(derived from your choices):${colors.reset}`);
  logInfo(`Deployment name     ${state.deploymentName || "(pending)"}`);
  logInfo(`Backend API app     ${state.backendApiAppDisplayName || "(pending)"}`);
  logInfo(`Model TPM capacity  ${fmtTpm(state.skuCapacity)}`);
  if (requestLimits) {
    logInfo(`App rate limits     ${requestLimits.perMinute} req/min · ${requestLimits.perDay} req/day`);
  }

  if (ctx.planSummary) {
    log(`\n  ${colors.bold}Plan:${colors.reset} ${colors.dim}${ctx.planSummary}${colors.reset}`);
  }

  log(
    `\n  ${colors.cyan}[number]${colors.reset} edit field   ` +
      `${colors.cyan}[d]${colors.reset} deploy   ` +
      `${colors.cyan}[q]${colors.reset} quit`
  );
}

const REQUIRED_KEYS = [
  "subscriptionLabel",
  "namePrefix",
  "location",
  "modelName",
  "resourceGroup",
  "aiServicesName",
  "functionAppName",
  "storageName",
  "sharepointOrigin",
];

export async function runReviewForm(state, ctx) {
  while (true) {
    renderForm(state, ctx);
    const choice = (await prompt("  > ")).toLowerCase();

    if (choice === "q" || choice === "quit") return false;
    if (choice === "d" || choice === "deploy") {
      const missing = REQUIRED_KEYS.filter((k) => !state[k]);
      if (missing.length > 0) {
        log(`\n  ${colors.red}Missing values:${colors.reset} ${missing.join(", ")}`);
        log(`  Edit them before deploying.\n`);
        continue;
      }
      return true;
    }
    if (choice === "" || choice === "?" || choice === "h") continue;

    const n = Number(choice);
    if (!Number.isInteger(n) || n < 1 || n > FIELDS.length) {
      log(`\n  ${colors.yellow}Unrecognised input.${colors.reset} Type 1-${FIELDS.length} to edit, 'd' to deploy, 'q' to quit.\n`);
      continue;
    }

    log("");
    try {
      await FIELDS[n - 1].edit(state);
    } catch (error) {
      if ((error.message || "").includes("cancelled")) {
        log(`\n  ${colors.yellow}Edit cancelled.${colors.reset}\n`);
      } else {
        log(`\n  ${colors.red}Edit failed:${colors.reset} ${error.message}\n`);
      }
    }
    log("");
  }
}

export function buildPlanSummary() {
  return (
    "Resource group → AI Services → model deployment → Storage → " +
    "Function App → Backend API + SPFx grant → Managed identity → " +
    "Easy Auth → Code deploy → Health check"
  );
}
