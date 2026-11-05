import { createHash } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { readRechargeNoticePredecessorFile as readFileSync } from './helpers/rechargeNoticeSourceContinuity';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REGISTERED_PAGE_ROUTES, resolveRegisteredPageRoute } from '../../view/uniapp-ts/src/config/navigation';
import { buildAdminFrontendApiAuditReport } from '../scripts/admin-frontend-api-audit';
import {
  MEMBERSHIP_SOURCE_CONTINUITY_FILE, MEMBERSHIP_SOURCE_CONTINUITY_SHA,
  membershipContractSourceContinuity as proof,
  projectMembershipHistoricalSource, projectMembershipHistoricalRoutes,
  projectMembershipHistoricalReport, readMembershipContinuityHistoricalFile,
  assertMembershipReportInputInventory,
  type MembershipHistoryImage,
} from './helpers/membershipContractSourceContinuity';
import { readMembershipCouponsHistoricalFile } from './helpers/membershipCouponsSourceBinding';
import { readMembershipCardActivationHistoricalFile } from './helpers/membershipCardActivationSourceBinding';
import { projectMigrationMergeReport } from './helpers/migrationMergeSourceBinding';

const root = resolve(import.meta.dirname, '../..');
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const blob = (value: string | Uint8Array) => createHash('sha1').update('blob ' + Buffer.byteLength(value) + '\0').update(value).digest('hex');
const text = (file: string) => readFileSync(resolve(root, file), 'utf8');
const image = (value: string | Uint8Array): MembershipHistoryImage => ({ bytes: Buffer.byteLength(value), sha256: sha(value), gitBlobSha1: blob(value) });
let currentReport: ReturnType<typeof buildAdminFrontendApiAuditReport> | undefined;
const report = () => currentReport ??= buildAdminFrontendApiAuditReport();

describe('dated 7e41 membership contract source continuity before older proofs', () => {
  it('pins the independent complete proof and distinguishes committed evolution from historical source views', () => {
    expect(sha(readFileSync(resolve(root, MEMBERSHIP_SOURCE_CONTINUITY_FILE)))).toBe(MEMBERSHIP_SOURCE_CONTINUITY_SHA);
    expect(proof.sources).toHaveLength(43); expect(proof.wiring).toHaveLength(4);
    expect(proof.baseCommit).toBe('71fc0a2e3b42384b54d7cbd7be489d16543c51f3');
    expect(proof.sources.filter(row => !row.gitEvolution.currentEqualsBase).map(row => row.file)).toEqual([
      'workers-ts/scripts/run-local-finance-postgres.mjs', 'workers-ts/src/services/user/PaidMembershipService.ts',
    ]);
    for (const row of proof.sources) {
      expect(row.gitEvolution.baseCommit).toBe(proof.baseCommit);
      expect(row.historicalOrigin.commit).toBe(row.file === 'workers-ts/package.json' ? proof.postMergeCommit : proof.mergeCommit);
      expect(row.historicalOrigin.gitBlobSha1).toBe(row.historical.gitBlobSha1);
      expect(row.gitEvolution.committedPathHistory.length).toBeGreaterThan(0);
    }
  });
  it('checks every live complete input and every derived historical complete output including Git blob identities', () => {
    for (const row of [...proof.sources, ...proof.wiring]) {
      const actual = text(row.file);
      expect(image(actual)).toEqual(row.current);
      const before = projectMembershipHistoricalSource(row.file, actual);
      expect(image(before)).toEqual(row.historical);
      expect(before).not.toBe(actual);
    }
  });
  it.each(['suffix', 'prefix', 'CRLF', 'same-size edit', 'old complete image'] as const)(
    'rejects %s for every selected source instead of accepting an old image on disk', kind => {
      for (const row of [...proof.sources, ...proof.wiring]) {
        const actual = text(row.file), before = projectMembershipHistoricalSource(row.file, actual);
        const changed = kind === 'suffix' ? actual + '\n// unknown\n'
          : kind === 'prefix' ? '// unknown\n' + actual
          : kind === 'CRLF' ? actual.replace(/\n/g, '\r\n')
          : kind === 'same-size edit' ? (actual.startsWith('X') ? 'Y' : 'X') + actual.slice(1) : before;
        expect(changed).not.toBe(actual);
        expect(() => projectMembershipHistoricalSource(row.file, changed)).toThrow('complete current source differs');
      }
    });
  it('preserves the complete original four source-test byte vectors and all older immutable proof JSONs', () => {
    for (const row of proof.originalFourSourceTests) {
      const actual = text(row.file);
      const historical = proof.wiring.some(entry => entry.file === row.file)
        ? projectMembershipHistoricalSource(row.file, actual) : actual;
      expect(image(historical)).toEqual({ bytes: row.bytes, sha256: row.sha256, gitBlobSha1: row.gitBlobSha1 });
    }
    for (const row of proof.preservedProofs) {
      const bytes = readFileSync(resolve(root, row.file));
      expect(bytes.byteLength).toBe(row.bytes); expect(sha(bytes)).toBe(row.sha256);
    }
  });
  it('restores both historical navigation sources while the actual assigned-order page remains registered', () => {
    const file = proof.routeSet.file;
    expect(REGISTERED_PAGE_ROUTES.has(proof.routeSet.addedRoute)).toBe(true);
    expect(resolveRegisteredPageRoute(proof.routeSet.addedRoute)).toBe(proof.routeSet.addedRoute);
    expect(sha(text(file))).toBe('8358b8e6dd8cde4c236a6e3dde51056e633041d22f2cd20c73623a83b7625c4a');
    expect(sha(projectMembershipHistoricalSource(file, text(file)))).toBe('ab00ab314297acaa48a2a63fd67b4f8cf6682da14481e916a5b24cf96e91f2a0');
    expect(sha(readMembershipCouponsHistoricalFile(resolve(root, file), 'utf8')))
      .toBe('806571a8d73485a4e84183a989b6bdf0dc08cfded5526179ea70a8b638f1e648');
    expect(sha(readMembershipCardActivationHistoricalFile(resolve(root, file), 'utf8')))
      .toBe('97fea06f3fe5ead3da7564c26004aee138eb0615056def633c59189f54e6fc8b');
  });
  it('projects only the exact complete154-route set and verifies the complete153-route predecessor', () => {
    const previous = projectMembershipHistoricalRoutes(REGISTERED_PAGE_ROUTES);
    expect(previous.size).toBe(153); expect(previous.has(proof.routeSet.addedRoute)).toBe(false);
    expect(sha(JSON.stringify([...previous].sort()))).toBe(proof.routeSet.historical.sortedJsonSha256);
    expect(REGISTERED_PAGE_ROUTES.size).toBe(154);
    expect(() => projectMembershipHistoricalRoutes(previous)).toThrow('complete current registered routes differ');
  });
  it.each(['extra', 'missing', 'substituted', 'old complete set'] as const)('rejects %s route inventory', kind => {
    const changed = new Set(REGISTERED_PAGE_ROUTES);
    if (kind === 'extra') changed.add('/pages/unknown-unreviewed');
    if (kind === 'missing') changed.delete('/pages/index/index');
    if (kind === 'substituted') { changed.delete('/pages/index/index'); changed.add('/pages/unknown-unreviewed'); }
    if (kind === 'old complete set') changed.delete(proof.routeSet.addedRoute);
    expect(() => projectMembershipHistoricalRoutes(changed)).toThrow('complete current registered routes differ');
  });
  it('generates the actual current Admin AST report, then validates the exact complete historical report before old parent projection', () => {
    const actual = report();
    expect(image(JSON.stringify(actual, null, 2) + '\n')).toEqual(proof.report.current);
    expect(actual.counts).toMatchObject({ pathVariants: 867, registered: 867, executable: 867, unregistered: 0, unresolved: 0 });
    expect(proof.report.inputFiles).toHaveLength(329);
    const previous = projectMembershipHistoricalReport(actual);
    expect(image(JSON.stringify(previous, null, 2) + '\n')).toEqual(proof.report.historical);
    expect(proof.report.historical.sha256).toBe('e5d5f91d8a9b0e259e1b5446a7a03253496d8d65b00a964c18354040c81c7f8d');
    expect(sha(JSON.stringify(projectMigrationMergeReport(previous, 'main'), null, 2) + '\n'))
      .toBe('aa44ac94f3e234b35f42d37a2756e2914bfdb1c661aceb70d268878466ef8af9');
  });
  it.each(['uppercase extension', 'extra file', 'missing file', 'duplicate file'] as const)(
    'rejects %s in the complete case-sensitive AST source inventory', kind => {
      const files = proof.report.inputFiles.map(row => row.file);
      assertMembershipReportInputInventory(files);
      if (kind === 'uppercase extension') {
        const index = files.findIndex(file => file.endsWith('.ts'));
        expect(index).toBeGreaterThanOrEqual(0); files[index] = files[index]!.replace(/\.ts$/, '.TS');
      }
      if (kind === 'extra file') files.push('view/admin-ts/src/api/unreviewed-source.TS');
      if (kind === 'missing file') files.pop();
      if (kind === 'duplicate file') files.push(files[0]!);
      expect(() => assertMembershipReportInputInventory(files)).toThrow('complete actual report input inventory differs');
    });
  it.each(['count', 'source hash', 'route line', 'extra call', 'CRLF metadata', 'unknown field', 'old complete report'] as const)(
    'rejects %s in actual AST metadata without ignored fields or current-image fallback', kind => {
      let changed = structuredClone(report());
      if (kind === 'count') changed.counts.registered++;
      if (kind === 'source hash') changed.frontendSources[0]!.sha256 = '0'.repeat(64);
      if (kind === 'route line') changed.backend.registeredRoutes[0]!.line++;
      if (kind === 'extra call') changed.calls.push(structuredClone(changed.calls[0]!));
      if (kind === 'CRLF metadata') changed.methodology.scope += '\r\n';
      if (kind === 'unknown field') Object.assign(changed, { unknown: true });
      if (kind === 'old complete report') changed = projectMembershipHistoricalReport(changed);
      expect(() => projectMembershipHistoricalReport(changed)).toThrow('complete current source differs');
    });
  it('keeps UTF8/Buffer, URL and byte-path historical reads exact, while file descriptors and unrelated files retain native behavior', () => {
    const row = proof.sources.find(row => row.file === 'workers-ts/package.json')!;
    const file = resolve(root, row.file), actual = text(row.file), before = projectMembershipHistoricalSource(row.file, actual);
    for (const path of [file, pathToFileURL(file), Buffer.from(file)]) {
      expect(readMembershipContinuityHistoricalFile(path, 'utf8')).toBe(before);
      expect(readMembershipContinuityHistoricalFile(path)).toEqual(Buffer.from(before));
    }
    expect(() => readMembershipContinuityHistoricalFile(file, 'ascii')).toThrow('requires exact UTF8 or bytes');
    const fd = openSync(file, 'r');
    try { expect(readMembershipContinuityHistoricalFile(fd, 'utf8')).toBe(actual); }
    finally { closeSync(fd); }
    const unrelated = resolve(root, 'workers-ts/tsconfig.json');
    expect(readMembershipContinuityHistoricalFile(unrelated)).toEqual(readFileSync(unrelated));
    expect(projectMembershipHistoricalSource('unrelated.ts', 'actual bytes')).toBe('actual bytes');
    expect(() => readMembershipContinuityHistoricalFile(resolve(root, '.missing-membership-source-continuity'))).toThrow();
  });
  it.each(['current hash', 'historical hash', 'bytes', 'blob', 'scope', 'edit position', 'literal', 'unique anchor',
    'overlap', 'origin', 'local origin', 'route inventory', 'report input', 'preserved proof', 'unknown field'] as const)(
    'rejects forged %s proof data before any historical view is produced', kind => {
      const changed = structuredClone(proof), row = changed.sources[0]!, edit = row.inverseEdits[0]!;
      if (kind === 'current hash') row.current.sha256 = '0'.repeat(64);
      if (kind === 'historical hash') row.historical.sha256 = '0'.repeat(64);
      if (kind === 'bytes') row.current.bytes++;
      if (kind === 'blob') row.historical.gitBlobSha1 = '0'.repeat(40);
      if (kind === 'scope') row.file += '.other';
      if (kind === 'edit position') edit.start++;
      if (kind === 'literal') edit.after.push('// invented\n');
      if (kind === 'unique anchor') edit.anchor[0] = edit.anchor[0]! + '// invented\n';
      if (kind === 'overlap') row.inverseEdits.push(structuredClone(edit));
      if (kind === 'origin') row.historicalOrigin.commit = '0'.repeat(40);
      if (kind === 'local origin') row.gitEvolution.baseCommit = '0'.repeat(40);
      if (kind === 'route inventory') changed.routeSet.current.count++;
      if (kind === 'report input') changed.report.inputFiles[0]!.sha256 = '0'.repeat(64);
      if (kind === 'preserved proof') changed.preservedProofs[0]!.sha256 = '0'.repeat(64);
      if (kind === 'unknown field') Object.assign(changed, { unknown: true });
      expect(() => projectMembershipHistoricalSource(proof.sources[0]!.file, text(proof.sources[0]!.file), changed))
        .toThrow('complete proof differs');
    });
});
