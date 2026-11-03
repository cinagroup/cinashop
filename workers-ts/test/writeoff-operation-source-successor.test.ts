import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCreateTables } from '../scripts/data-migration/schema-audit';
import { historicalWriteoffOperationSource, WRITEOFF_SOURCE_SUCCESSOR as proof } from './helpers/writeoffOperationSourceSuccessor';

const root = resolve(import.meta.dirname, '..');
const current = readFileSync(resolve(root, proof.file), 'utf8');
const sha = (source: string) => createHash('sha256').update(source).digest('hex');

describe('reviewed writeoff constraint-name source successor', () => {
  it('retains the old full-source pin and derives its complete Git parent from the actual current source', () => {
    expect(sha(current)).toBe(proof.currentSha256);
    const historical = historicalWriteoffOperationSource(current);
    expect(sha(historical)).toBe('044d8aa876e686e3e8b238b8cb4233240082f293060fc426ef00b7c5b1d952f0');
    expect(current).toBe(historical.replace(proof.before, proof.after));
    expect(current.split(proof.after)).toHaveLength(2);
    expect(historical.split(proof.before)).toHaveLength(2);
    expect(readFileSync(resolve(root, proof.file), 'utf8')).toBe(current);
  });

  it('retains every table, ordered column and primary-key column while the physical name stays current', () => {
    const historical = parseCreateTables(historicalWriteoffOperationSource(current), 'postgres');
    const actual = parseCreateTables(current, 'postgres');
    expect([...actual.keys()]).toEqual(['customer_writeoff_operation_request']);
    expect([...historical.keys()]).toEqual([...actual.keys()]);
    const table = actual.get('customer_writeoff_operation_request')!;
    expect([...table.columns]).toEqual([...historical.get(table.name)!.columns]);
    expect(table.primaryKey).toEqual(['actor_uid', 'request_key']);
    expect(table.primaryKey).toEqual(historical.get(table.name)!.primaryKey);
    expect(current).toContain(proof.after);
    expect(current).not.toContain(proof.before);
  });

  it.each([
    ['old-image fallback', () => historicalWriteoffOperationSource(current)],
    ['prefix drift', () => '// unreviewed\n' + current],
    ['suffix drift', () => current + '\n// unreviewed\n'],
    ['different constraint name', () => current.replace(proof.after, proof.after.replace('_pkey', '_other'))],
    ['changed primary-key columns', () => current.replace(proof.after, proof.after.replace('actor_uid,request_key', 'request_key,actor_uid'))],
    ['duplicate constraint line', () => current + proof.after],
    ['unrelated body drift', () => current.replace('731675', '731676')],
  ] as const)('refuses %s instead of refreshing the historical pin', (_name, source) => {
    expect(() => historicalWriteoffOperationSource(source())).toThrow('Current complete writeoff source differs');
  });
});
