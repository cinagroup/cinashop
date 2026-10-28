import { peelReviewedAdminHistoricalSourceIfPresent } from './helpers/reviewedAdminSourceTailBinding';
import { reverseMembershipRightsReport } from './helpers/membershipRightsSourceBinding';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { buildAdminFrontendApiAuditReport } from '../scripts/admin-frontend-api-audit';
import { applyEditorialAuthorReport } from './helpers/diyEditorialAuthorSourceBinding';
import { applyCommerceAuthorReport } from './helpers/diyCommerceAuthorSourceBinding';
import { applyCommunityAuthorReport } from './helpers/diyCommunityAuthorSourceBinding';
import { applyAdminUserFilterReport, adminUserFilterSourceBinding as original } from './helpers/adminUserFilterSourceBinding';
import { applyMigrationAuditReport, reverseMigrationAuditReport } from './helpers/migrationAuditFollowupSourceBinding';
import { adminLevelDefinitionSourceBinding as proof, applyAdminLevelDefinitionReport, reverseAdminLevelDefinitionReport,
  peelAdminLevelDefinitionReport, reverseAdminLevelDefinitionSource, reverseAdminLevelDefinitionHarnessSource } from './helpers/adminLevelDefinitionSourceBinding';

const root = resolve(import.meta.dirname, '../..');
const readHistorical = (file: string) => peelReviewedAdminHistoricalSourceIfPresent(file,readFileSync(resolve(root, file), 'utf8'));
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const pretty = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const blob = (value: string) => createHash('sha1').update(`blob ${Buffer.byteLength(value)}\0`).update(value).digest('hex');
let report: ReturnType<typeof buildAdminFrontendApiAuditReport> | undefined;
const historicalLevelReport = () => structuredClone(report ??= reverseMembershipRightsReport(buildAdminFrontendApiAuditReport()));
const previousFilter = () => applyAdminUserFilterReport(applyCommunityAuthorReport(applyCommerceAuthorReport(applyEditorialAuthorReport(JSON.parse(readHistorical(original.api_report.base_file))))));
const historical = () => applyMigrationAuditReport(previousFilter()) as ReturnType<typeof buildAdminFrontendApiAuditReport>;
const sourceFiles = ['view/admin-ts/src/api/level.ts', 'workers-ts/src/controllers/api/v1/AdminCrudController.ts'];
const harnessFiles = ['workers-ts/test/helpers/migrationAuditFollowupSourceBinding.ts', 'workers-ts/test/migration-audit-followup-source-binding.test.ts', 'workers-ts/test/admin-user-filter-source-binding.test.ts'];

function apiCalls(source: string) {
  const tree = ts.createSourceFile('level.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const calls: Array<{ method: string; path: string; line: number; argumentCount: number }> = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(tree) === 'request') {
      const first = node.arguments[0];
      calls.push({ method: node.expression.name.text, path: first && ts.isStringLiteral(first) ? first.text : first?.getText(tree) ?? '',
        line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1, argumentCount: node.arguments.length });
    }
    ts.forEachChild(node, visit);
  }
  visit(tree); return calls;
}

describe('exact ordinary-level authoring source and complete Admin API report increment', () => {
  it('pins the independently captured parent, real Git patch, whole sources and immutable predecessor fixtures', () => {
    expect(sha(readHistorical('workers-ts/test/fixtures/admin-level-definition-source-binding-20261026.json'))).toBe('745e8dcb2a924a02d825bf0cc67e2db517a0ec181d343a3f6828c50c6869c431');
    expect(proof.base_ref).toBe('1846f34db81e90a661a41f53d56095509d5eeb92');
    expect(proof.level_ref).toBe('9969402715601d596dc4a310167b86d98655acc2');
    expect(proof.current_ref).toBe('677b60d86e11a78e57dcf3688ca476f3427f9579');
    expect(proof.php_ref).toBe('8ed2a5b139f9170dd11b0dff91803f2fd59e40a5');
    expect(proof.sources.map(row => row.file)).toEqual(sourceFiles); expect(proof.sources.map(row => row.edits.length)).toEqual([1, 2]);
    expect(proof.sources.map(row => [row.before_sha256, row.after_sha256, row.before_bytes, row.after_bytes])).toEqual([
      ['553b40a64d6fcfbc6e13fa5d0825911c2e9192c9f55d6ed739a8e57ef890cadf', 'e3482d01cb90e3c59e0a5f80b7602f3be71c0953f85368376cfc63757b6b20c6', 845, 7726],
      ['15a46c5ed194debb5dd24b814aa9cd2dcf805d6434caad64f0a0f8456421011d', '8f8aafa4a5c5c14cc288a040d66705d7e6dee9ff35b816624e174325b4435482', 112713, 111149],
    ]);
    for (const entry of proof.sources) {
      const actual = readHistorical(entry.file), before = reverseAdminLevelDefinitionSource(entry.file, actual);
      expect(sha(actual)).toBe(entry.after_sha256); expect(Buffer.byteLength(actual)).toBe(entry.after_bytes); expect(blob(actual)).toBe(entry.after_git_blob_sha1);
      expect(sha(before)).toBe(entry.before_sha256); expect(Buffer.byteLength(before)).toBe(entry.before_bytes); expect(blob(before)).toBe(entry.before_git_blob_sha1);
      let reconstructed = before; for (const edit of entry.edits) reconstructed = reconstructed.replace(edit.before_source, edit.after_source);
      expect(reconstructed).toBe(actual);
    }
    const patch = proof.production_patch;
    expect(patch.before_ref).toBe(proof.base_ref); expect(patch.after_ref).toBe(proof.level_ref);
    expect(patch.sha256).toBe('963e15a586f37ca8be05c4d7a553e47f88703e3e07739fc54e98c32e3600f233'); expect(patch.bytes).toBe(13792);
    expect(sha(patch.unified_diff)).toBe(patch.sha256); expect(Buffer.byteLength(patch.unified_diff)).toBe(patch.bytes);
    expect(patch.unified_diff.match(/^diff --git /gm)).toHaveLength(2);
    for (const entry of proof.sources) expect(patch.unified_diff).toContain(`index ${entry.before_git_blob_sha1.slice(0, 8)}..${entry.after_git_blob_sha1.slice(0, 8)} 100644`);
    expect(proof.preserved_files).toHaveLength(11);
    for (const entry of proof.preserved_files) { expect(sha(readHistorical(entry.file)), entry.file).toBe(entry.sha256); expect(Buffer.byteLength(readHistorical(entry.file)), entry.file).toBe(entry.bytes); }
    const oldController = original.new_consumer_sources.find(row => row.file === sourceFiles[1])!;
    expect(proof.sources[1]!.before_sha256).toBe(oldController.sha256); expect(proof.sources[1]!.before_bytes).toBe(oldController.bytes);
  });

  it('limits historical test adapters to three exact reversible whole-file changes', () => {
    expect(proof.harness_sources.map(row => row.file)).toEqual(harnessFiles); expect(proof.harness_sources.map(row => row.edits.length)).toEqual([2, 2, 2]);
    for (const entry of proof.harness_sources) {
      const actual = readHistorical(entry.file), before = reverseAdminLevelDefinitionHarnessSource(entry.file, actual);
      expect(sha(actual)).toBe(entry.after_sha256); expect(Buffer.byteLength(actual)).toBe(entry.after_bytes); expect(blob(actual)).toBe(entry.after_git_blob_sha1);
      expect(sha(before)).toBe(entry.before_sha256); expect(Buffer.byteLength(before)).toBe(entry.before_bytes); expect(blob(before)).toBe(entry.before_git_blob_sha1);
      let reconstructed = before; for (const edit of entry.edits) reconstructed = reconstructed.replace(edit.before_source, edit.after_source); expect(reconstructed).toBe(actual);
    }
    expect(reverseAdminLevelDefinitionSource('unrelated.ts', '// unchanged\n')).toBe('// unchanged\n');
    expect(reverseAdminLevelDefinitionHarnessSource('unrelated.ts', '// unchanged\n')).toBe('// unchanged\n');
  });

  it('independently parses the real four requests and retains the existing three bare route/handler contracts', () => {
    const actual = readHistorical(sourceFiles[0]!);
    expect(apiCalls(actual)).toEqual([
      { method: 'get', path: '/level/list', line: 79, argumentCount: 1 },
      { method: 'get', path: '/level/list', line: 82, argumentCount: 2 },
      { method: 'post', path: '/level/save', line: 85, argumentCount: 3 },
      { method: 'delete', path: '`/level/del/${id}`', line: 87, argumentCount: 2 },
    ]);
    expect(apiCalls(reverseAdminLevelDefinitionSource(sourceFiles[0]!, actual)).map(row => [row.method, row.path, row.line])).toEqual([
      ['get', '/level/list', 21], ['post', '/level/save', 26], ['delete', '`/level/del/${id}`', 31],
    ]);
    for (const changed of [actual.replace("request.get('/level/list',", "request.post('/level/list',"), actual.replace('paged: 1', 'paged: 0'), actual.replace("'/level/save'", "'/level/unreviewed'")]) {
      expect(changed).not.toBe(actual); expect(() => reverseAdminLevelDefinitionSource(sourceFiles[0]!, changed)).toThrow();
    }
  });

  it('reconstructs the entire dated level report through six reviewed operations before the original migration layer', () => {
    const before = historical(), actual = historicalLevelReport(), p = proof.api_report;
    expect(sha(pretty(before))).toBe('0d9bc7d912efd02d8ff5efdafc8bb4b7d7a79962905684d861724d7273d6ea7f'); expect(Buffer.byteLength(pretty(before))).toBe(644215);
    expect(sha(pretty(actual))).toBe('022080855cf8133954840763e47742110b84ef1800c0db64d5b59151a61fdab7'); expect(Buffer.byteLength(pretty(actual))).toBe(644498);
    expect(p.operations.map(row => [row.kind, row.path])).toEqual([
      ['replace', ['frontendSources', 43, 'sha256']], ['replace', ['counts', 'callSites']], ['replace', ['counts', 'pathVariants']],
      ['replace', ['counts', 'registered']], ['replace', ['counts', 'executable']], ['splice', ['calls']],
    ]);
    expect(p.operations[5]).toMatchObject({ index: 295, before: before.calls.slice(295, 298), after: actual.calls.slice(295, 299) });
    expect(applyAdminLevelDefinitionReport(before)).toEqual(actual); expect(reverseAdminLevelDefinitionReport(actual)).toEqual(before);
    expect(reverseAdminLevelDefinitionReport(applyAdminLevelDefinitionReport(before))).toEqual(before);
    expect(applyAdminLevelDefinitionReport(reverseAdminLevelDefinitionReport(actual))).toEqual(actual);
    expect(actual.counts).toEqual({ callSites: 707, pathVariants: 745, registered: 745, executable: 745, controlledUnavailable: 0, unregistered: 0, unresolved: 0 });
    expect(actual.backend).toEqual(before.backend); expect(actual.methodology).toEqual(before.methodology);
    expect(actual.frontendSources).toHaveLength(107); expect(actual.backend.registeredRoutes).toHaveLength(1677);
    expect(actual.calls.slice(0, 295)).toEqual(before.calls.slice(0, 295)); expect(actual.calls.slice(299)).toEqual(before.calls.slice(298));
    expect(actual.calls.slice(295, 299).map(row => [row.method, row.path, row.matchedHandler, row.availability])).toEqual([
      ['GET', '/level/list', 'AdminCrud.adminLevelList', 'executable'], ['GET', '/level/list', 'AdminCrud.adminLevelList', 'executable'],
      ['POST', '/level/save', 'AdminCrud.adminLevelSave', 'executable'], ['DELETE', '/level/del/:param', 'AdminCrud.adminLevelDel', 'executable'],
    ]);
    expect(peelAdminLevelDefinitionReport(before)).toEqual(before); expect(peelAdminLevelDefinitionReport(actual)).toEqual(before);
    expect(reverseMigrationAuditReport(actual)).toEqual(previousFilter()); expect(reverseMigrationAuditReport(before)).toEqual(previousFilter());
    // The old apply operation still produces its exact old result, never the new level catalogue.
    expect(sha(pretty(applyMigrationAuditReport(previousFilter())))).toBe('0d9bc7d912efd02d8ff5efdafc8bb4b7d7a79962905684d861724d7273d6ea7f');
  });

  for (const file of [...sourceFiles, ...harnessFiles]) it.each(['extra', 'missing', 'duplicate', 'newline', 'same-length', 'old'] as const)('rejects unreviewed whole-source %s in ' + file, kind => {
    const harness = harnessFiles.includes(file), reverse = harness ? reverseAdminLevelDefinitionHarnessSource : reverseAdminLevelDefinitionSource;
    const entry = (harness ? proof.harness_sources : proof.sources).find(row => row.file === file)!, originalSource = readHistorical(file);
    let changed = originalSource;
    if (kind === 'extra') changed += '\n// unrelated\n'; if (kind === 'missing') changed = changed.replace(entry.edits[0]!.after_source, '');
    if (kind === 'duplicate') changed += entry.edits[0]!.after_source; if (kind === 'newline') changed = changed.replace('\n', '\r\n');
    if (kind === 'same-length') changed = changed.replace('a', 'z'); if (kind === 'old') changed = reverse(file, originalSource);
    expect(changed).not.toBe(originalSource); expect(() => reverse(file, changed)).toThrow();
  });

  it.each(['count', 'route', 'source', 'methodology', 'line', 'handler', 'missing-call', 'duplicate-call', 'new-call', 'extra'] as const)('rejects unrelated complete-report %s in either exact state', kind => {
    for (const direction of ['before', 'after'] as const) {
      const value = direction === 'before' ? historical() : historicalLevelReport();
      if (kind === 'count') value.counts.registered++; if (kind === 'route') value.backend.registeredRoutes[0]!.handler = 'unreviewed';
      if (kind === 'source') value.frontendSources[0]!.sha256 = '0'.repeat(64); if (kind === 'methodology') value.methodology.scope = 'unreviewed';
      if (kind === 'line') value.calls[295]!.line++; if (kind === 'handler') value.calls[295]!.matchedHandler = 'unreviewed';
      if (kind === 'missing-call') value.calls.splice(296, 1); if (kind === 'duplicate-call') value.calls.splice(296, 0, structuredClone(value.calls[295]!));
      if (kind === 'new-call') value.calls.push({ ...value.calls[0]!, path: '/unreviewed' }); if (kind === 'extra') Object.assign(value, { unreviewed: true });
      expect(() => peelAdminLevelDefinitionReport(value)).toThrow(); expect(() => reverseMigrationAuditReport(value)).toThrow();
      expect(() => direction === 'before' ? applyAdminLevelDefinitionReport(value) : reverseAdminLevelDefinitionReport(value)).toThrow();
    }
  });

  it.each(['source-order', 'source-missing', 'source-file', 'source-hash', 'source-bytes', 'source-line', 'source-literal', 'harness-hash', 'operation-order', 'operation-missing', 'operation-path', 'operation-splice', 'operation-rows', 'report-hash', 'report-bytes', 'base', 'patch', 'preserved', 'extra'] as const)('rejects forged exact inventory %s', kind => {
    const binding = structuredClone(proof);
    if (kind === 'source-order') binding.sources.reverse(); if (kind === 'source-missing') binding.sources.pop(); if (kind === 'source-file') binding.sources[0]!.file = 'unknown.ts';
    if (kind === 'source-hash') binding.sources[0]!.before_sha256 = '0'.repeat(64); if (kind === 'source-bytes') binding.sources[0]!.after_bytes++;
    if (kind === 'source-line') binding.sources[0]!.edits[0]!.after_line++; if (kind === 'source-literal') binding.sources[0]!.edits[0]!.before_source += '// unknown';
    if (kind === 'harness-hash') binding.harness_sources[0]!.after_sha256 = '0'.repeat(64); if (kind === 'operation-order') binding.api_report.operations.reverse();
    if (kind === 'operation-missing') binding.api_report.operations.pop(); if (kind === 'operation-path') binding.api_report.operations[0]!.path = [];
    const splice = binding.api_report.operations[5]; if (splice?.kind === 'splice') { if (kind === 'operation-splice') splice.index++; if (kind === 'operation-rows') splice.after.pop(); }
    if (kind === 'report-hash') binding.api_report.after_sha256 = '0'.repeat(64); if (kind === 'report-bytes') binding.api_report.before_bytes++;
    if (kind === 'base') binding.base_ref = 'unknown'; if (kind === 'patch') binding.production_patch.unified_diff += '\n';
    if (kind === 'preserved') binding.preserved_files.pop(); if (kind === 'extra') Object.assign(binding, { unknown: true });
    expect(() => reverseAdminLevelDefinitionSource(sourceFiles[0]!, readHistorical(sourceFiles[0]!), binding)).toThrow();
    expect(() => reverseAdminLevelDefinitionHarnessSource(harnessFiles[0]!, readHistorical(harnessFiles[0]!), binding)).toThrow();
    expect(() => peelAdminLevelDefinitionReport(historicalLevelReport(), binding)).toThrow(); expect(() => applyAdminLevelDefinitionReport(historical(), binding)).toThrow();
  });
});
