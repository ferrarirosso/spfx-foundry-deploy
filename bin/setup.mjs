#!/usr/bin/env node

/**
 * spfx-foundry-setup
 *
 * Re-wires a webpart's config/serve.json from the values stored in
 * <repo-root>/.deploy-output.json. Useful when:
 *  - you've cloned the repo on a new machine and don't want to redeploy
 *  - the function key was rotated
 *  - you accidentally edited serve.json by hand
 *
 * Usage from a webpart:
 *   spfx-foundry-deploy setup
 */

import { resolve } from "node:path";
import { banner, logOk, logFail, logInfo, log, colors } from "../src/lib/log.mjs";
import { loadOrInferConfig, findRepoRoot, parseArgs } from "../src/lib/config.mjs";
import { readDeployOutput } from "../src/wiring/deployOutput.mjs";
import { patchServeJson } from "../src/wiring/serveJson.mjs";
import { patchPackageSolution } from "../src/wiring/packageSolution.mjs";
import { resolveServeProperties } from "../src/wiring/serveProperties.mjs";
import { closePrompt } from "../src/lib/ask.mjs";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { config, configDir, inferred, slugSource } = loadOrInferConfig(args.config);
  const webpartDir = args.webpart ? resolve(args.webpart) : configDir;
  const repoRoot = findRepoRoot(webpartDir);

  banner(`spfx-foundry-setup — ${config.slug}`);
  if (inferred) {
    logInfo(
      `No deploy.config.json found — using slug="${config.slug}" (from ${slugSource}).`
    );
  }

  const all = readDeployOutput(repoRoot);
  const slugData = all[config.slug];
  if (!slugData) {
    logFail(`No deploy output for slug '${config.slug}' in ${repoRoot}/.deploy-output.json`);
    logInfo("Run 'npm run deploy' first.");
    process.exit(1);
  }

  const resolvedServeProperties = await resolveServeProperties(config.serveProperties);
  const props = {
    backendUrl: slugData.backendUrl,
    backendApiResource: slugData.backendApiResource,
    ...resolvedServeProperties,
  };

  try {
    const { servePath } = patchServeJson(webpartDir, props);
    logOk(`Patched: ${servePath}`);
  } catch (error) {
    logFail(`Could not patch serve.json: ${error.message}`);
    closePrompt();
    process.exit(1);
  }

  if (slugData.backendApiAppDisplayName) {
    try {
      const { path: pkgPath, action } = patchPackageSolution(
        webpartDir,
        slugData.backendApiAppDisplayName
      );
      const verb = action === "unchanged" ? "verified" : action;
      logOk(`Patched: ${pkgPath}  (webApiPermissionRequests ${verb})`);
    } catch (error) {
      logFail(`Could not patch package-solution.json: ${error.message}`);
    }
  }

  log(`  Last deployed: ${slugData.deployedAt}`, colors.dim);
  closePrompt();
}

main().catch((error) => {
  logFail(error.message);
  closePrompt();
  process.exit(1);
});
