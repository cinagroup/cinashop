import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, mkdtemp, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DB003_COLUMNS, DB003_DELETE_IDS, DB003_HYPERDRIVE_IDS,
  evaluateDb003ControlPlane, openSyntheticDb003Preimage,
  runDb003ControlPlaneGet, sealSyntheticDb003Preimage,
  writeSyntheticEnvelopeExclusive,
} from "../scripts/db003-maintenance-readonly-gate.mjs";

const keyById = new Map([
  ...[409, 403, 397, 1].map((id) => [id, "record_No"]),
  ...[405, 399, 3].map((id) => [id, "sign_give_point"]),
  ...[406, 400, 4].map((id) => [id, "sign_status"]),
  ...[410, 404, 398, 2].map((id) => [id, "site_url"]),
  ...[408, 402, 6].map((id) => [id, "system_comment_time"]),
  ...[407, 401, 5].map((id) => [id, "system_delivery_time"]),
]);

function configs() {
  const origin = { service_id: "synthetic-service", database: "synthetic-db", scheme: "postgres" };
  return {
    app: { id: DB003_HYPERDRIVE_IDS.app, origin: { ...origin, user: "synthetic-app", password: "SECRET_SENTINEL" },
      caching: { disabled: true }, modified_on: "synthetic-time" },
    admin: { id: DB003_HYPERDRIVE_IDS.admin, origin: { ...origin, user: "synthetic-admin" },
      caching: { disabled: true }, modified_on: "synthetic-time" },
    maintenance: { id: DB003_HYPERDRIVE_IDS.maintenance, origin: { ...origin, user: "postgres" },
      caching: { disabled: true }, modified_on: "synthetic-time" },
  };
}

function syntheticRows() {
  return DB003_DELETE_IDS.map((id) => ({
    id, is_store: 0, menu_name: keyById.get(id), type: "synthetic",
    input_type: "synthetic", config_tab_id: 0, parameter: "synthetic",
    upload_type: 0, required: "synthetic", width: 0, high: 0,
    value: `SYNTHETIC_DB003_VALUE_${id}`, info: "synthetic",
    description: "synthetic", sort: 0, status: 0,
  }));
}

test("three matching cache-disabled configurations permit designing a later SQL probe, not DML", () => {
  const report = evaluateDb003ControlPlane(configs());
  assert.equal(report.mayDesignFreshSqlProbe, true);
  assert.equal(report.productionSqlExecuted, false);
  assert.equal(report.physicalPrimaryVerified, false);
  assert.equal(report.livePrivilegesVerified, false);
  assert.equal(report.livePreimageCaptured, false);
  assert.equal(report.readyForDml, false);
  assert.equal(JSON.stringify(report).includes("SECRET_SENTINEL"), false);
});

test("the observed cache-enabled maintenance route fails before any SQL", () => {
  const fixture = configs();
  fixture.maintenance.caching.disabled = false;
  const report = evaluateDb003ControlPlane(fixture);
  assert.equal(report.mayDesignFreshSqlProbe, false);
  assert.deepEqual(report.reasonCodes, ["MAINTENANCE_CACHE_DISABLED"]);
  assert.equal(report.productionSqlExecuted, false);
});

test("origin, identity, cache and metadata drift each fail closed", () => {
  const alterations = [
    (f) => { f.maintenance.id = "wrong"; },
    (f) => { f.maintenance.origin.service_id = "other"; },
    (f) => { f.maintenance.origin.database = "other"; },
    (f) => { f.maintenance.origin.scheme = "other"; },
    (f) => { f.maintenance.origin.service_id = ""; },
    (f) => { f.maintenance.origin.user = "synthetic-app"; },
    (f) => { f.maintenance.origin.user = "other"; },
    (f) => { f.app.caching.disabled = false; },
    (f) => { delete f.maintenance.caching.disabled; },
    (f) => { f.admin.modified_on = ""; },
  ];
  for (const alter of alterations) {
    const fixture = configs();
    alter(fixture);
    const report = evaluateDb003ControlPlane(fixture);
    assert.equal(report.mayDesignFreshSqlProbe, false);
    assert.ok(report.reasonCodes.length > 0);
    assert.equal(report.readyForDml, false);
  }
});

test("control-plane probe issues only three GETs and never returns raw configuration", async () => {
  const fixture = configs();
  const seen = [];
  const fetcher = async (url, init) => {
    seen.push({ url, method: init.method, authorization: init.headers.Authorization,
      body: init.body });
    const kind = Object.keys(DB003_HYPERDRIVE_IDS)
      .find((name) => url.endsWith(`/${DB003_HYPERDRIVE_IDS[name]}`));
    return { ok: true, json: async () => ({ success: true, result: fixture[kind] }) };
  };
  const report = await runDb003ControlPlaneGet({ token: "SYNTHETIC_TOKEN", fetcher });
  assert.equal(seen.length, 3);
  assert.ok(seen.every((item) => item.method === "GET" && item.body === undefined));
  assert.ok(seen.every((item) => item.authorization === "Bearer SYNTHETIC_TOKEN"));
  assert.equal(JSON.stringify(report).includes("SECRET_SENTINEL"), false);
  assert.equal(JSON.stringify(report).includes("SYNTHETIC_TOKEN"), false);
});

test("malformed or failed control-plane replies expose no remote body", async () => {
  await assert.rejects(runDb003ControlPlaneGet({ token: "SYNTHETIC_TOKEN",
    fetcher: async () => ({ ok: false, json: async () => ({ secret: "SECRET_SENTINEL" }) }) }),
  (error) => error.message === "Control-plane GET failed");
  await assert.rejects(runDb003ControlPlaneGet({ token: "SYNTHETIC_TOKEN",
    fetcher: async () => ({ ok: true, json: async () => ({ success: true,
      result: { id: "wrong", password: "SECRET_SENTINEL" } }) }) }),
  (error) => error.message === "Control-plane response failed validation");
});

test("synthetic 20-row 16-column preimage seals, saves exclusively and authenticates", async () => {
  const rows = syntheticRows();
  assert.equal(rows.length, 20);
  assert.ok(rows.every((row) => DB003_COLUMNS.every((column) => Object.hasOwn(row, column))));
  const key = randomBytes(32);
  const envelope = sealSyntheticDb003Preimage(rows, key);
  assert.equal(JSON.stringify(envelope).includes("SYNTHETIC_DB003_VALUE_"), false);
  assert.deepEqual(openSyntheticDb003Preimage(envelope, key), rows);
  const dir = await mkdtemp(join(tmpdir(), "db003-synthetic-"));
  const path = join(dir, "preimage.enc.json");
  try {
    const saved = await writeSyntheticEnvelopeExclusive(path, envelope);
    assert.equal(saved.ciphertextSha256.length, 64);
    const bytes = await readFile(path, "utf8");
    assert.equal(bytes.includes("SYNTHETIC_DB003_VALUE_"), false);
    assert.deepEqual(openSyntheticDb003Preimage(JSON.parse(bytes), key), rows);
    await assert.rejects(writeSyntheticEnvelopeExclusive(path, envelope), { code: "EEXIST" });
  } finally {
    await unlink(path);
    await rmdir(dir);
  }
});

test("preimage rejects wrong key, tamper, missing column, duplicate ID and real-looking value", () => {
  const rows = syntheticRows();
  const key = randomBytes(32);
  const envelope = sealSyntheticDb003Preimage(rows, key);
  assert.throws(() => openSyntheticDb003Preimage(envelope, randomBytes(32)), /authentication/);
  assert.throws(() => openSyntheticDb003Preimage({ ...envelope,
    ciphertext: `A${envelope.ciphertext.slice(1)}` }, key), /authentication/);
  assert.throws(() => sealSyntheticDb003Preimage(rows.slice(1), key), /row set invalid/);
  assert.throws(() => sealSyntheticDb003Preimage(rows.map((row, index) =>
    index === 1 ? { ...row, id: rows[0].id } : row), key), /row set invalid/);
  assert.throws(() => sealSyntheticDb003Preimage(rows.map((row, index) => {
    if (index !== 0) return row;
    const { description: _description, ...incomplete } = row;
    return incomplete;
  }), key), /row set invalid/);
  assert.throws(() => sealSyntheticDb003Preimage(rows.map((row, index) =>
    index === 0 ? { ...row, value: "https://real.example" } : row), key), /row set invalid/);
  assert.throws(() => openSyntheticDb003Preimage({ ...envelope, rawValue: "SECRET_SENTINEL" }, key),
    /Synthetic envelope invalid/);
});
