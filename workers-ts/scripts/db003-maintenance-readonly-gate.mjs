/**
 * DB-003 control-plane preflight and synthetic-only preimage rehearsal.
 * This file has no PostgreSQL client, Worker deploy, DML, DDL, or grant path.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DB003_HYPERDRIVE_IDS = Object.freeze({
  app: "ba7faa6680cd48d4b3a1d36a7a5fc8f7",
  admin: "446e94a4de0143f58c8e5178ec55db8b",
  maintenance: "9748c294e21c49a99579c9cef70102e0",
});

const ACCOUNT_ID = "7ea8e46d8210bad342fa7595f7935fea";
const KEY_FOR_ID = new Map([
  [409, "record_No"], [403, "record_No"], [397, "record_No"], [1, "record_No"],
  [405, "sign_give_point"], [399, "sign_give_point"], [3, "sign_give_point"],
  [406, "sign_status"], [400, "sign_status"], [4, "sign_status"],
  [410, "site_url"], [404, "site_url"], [398, "site_url"], [2, "site_url"],
  [408, "system_comment_time"], [402, "system_comment_time"], [6, "system_comment_time"],
  [407, "system_delivery_time"], [401, "system_delivery_time"], [5, "system_delivery_time"],
]);
export const DB003_DELETE_IDS = Object.freeze([...KEY_FOR_ID.keys()].sort((a, b) => a - b));
export const DB003_COLUMNS = Object.freeze([
  "id", "is_store", "menu_name", "type", "input_type", "config_tab_id",
  "parameter", "upload_type", "required", "width", "high", "value",
  "info", "description", "sort", "status",
]);

function populated(value) { return typeof value === "string" && value.length > 0; }

/** Only booleans and fixed reason codes leave this function. */
export function evaluateDb003ControlPlane(configs) {
  const app = configs?.app;
  const admin = configs?.admin;
  const maintenance = configs?.maintenance;
  const originA = app?.origin;
  const originD = admin?.origin;
  const originM = maintenance?.origin;
  const sameOrigin = ["service_id", "database", "scheme"].every((field) =>
    populated(originA?.[field]) && originA[field] === originD?.[field]
      && originA[field] === originM?.[field]);
  const checks = {
    exact_config_ids: app?.id === DB003_HYPERDRIVE_IDS.app
      && admin?.id === DB003_HYPERDRIVE_IDS.admin
      && maintenance?.id === DB003_HYPERDRIVE_IDS.maintenance,
    same_configured_origin: sameOrigin,
    distinct_configured_users: populated(originA?.user) && populated(originD?.user)
      && originA.user !== originD.user && originA.user !== originM?.user
      && originD.user !== originM?.user,
    maintenance_configured_postgres: originM?.user === "postgres",
    app_cache_disabled: app?.caching?.disabled === true,
    maintenance_cache_disabled: maintenance?.caching?.disabled === true,
    modification_timestamps_present: [app, admin, maintenance]
      .every((item) => populated(item?.modified_on)),
  };
  const reasonCodes = Object.entries(checks)
    .filter(([, passed]) => !passed).map(([name]) => name.toUpperCase());
  return {
    mode: "cloudflare-control-plane-get-only",
    checks,
    reasonCodes,
    mayDesignFreshSqlProbe: reasonCodes.length === 0,
    productionSqlExecuted: false,
    physicalPrimaryVerified: false,
    livePrivilegesVerified: false,
    livePreimageCaptured: false,
    readyForDml: false,
  };
}

/** No response body, URL, user or connection string is logged or returned. */
export async function runDb003ControlPlaneGet({ token, fetcher = fetch }) {
  if (!populated(token)) throw new Error("Control-plane credentials unavailable");
  const configs = {};
  for (const [kind, id] of Object.entries(DB003_HYPERDRIVE_IDS)) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/hyperdrive/configs/${id}`;
    let response;
    let body;
    try {
      response = await fetcher(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response?.ok) throw new Error("http");
      body = await response.json();
    } catch {
      throw new Error("Control-plane GET failed");
    }
    if (body?.success !== true || body?.result?.id !== id) {
      throw new Error("Control-plane response failed validation");
    }
    configs[kind] = body.result;
  }
  return evaluateDb003ControlPlane(configs);
}

function exactSyntheticRows(rows) {
  if (!Array.isArray(rows) || rows.length !== DB003_DELETE_IDS.length) {
    throw new Error("Synthetic preimage row set invalid");
  }
  const expectedKeys = [...DB003_COLUMNS].sort().join("|");
  const ids = new Set();
  for (const row of rows) {
    if (row === null || typeof row !== "object" || Array.isArray(row)
      || Object.keys(row).sort().join("|") !== expectedKeys
      || !Number.isSafeInteger(row.id) || ids.has(row.id)
      || KEY_FOR_ID.get(row.id) !== row.menu_name || row.is_store !== 0
      || row.value !== `SYNTHETIC_DB003_VALUE_${row.id}`
      || ["config_tab_id", "upload_type", "width", "high", "sort", "status"]
        .some((field) => !Number.isSafeInteger(row[field]))
      || ["type", "input_type", "parameter", "required", "info", "description"]
        .some((field) => typeof row[field] !== "string" || row[field] !== "synthetic")) {
      throw new Error("Synthetic preimage row set invalid");
    }
    ids.add(row.id);
  }
  if (DB003_DELETE_IDS.some((id) => !ids.has(id))) {
    throw new Error("Synthetic preimage row set invalid");
  }
  return [...rows].sort((a, b) => a.id - b.id);
}

function assertKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error("Synthetic rehearsal requires a 256-bit key");
  }
}

function assertSyntheticEnvelope(envelope) {
  const exactKeys = "algorithm|ciphertext|iv|mode|rowCount|tag";
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)
    || Object.keys(envelope).sort().join("|") !== exactKeys
    || envelope.mode !== "offline-synthetic-only"
    || envelope.algorithm !== "AES-256-GCM" || envelope.rowCount !== 20
    || typeof envelope.ciphertext !== "string"
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.ciphertext)
    || Buffer.from(envelope.ciphertext, "base64").length === 0
    || Buffer.from(envelope.ciphertext, "base64").length > 65_536
    || typeof envelope.iv !== "string" || Buffer.from(envelope.iv, "base64").length !== 12
    || typeof envelope.tag !== "string" || Buffer.from(envelope.tag, "base64").length !== 16) {
    throw new Error("Synthetic envelope invalid");
  }
}

/** Offline exercise only: accepts synthetic rows; no production input path exists. */
export function sealSyntheticDb003Preimage(rows, key) {
  assertKey(key);
  const sorted = exactSyntheticRows(rows);
  const iv = randomBytes(12);
  const aad = Buffer.from("db003-synthetic-preimage-v1:20-fixed-ids", "utf8");
  const plaintext = Buffer.from(JSON.stringify(sorted), "utf8");
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      mode: "offline-synthetic-only",
      algorithm: "AES-256-GCM",
      rowCount: 20,
      iv: iv.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
  } finally {
    plaintext.fill(0);
  }
}

export function openSyntheticDb003Preimage(envelope, key) {
  assertKey(key);
  assertSyntheticEnvelope(envelope);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(Buffer.from("db003-synthetic-preimage-v1:20-fixed-ids", "utf8"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final(),
    ]);
    try { return exactSyntheticRows(JSON.parse(plain.toString("utf8"))); }
    finally { plain.fill(0); }
  } catch {
    throw new Error("Synthetic envelope authentication or row validation failed");
  }
}

/** Exclusive ciphertext write for the offline fixture; production key custody is unresolved. */
export async function writeSyntheticEnvelopeExclusive(path, envelope) {
  assertSyntheticEnvelope(envelope);
  const bytes = Buffer.from(JSON.stringify(envelope), "utf8");
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(bytes); await file.sync(); }
  finally { await file.close(); bytes.fill(0); }
  return { byteCount: Buffer.byteLength(JSON.stringify(envelope)),
    ciphertextSha256: createHash("sha256").update(Buffer.from(envelope.ciphertext, "base64")).digest("hex") };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== "--control-plane-readonly") {
    process.stderr.write("Usage: node db003-maintenance-readonly-gate.mjs --control-plane-readonly\n");
    process.exitCode = 2;
  } else {
    try {
      const report = await runDb003ControlPlaneGet({ token: process.env.CLOUDFLARE_API_TOKEN });
      process.stdout.write(`${JSON.stringify(report)}\n`);
      if (!report.mayDesignFreshSqlProbe) process.exitCode = 2;
    } catch {
      process.stdout.write(`${JSON.stringify({ mode: "cloudflare-control-plane-get-only",
        reasonCodes: ["CONTROL_PLANE_PREFLIGHT_FAILED"], productionSqlExecuted: false,
        readyForDml: false })}\n`);
      process.exitCode = 2;
    }
  }
}
