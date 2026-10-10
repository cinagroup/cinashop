import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ create: vi.fn(), audit: vi.fn(), end: vi.fn() }));
vi.mock("@/lib/di", () => ({ createDbFromConnectionString: mocks.create }));
vi.mock("@/migrations/auditProductionObservability", () => ({ auditProductionObservability: mocks.audit }));

import worker from "./integration/ProductionObservabilityAuditWorker";

const token = "a".repeat(64);
const hash = createHash("sha256").update(token).digest("hex");
const secret = "private-connection-or-sql-never-returned";

function env(expires = Date.now() + 60_000) {
  return {
    HYPERDRIVE: { connectionString: `postgresql://${secret}/never-used` } as Hyperdrive,
    AUDIT_TOKEN_SHA256: hash,
    AUDIT_EXPIRES_AT: String(expires),
  };
}
function request(path = "/observability", method = "GET", credential = token) {
  return new Request(`https://audit.invalid${path}`, {
    method, headers: credential ? { "X-Audit-Token": credential } : {},
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.create.mockReturnValue({ $client: { end: mocks.end } });
  mocks.end.mockResolvedValue(undefined);
  mocks.audit.mockResolvedValue({ scope: "production-observability-db-aggregate", ready: false,
    safety: { identityVerified: true, transactionReadOnly: true, repeatableRead: true } });
});

describe("TEST-003B temporary aggregate Worker boundary", () => {
  it("rejects invalid credentials, expiry, routes, queries and methods before opening a database", async () => {
    for (const credential of ["", "b".repeat(64), "a".repeat(63), "A".repeat(64)]) {
      expect((await worker.fetch(request("/observability", "GET", credential), env())).status).toBe(403);
    }
    expect((await worker.fetch(request(), env(Date.now() - 1))).status).toBe(403);
    expect((await worker.fetch(request(), env(Date.now() + 11 * 60_000))).status).toBe(403);
    expect((await worker.fetch(request("/other"), env())).status).toBe(404);
    expect((await worker.fetch(request("/observability?sql=select"), env())).status).toBe(404);
    expect((await worker.fetch(request("/observability", "POST"), env())).status).toBe(405);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("passes only fixed production identity and returns a non-cacheable aggregate", async () => {
    const response = await worker.fetch(request(), env());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(await response.json()).toMatchObject({ scope: "production-observability-db-aggregate",
      ready: false, safety: { transactionReadOnly: true } });
    expect(mocks.audit).toHaveBeenCalledExactlyOnceWith(mocks.create.mock.results[0].value.$client,
      { role: "cinashop_app_v1", database: "postgres" });
    expect(mocks.end).toHaveBeenCalledExactlyOnceWith({ timeout: 1 });
  });

  it.each([
    ["connect", "other", "create"],
    ["sample", "permission", "audit"],
    ["close", "other", "end"],
  ] as const)("fails closed at %s without leaking driver data", async (stage, category, failed) => {
    const error = Object.assign(Error(secret), { code: failed === "audit" ? "42501" : "XX000" });
    if (failed === "create") mocks.create.mockImplementationOnce(() => { throw error; });
    else mocks[failed].mockRejectedValueOnce(error);
    const response = await worker.fetch(request(), env());
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ error: "audit failed", stage, category });
    expect(body).not.toContain(secret);
    if (failed !== "create") expect(mocks.end).toHaveBeenCalled();
  });
});
