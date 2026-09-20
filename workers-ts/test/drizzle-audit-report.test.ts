import { describe, expect, it } from 'vitest';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { readDrizzleAuditReport } from './helpers/drizzleAuditReport';

const root = resolve(import.meta.dirname, '..');
const preload = join(root, 'test/helpers/drizzleCliAudit.cjs');
const data = { loaded: ['test/helpers/foreignKeyNameLocalAudit.cjs'], esbuild: [['node_modules/esbuild/lib/main.js', '0.28.2']],
  networkAttempts: 0, blockedIpcAttempts: 0, blockedSockets: [] };
const packet = JSON.stringify({ version: 1, pid: 1234, data });
function result(raw: string | null = packet) {
  return { pid: 1234, status: 0, signal: null, output: [null, '', '', raw] } as SpawnSyncReturns<string>;
}
function environment(extra: Record<string, string | undefined>) {
  const allowed = new Set(['PATH','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','TEMP','TMP','LOCALAPPDATA']);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (!allowed.has(key.toUpperCase())) delete env[key];
  return Object.assign(env, { CI: '1' }, extra);
}
function child(source: string, env: Record<string, string | undefined>, pipe = true) {
  return spawnSync(process.execPath, ['--require', preload, '-e', source], {
    cwd: root, env: environment(env), encoding: 'utf8', windowsHide: true, timeout: 5000,
    stdio: pipe ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
  });
}

describe('isolated Drizzle report transport', () => {
  it('accepts one complete report from the successfully terminated expected child', () => {
    expect(readDrizzleAuditReport(result())).toEqual(data);
  });
  it.each([null, '', packet.slice(0, -1), packet + packet, 'x'.repeat(1024 * 1024 + 1)])('rejects missing, truncated, duplicate or oversized output %#', raw => {
    expect(() => readDrizzleAuditReport(result(raw))).toThrow();
  });
  it.each([
    { status: 1 }, { status: null }, { signal: 'SIGTERM' as const }, { error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) },
    { pid: 9999 }, { pid: 0 },
  ])('rejects unsuccessful execution or a different process identity %#', patch => {
    expect(() => readDrizzleAuditReport({ ...result(), ...patch })).toThrow();
  });
  it.each([
    { version: 2 }, { data: { ...data, loaded: ['a', 'a'] } }, { data: { ...data, loaded: [null] } },
    { data: { ...data, networkAttempts: 1 } }, { data: { ...data, blockedSockets: ['attempt'] } },
    { data: { ...data, blockedIpcAttempts: -1 } }, { data: { ...data, esbuild: [[]] } },
    { data: { ...data, loaded: ['node_modules/@esbuild-kit/core-utils/index.js'] } },
    { data: {} }, { unreviewed: true },
  ])('rejects malformed, unsafe or unreviewed report data %#', patch => {
    expect(() => readDrizzleAuditReport(result(JSON.stringify({ version: 1, pid: 1234, data, ...patch })))).toThrow();
  });
  it.each(['file', 'pipe'])('demonstrates directory removal before exit with the actual preload (%s)', mode => {
    const directory = mkdtempSync(join(tmpdir(), 'cinashop-drizzle-report-'));
    const exact = realpathSync(directory), parent = realpathSync(tmpdir());
    expect(dirname(exact)).toBe(parent); expect(basename(exact)).toMatch(/^cinashop-drizzle-report-[A-Za-z0-9]+$/);
    try {
      const run = child(`const fs=require('node:fs'); const path=require('node:path'); const p=${JSON.stringify(exact)};
        if(path.dirname(fs.realpathSync(p))!==${JSON.stringify(parent)} || !/^cinashop-drizzle-report-[A-Za-z0-9]+$/.test(path.basename(p))) throw Error('Unsafe fixture');
        fs.rmSync(p,{recursive:true}); process.stdout.write('semantic-probe-complete');`,
      mode === 'pipe' ? { CINASHOP_DRIZZLE_AUDIT_REPORT_FD: '3' } : { CINASHOP_DRIZZLE_AUDIT_REPORT: join(exact, 'audit.json') });
      expect(run.error).toBeUndefined(); expect(run.stdout).toBe('semantic-probe-complete'); expect(existsSync(exact)).toBe(false);
      if (mode === 'file') { expect(run.status).toBe(1); expect(run.stderr).toContain('ENOENT'); }
      else { expect(run.stderr).toBe(''); expect(readDrizzleAuditReport(run).networkAttempts).toBe(0); }
    } finally { if (existsSync(exact)) rmSync(exact, { recursive: true }); }
  });
  it('keeps denied network attempts visible even when the child catches the rejection', () => {
    const run = child("try { require('node:net').connect({host:'127.0.0.1',port:9}); } catch {}", { CINASHOP_DRIZZLE_AUDIT_REPORT_FD: '3' });
    expect(run.error).toBeUndefined(); expect(run.status).toBe(0);
    expect(() => readDrizzleAuditReport(run)).toThrow('attempted network access');
  });
  it('fails when the dedicated pipe was not supplied', () => {
    const run = child('', { CINASHOP_DRIZZLE_AUDIT_REPORT_FD: '3' }, false);
    expect(run.error).toBeUndefined(); expect(run.status).not.toBe(0);
    expect(() => readDrizzleAuditReport(run)).toThrow();
  });
  it('preserves the original file-report contract for existing generator suites', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cinashop-drizzle-report-'));
    const exact = realpathSync(directory);
    expect(dirname(exact)).toBe(realpathSync(tmpdir())); expect(basename(exact)).toMatch(/^cinashop-drizzle-report-[A-Za-z0-9]+$/);
    try {
      const report = join(exact, 'audit.json'); const run = child('', { CINASHOP_DRIZZLE_AUDIT_REPORT: report });
      expect(run.error).toBeUndefined(); expect(run.status).toBe(0);
      expect(JSON.parse(readFileSync(report, 'utf8'))).toMatchObject({ networkAttempts: 0, blockedSockets: [], loaded: [] });
    } finally { rmSync(exact, { recursive: true }); }
  });
  it.each([{}, { CINASHOP_DRIZZLE_AUDIT_REPORT_FD: '4' },
    { CINASHOP_DRIZZLE_AUDIT_REPORT_FD: '3', CINASHOP_DRIZZLE_AUDIT_REPORT: 'ambiguous.json' }])('requires exactly one explicit report channel %#', env => {
    const run = child('', env);
    expect(run.error).toBeUndefined(); expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('Exactly one isolated Drizzle audit report channel');
  });
});
