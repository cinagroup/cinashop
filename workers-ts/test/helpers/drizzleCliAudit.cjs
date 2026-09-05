// Test-only preload. Never imported by the application or normal Drizzle CLI.
const { writeFileSync } = require("node:fs");
const Module = require("node:module");
const { resolve } = require("node:path");
const net = require("node:net");
const report = process.env.CINASHOP_DRIZZLE_AUDIT_REPORT;
if (process.env.CI !== "1" || !report) throw new Error("Isolated Drizzle audit configuration required");

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
process.on("exit", () => writeFileSync(report, JSON.stringify({ loaded: [...loaded].sort(), esbuild: [...esbuild], networkAttempts, blockedIpcAttempts, blockedSockets })));
