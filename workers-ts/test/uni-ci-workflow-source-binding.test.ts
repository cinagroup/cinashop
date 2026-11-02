import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { projectMigrationMergeSource } from './helpers/migrationMergeSourceBinding';
import { UNI_CI_WORKFLOW_FILE, UNI_CI_WORKFLOW_PROOF_FILE, UNI_CI_WORKFLOW_PROOF_SHA,
  projectUniCiWorkflowSource, readUniCiHistoricalWorkflow, uniCiWorkflowSourceBinding as proof } from './helpers/uniCiWorkflowSourceBinding';

const root = resolve(import.meta.dirname, '../..');
const workflow = resolve(root, UNI_CI_WORKFLOW_FILE);
const actual = readFileSync(workflow, 'utf8');
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const clone = () => structuredClone(proof);

describe('exact two-layer Uni CI historical workflow readport', () => {
  it('pins the real candidate separately from both complete Git predecessor images', () => {
    expect(sha(readFileSync(resolve(root, UNI_CI_WORKFLOW_PROOF_FILE)))).toBe(UNI_CI_WORKFLOW_PROOF_SHA);
    expect(actual).toBe(proof.images.candidate.raw_utf8);
    expect(sha(actual)).toBe('30c49172a5fa6fa01a18131f344f614cf9e640b50fd59daa39209e54631aecce');
    expect(actual).toContain('needs: [uni-core, uni-authors]');
    expect(proof.images.parent.origins).toEqual(['20f180ae24a88f40fe6d0a35c26d2cae0204ca01', 'b874c56accd2bfc12c13c3c2cd2652736df07d5e']);
    expect(proof.images.merge.origins).toEqual(['42756fe6946115fefdab1fe65fc36a30f210aba9', '3d4780a6a5816934f7b82b31132c0111a5f5065d']);
    for (const image of Object.values(proof.images)) {
      expect(Buffer.byteLength(image.raw_utf8)).toBe(image.bytes);
      expect(sha(image.raw_utf8)).toBe(image.sha256);
    }
    expect(projectUniCiWorkflowSource(UNI_CI_WORKFLOW_FILE, actual, 'parent')).toBe(proof.images.parent.raw_utf8);
    expect(projectUniCiWorkflowSource(UNI_CI_WORKFLOW_FILE, actual)).toBe(proof.images.merge.raw_utf8);
  });

  it('retains the complete b874 additions while explicitly reversing them for the older merge proof', () => {
    const parent = projectUniCiWorkflowSource(UNI_CI_WORKFLOW_FILE, actual, 'parent');
    const merged = projectUniCiWorkflowSource(UNI_CI_WORKFLOW_FILE, actual);
    expect(sha(parent)).toBe('fae6a6cf86ec9c020280565341781fa59b8a65796b6a6c8400585bf6e79f69f1');
    expect(sha(merged)).toBe('95be73a9c5199114841ff8266304bcc6bdf7c8355fb0bece2e249b43cfb69dbd');
    for (const added of ['      - ".gitleaksignore"', '      - "docs/security/gitleaks-reviewed-findings-20261030.md"',
      'Set up Node.js for isolated scanner canaries', 'Verify exact historical ignores retain new-secret detection']) {
      expect(actual).toContain(added); expect(parent).toContain(added); expect(merged).not.toContain(added);
    }
    const runtime = (text: string) => text.slice(text.indexOf('\n  runtime:\n'), text.indexOf('\n  frontends:\n'));
    expect(runtime(parent)).toContain('image: postgres:16.14-alpine');
    expect(runtime(merged)).not.toContain('image: postgres:16.14-alpine');
    expect(proof.inverse_layers.map(layer => layer.edits.length)).toEqual([3, 5]);
  });

  it('maps only the historical workflow reader and preserves UTF8, Buffer and file-URL forms', () => {
    expect(readUniCiHistoricalWorkflow(workflow, 'utf8')).toBe(proof.images.merge.raw_utf8);
    expect(readUniCiHistoricalWorkflow(workflow)).toEqual(Buffer.from(proof.images.merge.raw_utf8));
    expect(readUniCiHistoricalWorkflow(pathToFileURL(workflow), 'utf8')).toBe(proof.images.merge.raw_utf8);
    expect(readUniCiHistoricalWorkflow(Buffer.from(workflow), 'utf8')).toBe(proof.images.merge.raw_utf8);
    const unrelated = resolve(root, 'view/uniapp-ts/package.json');
    expect(readUniCiHistoricalWorkflow(unrelated)).toEqual(readFileSync(unrelated));
    expect(projectUniCiWorkflowSource('unrelated.yml', actual + '\nunknown')).toBe(actual + '\nunknown');
    // Current CI capacity assertions always observe the actual new job graph.
    expect(readFileSync(workflow, 'utf8')).toBe(actual);
  });

  it.each(['main', 'checkpoint'] as const)('feeds the unchanged %s merge inverse its exact former input', parent => {
    const binding = JSON.parse(readFileSync(resolve(root, proof.legacy_fixture.file), 'utf8'));
    const before = readUniCiHistoricalWorkflow(workflow, 'utf8');
    expect(sha(before)).toBe(binding.parents[parent].sources[UNI_CI_WORKFLOW_FILE].current_sha256);
    expect(sha(projectMigrationMergeSource(UNI_CI_WORKFLOW_FILE, before, parent)))
      .toBe(binding.parents[parent].sources[UNI_CI_WORKFLOW_FILE].parent_sha256);
    expect(() => projectMigrationMergeSource(UNI_CI_WORKFLOW_FILE, before + '\n', parent)).toThrow('source differs');
  });

  it('keeps the old proof, PIN and both old assertion bodies byte-for-byte through import-only wiring', () => {
    const legacy = readFileSync(resolve(root, proof.legacy_fixture.file));
    expect(legacy.byteLength).toBe(proof.legacy_fixture.bytes);
    expect(sha(legacy)).toBe('11b657f6c1d223bcc730a21c604c4a89b61d379ac4145ea5b4938559db7ce4cb');
    for (const entry of proof.legacy_imports) {
      expect(sha(entry.before.raw_utf8)).toBe(entry.before.sha256);
      expect(entry.before.raw_utf8.split(entry.before_import)).toHaveLength(2);
      const expected = entry.before.raw_utf8.replace(entry.before_import, entry.after_import);
      expect(readFileSync(resolve(root, entry.file), 'utf8')).toBe(expected);
    }
    const helper = readFileSync(resolve(root, proof.legacy_imports[0]!.file), 'utf8');
    expect(helper).toContain("const PIN='11b657f6c1d223bcc730a21c604c4a89b61d379ac4145ea5b4938559db7ce4cb'");
  });

  it.each([
    ['append', actual + '\n# unreviewed\n'], ['truncate', actual.slice(1)],
    ['CRLF', actual.replace(/\n/g, '\r\n')], ['duplicate', actual + actual],
    ['changed aggregate', actual.replace('needs: [uni-core, uni-authors]', 'needs: [uni-core]')],
    ['20f180 fallback', proof.images.parent.raw_utf8], ['merge fallback', proof.images.merge.raw_utf8],
  ])('rejects unknown current-source bytes: %s', (_name, changed) => {
    expect(() => projectUniCiWorkflowSource(UNI_CI_WORKFLOW_FILE, changed)).toThrow('current workflow source differs');
  });

  for (const image of ['candidate', 'parent', 'merge'] as const) {
    it.each(['text', 'digest', 'size', 'origin'] as const)('rejects forged complete ' + image + ' image %s', kind => {
      const changed = clone(), value = changed.images[image];
      if (kind === 'text') value.raw_utf8 += '\n';
      if (kind === 'digest') value.sha256 = '0'.repeat(64);
      if (kind === 'size') value.bytes++;
      if (kind === 'origin') value.origins.push('0'.repeat(40));
      expect(() => projectUniCiWorkflowSource(UNI_CI_WORKFLOW_FILE, actual, 'merge', changed)).toThrow();
    });
  }
  for (const layer of [0, 1]) {
    it.each(['missing', 'shifted', 'changed before', 'changed after', 'duplicate', 'full-image shortcut'] as const)
    ('rejects altered exact inverse layer ' + layer + ': %s', kind => {
      const changed = clone(), target = changed.inverse_layers[layer]!;
      if (kind === 'missing') target.edits.splice(0, 1);
      if (kind === 'shifted') target.edits[0]!.start++;
      if (kind === 'changed before') target.edits[0]!.before.push('# unrelated predecessor\n');
      if (kind === 'changed after') target.edits[0]!.after.push('# unrelated current\n');
      if (kind === 'duplicate') target.edits.push(structuredClone(target.edits[0]!));
      if (kind === 'full-image shortcut') target.edits = [{ start: 0,
        after: changed.images[target.from].raw_utf8.match(/[^\n]*\n|[^\n]+$/g)!,
        before: changed.images[target.to].raw_utf8.match(/[^\n]*\n|[^\n]+$/g)! }];
      expect(() => projectUniCiWorkflowSource(UNI_CI_WORKFLOW_FILE, actual, 'merge', changed)).toThrow('exact inverse layer differs');
    });
  }
  it('rejects omitted or reversed history layers and changed scope or Git history', () => {
    for (const mutate of [
      (changed: ReturnType<typeof clone>) => { changed.inverse_layers.pop(); },
      (changed: ReturnType<typeof clone>) => { changed.inverse_layers.reverse(); },
      (changed: ReturnType<typeof clone>) => { changed.file = 'unrelated.yml'; },
      (changed: ReturnType<typeof clone>) => { changed.historical_change.commit = '0'.repeat(40); },
      (changed: ReturnType<typeof clone>) => { changed.legacy_fixture.sha256 = '0'.repeat(64); },
    ]) { const changed = clone(); mutate(changed); expect(() => projectUniCiWorkflowSource(UNI_CI_WORKFLOW_FILE, actual, 'merge', changed)).toThrow(); }
  });
});
