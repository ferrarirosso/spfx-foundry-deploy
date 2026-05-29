import { run, runLive } from "../lib/exec.mjs";
import { banner, log, logInfo, colors } from "../lib/log.mjs";
import { httpFetch } from "../lib/http.mjs";
import {
  ensureBackendApiApplication,
  ensureSpfxPermissionGrant,
  configureFunctionAppEasyAuth,
  tryAssignDeployingUserToRole,
} from "../lib/spfx.mjs";
import {
  findSoftDeletedAiServices,
  purgeSoftDeletedAiServices,
  disableLocalAuthOnAccount,
  disableLocalAuthHint,
} from "../lib/aiServices.mjs";
import {
  ensureLogAnalyticsWorkspace,
  ensureDiagnosticSetting,
  resourceId,
} from "../lib/diagnostics.mjs";
import { createStepList } from "../ui/stepList.mjs";
import { modelUsesMaxCompletionTokens } from "../prompts/pickModel.mjs";

const RUNTIME_DEFAULTS = {
  modelFormat: "OpenAI",
  defaultReasoningEffort: "low",
  apiVersion: "2025-01-01-preview",
};

const STEP_LABELS = [
  "Resource group",
  "AI Services (Foundry)",
  "gpt-5-mini deployment",
  "Storage account",
  "Function App",
  "Backend API + SPFx grant",
  "Managed identity",
  "Role assignment",
  "Code deploy",
  "App settings",
  "Easy Auth",
  "Platform hardening",
  "Telemetry & diagnostics",
  "Health check",
];

function bail(steps, i, error) {
  steps.fail(i, (error.message || String(error)).split("\n").pop());
  steps.close();
  log("");
  log(`  ${colors.red}Deployment failed at: ${STEP_LABELS[i]}${colors.reset}`);
  log(`  ${colors.dim}${error.message || error}${colors.reset}`);
  process.exit(1);
}

export async function deployChatCompletionsBackend({
  config,
  resolved,
  account,
  backendDir,
  hardenExisting = false,
}) {
  const { subscriptionId, tenantId } = account;
  const {
    namePrefix,
    resourceGroup,
    location,
    aiServicesName,
    functionAppName,
    storageName,
    sharepointOrigin,
    deploymentName,
    backendApiAppDisplayName,
    model: chosenModel,
  } = resolved;

  const model = {
    ...RUNTIME_DEFAULTS,
    modelName: chosenModel.name,
    modelVersion: chosenModel.version,
    skuName: chosenModel.skuName || "GlobalStandard",
    skuCapacity: chosenModel.skuCapacity || 40,
    deploymentName,
    usesMaxCompletionTokens: modelUsesMaxCompletionTokens(chosenModel.name),
  };
  const requestLimits = config.requestLimits || { perMinute: 30, perDay: 1000 };

  const steps = createStepList(
    STEP_LABELS.map((label) => ({ label })),
    { title: `Deploying ${config.slug}:` }
  );
  steps.init();

  // ── 0: Resource Group ───────────────────────────────────────
  steps.start(0);
  try {
    const exists = await run("az", ["group", "exists", "--name", resourceGroup], { silent: true });
    if (exists === "true") {
      steps.done(0, `${resourceGroup}  (already existed)`);
    } else {
      await run("az", ["group", "create", "--name", resourceGroup, "--location", location, "--output", "none"]);
      steps.done(0, resourceGroup);
    }
  } catch (e) {
    bail(steps, 0, e);
  }

  // ── 1: AI Services ──────────────────────────────────────────
  let aiServicesEndpoint;
  let aiResourceId;
  let localAuthWarnTarget = null; // set if we tried to disable key auth and it didn't take
  steps.start(1);
  try {
    let aiExists = false;
    try {
      await run(
        "az",
        ["cognitiveservices", "account", "show", "--name", aiServicesName, "--resource-group", resourceGroup, "--output", "none"],
        { silent: true }
      );
      aiExists = true;
    } catch {
      /* will create */
    }
    if (!aiExists) {
      const softDeleted = await findSoftDeletedAiServices(aiServicesName, location);
      if (softDeleted) {
        steps.update(1, `purging soft-deleted '${aiServicesName}'…`);
        await purgeSoftDeletedAiServices(aiServicesName, location, resourceGroup);
      }
      steps.update(1, `creating '${aiServicesName}' (1-2 min)…`);
      await run(
        "az",
        [
          "cognitiveservices", "account", "create",
          "--name", aiServicesName,
          "--resource-group", resourceGroup,
          "--location", location,
          "--kind", "AIServices",
          "--sku", "S0",
          "--custom-domain", aiServicesName,
          "--yes",
          "--output", "none",
        ],
        { timeout: 180_000 }
      );
    }

    aiResourceId = (
      await run(
        "az",
        ["cognitiveservices", "account", "show", "--name", aiServicesName, "--resource-group", resourceGroup, "--query", "id", "--output", "tsv"],
        { silent: true }
      )
    ).trim();
    aiServicesEndpoint = (
      await run(
        "az",
        ["cognitiveservices", "account", "show", "--name", aiServicesName, "--resource-group", resourceGroup, "--query", "properties.endpoint", "--output", "tsv"],
        { silent: true }
      )
    ).trim();

    // Sec-2: passwordless-only to Foundry. Disable key/local auth on newly
    // created accounts (or existing ones with --harden-existing). MI callers
    // are unaffected; key-based local dev must switch to `az login`. The helper
    // reads the property back and returns false if it didn't actually flip —
    // we surface that loudly rather than claim a control that isn't in place.
    let authNote = "";
    if (!aiExists || hardenExisting) {
      const disabled = await disableLocalAuthOnAccount(aiResourceId, aiServicesName, resourceGroup);
      if (disabled) {
        authNote = "  · key auth disabled";
      } else {
        authNote = `  · ${colors.yellow}⚠ key auth STILL ON${colors.reset}`;
        localAuthWarnTarget = aiResourceId;
      }
    }
    steps.done(1, `${aiServicesName}${aiExists ? "  (already existed)" : ""}${authNote}`);
  } catch (e) {
    bail(steps, 1, e);
  }

  // ── 2: Model deployment ─────────────────────────────────────
  steps.start(2, `${model.modelName} → ${model.deploymentName}`);
  try {
    let modelExists = false;
    try {
      await run(
        "az",
        ["cognitiveservices", "account", "deployment", "show", "--name", aiServicesName, "--resource-group", resourceGroup, "--deployment-name", model.deploymentName, "--output", "none"],
        { silent: true }
      );
      modelExists = true;
    } catch {
      /* will deploy */
    }
    if (!modelExists) {
      steps.update(2, `deploying ${model.modelName} (${model.skuCapacity}K TPM)…`);
      await run(
        "az",
        [
          "cognitiveservices", "account", "deployment", "create",
          "--name", aiServicesName,
          "--resource-group", resourceGroup,
          "--deployment-name", model.deploymentName,
          "--model-name", model.modelName,
          "--model-version", model.modelVersion,
          "--model-format", model.modelFormat,
          "--sku-capacity", String(model.skuCapacity),
          "--sku-name", model.skuName,
          "--output", "none",
        ],
        { timeout: 180_000 }
      );
    }
    steps.done(2, `${model.deploymentName}${modelExists ? "  (already existed)" : ""}`);
  } catch (e) {
    bail(steps, 2, e);
  }

  // ── 3: Storage account ──────────────────────────────────────
  steps.start(3);
  try {
    let storExists = false;
    try {
      await run(
        "az",
        ["storage", "account", "show", "--name", storageName, "--resource-group", resourceGroup, "--output", "none"],
        { silent: true }
      );
      storExists = true;
    } catch {
      /* create below */
    }
    if (!storExists) {
      // Sec-7 (storage option C): harden the account at create — TLS 1.2 floor
      // and no anonymous blob access. The Functions host still uses the shared
      // key for its content share (Consumption limitation), so shared-key
      // access stays enabled.
      await run(
        "az",
        [
          "storage", "account", "create",
          "--name", storageName,
          "--resource-group", resourceGroup,
          "--location", location,
          "--sku", "Standard_LRS",
          "--min-tls-version", "TLS1_2",
          "--allow-blob-public-access", "false",
          "--output", "none",
        ],
        { timeout: 120_000 }
      );
    } else if (hardenExisting) {
      await run(
        "az",
        ["storage", "account", "update", "--name", storageName, "--resource-group", resourceGroup, "--min-tls-version", "TLS1_2", "--allow-blob-public-access", "false", "--output", "none"],
        { silent: true, ignoreError: true }
      );
    }
    steps.done(3, `${storageName}${storExists ? "  (already existed)" : "  · TLS1.2 · no public blob"}`);
  } catch (e) {
    bail(steps, 3, e);
  }

  // ── 4: Function App ─────────────────────────────────────────
  steps.start(4);
  try {
    let funcExists = false;
    try {
      await run(
        "az",
        ["functionapp", "show", "--name", functionAppName, "--resource-group", resourceGroup, "--output", "none"],
        { silent: true }
      );
      funcExists = true;
    } catch {
      /* create below */
    }
    if (!funcExists) {
      await run(
        "az",
        [
          "functionapp", "create",
          "--name", functionAppName,
          "--resource-group", resourceGroup,
          "--storage-account", storageName,
          "--consumption-plan-location", location,
          "--runtime", "node",
          "--runtime-version", "22",
          "--functions-version", "4",
          "--os-type", "linux",
          "--output", "none",
        ],
        { timeout: 180_000 }
      );
    }
    steps.done(4, `${functionAppName}${funcExists ? "  (already existed)" : ""}`);
  } catch (e) {
    bail(steps, 4, e);
  }

  // ── 5: Backend API registration + SPFx grant + deployer role assignment ──
  steps.start(5);
  let backendApiConfig;
  let roleAssignment = null;
  try {
    backendApiConfig = await ensureBackendApiApplication(backendApiAppDisplayName, namePrefix);
    await ensureSpfxPermissionGrant(backendApiConfig.appId);
    // Best-effort: pre-assign the deploying user so they can chat immediately
    // without a Portal click. Falls back to manual instructions if the API
    // call is rejected (permissions, etc.).
    roleAssignment = await tryAssignDeployingUserToRole(
      backendApiConfig.servicePrincipalId,
      backendApiConfig.appRoleId
    );
    const note =
      roleAssignment?.status === "assigned"
        ? `${backendApiConfig.displayName}  (role + assigned ${roleAssignment.upn})`
        : roleAssignment?.status === "already-assigned"
        ? `${backendApiConfig.displayName}  (role + ${roleAssignment.upn} already had it)`
        : `${backendApiConfig.displayName}  (role; auto-assignment skipped)`;
    steps.done(5, note);
  } catch (e) {
    bail(steps, 5, e);
  }

  // ── 6: Managed identity ─────────────────────────────────────
  steps.start(6);
  let principalId;
  try {
    const identityRaw = await run(
      "az",
      ["functionapp", "identity", "assign", "--name", functionAppName, "--resource-group", resourceGroup, "--output", "json"],
      { silent: true }
    );
    const identity = JSON.parse(identityRaw);
    principalId = identity.principalId;
    steps.done(6, principalId);
  } catch (e) {
    bail(steps, 6, e);
  }

  // ── 7: Role assignment ──────────────────────────────────────
  steps.start(7);
  try {
    const delaySeconds = [0, 15, 15, 20, 30];
    let assigned = false;
    for (let attempt = 0; attempt < delaySeconds.length; attempt++) {
      if (delaySeconds[attempt] > 0) {
        steps.update(
          7,
          `waiting ${delaySeconds[attempt]}s for identity propagation (try ${attempt + 1}/${delaySeconds.length})…`
        );
        await new Promise((r) => setTimeout(r, delaySeconds[attempt] * 1000));
      }
      try {
        await run(
          "az",
          ["role", "assignment", "create", "--assignee", principalId, "--role", "Cognitive Services OpenAI User", "--scope", aiResourceId, "--output", "none"],
          { silent: true }
        );
        steps.done(7, "Cognitive Services OpenAI User");
        assigned = true;
        break;
      } catch (error) {
        if (error.message.includes("already exists")) {
          steps.done(7, "Cognitive Services OpenAI User  (already existed)");
          assigned = true;
          break;
        }
        if (
          error.message.includes("Cannot find user or service principal") &&
          attempt < delaySeconds.length - 1
        ) {
          continue;
        }
        bail(steps, 7, error);
        return;
      }
    }
    if (!assigned) {
      bail(steps, 7, new Error("Role assignment failed after all retries."));
    }
  } catch (e) {
    bail(steps, 7, e);
  }

  // ── 8: Code deploy (func publish needs the terminal) ────────
  // runLive streams func's own build output. We pause the step list, let
  // func publish own the terminal, then resume() so the next render starts
  // fresh below the publish output.
  steps.update(8, "publishing proxy code (remote build, ~2 min)…");
  steps.suspend();
  log("");
  process.chdir(backendDir);
  try {
    runLive("func", ["azure", "functionapp", "publish", functionAppName, "--javascript", "--build", "remote"]);
  } catch (e) {
    log("");
    log(`  ${colors.red}Code publish failed.${colors.reset}`);
    log(`  ${colors.dim}${e.message}${colors.reset}`);
    process.exit(1);
  }
  log("");
  steps.resume();
  steps.done(8, "func publish complete");

  // ── 9: App settings ─────────────────────────────────────────
  steps.start(9);
  try {
    const settings = [
      `AZURE_OPENAI_ENDPOINT=${aiServicesEndpoint.replace(/\/$/, "")}`,
      `AZURE_OPENAI_API_VERSION=${model.apiVersion}`,
      `AZURE_OPENAI_DEPLOYMENT=${model.deploymentName}`,
      `AZURE_OPENAI_REASONING_EFFORT=${model.defaultReasoningEffort}`,
      `AZURE_OPENAI_USES_MAX_COMPLETION_TOKENS=${model.usesMaxCompletionTokens ? "true" : "false"}`,
      `REQUESTS_PER_MINUTE=${requestLimits.perMinute}`,
      `REQUESTS_PER_DAY=${requestLimits.perDay}`,
      `ALLOWED_ORIGIN=${sharepointOrigin}`,
      `ALLOW_PERMISSIVE_LOCAL_CORS=false`,
      // Sec-2: backend rejects callers without this app role assignment.
      `REQUIRED_APP_ROLE=${backendApiConfig.roleValue}`,
    ];
    await run(
      "az",
      ["functionapp", "config", "appsettings", "set", "--name", functionAppName, "--resource-group", resourceGroup, "--settings", ...settings, "--output", "none"],
      { silent: true }
    );
    steps.done(9, `${settings.length} env vars`);
  } catch (e) {
    bail(steps, 9, e);
  }

  // ── 10: Easy Auth ───────────────────────────────────────────
  // App Service CORS MUST be configured before Easy Auth runs in
  // requireAuthentication mode — otherwise browser preflight (OPTIONS)
  // gets gated by Easy Auth, returns 401 without CORS headers, and the
  // browser fails. App Service CORS sits in front of Easy Auth and
  // answers preflights directly with the right Access-Control-Allow-*
  // headers, even on protected endpoints.
  steps.start(10);
  try {
    await run(
      "az",
      ["functionapp", "cors", "add", "--name", functionAppName, "--resource-group", resourceGroup, "--allowed-origins", sharepointOrigin, "--output", "none"],
      { silent: true, ignoreError: true }
    );
    await configureFunctionAppEasyAuth({
      subscriptionId,
      tenantId,
      resourceGroup,
      functionAppName,
      backendApiAppId: backendApiConfig.appId,
      backendApiResource: backendApiConfig.resource,
    });
    steps.done(10, `Entra-required (Return401) + App Service CORS for ${sharepointOrigin}`);
  } catch (e) {
    bail(steps, 10, e);
  }

  // ── 11: Platform hardening (Sec-7) ──────────────────────────
  steps.start(11, "HTTPS-only · TLS 1.2 · FTP off…");
  try {
    await run(
      "az",
      ["functionapp", "update", "--name", functionAppName, "--resource-group", resourceGroup, "--set", "httpsOnly=true", "--output", "none"],
      { silent: true }
    );
    await run(
      "az",
      ["functionapp", "config", "set", "--name", functionAppName, "--resource-group", resourceGroup, "--min-tls-version", "1.2", "--ftps-state", "Disabled", "--output", "none"],
      { silent: true }
    );
    steps.done(11, "HTTPS-only · TLS 1.2 · FTP disabled");
  } catch (e) {
    bail(steps, 11, e);
  }

  // ── 12: Telemetry & diagnostics (Sec-7) ─────────────────────
  // Workspace-based App Insights (classic key-only mode is deprecated) plus
  // diagnostic settings routing each resource's logs + metrics to a per-RG
  // Log Analytics workspace. Best-effort: the deploy still works without
  // telemetry, but a skip is surfaced rather than silent.
  steps.start(12, "Log Analytics + App Insights…");
  try {
    const aiInsightsName = `${functionAppName}-ai`.slice(0, 60);
    const workspaceId = await ensureLogAnalyticsWorkspace(resourceGroup, location, namePrefix);

    const createArgs = ["monitor", "app-insights", "component", "create", "--app", aiInsightsName, "--location", location, "--resource-group", resourceGroup, "--kind", "web", "--output", "none"];
    if (workspaceId) createArgs.push("--workspace", workspaceId);
    await run("az", createArgs, { silent: true, ignoreError: true });

    const connString = (
      await run(
        "az",
        ["monitor", "app-insights", "component", "show", "--app", aiInsightsName, "--resource-group", resourceGroup, "--query", "connectionString", "--output", "tsv"],
        { silent: true, ignoreError: true }
      )
    ).trim();
    if (connString) {
      await run(
        "az",
        ["functionapp", "config", "appsettings", "set", "--name", functionAppName, "--resource-group", resourceGroup, "--settings", `APPLICATIONINSIGHTS_CONNECTION_STRING=${connString}`, "--output", "none"],
        { silent: true }
      );
    }

    let diagCount = 0;
    if (workspaceId) {
      const funcId = await resourceId("functionapp", functionAppName, resourceGroup);
      const storeId = await resourceId("storage", storageName, resourceGroup);
      if (funcId && (await ensureDiagnosticSetting(funcId, workspaceId, { logs: true, metrics: true }))) diagCount++;
      if (aiResourceId && (await ensureDiagnosticSetting(aiResourceId, workspaceId, { logs: true, metrics: true }))) diagCount++;
      if (storeId && (await ensureDiagnosticSetting(storeId, workspaceId, { logs: false, metrics: true }))) diagCount++;
    }
    const note = workspaceId
      ? `${aiInsightsName} → Log Analytics  (${diagCount} diag settings)`
      : `${aiInsightsName}  (no workspace — App Insights only)`;
    steps.done(12, note);
  } catch (e) {
    // Non-fatal: deploy still works without telemetry.
    steps.done(12, `partial (${(e.message || String(e)).split("\n").pop()})`);
  }

  // ── 13: Health check ────────────────────────────────────────
  // /health is anonymous-but-Easy-Auth-protected. With requireAuthentication=true
  // even the anonymous route now returns 401 to unauthenticated callers — that's
  // the correct outcome and proves the Easy Auth gate is working.
  const proxyUrl = `https://${functionAppName}.azurewebsites.net/api`;
  steps.start(13, "waiting 10s for Azure to settle…");
  await new Promise((r) => setTimeout(r, 10_000));
  try {
    const healthRes = await httpFetch(`${proxyUrl}/health`);
    if (healthRes.status === 401) {
      steps.done(13, "Easy Auth gate confirmed (401 without token)");
    } else if (healthRes.status === 200) {
      // Possible during the brief warmup window before Easy Auth fully applies.
      steps.done(13, "warming up; recheck in ~30s");
    } else {
      steps.done(13, `HTTP ${healthRes.status} — recheck in ~30s`);
    }
  } catch (error) {
    steps.done(13, `couldn't reach health endpoint — try: curl ${proxyUrl}/health`);
  }

  steps.close();
  banner("Deployment complete");
  log("  Your proxy is live:\n", colors.bold);
  logInfo(`Proxy URL:          ${proxyUrl}`);
  logInfo(`Backend API URI:    ${backendApiConfig.resource}`);
  logInfo(`Resource group:     ${resourceGroup}`);
  log("");
  logInfo("Auth: Easy Auth requires an Entra token for api://<backend-app-id>.");
  logInfo("No function key in the browser path. SPFx acquires the token via AadTokenProvider.");
  log("");
  const portalUrl = `https://entra.microsoft.com/${tenantId}/#view/Microsoft_AAD_IAM/ManagedAppMenuBlade/~/Users/objectId/${backendApiConfig.servicePrincipalId}/appId/${backendApiConfig.appId}`;
  if (roleAssignment?.status === "assigned" || roleAssignment?.status === "already-assigned") {
    log(`  ${colors.bold}You're already assigned to '${backendApiConfig.roleValue}' — you can chat immediately.${colors.reset}`);
    logInfo(`To onboard more users, assign them the role at:`);
    logInfo(portalUrl);
  } else {
    log(`  ${colors.yellow}Required next step — assign users to the '${backendApiConfig.roleValue}' role:${colors.reset}`);
    logInfo(portalUrl);
    logInfo("Without an assignment, calls to the proxy return 403. This is the deliberate default-deny posture.");
  }

  if (localAuthWarnTarget) {
    log("");
    log(`  ${colors.yellow}⚠ Could not disable key (local) auth on the Foundry account — API keys are STILL ENABLED.${colors.reset}`);
    logInfo("The proxy uses managed identity regardless, but a leaked/listed key would bypass the auth gate.");
    logInfo("Fix it manually, then re-check:");
    logInfo(disableLocalAuthHint(localAuthWarnTarget));
  }

  return {
    proxyUrl,
    backendApiResource: backendApiConfig.resource,
    backendApiAppId: backendApiConfig.appId,
    backendApiAppDisplayName: backendApiConfig.displayName,
    backendApiRoleValue: backendApiConfig.roleValue,
    resourceGroup,
    location,
    aiServicesName,
    functionAppName,
    deploymentName: model.deploymentName,
    modelName: model.modelName,
  };
}
