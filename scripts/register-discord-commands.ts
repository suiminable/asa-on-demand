const token = process.env.DISCORD_BOT_TOKEN;
const applicationId = process.env.DISCORD_APPLICATION_ID;
const guildId = process.env.DISCORD_GUILD_ID;

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
            name: "duration_hours",
            description: "Auto-stop after this many hours",
            type: 4,
            required: false,
            min_value: 1,
            max_value: 8,
          },
          {
            name: "map",
            description: "Map name",
            type: 3,
            required: false,
            choices: [{ name: "The Island", value: "TheIsland_WP" }],
          },
          {
            name: "max_players",
            description: "Maximum players",
            type: 4,
            required: false,
            min_value: 1,
            max_value: 8,
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
      },
      {
        name: "status",
        description: "Show ASA server status.",
        type: 1,
      },
      {
        name: "info",
        description: "Show ASA connection info.",
        type: 1,
      },
      {
        name: "backup",
        description: "Request a save backup or show the latest backup.",
        type: 1,
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
