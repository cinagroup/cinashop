import { createHash } from 'node:crypto';
import { readRechargeRefundPredecessorFile as readFileSync } from './helpers/rechargeRefundSourceContinuity';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LEGACY_PHP_WORKFLOW_FILE, LEGACY_PHP_WORKFLOW_PROOF_FILE, LEGACY_PHP_WORKFLOW_PROOF_SHA,
  legacyPhpWorkflowSourceBinding as proof, projectLegacyPhpWorkflowPredecessor, readLegacyPhpWorkflowPredecessor } from './helpers/legacyPhpInputSourceBinding';
import { projectUniCiWorkflowSource, uniCiWorkflowSourceBinding } from './helpers/uniCiWorkflowSourceBinding';

const root = resolve(import.meta.dirname, '../..');
const workflow = resolve(root, LEGACY_PHP_WORKFLOW_FILE), current = readFileSync(workflow, 'utf8');
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const clone = () => structuredClone(proof);

describe('fixed PHP input workflow and exact historical predecessor', () => {
  it('binds the actual workflow and provisions the same full fixed input on both Worker shards', () => {
    expect(sha(readFileSync(resolve(root, LEGACY_PHP_WORKFLOW_PROOF_FILE)))).toBe(LEGACY_PHP_WORKFLOW_PROOF_SHA);
    expect(current).toBe(proof.images.candidate.raw_utf8);
    const unit = current.slice(current.indexOf('\n  worker-unit:\n'), current.indexOf('\n  worker-catalog:\n'));
    const checkout = unit.slice(unit.indexOf('      - name: Check out fixed legacy PHP input'), unit.indexOf('      - name: Install locked dependencies\n'));
    expect(checkout).toContain('repository: cinagroup/cinashop-php');
    expect(checkout).toContain('ref: 8ed2a5b139f9170dd11b0dff91803f2fd59e40a5');
    expect(checkout).toContain('path: .cache/legacy-php-input');
    expect(checkout).toContain('persist-credentials: false');
    expect(checkout).toContain('ssh-key: ${{ secrets.LEGACY_PHP_READONLY_SSH_KEY }}');
    expect(checkout).toContain('ssh-strict: true');
    expect(unit).toContain('environment: legacy-php-readonly');
    expect(checkout).toContain('node --experimental-strip-types scripts/verify-legacy-php-input.ts --input ../.cache/legacy-php-input --link-sibling');
    expect(checkout).not.toContain('if:');
    expect(unit.indexOf(checkout)).toBeLessThan(unit.indexOf('      - name: Run Worker unit tests'));
    expect(unit).toContain('workers-ts/legacy-php-input-receipt.json');
    expect(unit).toContain('shard: [1, 2]');
    expect(unit).toContain('scripts/audit-unit-shards.mjs');
    for (const name of ['Audit legacy-to-PostgreSQL schema drift', 'Audit legacy-to-Worker route parity'])
      expect(unit).toContain(`- name: ${name}\n        if: matrix.shard == 1\n        run: |\n          set -euo pipefail\n`);
  });
  it('retains the frozen previous proof and both old assertion bodies through import-only wiring', () => {
    expect(sha(readFileSync(resolve(root, proof.unchanged_proof.file)))).toBe(proof.unchanged_proof.sha256);
    for (const row of proof.legacy_imports) {
      expect(sha(row.before.raw_utf8)).toBe(row.before.sha256);
      expect(row.before.origins).toEqual(['f2a848eb6b8375b292de33df2937e9c091673662']);
      expect(readFileSync(resolve(root, row.file), 'utf8')).toBe(row.before.raw_utf8.replace(row.before_import, row.after_import));
    }
    const previous = projectLegacyPhpWorkflowPredecessor(LEGACY_PHP_WORKFLOW_FILE, current);
    expect(previous).toBe(uniCiWorkflowSourceBinding.images.candidate.raw_utf8);
    expect(projectUniCiWorkflowSource(LEGACY_PHP_WORKFLOW_FILE, previous)).toBe(uniCiWorkflowSourceBinding.images.merge.raw_utf8);
  });
  it('projects only historical workflow reads and preserves real filesystem forms', () => {
    const previous = proof.images.predecessor.raw_utf8;
    expect(readLegacyPhpWorkflowPredecessor(workflow, 'utf8')).toBe(previous);
    expect(readLegacyPhpWorkflowPredecessor(workflow)).toEqual(Buffer.from(previous));
    expect(readLegacyPhpWorkflowPredecessor(pathToFileURL(workflow), 'utf8')).toBe(previous);
    expect(readLegacyPhpWorkflowPredecessor(Buffer.from(workflow), 'utf8')).toBe(previous);
    const unrelated = resolve(root, 'workers-ts/scripts/verify-legacy-php-input.ts');
    expect(readLegacyPhpWorkflowPredecessor(unrelated)).toEqual(readFileSync(unrelated));
    expect(projectLegacyPhpWorkflowPredecessor('other.yml', 'unreviewed')).toBe('unreviewed');
    expect(readFileSync(workflow, 'utf8')).toBe(current);
  });
  it.each([
    ['append', current + '\n# drift\n'], ['truncate', current.slice(1)],
    ['CRLF', current.replaceAll('\n', '\r\n')], ['duplicate', current + current],
    ['moving ref', current.replace('ref: 8ed2a5b139f9170dd11b0dff91803f2fd59e40a5', 'ref: main')],
    ['previous fallback', proof.images.predecessor.raw_utf8],
  ])('rejects unreviewed real workflow bytes: %s', (_kind, text) => {
    expect(() => projectLegacyPhpWorkflowPredecessor(LEGACY_PHP_WORKFLOW_FILE, text)).toThrow('current workflow source differs');
  });
  for (const name of ['candidate', 'predecessor'] as const) {
    it.each(['text', 'digest', 'bytes', 'origin'] as const)(`rejects a forged complete ${name} image: %s`, kind => {
      const changed = clone(), image = changed.images[name];
      if (kind === 'text') image.raw_utf8 += '\n';
      if (kind === 'digest') image.sha256 = '0'.repeat(64);
      if (kind === 'bytes') image.bytes++;
      if (kind === 'origin') image.origins.push('0'.repeat(40));
      expect(() => projectLegacyPhpWorkflowPredecessor(LEGACY_PHP_WORKFLOW_FILE, current, changed)).toThrow();
    });
  }
  it.each(['missing edit', 'shifted', 'before', 'after', 'full image', 'scope', 'ref', 'old proof', 'old import'] as const)
  ('rejects changed inverse proof: %s', kind => {
    const changed = clone();
    if (kind === 'missing edit') changed.inverse_edits.pop();
    if (kind === 'shifted') changed.inverse_edits[0]!.start++;
    if (kind === 'before') changed.inverse_edits[0]!.before.push('# drift\n');
    if (kind === 'after') changed.inverse_edits[0]!.after.push('# drift\n');
    if (kind === 'full image') changed.inverse_edits = [{ start: 0, after: current.match(/[^\n]*\n|[^\n]+$/g)!, before: proof.images.predecessor.raw_utf8.match(/[^\n]*\n|[^\n]+$/g)! }];
    if (kind === 'scope') changed.file = 'other.yml';
    if (kind === 'ref') changed.predecessor_commit = '0'.repeat(40);
    if (kind === 'old proof') changed.unchanged_proof.sha256 = '0'.repeat(64);
    if (kind === 'old import') changed.legacy_imports[0]!.after_import += '\n';
    expect(() => projectLegacyPhpWorkflowPredecessor(LEGACY_PHP_WORKFLOW_FILE, current, changed)).toThrow();
  });
});
