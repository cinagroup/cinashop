// Test-only preload. Never imported by the application or normal Drizzle CLI.
const { writeFileSync, writeSync } = require("node:fs");
const Module = require("node:module");
const { resolve } = require("node:path");
const net = require("node:net");
const report = process.env.CINASHOP_DRIZZLE_AUDIT_REPORT;
const reportFd = process.env.CINASHOP_DRIZZLE_AUDIT_REPORT_FD;
if (process.env.CI !== "1" || Boolean(report) === Boolean(reportFd) || (reportFd && reportFd !== "3")) {
  throw new Error("Exactly one isolated Drizzle audit report channel is required");
}

const root = resolve(__dirname, "../..").replaceAll("\\", "/");
const loaded = new Set();
const esbuild = new Map();
let networkAttempts = 0;
let blockedIpcAttempts = 0;
const blockedSockets = [];
const denyNetwork = () => {
  networkAttempts++;
  const error = new Error("Drizzle generation must not open a socket or contact a database");
  blockedSockets.push(error.stack);
  throw error;
};
net.Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  const ipc = (typeof options === "object" && options !== null && typeof options.path === "string" && options.port === undefined)
    || (typeof options === "string" && !/^\d+$/.test(options));
  if (ipc) {
    // tsx optionally tries its parent's local IPC pipe even with caches off.
    // Block it too, but do not misreport a named pipe as a database/TCP attempt.
    blockedIpcAttempts++;
    throw new Error("Local IPC disabled in the isolated Drizzle audit");
  }
  return denyNetwork();
};
net.Server.prototype.listen = denyNetwork;
require("node:dgram").createSocket = denyNetwork;

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const filename = Module._resolveFilename(request, parent, isMain);
  const normalized = filename.replaceAll("\\", "/");
  if (normalized.startsWith(root + "/")) loaded.add(normalized.slice(root.length + 1));
  if (/(?:^|\/)@esbuild-kit\/(?:core-utils|esm-loader)\//.test(normalized)) {
    throw new Error("Legacy esbuild-kit entered Drizzle; reopen TEST-004E");
  }
  const result = originalLoad.apply(this, arguments);
  if (/\/node_modules\/esbuild\/lib\/main\.js$/.test(normalized)) {
    esbuild.set(normalized.slice(root.length + 1), result.version);
  }
  return result;
};
process.on("exit", () => {
  const data = { loaded: [...loaded].sort(), esbuild: [...esbuild], networkAttempts, blockedIpcAttempts, blockedSockets };
  if (!reportFd) return writeFileSync(report, JSON.stringify(data));
  // A dedicated synchronous pipe is independent of temporary-directory cleanup.
  // Do not use stdout (semantic diagnostics) or swallow a missing/broken channel.
  const payload = Buffer.from(JSON.stringify({ version: 1, pid: process.pid, data }), "utf8");
  if (payload.length > 1024 * 1024) throw new Error("Isolated Drizzle report exceeds its byte limit");
  for (let offset = 0; offset < payload.length;) {
    const written = writeSync(3, payload, offset, payload.length - offset);
    if (written <= 0) throw new Error("Incomplete isolated Drizzle report write");
    offset += written;
  }
});
