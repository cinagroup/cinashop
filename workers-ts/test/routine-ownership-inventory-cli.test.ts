import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const key = Buffer.alloc(32, 1).toString('hex');
const marker = 'synthetic-inventory-private-value';
function invoke(args: string[], url?: string, fingerprintKey: string | undefined = key) {
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: `postgres://fallback:${marker}@invalid.example/other`, APP_KEY: marker };
  delete env.ROUTINE_OWNERSHIP_INVENTORY_DATABASE_URL;
  delete env.ROUTINE_OWNERSHIP_INVENTORY_FINGERPRINT_KEY;
  if (url !== undefined) env.ROUTINE_OWNERSHIP_INVENTORY_DATABASE_URL = url;
  if (fingerprintKey !== undefined) env.ROUTINE_OWNERSHIP_INVENTORY_FINGERPRINT_KEY = fingerprintKey;
  const result = spawnSync(process.execPath, ['--import','tsx','scripts/inspect-routine-ownership.ts',...args],
    { cwd: root, env, encoding: 'utf8', timeout: 10000 });
  expect(result.error).toBeUndefined(); expect(result.status).toBe(1); expect(result.stdout).toBe('');
  expect(result.stderr).toBe('Routine ownership database inventory incomplete; no ownership or switch authorization issued.\n');
  expect(result.stderr).not.toContain(marker);
}

describe('Routine ownership inventory explicit CLI target', () => {
  it('requires its own URL and fingerprint key despite runtime fallback variables', () => {
    invoke(['inventory_db','maintenance']);
    invoke(['inventory_db','maintenance'], `postgres://maintenance:${marker}@invalid.example/inventory_db`, '');
  });
  it.each([
    [], ['inventory_db'], ['inventory_db','maintenance','--install'], ['inventory_db','bad role'],
  ].map(args => ({ args })))('rejects invalid arguments $args without returning a partial report', ({ args }) => invoke(args));
  it.each([
    `https://maintenance:${marker}@invalid.example/inventory_db`,
    `postgres://other:${marker}@invalid.example/inventory_db`,
    `postgres://maintenance:${marker}@invalid.example/other`,
    `postgres://maintenance:${marker}@invalid.example/inventory_db?options=anything`,
    `postgres://maintenance:${marker}@invalid.example/inventory_db#anything`,
  ])('rejects mismatched or decorated explicit URLs without exposing credentials', url =>
    invoke(['inventory_db','maintenance'], url));
});
