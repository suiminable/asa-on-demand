import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import { canStart, hours, monthKey } from "../src/shared/budget.js";
import { normalizeConfigPrefix, parameterNamesFor, secretNamesFor } from "../src/shared/config.js";
import { DEFAULT_SESSION_HOURS, MAX_SESSION_HOURS } from "../src/shared/defaults.js";
import { isAuthorized, verifyDiscordSignature } from "../src/shared/discord.js";
import { connectCommandForIp, eniIdFromTask, taskStopReason } from "../src/shared/ecs.js";
import { ASA_MAPS, isSupportedAsaMap, parseEnabledMaps } from "../src/shared/maps.js";

describe("Discord helpers", () => {
  it("verifies valid Ed25519 signatures", () => {
    const keyPair = nacl.sign.keyPair();
    const timestamp = "1710000000";
    const now = new Date(Number(timestamp) * 1000);
    const rawBody = JSON.stringify({ type: 1 });
    const signature = Buffer.from(nacl.sign.detached(Buffer.from(timestamp + rawBody), keyPair.secretKey)).toString("hex");
    const publicKey = Buffer.from(keyPair.publicKey).toString("hex");

    expect(verifyDiscordSignature({ publicKey, signature, timestamp, rawBody, now })).toBe(true);
    expect(verifyDiscordSignature({ publicKey, signature, timestamp, rawBody: "{}", now })).toBe(false);
    expect(verifyDiscordSignature({ publicKey, signature: "not-hex", timestamp, rawBody, now })).toBe(false);
    expect(verifyDiscordSignature({ publicKey, signature, timestamp, rawBody, now: new Date((Number(timestamp) + 301) * 1000) })).toBe(
      false,
    );
  });

  it("authorizes by allowed user or role", () => {
    expect(isAuthorized({ type: 2, member: { user: { id: "u1" }, roles: [] } }, ["u1"], [])).toBe(true);
    expect(isAuthorized({ type: 2, member: { user: { id: "u2" }, roles: ["r1"] } }, [], ["r1"])).toBe(true);
    expect(isAuthorized({ type: 2, member: { user: { id: "u2" }, roles: ["r2"] } }, ["u1"], ["r1"])).toBe(false);
  });
});

describe("Budget helpers", () => {
  it("formats monthly keys and hours", () => {
    expect(monthKey(new Date("2026-06-24T00:00:00Z"))).toBe("BUDGET#2026-06");
    expect(monthKey(new Date("2026-06-30T15:00:00Z"))).toBe("BUDGET#2026-07");
    expect(hours(3660)).toBe(1);
    expect(hours(5400)).toBe(1.5);
  });

  it("rejects starts that exceed runtime limit", () => {
    expect(
      canStart({
        budget: { pk: "BUDGET#2026-06", runtimeSeconds: 79 * 3600, estimatedCostJpy: 0, estimatedCostUsd: 0, startCount: 0, updatedAt: "" },
        requestedHours: 2,
        monthlyRuntimeHoursLimit: 80,
      }).ok,
    ).toBe(false);
    expect(canStart({ budget: undefined, requestedHours: 4, monthlyRuntimeHoursLimit: 80 }).ok).toBe(true);
  });
});

describe("ECS helpers", () => {
  it("extracts ENI IDs from task attachments", () => {
    expect(
      eniIdFromTask({
        attachments: [
          {
            type: "ElasticNetworkInterface",
            details: [{ name: "networkInterfaceId", value: "eni-123" }],
          },
        ],
      }),
    ).toBe("eni-123");
  });

  it("builds connect commands", () => {
    expect(connectCommandForIp("203.0.113.10")).toBe("open 203.0.113.10:7777?Password=YOUR_SERVER_PASSWORD");
    expect(connectCommandForIp("203.0.113.10", "ark.example.com")).toBe("open ark.example.com:7777?Password=YOUR_SERVER_PASSWORD");
    expect(connectCommandForIp(undefined)).toBeNull();
  });

  it("includes container failures in task stop reasons", () => {
    expect(taskStopReason("Essential container in task exited", [{ reason: "OutOfMemoryError" }])).toBe(
      "Essential container in task exited: OutOfMemoryError",
    );
    expect(taskStopReason(undefined, undefined)).toBe("unknown");
  });
});

describe("Config helpers", () => {
  it("normalizes scoped SSM and Secrets Manager prefixes", () => {
    expect(normalizeConfigPrefix(" /asa/maps/the-island/ ")).toBe("/asa/maps/the-island");
    expect(parameterNamesFor("/asa/maps/the-island").defaultMap).toBe("/asa/maps/the-island/server/default-map");
    expect(parameterNamesFor("/asa/maps/the-island").enabledMaps).toBe("/asa/maps/the-island/server/enabled-maps");
    expect(secretNamesFor("/asa/maps/the-island").serverPassword).toBe("/asa/maps/the-island/server/password");
  });
});

describe("ASA maps", () => {
  it("keeps Discord choices and server validation on the same allowlist", () => {
    expect(ASA_MAPS).toContainEqual({ name: "The Island", value: "TheIsland_WP" });
    expect(ASA_MAPS).toContainEqual({ name: "Genesis: Part 1", value: "Genesis_WP" });
    expect(isSupportedAsaMap("Ragnarok_WP")).toBe(true);
    expect(isSupportedAsaMap("Genesis_WP")).toBe(true);
    expect(isSupportedAsaMap("Genesis2_WP")).toBe(false);
  });

  it("parses comma-separated enabled maps and ignores whitespace and empty values", () => {
    expect(parseEnabledMaps("")).toEqual([]);
    expect(parseEnabledMaps("  ,  ")).toEqual([]);
    expect(parseEnabledMaps(" TheIsland_WP, , ScorchedEarth_WP ")).toEqual(["TheIsland_WP", "ScorchedEarth_WP"]);
  });
});

describe("Session defaults", () => {
  it("uses an 8-hour default and a 48-hour maximum", () => {
    expect(DEFAULT_SESSION_HOURS).toBe(8);
    expect(MAX_SESSION_HOURS).toBe(48);
  });
});
