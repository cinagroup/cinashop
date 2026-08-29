import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  sha256Hex,
  signVisitorToken,
  verifyVisitorToken,
} from "../src/services/kefu/KefuVisitorSessionService";

describe("signed customer-service visitor sessions", () => {
  it("binds issuer, audience, session UUID, high-range UID and expiry", async () => {
    const secret = "visitor-session-unit-secret";
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const expiresAt = Math.floor(Date.now() / 1_000) + 3_600;
    const token = await signVisitorToken(secret, sessionId, 1_000_000_017, expiresAt);
    await expect(verifyVisitorToken(token, secret)).resolves.toEqual({
      sub: sessionId,
      exp: expiresAt,
      visitor_uid: 1_000_000_017,
    });
    await expect(verifyVisitorToken(token, "wrong-secret")).rejects.toThrow();
    await expect(sha256Hex(token)).resolves.toMatch(/^[0-9a-f]{64}$/);
    expect(token).not.toContain(sessionId);
  });

  it("keeps the external and embedded visitor DDL byte-equivalent", () => {
    const migration = readFileSync("migrations/0104_kefu_visitor_session.sql", "utf8").trim();
    const embedded = readFileSync("src/services/MigrationService.ts", "utf8")
      .match(/private migration_0111\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    expect(embedded).toBe(migration);
    expect(migration).toContain('START WITH 1000000000');
    expect(migration).toContain('"token_hash" VARCHAR(64) NOT NULL UNIQUE');
    expect(migration).not.toContain('"ip"');
    expect(migration).not.toContain('"token" VARCHAR');
  });
});
