import { run, parseJsonOutput } from "../lib/exec.mjs";
import { ask } from "../lib/ask.mjs";

export async function suggestSharePointOrigin() {
  return suggestFromAccount();
}

async function suggestFromAccount() {
  const account = parseJsonOutput(
    await run("az", ["account", "show", "--output", "json"], { silent: true, ignoreError: true })
  );
  const userName = account?.user?.name || "";
  const at = userName.indexOf("@");
  if (at < 0) return "";
  const domain = userName.slice(at + 1);
  if (!domain) return "";
  if (domain.endsWith(".onmicrosoft.com")) {
    const tenant = domain.replace(".onmicrosoft.com", "");
    return `https://${tenant}.sharepoint.com`;
  }
  const firstLabel = domain.split(".")[0];
  if (firstLabel) return `https://${firstLabel}.sharepoint.com`;
  return "";
}

export async function askSharePointOrigin() {
  const suggested = await suggestFromAccount();
  while (true) {
    const raw = (await ask(
      "SharePoint origin for CORS (e.g. https://contoso.sharepoint.com)",
      suggested
    )).trim();
    if (!raw) continue;
    if (!/^https:\/\/[a-z0-9-]+\.sharepoint\.com\/?$/i.test(raw)) {
      console.log("  Must be https://<tenant>.sharepoint.com");
      continue;
    }
    return raw.replace(/\/+$/, "");
  }
}
