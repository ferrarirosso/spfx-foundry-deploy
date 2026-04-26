import { randomUUID } from "node:crypto";
import { exec, shellQuote, parseJsonOutput } from "./exec.mjs";
import { logOk, logSkip, logInfo } from "./log.mjs";

// SPFx first-party client — service principal exists in every tenant with SPO.
// Granting it access to the Backend API scope makes
// AadTokenProvider.getToken("api://<backendAppId>") work for every user.
export const SPFX_CLIENT_APP_ID = "08e18876-6177-487e-b8b5-cf950c1e598c";

const SCOPE_VALUE = "user_impersonation";

function buildUserScope(displayName, existingScopeId) {
  return {
    adminConsentDescription: `Allow ${displayName} to call the backend API on behalf of the signed-in user.`,
    adminConsentDisplayName: `Access ${displayName} backend`,
    id: existingScopeId || randomUUID(),
    isEnabled: true,
    type: "User",
    userConsentDescription: `Allow ${displayName} to call the backend API on your behalf.`,
    userConsentDisplayName: `Access ${displayName} backend`,
    value: SCOPE_VALUE,
  };
}

// Sec-2 (Option B): the Backend API app declares one app role per deployment.
// The role's value is `<namePrefix>.User` so it's unique per deployment and
// admins can tell roles apart at-a-glance in the Enterprise Apps blade.
function buildAppRole(namePrefix, existingRoleId) {
  return {
    id: existingRoleId || randomUUID(),
    isEnabled: true,
    allowedMemberTypes: ["User"],
    displayName: `${namePrefix} backend user`,
    description: `Authorizes the bearer to call the ${namePrefix} Backend API.`,
    value: `${namePrefix}.User`,
  };
}

export async function ensureBackendApiApplication(displayName, namePrefix) {
  let app = parseJsonOutput(
    await exec(
      `az ad app list --display-name "${displayName}" --query "[0]" --output json`,
      { silent: true, ignoreError: true }
    )
  );

  if (!app) {
    app = JSON.parse(
      await exec(
        `az ad app create ` +
          `--display-name "${displayName}" ` +
          `--sign-in-audience AzureADMyOrg ` +
          `--requested-access-token-version 2 ` +
          `--output json`,
        { silent: true }
      )
    );
    logOk(`Created Entra app registration: ${displayName}`);
  } else {
    logSkip(`${displayName} app registration`);
  }

  const graphApp = JSON.parse(
    await exec(
      `az rest --method GET ` +
        `--uri "https://graph.microsoft.com/v1.0/applications/${app.id}?$select=id,appId,displayName,identifierUris,api,appRoles" ` +
        `--output json`,
      { silent: true }
    )
  );

  const backendApiResource = `api://${graphApp.appId}`;
  const existingScope = Array.isArray(graphApp.api?.oauth2PermissionScopes)
    ? graphApp.api.oauth2PermissionScopes.find((s) => s.value === SCOPE_VALUE)
    : undefined;
  const roleValue = `${namePrefix}.User`;
  const existingRole = Array.isArray(graphApp.appRoles)
    ? graphApp.appRoles.find((r) => r.value === roleValue)
    : undefined;

  const patchBody = {
    identifierUris: [backendApiResource],
    api: {
      requestedAccessTokenVersion: 2,
      oauth2PermissionScopes: [buildUserScope(displayName, existingScope?.id)],
    },
    appRoles: [buildAppRole(namePrefix, existingRole?.id)],
  };

  await exec(
    `az rest --method PATCH ` +
      `--uri "https://graph.microsoft.com/v1.0/applications/${graphApp.id}" ` +
      `--headers Content-Type=application/json ` +
      `--body ${shellQuote(JSON.stringify(patchBody))} ` +
      `--output none`,
    { silent: true }
  );
  logOk(`Configured API scope + '${roleValue}' app role on ${displayName}`);

  try {
    await exec(`az ad sp show --id ${graphApp.appId} --output none`, { silent: true });
    logSkip(`${displayName} service principal`);
  } catch {
    await exec(`az ad sp create --id ${graphApp.appId} --output none`, { silent: true });
    logOk(`Created service principal for ${displayName}`);
  }

  // Re-read the SP to get its objectId + the freshly-created role id.
  // Needed for the post-deploy "assign users to role" flow.
  const sp = JSON.parse(
    await exec(
      `az ad sp show --id ${graphApp.appId} --query "{id:id,appRoles:appRoles}" --output json`,
      { silent: true }
    )
  );
  const provisionedRole = (sp.appRoles || []).find((r) => r.value === roleValue);

  return {
    appId: graphApp.appId,
    objectId: graphApp.id,
    resource: backendApiResource,
    displayName,
    scopeValue: SCOPE_VALUE,
    roleValue,
    servicePrincipalId: sp.id,
    appRoleId: provisionedRole?.id || null,
  };
}

// Best-effort: assign the deploying user the freshly-created app role so
// they can chat immediately after `npm run deploy` without a Portal click.
// Fails open: if the user lacks permissions or the assignment already
// exists, the post-deploy banner prints the manual Portal URL anyway.
export async function tryAssignDeployingUserToRole(servicePrincipalId, appRoleId) {
  if (!servicePrincipalId || !appRoleId) return null;

  let userId;
  let upn;
  try {
    userId = (
      await exec(`az ad signed-in-user show --query id --output tsv`, { silent: true })
    ).trim();
    upn = (
      await exec(`az ad signed-in-user show --query userPrincipalName --output tsv`, {
        silent: true,
        ignoreError: true,
      })
    ).trim();
  } catch {
    return { status: "no-user" };
  }
  if (!userId) return { status: "no-user" };

  const body = JSON.stringify({
    principalId: userId,
    resourceId: servicePrincipalId,
    appRoleId,
  });

  try {
    await exec(
      `az rest --method POST ` +
        `--uri "https://graph.microsoft.com/v1.0/users/${userId}/appRoleAssignments" ` +
        `--headers Content-Type=application/json ` +
        `--body ${shellQuote(body)} ` +
        `--output none`,
      { silent: true }
    );
    return { status: "assigned", upn };
  } catch (error) {
    const message = String(error?.message || "");
    // Graph returns 4xx with "Permission being assigned already exists on the object"
    // when the assignment is already in place. Treat that as success.
    if (/already exists|already assigned|Conflict/i.test(message)) {
      return { status: "already-assigned", upn };
    }
    return { status: "failed", upn, error: message.split("\n").pop() };
  }
}

export async function ensureSpfxPermissionGrant(backendApiAppId) {
  const spfxSpId = parseJsonOutput(
    await exec(
      `az ad sp list --filter "appId eq '${SPFX_CLIENT_APP_ID}'" --query "[0].id" --output json`,
      { silent: true, ignoreError: true }
    )
  );
  if (!spfxSpId) {
    logInfo(
      "SPFx service principal not found in tenant — permission grant skipped (manual admin approval may be required)."
    );
    return;
  }

  const backendSpId = parseJsonOutput(
    await exec(
      `az ad sp list --filter "appId eq '${backendApiAppId}'" --query "[0].id" --output json`,
      { silent: true, ignoreError: true }
    )
  );
  if (!backendSpId) {
    logInfo("Backend API service principal not found — permission grant skipped.");
    return;
  }

  const existingGrants = JSON.parse(
    (await exec(
      `az rest --method GET ` +
        `--uri "https://graph.microsoft.com/v1.0/oauth2PermissionGrants?\\$filter=clientId eq '${spfxSpId}' and resourceId eq '${backendSpId}'" ` +
        `--query "value" --output json`,
      { silent: true, ignoreError: true }
    )) || "[]"
  );

  const hasGrant = existingGrants.some((g) =>
    String(g.scope || "").split(" ").includes(SCOPE_VALUE)
  );

  if (hasGrant) {
    logSkip("SPFx → Backend API permission grant");
    return;
  }

  const grantBody = JSON.stringify({
    clientId: spfxSpId,
    consentType: "AllPrincipals",
    resourceId: backendSpId,
    scope: SCOPE_VALUE,
  });

  await exec(
    `az rest --method POST ` +
      `--uri "https://graph.microsoft.com/v1.0/oauth2PermissionGrants" ` +
      `--headers Content-Type=application/json ` +
      `--body ${shellQuote(grantBody)} ` +
      `--output none`,
    { silent: true }
  );
  logOk(`Granted SPFx → Backend API permission (${SCOPE_VALUE})`);
}

export async function configureFunctionAppEasyAuth({
  subscriptionId,
  tenantId,
  resourceGroup,
  functionAppName,
  backendApiAppId,
  backendApiResource,
}) {
  // Easy Auth in API mode:
  //   requireAuthentication=true → unauthenticated calls never reach the function
  //   unauthenticatedClientAction=Return401 → no redirect-to-login HTML for browsers
  //   audience pinned to api://<backend-app-id> → wrong-audience tokens are rejected
  const authSettingsBody = {
    properties: {
      platform: { enabled: true },
      globalValidation: {
        requireAuthentication: true,
        unauthenticatedClientAction: "Return401",
      },
      httpSettings: { requireHttps: true },
      identityProviders: {
        azureActiveDirectory: {
          enabled: true,
          registration: {
            clientId: backendApiAppId,
            openIdIssuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
          },
          validation: {
            allowedAudiences: [backendApiResource, backendApiAppId],
          },
        },
      },
      login: { tokenStore: { enabled: false } },
    },
  };

  await exec(
    `az rest --method PUT ` +
      `--uri "https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Web/sites/${functionAppName}/config/authsettingsV2?api-version=2023-12-01" ` +
      `--headers Content-Type=application/json ` +
      `--body ${shellQuote(JSON.stringify(authSettingsBody))} ` +
      `--output none`,
    { silent: true }
  );
}
