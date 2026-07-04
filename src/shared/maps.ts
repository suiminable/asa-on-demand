export const ASA_MAPS = [
  { name: "The Island", value: "TheIsland_WP" },
  { name: "Scorched Earth", value: "ScorchedEarth_WP" },
  { name: "The Center", value: "TheCenter_WP" },
  { name: "Aberration", value: "Aberration_WP" },
  { name: "Extinction", value: "Extinction_WP" },
  { name: "Astraeos", value: "Astraeos_WP" },
  { name: "Ragnarok", value: "Ragnarok_WP" },
  { name: "Valguero", value: "Valguero_WP" },
  { name: "Lost Colony", value: "LostColony_WP" },
] as const;

const asaMapValues = new Set<string>(ASA_MAPS.map((map) => map.value));

export function isSupportedAsaMap(value: string): boolean {
  return asaMapValues.has(value);
}
