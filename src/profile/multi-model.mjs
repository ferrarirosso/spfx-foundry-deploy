import { exec, execLive } from "../lib/exec.mjs";
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
} from "../lib/aiServices.mjs";
import { createStepList } from "../ui/stepList.mjs";

/**
 * multi-model profile
 *
 * Provisions the SAME protected Function App proxy as the single-model
 * chat-completions profile, but deploys N model deployments (declared in
 * config.models[]) on one Foundry account instead of one. Each model carries
 * a `$role` tag; the deployer writes one app setting per role:
 *
 *   AZURE_OPENAI_DEPLOYMENT_<ROLE>     = <deploymentName>
 *   AZURE_OPENAI_API_VERSION_<ROLE>    = <apiVersion>   (if the model declares one)
 *
 * plus the shared AZURE_OPENAI_ENDPOINT. The single-model chat-completions
 * profile (and its singular AZURE_OPENAI_DEPLOYMENT contract) is untouched —
 * this is a separate recipe so existing single-model consumers carry zero risk.
 *
 * Backends derive any provider-specific endpoint (e.g. the MAI image endpoint
 * *.services.ai.azure.com) from AZURE_OPENAI_ENDPOINT themselves.
 */

const STEP_LABELS = [
  "Resource group",
  "AI Services (Foundry)",
  "Model deployments",
  "Storage account",
  "Function App",
  "Backend API + SPFx grant",
  "Managed identity",
  "Role assignment",
  "Code deploy",
  "App settings",
  "Easy Auth",
  "Platform hardening",
  "Application Insights",
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

/** "image" → "IMAGE", "synthesis-lookup" → "SYNTHESIS_LOOKUP". */
function roleEnvSuffix(role, index) {
  const raw = (role || `model${index}`).toString();
  return raw.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export async function deployMultiModelBackend({
  config,
  resolved,
  account,
  backendDir,
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
    backendApiAppDisplayName,
  } = resolved;

  const models = (config.models || []).map((m, i) => ({
    name: m.name,
    deploymentName: m.deploymentName,
    version: m.version,
    format: m.format || "OpenAI",
    skuName: m.skuName || "GlobalStandard",
    skuCapacity: m.skuCapacity || 50,
    apiVersion: m.apiVersion,
    role: m.$role || m.role || `model${i}`,
  }));
  if (models.length === 0) {
    throw new Error("multi-model profile requires a non-empty config.models[] array");
  }
  const requestLimits = config.requestLimits || { perMinute: 30, perDay: 1000 };

  const steps = createStepList(
    STEP_LABELS.map((label) => ({ label })),
    { title: `Deploying ${config.slug}:` }
  );
  steps.init();

  // ── 0: Resource Group ───────────────────────────────────────
  steps.start(0);
  try {
    const exists = await exec(`az group exists --name ${resourceGroup}`, { silent: true });
    if (exists === "true") {
      steps.done(0, `${resourceGroup}  (already existed)`);
    } else {
      await exec(`az group create --name ${resourceGroup} --location ${location} --output none`);
      steps.done(0, resourceGroup);
    }
  } catch (e) {
    bail(steps, 0, e);
  }

  // ── 1: AI Services ──────────────────────────────────────────
  steps.start(1);
  try {
    let aiExists = false;
    try {
      await exec(
        `az cognitiveservices account show --name ${aiServicesName} --resource-group ${resourceGroup} --output none`,
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
      await exec(
        `az cognitiveservices account create ` +
          `--name ${aiServicesName} ` +
          `--resource-group ${resourceGroup} ` +
          `--location ${location} ` +
          `--kind AIServices ` +
          `--sku S0 ` +
          `--custom-domain ${aiServicesName} ` +
          `--yes ` +
          `--output none`,
        { timeout: 180_000 }
      );
    }
    steps.done(1, `${aiServicesName}${aiExists ? "  (already existed)" : ""}`);
  } catch (e) {
    bail(steps, 1, e);
  }

  const aiServicesEndpoint = (
    await exec(
      `az cognitiveservices account show --name ${aiServicesName} --resource-group ${resourceGroup} --query properties.endpoint --output tsv`,
      { silent: true }
    )
  ).trim();
  const aiResourceId = (
    await exec(
      `az cognitiveservices account show --name ${aiServicesName} --resource-group ${resourceGroup} --query id --output tsv`,
      { silent: true }
    )
  ).trim();

  // ── 2: Model deployments (×N) ───────────────────────────────
  steps.start(2);
  try {
    for (const m of models) {
      let exists = false;
      try {
        await exec(
          `az cognitiveservices account deployment show ` +
            `--name ${aiServicesName} ` +
            `--resource-group ${resourceGroup} ` +
            `--deployment-name ${m.deploymentName} ` +
            `--output none`,
          { silent: true }
        );
        exists = true;
      } catch { /* will create */ }
      if (!exists) {
        steps.update(2, `deploying ${m.name} → ${m.deploymentName}…`);
        const versionFlag = m.version ? `--model-version "${m.version}" ` : "";
        await exec(
          `az cognitiveservices account deployment create ` +
            `--name ${aiServicesName} ` +
            `--resource-group ${resourceGroup} ` +
            `--deployment-name ${m.deploymentName} ` +
            `--model-name ${m.name} ` +
            versionFlag +
            `--model-format "${m.format}" ` +
            `--sku-capacity ${m.skuCapacity} ` +
            `--sku-name ${m.skuName} ` +
            `--output none`,
          { timeout: 180_000 }
        );
      }
    }
    steps.done(2, `${models.length} models: ${models.map((m) => m.deploymentName).join(", ")}`);
  } catch (e) {
    bail(steps, 2, e);
  }

  // ── 3: Storage account ──────────────────────────────────────
  steps.start(3);
  try {
    let storExists = false;
    try {
      await exec(
        `az storage account show --name ${storageName} --resource-group ${resourceGroup} --output none`,
        { silent: true }
      );
      storExists = true;
    } catch {
      /* create below */
    }
    if (!storExists) {
      await exec(
        `az storage account create ` +
          `--name ${storageName} ` +
          `--resource-group ${resourceGroup} ` +
          `--location ${location} ` +
          `--sku Standard_LRS ` +
          `--output none`,
        { timeout: 120_000 }
      );
    }
    steps.done(3, `${storageName}${storExists ? "  (already existed)" : ""}`);
  } catch (e) {
    bail(steps, 3, e);
  }

  // ── 4: Function App ─────────────────────────────────────────
  steps.start(4);
  try {
    let funcExists = false;
    try {
      await exec(
        `az functionapp show --name ${functionAppName} --resource-group ${resourceGroup} --output none`,
        { silent: true }
      );
      funcExists = true;
    } catch {
      /* create below */
    }
    if (!funcExists) {
      await exec(
        `az functionapp create ` +
          `--name ${functionAppName} ` +
          `--resource-group ${resourceGroup} ` +
          `--storage-account ${storageName} ` +
          `--consumption-plan-location ${location} ` +
          `--runtime node ` +
          `--runtime-version 22 ` +
          `--functions-version 4 ` +
          `--os-type linux ` +
          `--output none`,
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
    const identityRaw = await exec(
      `az functionapp identity assign --name ${functionAppName} --resource-group ${resourceGroup} --output json`,
      { silent: true }
    );
    const identity = JSON.parse(identityRaw);
    principalId = identity.principalId;
    steps.done(6, principalId);
  } catch (e) {
    bail(steps, 6, e);
  }

  // ── 7: Role assignments ─────────────────────────────────────
  // "Cognitive Services OpenAI User" covers the /openai/ inference path (chat
  // / analyze models). "Cognitive Services User" additionally covers the MAI
  // image surface (…services.ai.azure.com/mai/v1/images/generations), which
  // the OpenAI-User role does NOT authorize — image models 401/403 without it.
  // Assign both so any role in models[] works.
  steps.start(7);
  try {
    const roles = ["Cognitive Services OpenAI User", "Cognitive Services User"];
    const delaySeconds = [0, 15, 15, 20, 30];
    for (const role of roles) {
      let assigned = false;
      for (let attempt = 0; attempt < delaySeconds.length; attempt++) {
        if (delaySeconds[attempt] > 0) {
          steps.update(
            7,
            `waiting ${delaySeconds[attempt]}s for identity propagation (${role}, try ${attempt + 1}/${delaySeconds.length})…`
          );
          await new Promise((r) => setTimeout(r, delaySeconds[attempt] * 1000));
        }
        try {
          await exec(
            `az role assignment create ` +
              `--assignee ${principalId} ` +
              `--role "${role}" ` +
              `--scope ${aiResourceId} ` +
              `--output none`,
            { silent: true }
          );
          assigned = true;
          break;
        } catch (error) {
          if (error.message.includes("already exists")) {
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
        bail(steps, 7, new Error(`Role assignment failed after all retries: ${role}`));
        return;
      }
    }
    steps.done(7, roles.join(" + "));
  } catch (e) {
    bail(steps, 7, e);
  }

  // ── 8: Code deploy ──────────────────────────────────────────
  // Remote build (Oryx) on the Function App. The backend ships its source
  // (TS) with node_modules + dist excluded via .funcignore, so Oryx does a
  // clean `npm install` (incl. devDeps like typescript) then `npm run build`
  // → compiles to dist → prunes. This is the platform-standard Linux
  // Consumption TS flow.
  steps.update(8, "publishing proxy code (remote build, ~2 min)…");
  steps.suspend();
  log("");
  process.chdir(backendDir);
  try {
    execLive(`func azure functionapp publish ${functionAppName} --javascript --build remote`);
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
      `REQUESTS_PER_MINUTE=${requestLimits.perMinute}`,
      `REQUESTS_PER_DAY=${requestLimits.perDay}`,
      `ALLOWED_ORIGIN=${sharepointOrigin}`,
      `ALLOW_PERMISSIVE_LOCAL_CORS=false`,
      `REQUIRED_APP_ROLE=${backendApiConfig.roleValue}`,
    ];
    for (let i = 0; i < models.length; i++) {
      const m = models[i];
      const suffix = roleEnvSuffix(m.role, i);
      settings.push(`AZURE_OPENAI_DEPLOYMENT_${suffix}=${m.deploymentName}`);
      if (m.apiVersion) {
        settings.push(`AZURE_OPENAI_API_VERSION_${suffix}=${m.apiVersion}`);
      }
    }
    await exec(
      `az functionapp config appsettings set ` +
        `--name ${functionAppName} ` +
        `--resource-group ${resourceGroup} ` +
        `--settings ${settings.map((s) => `"${s}"`).join(" ")} ` +
        `--output none`,
      { silent: true }
    );
    steps.done(9, `${settings.length} env vars`);
  } catch (e) {
    bail(steps, 9, e);
  }

  // ── 10: Easy Auth ───────────────────────────────────────────
  steps.start(10);
  try {
    await exec(
      `az functionapp cors add --name ${functionAppName} --resource-group ${resourceGroup} ` +
        `--allowed-origins "${sharepointOrigin}" --output none`,
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

  // ── 11: Platform hardening ──────────────────────────────────
  steps.start(11, "HTTPS-only · TLS 1.2 · FTP off…");
  try {
    await exec(
      `az functionapp update --name ${functionAppName} --resource-group ${resourceGroup} --set httpsOnly=true --output none`,
      { silent: true }
    );
    await exec(
      `az functionapp config set --name ${functionAppName} --resource-group ${resourceGroup} --min-tls-version 1.2 --ftps-state Disabled --output none`,
      { silent: true }
    );
    steps.done(11, "HTTPS-only · TLS 1.2 · FTP disabled");
  } catch (e) {
    bail(steps, 11, e);
  }

  // ── 12: Application Insights ────────────────────────────────
  steps.start(12, `provisioning ${functionAppName}-ai…`);
  try {
    const aiInsightsName = `${functionAppName}-ai`.slice(0, 60);
    await exec(
      `az monitor app-insights component create --app ${aiInsightsName} --location ${location} --resource-group ${resourceGroup} --kind web --output none`,
      { silent: true, ignoreError: true }
    );
    const connStringRaw = await exec(
      `az monitor app-insights component show --app ${aiInsightsName} --resource-group ${resourceGroup} --query connectionString --output tsv`,
      { silent: true }
    );
    const connString = connStringRaw.trim();
    if (connString) {
      await exec(
        `az functionapp config appsettings set --name ${functionAppName} --resource-group ${resourceGroup} --settings "APPLICATIONINSIGHTS_CONNECTION_STRING=${connString}" --output none`,
        { silent: true }
      );
      steps.done(12, aiInsightsName);
    } else {
      steps.done(12, "skipped (could not read connection string)");
    }
  } catch (e) {
    steps.done(12, `skipped (${(e.message || String(e)).split("\n").pop()})`);
  }

  // ── 13: Health check ────────────────────────────────────────
  const proxyUrl = `https://${functionAppName}.azurewebsites.net/api`;
  steps.start(13, "waiting 10s for Azure to settle…");
  await new Promise((r) => setTimeout(r, 10_000));
  try {
    const healthRes = await httpFetch(`${proxyUrl}/health`);
    if (healthRes.status === 401) {
      steps.done(13, "Easy Auth gate confirmed (401 without token)");
    } else if (healthRes.status === 200) {
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
  logInfo(`Models:             ${models.map((m) => `${m.role}→${m.deploymentName}`).join(", ")}`);
  log("");
  const portalUrl = `https://entra.microsoft.com/${tenantId}/#view/Microsoft_AAD_IAM/ManagedAppMenuBlade/~/Users/objectId/${backendApiConfig.servicePrincipalId}/appId/${backendApiConfig.appId}`;
  if (roleAssignment?.status === "assigned" || roleAssignment?.status === "already-assigned") {
    log(`  ${colors.bold}You're already assigned to '${backendApiConfig.roleValue}'.${colors.reset}`);
    logInfo(`To onboard more users, assign them the role at:`);
    logInfo(portalUrl);
  } else {
    log(`  ${colors.yellow}Required next step — assign users to the '${backendApiConfig.roleValue}' role:${colors.reset}`);
    logInfo(portalUrl);
    logInfo("Without an assignment, calls to the proxy return 403. This is the deliberate default-deny posture.");
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
    deployments: models.map((m) => ({
      role: m.role,
      deploymentName: m.deploymentName,
      modelName: m.name,
    })),
  };
}
