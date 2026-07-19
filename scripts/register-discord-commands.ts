import { execFileSync } from "node:child_process";
import { MAX_IDLE_MINUTES, MAX_PLAYERS, MAX_SESSION_HOURS, MIN_IDLE_MINUTES, MIN_SESSION_HOURS } from "../src/shared/defaults.js";
import { ASA_MAPS, isSupportedAsaMap, parseEnabledMaps } from "../src/shared/maps.js";

interface Arguments {
  profile?: string;
  resourcePrefix: string;
}

function parseArguments(argv: string[]): Arguments {
  const args: Arguments = { resourcePrefix: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--") continue;
    if (value === "--help") {
      console.log("Usage: pnpm run discord:register [--profile PROFILE] [--resourcePrefix PREFIX]");
      process.exit(0);
    }
    if (value !== "--profile" && value !== "--resource-prefix" && value !== "--resourcePrefix") {
      throw new Error(`Unknown argument: ${value}`);
    }
    const next = argv[index + 1];
    if (!next) throw new Error(`${value} requires a value.`);
    if (value === "--profile") args.profile = next;
    else args.resourcePrefix = next;
    index += 1;
  }
  return args;
}

function aws(args: string[], profile?: string): string {
  const profileArgs = profile ? ["--profile", profile] : [];
  return execFileSync("aws", [...profileArgs, ...args, "--output", "text"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

function optionalParameter(name: string, profile?: string): string {
  const profileArgs = profile ? ["--profile", profile] : [];
  try {
    return execFileSync("aws", [...profileArgs, "ssm", "get-parameter", "--name", name, "--query", "Parameter.Value", "--output", "text"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const stderr = String((error as { stderr?: string | Buffer }).stderr ?? "");
    if (stderr.includes("ParameterNotFound")) return "";
    if (stderr) process.stderr.write(stderr);
    throw error;
  }
}

const args = parseArguments(process.argv.slice(2));
const resourcePrefix = args.resourcePrefix.trim().replace(/^\/+|\/+$/g, "");
if (resourcePrefix && !/^[A-Za-z0-9_./-]+$/.test(resourcePrefix)) {
  throw new Error("Resource prefix contains unsupported characters.");
}
const configPrefix = resourcePrefix ? `/asa/${resourcePrefix}` : "/asa";

const token =
  process.env.DISCORD_BOT_TOKEN ??
  aws(["secretsmanager", "get-secret-value", "--secret-id", `${configPrefix}/discord/bot-token`, "--query", "SecretString"], args.profile);
const applicationId =
  process.env.DISCORD_APPLICATION_ID ??
  aws(["ssm", "get-parameter", "--name", `${configPrefix}/discord/application-id`, "--query", "Parameter.Value"], args.profile);
const guildId =
  process.env.DISCORD_GUILD_ID ??
  aws(["ssm", "get-parameter", "--name", `${configPrefix}/discord/guild-id`, "--query", "Parameter.Value"], args.profile);
const enabledMaps = parseEnabledMaps(
  process.env.ASA_ENABLED_MAPS ?? optionalParameter(`${configPrefix}/server/enabled-maps`, args.profile),
);
const unsupportedEnabledMaps = enabledMaps.filter((map) => !isSupportedAsaMap(map));
if (unsupportedEnabledMaps.length > 0) {
  throw new Error(`enabled-maps contains unsupported map values: ${unsupportedEnabledMaps.join(", ")}`);
}
const mapChoices = (enabledMaps.length > 0 ? ASA_MAPS.filter((map) => enabledMaps.includes(map.value)) : ASA_MAPS).map(
  ({ name, value }) => ({
    name,
    value,
  }),
);
if (enabledMaps.length > 0 && mapChoices.length === 0) {
  throw new Error("enabled-maps did not match any supported maps.");
}

if (!token || !applicationId || !guildId) {
  throw new Error("DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID, and DISCORD_GUILD_ID are required.");
}

const commands = [
  {
    name: "asa",
    description: "Operate the private ARK: Survival Ascended server.",
    options: [
      {
        name: "start",
        description: "Start the private ARK: Survival Ascended server.",
        type: 1,
        options: [
          {
            name: "idle_minutes",
            description: "Auto-stop after this many minutes with no players",
            type: 4,
            required: false,
            min_value: MIN_IDLE_MINUTES,
            max_value: MAX_IDLE_MINUTES,
          },
          {
            name: "session_hours",
            description: "Maximum reserved session length in task-hours",
            type: 4,
            required: false,
            min_value: MIN_SESSION_HOURS,
            max_value: MAX_SESSION_HOURS,
          },
          {
            name: "map",
            description: "Map name",
            type: 3,
            required: false,
            choices: mapChoices,
          },
          {
            name: "max_players",
            description: "Maximum players",
            type: 4,
            required: false,
            min_value: 1,
            max_value: MAX_PLAYERS,
          },
          {
            name: "public_notify",
            description: "Post server info to the channel",
            type: 5,
            required: false,
          },
        ],
      },
      {
        name: "stop",
        description: "Stop the private ARK: Survival Ascended server.",
        type: 1,
        options: [
          { name: "map", description: "Map name (required when multiple maps are active)", type: 3, required: false, choices: mapChoices },
        ],
      },
      {
        name: "status",
        description: "Show ASA server status.",
        type: 1,
        options: [{ name: "map", description: "Map name; omit to list all enabled maps", type: 3, required: false, choices: mapChoices }],
      },
      {
        name: "info",
        description: "Show ASA connection info.",
        type: 1,
        options: [
          { name: "map", description: "Map name (required when multiple maps are active)", type: 3, required: false, choices: mapChoices },
        ],
      },
      {
        name: "backup",
        description: "Request a save backup or show the latest backup.",
        type: 1,
        options: [
          { name: "map", description: "Map name (required when multiple maps are active)", type: 3, required: false, choices: mapChoices },
        ],
      },
      {
        name: "budget",
        description: "Show this month's runtime budget.",
        type: 1,
      },
    ],
  },
];

const url = `https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`;
const response = await fetch(url, {
  method: "PUT",
  headers: {
    authorization: `Bot ${token}`,
    "content-type": "application/json",
  },
  body: JSON.stringify(commands),
});

if (!response.ok) {
  throw new Error(`Discord command registration failed: ${response.status} ${await response.text()}`);
}

console.log(JSON.stringify(await response.json(), null, 2));
