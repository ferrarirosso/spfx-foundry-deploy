import { run, parseJsonOutput } from "../lib/exec.mjs";
import { logInfo } from "../lib/log.mjs";
import { pickFromList } from "./menu.mjs";

export async function pickSubscription() {
  const subs = parseJsonOutput(
    await run(
      "az",
      ["account", "list", "--query", "[].{name:name,id:id,tenantId:tenantId,isDefault:isDefault}", "--output", "json"],
      { silent: true }
    ),
    []
  );
  if (subs.length === 0) {
    throw new Error("No Azure subscriptions visible. Run 'az login' first.");
  }
  const defaultIndex = Math.max(0, subs.findIndex((s) => s.isDefault));
  const chosen = await pickFromList({
    title: "Pick an Azure subscription",
    items: subs,
    label: (s) => `${s.name}  ${s.id}${s.isDefault ? "  (current)" : ""}`,
    defaultIndex,
  });
  if (!chosen.isDefault) {
    logInfo(`Switching active subscription to ${chosen.id}`);
    await run("az", ["account", "set", "--subscription", chosen.id], { silent: true });
  }
  return { subscriptionId: chosen.id, tenantId: chosen.tenantId, name: chosen.name };
}
