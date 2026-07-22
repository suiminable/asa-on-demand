export interface AsaMapDefinition {
  mapId: string;
  name: string;
  arkMapName: string;
  sessionSuffix: string;
  /** Discord choice compatibility. */
  value: string;
}

function map(mapId: string, name: string, arkMapName: string, sessionSuffix: string): AsaMapDefinition {
  return { mapId, name, arkMapName, sessionSuffix, value: arkMapName };
}

export const ASA_MAPS = [
  map("the-island", "The Island", "TheIsland_WP", "island"),
  map("scorched-earth", "Scorched Earth", "ScorchedEarth_WP", "scorched"),
  map("the-center", "The Center", "TheCenter_WP", "center"),
  map("aberration", "Aberration", "Aberration_WP", "aberration"),
  map("extinction", "Extinction", "Extinction_WP", "extinction"),
  map("astraeos", "Astraeos", "Astraeos_WP", "astraeos"),
  map("ragnarok", "Ragnarok", "Ragnarok_WP", "ragnarok"),
  map("valguero", "Valguero", "Valguero_WP", "valguero"),
  map("lost-colony", "Lost Colony", "LostColony_WP", "lost-colony"),
  map("genesis-1", "Genesis: Part 1", "Genesis_WP", "genesis-1"),
] as const satisfies readonly AsaMapDefinition[];

const byArkMapName = new Map<string, AsaMapDefinition>(ASA_MAPS.map((definition) => [definition.arkMapName, definition]));
const byMapId = new Map<string, AsaMapDefinition>(ASA_MAPS.map((definition) => [definition.mapId, definition]));

export function parseEnabledMaps(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

export function mapByArkMapName(value: string): AsaMapDefinition | undefined {
  return byArkMapName.get(value);
}

export function mapById(value: string): AsaMapDefinition | undefined {
  return byMapId.get(value);
}

export function requireMapByArkMapName(value: string): AsaMapDefinition {
  const definition = mapByArkMapName(value);
  if (!definition) throw new Error(`Unsupported ASA map: ${value}`);
  return definition;
}

export function isSupportedAsaMap(value: string): boolean {
  return byArkMapName.has(value);
}

export function enabledMapDefinitions(enabledArkMapNames: string[]): AsaMapDefinition[] {
  const selected = enabledArkMapNames.length > 0 ? enabledArkMapNames : ASA_MAPS.map((definition) => definition.arkMapName);
  return selected.map(requireMapByArkMapName);
}

export function sessionNameFor(baseName: string, definition: AsaMapDefinition): string {
  const value = `${baseName}-${definition.sessionSuffix}`;
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(value)) {
    throw new Error(`Map session name ${value} is invalid or exceeds 64 characters.`);
  }
  return value;
}
