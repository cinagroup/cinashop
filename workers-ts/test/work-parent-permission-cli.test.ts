import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';

const exec = promisify(execFile);
async function cli(values: Record<string, string> = {}, args: string[] = []) {
  const environment = { ...process.env };
  const allow = new Set(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'LOCALAPPDATA']);
  for (const key of Object.keys(environment)) if (!allow.has(key)) delete environment[key];
  Object.assign(environment, values);
  try {
    const result = await exec(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/audit-work-parent-permissions.ts', ...args], {
      cwd: resolve(import.meta.dirname, '..'), env: environment, timeout: 15000, windowsHide: true,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
    if (typeof failed.code !== 'number' || failed.killed) throw error;
    return { code: failed.code, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
  }
}

it('refuses invalid inputs and implicit fallback before any connection to a listening local sentinel', async () => {
  let connections = 0;
  const server = createServer(socket => { connections++; socket.destroy(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected local TCP sentinel');
  const url = `postgresql://sentinel:synthetic-secret@127.0.0.1:${address.port}/fixture`;
  try {
    const attempts: Array<[Record<string, string>, string[]]> = [
      [{ DATABASE_URL: url, TEST_FINANCE_POSTGRES_URL: url }, []],
      [{ WORK_PARENT_AUDIT_DATABASE_URL: url }, ['--apply']],
      [{ WORK_PARENT_AUDIT_DATABASE_URL: url + '?options=-c%20default_transaction_read_only%3Doff' }, []],
      [{ WORK_PARENT_AUDIT_DATABASE_URL: url + '#fragment' }, []],
      [{ WORK_PARENT_AUDIT_DATABASE_URL: url.replace('postgresql:', 'https:') }, []],
      [{ WORK_PARENT_AUDIT_DATABASE_URL: 'postgresql://runtime:synthetic-secret@not-authorized.invalid/fixture' }, []],
    ];
    for (const [values, args] of attempts) {
      const result = await cli(values, args);
      expect(result).toMatchObject({ code: 2, stdout: '', stderr: expect.stringContaining('No database was contacted') });
      expect(result.stderr).not.toContain('synthetic-secret');
    }
    expect(connections).toBe(0);
  } finally { await new Promise<void>(resolveClose => server.close(() => resolveClose())); }
}, 15000);

it('pins the packaged command and forbids weakening connection defaults', () => {
  const root = resolve(import.meta.dirname, '..');
  expect(JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).scripts['audit:work-parent-permissions'])
    .toBe('tsx scripts/audit-work-parent-permissions.ts');
  const source = readFileSync(resolve(root, 'scripts/audit-work-parent-permissions.ts'), 'utf8');
  expect(source).toContain('ssl: remote ? { rejectUnauthorized: true } : false');
  expect(source).toContain('default_transaction_read_only=on');
  expect(source).not.toContain('process.env.DATABASE_URL');
});

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('actual PG16 CLI identity and exit contract', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  beforeAll(async () => {
    f = await sequenceRunnerDatabase();
    const api = await import('drizzle-kit/api'), models = await import('../src/models/schema');
    await f.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(models))).join('\n'));
    await f.exec(`INSERT INTO work_client_current(corp_id,external_userid) VALUES('cli-fixture','synthetic');
      INSERT INTO work_callback_event(event_key,payload_hash,subject_key_hash,corp_id,payload)
      VALUES(repeat('a',64),repeat('b',64),repeat('c',64),'cli-fixture','{}')`);
  }, 120000);
  afterAll(async () => { await f?.close(); }, 45000);
  const snapshot = () => f.query(`SELECT jsonb_build_object(
    'clients',(SELECT jsonb_agg(to_jsonb(c)) FROM work_client_current c),
    'events',(SELECT jsonb_agg(to_jsonb(e)) FROM work_callback_event e),
    'acl',(SELECT jsonb_agg(jsonb_build_object('oid',oid,'acl',relacl) ORDER BY oid) FROM pg_class
      WHERE oid IN ('work_client_current'::regclass,'work_callback_event'::regclass))) AS state`);

  it('returns zero for the parent envelope, one for unsafe grants and two for an operational failure without leaking credentials', async () => {
    await f.withRuntimeRole!(async runtime => {
      await f.exec(`GRANT SELECT ON work_client_current,work_callback_event TO "${runtime.role}"`);
      const before = await snapshot();
      const input = { WORK_PARENT_AUDIT_DATABASE_URL: runtime.connectionString };
      const safe = await cli(input);
      expect(safe.code).toBe(0); expect(safe.stderr).toBe('');
      expect(JSON.parse(safe.stdout)).toMatchObject({ scope: 'work-parent-identity-only', ready: true, failures: [] });
      expect(await snapshot()).toEqual(before);
      await f.exec(`GRANT DELETE ON work_client_current TO "${runtime.role}"`);
      const elevatedBefore = await snapshot();
      const elevated = await cli(input);
      expect(elevated.code).toBe(1); expect(elevated.stderr).toBe('');
      expect(JSON.parse(elevated.stdout).failures).toContain('noParentRemovalOrTriggerCreation');
      expect(await snapshot()).toEqual(elevatedBefore);
      const bad = new URL(runtime.connectionString); bad.password = 'synthetic-incorrect-password';
      const failed = await cli({ WORK_PARENT_AUDIT_DATABASE_URL: bad.href });
      expect(failed).toMatchObject({ code: 2, stdout: '', stderr: expect.stringContaining('could not complete') });
      const passwordless = new URL(runtime.connectionString); passwordless.password = '';
      const inherited = await cli({ WORK_PARENT_AUDIT_DATABASE_URL: passwordless.href,
        PGPASSWORD: decodeURIComponent(new URL(runtime.connectionString).password) });
      expect(inherited).toMatchObject({ code: 2, stdout: '', stderr: expect.stringContaining('could not complete') });
      for (const result of [safe, elevated, failed, inherited]) {
        expect(result.stdout + result.stderr).not.toContain(runtime.role);
        expect(result.stdout + result.stderr).not.toContain(new URL(runtime.connectionString).password);
        expect(result.stdout + result.stderr).not.toContain('synthetic-incorrect-password');
      }
      expect(await snapshot()).toEqual(elevatedBefore);
    });
  }, 30000);
});
