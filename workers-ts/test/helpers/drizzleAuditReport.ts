import assert from 'node:assert/strict';
import type { SpawnSyncReturns } from 'node:child_process';

interface AuditReport {
  loaded: string[];
  esbuild: [string, string][];
  networkAttempts: number;
  blockedIpcAttempts: number;
  blockedSockets: string[];
}

/** A report is evidence only after the same child exits successfully. A valid
 * JSON prefix, duplicate packet, other writer PID or missing pipe is not proof. */
export function readDrizzleAuditReport(result: Pick<SpawnSyncReturns<string>, 'error' | 'status' | 'signal' | 'pid' | 'output'>): AuditReport {
  assert.ok(!result.error && result.status === 0 && !result.signal, 'Isolated Drizzle child did not exit successfully');
  const raw = result.output[3];
  assert.ok(typeof raw === 'string' && raw.length > 0 && Buffer.byteLength(raw, 'utf8') <= 1024 * 1024,
    'Missing or oversized isolated Drizzle report');
  const envelope: unknown = JSON.parse(raw);
  assert.ok(envelope && typeof envelope === 'object' && !Array.isArray(envelope));
  assert.deepEqual(Object.keys(envelope).sort(), ['data', 'pid', 'version']);
  const value = envelope as { version: unknown; pid: unknown; data: unknown };
  assert.equal(value.version, 1); assert.ok(Number.isSafeInteger(result.pid) && result.pid > 0);
  assert.equal(value.pid, result.pid, 'Isolated Drizzle report writer PID differs');
  assert.ok(value.data && typeof value.data === 'object' && !Array.isArray(value.data));
  assert.deepEqual(Object.keys(value.data).sort(), ['blockedIpcAttempts', 'blockedSockets', 'esbuild', 'loaded', 'networkAttempts']);
  const data = value.data as AuditReport;
  assert.ok(Array.isArray(data.loaded) && data.loaded.every(path => typeof path === 'string' && path.length > 0));
  assert.equal(new Set(data.loaded).size, data.loaded.length);
  assert.ok(Array.isArray(data.esbuild) && data.esbuild.every(entry => Array.isArray(entry) && entry.length === 2
    && entry.every(part => typeof part === 'string' && part.length > 0)));
  assert.ok(Number.isSafeInteger(data.blockedIpcAttempts) && data.blockedIpcAttempts >= 0);
  assert.equal(data.networkAttempts, 0, 'Isolated Drizzle audit attempted network access');
  assert.deepEqual(data.blockedSockets, []);
  assert.ok(data.loaded.every(path => !/(?:^|\/)@esbuild-kit\/(?:core-utils|esm-loader)\//.test(path)),
    'Legacy esbuild-kit entered the isolated audit');
  return data;
}
