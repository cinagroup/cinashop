import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const exec = promisify(execFile);
it('refuses implicit, remote, wrong-identity and argument targets before TCP, without printing credentials', async () => {
  let connections = 0;
  const server = createServer(socket => { connections++; socket.destroy(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing sentinel port');
  const url = `postgresql://finance_test:synthetic-capacity-secret@127.0.0.1:${address.port}/cinashop_finance_test`;
  try {
    for (const [target, args] of [
      ['', []],
      [url.replace('127.0.0.1', 'unauthorized.invalid'), []],
      [url.replace('/cinashop_finance_test', '/existing_database'), []],
      [url, ['--apply']],
    ] as Array<[string, string[]]>) {
      const env = { ...process.env }, allow = new Set(['PATH','Path','SystemRoot','WINDIR','COMSPEC','PATHEXT','TEMP','TMP','LOCALAPPDATA']);
      for (const key of Object.keys(env)) if (!allow.has(key)) delete env[key];
      Object.assign(env, { TEST_FINANCE_POSTGRES_URL: target, DATABASE_URL: url });
      try {
        await exec(process.execPath, ['node_modules/tsx/dist/cli.mjs','scripts/audit-shipping-lifecycle-capacity.ts',...args],
          { cwd: resolve(import.meta.dirname, '..'), env, timeout: 15000, windowsHide: true });
        throw new Error('Unsafe target accepted');
      } catch (error) {
        const result = error as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
        expect(result.code).toBe(1); expect(result.killed).not.toBe(true);
        expect(result.stdout).toBe(''); expect(result.stderr).not.toContain('synthetic-capacity-secret');
        expect(result.stderr).toMatch(/No arguments accepted|test URL|dedicated loopback/);
      }
    }
    expect(connections).toBe(0);
  } finally {
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  }
}, 30000);
