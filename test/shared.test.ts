import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import { canStart, hours, monthKey } from "../src/shared/budget.js";
import { normalizeConfigPrefix, parameterNamesFor, secretNamesFor } from "../src/shared/config.js";
import { isAuthorized, verifyDiscordSignature } from "../src/shared/discord.js";
import { connectCommandForIp, eniIdFromTask } from "../src/shared/ecs.js";

describe("Discord helpers", () => {
  it("verifies valid Ed25519 signatures", () => {
    const keyPair = nacl.sign.keyPair();
    const timestamp = "1710000000";
    const rawBody = JSON.stringify({ type: 1 });
    const signature = Buffer.from(nacl.sign.detached(Buffer.from(timestamp + rawBody), keyPair.secretKey)).toString("hex");
    const publicKey = Buffer.from(keyPair.publicKey).toString("hex");

    expect(verifyDiscordSignature({ publicKey, signature, timestamp, rawBody })).toBe(true);
    expect(verifyDiscordSignature({ publicKey, signature, timestamp, rawBody: "{}" })).toBe(false);
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
    expect(connectCommandForIp("203.0.113.10")).toBe("open 203.0.113.10:7777");
    expect(connectCommandForIp("203.0.113.10", "ark.example.com")).toBe("open ark.example.com:7777");
    expect(connectCommandForIp(undefined)).toBeNull();
  });
});

describe("Config helpers", () => {
  it("normalizes scoped SSM and Secrets Manager prefixes", () => {
    expect(normalizeConfigPrefix(" /asa/maps/the-island/ ")).toBe("/asa/maps/the-island");
    expect(parameterNamesFor("/asa/maps/the-island").defaultMap).toBe("/asa/maps/the-island/server/default-map");
    expect(secretNamesFor("/asa/maps/the-island").serverPassword).toBe("/asa/maps/the-island/server/password");
  });
});
