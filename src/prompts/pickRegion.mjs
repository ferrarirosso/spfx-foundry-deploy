import { run, parseJsonOutput } from "../lib/exec.mjs";
import { logInfo, colors } from "../lib/log.mjs";
import { pickFromList } from "./menu.mjs";
import { ask } from "../lib/ask.mjs";

const FOUNDRY_REGIONS_BY_PRIORITY = [
  "swedencentral",
  "eastus2",
  "eastus",
  "westus",
  "westus3",
  "northeurope",
  "westeurope",
  "uksouth",
  "francecentral",
  "japaneast",
  "australiaeast",
];

async function listAllRegions() {
  return parseJsonOutput(
    await run(
      "az",
      [
        "account", "list-locations",
        "--query", "[?metadata.regionType=='Physical'].{name:name,displayName:displayName}",
        "--output", "json",
      ],
      { silent: true, ignoreError: true }
    ),
    []
  );
}

export async function pickRegion(defaultRegion = "swedencentral") {
  const all = await listAllRegions();
  const allByName = new Map(all.map((r) => [r.name, r.displayName]));

  const curated = FOUNDRY_REGIONS_BY_PRIORITY.filter((n) => allByName.has(n)).map((n) => ({
    name: n,
    displayName: allByName.get(n),
  }));

  const items = [
    ...curated,
    { name: "__other__", displayName: "Other (type a region name)" },
  ];

  const defaultIndex = Math.max(
    0,
    items.findIndex((r) => r.name === defaultRegion)
  );

  const chosen = await pickFromList({
    title: `Pick an Azure region for the Foundry resource ${colors.dim}(curated for gpt-5-mini availability)${colors.reset}`,
    items,
    label: (r) => (r.name === "__other__" ? r.displayName : `${r.displayName}  (${r.name})`),
    defaultIndex,
  });

  if (chosen.name !== "__other__") {
    return chosen.name;
  }

  while (true) {
    const typed = (await ask("Region (e.g. swedencentral)", defaultRegion)).trim();
    if (!typed) continue;
    if (allByName.has(typed)) return typed;
    logInfo(`'${typed}' is not a valid region. Try one of: ${[...allByName.keys()].slice(0, 6).join(", ")}, …`);
  }
}
