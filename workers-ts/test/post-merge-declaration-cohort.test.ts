import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertPostMergeDeclarationCohort, POST_MERGE_DECLARATION_PROOF_FILE,
  POST_MERGE_DECLARATION_PROOF_SHA256, postMergeDeclarationProof as proof,
  reviewedPostMergeDeclarationSources, reviewedPostMergeDeclarationTableNames,
  verifyPostMergeDeclarationCohort } from './helpers/postMergeDeclarationCohort';

const root = resolve(import.meta.dirname, '..');
const images = new Map(proof.sourceImages.map(row => [row.file, row.rawUtf8]));
const frozenSource = (file: string): string => {
  const source = images.get(file);
  if (source === undefined) throw new Error(`Unreviewed source requested: ${file}`);
  return source;
};

describe('post-merge independent declaration cohort without installed-catalog claims', () => {
  it('pins the complete Git-backed fixture, all sources, and explicit installation owners', () => {
    const bytes = readFileSync(resolve(root, POST_MERGE_DECLARATION_PROOF_FILE));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(POST_MERGE_DECLARATION_PROOF_SHA256);
    expect(proof.basisCommit).toBe('a03a52a119122615fbf5bd5c3a983dc6f60bb5cd');
    expect(proof.sourceImages).toHaveLength(63);
    expect(proof.sourceImages.reduce((sum, row) => sum + row.bytes, 0)).toBe(813071);
    expect(proof.modules).toHaveLength(33); expect(proof.owners).toHaveLength(31);
    expect(proof.owners.flatMap(owner => owner.entryPoints)).toHaveLength(61);
    expect(Object.isFrozen(proof)).toBe(true);
    expect(Object.isFrozen(proof.modules[0]!.tables[0]!.columns)).toBe(true);
    expect(Object.isFrozen(proof.owners[0]!.entryPoints)).toBe(true);
  });

  it('verifies actual current bytes, all 41 ordered column/PK definitions, and owner execution positions', () => {
    const result = assertPostMergeDeclarationCohort(root);
    expect(result.tableNames).toHaveLength(41);
    expect(new Set(result.tableNames).size).toBe(41);
    expect(result.sourceNames).toHaveLength(33);
    const profile = result.modules.find(module => module.file.endsWith('/adminProfile.ts'))!;
    expect(profile.tables.map(table => table.name)).toEqual(['admin_profile_operation', 'admin_profile_avatar']);
    const menu = result.modules.find(module => module.file.endsWith('/adminWechatMenuOperation.ts'))!.tables[0]!;
    expect(menu.primaryKey).toEqual(['operation_id', 'phase']);
    expect(menu.columns.filter(column => column.primaryKey).map(column => column.name)).toEqual(['operation_id', 'phase']);
    const attempt = result.modules.find(module => module.file.endsWith('/routinePaymentAttempt.ts'))!.tables[0]!;
    expect(attempt.primaryKey).toEqual(['order_no', 'event_kind']);
    expect(attempt.columns.map(column => column.name)).toEqual(['order_no', 'event_kind', 'payload', 'created_at', 'signature']);
  });

  it('returns exactly the reviewed basenames and names without admitting a future module', () => {
    const sources: string[] = reviewedPostMergeDeclarationSources(root);
    const tables: string[] = reviewedPostMergeDeclarationTableNames(root);
    expect(sources).toEqual(proof.declarationSourceNames);
    expect(tables).toEqual(proof.declarationTableNames);
    const currentDirectory = [...sources, 'futureUnknownOperation.ts'];
    expect(currentDirectory.filter(file => !sources.includes(file))).toEqual(['futureUnknownOperation.ts']);
    expect(sources.every(file => !file.includes('/'))).toBe(true);
  });

  it('keeps all 34 SQL interpolation expressions unresolved and never assembles executable SQL', () => {
    const result = verifyPostMergeDeclarationCohort(frozenSource);
    expect(result.modules.reduce((sum, module) => sum + module.interpolations.length, 0)).toBe(34);
    expect(result.modules.every(module => module.representation === 'interpolated-template')).toBe(true);
    expect(result.modules.flatMap(module => module.interpolations).every(expression => expression.syntaxKind === 'Identifier')).toBe(true);
    expect(result.installationEquivalenceProven).toBe(false);
    expect(result.runAllRegistrationProven).toBe(false);
    expect(result.completeSqlEvaluation).toBe(false);
    expect(result.unresolvedListExhaustive).toBe(false);
    expect('sql' in result).toBe(false);
  });

  it('preserves the two real owner bundles rather than treating each table as an independent installer', () => {
    expect(proof.atomicOwnerBundles).toEqual([
      { ownerFile: 'src/migrations/runAdminWechatAppUpgrade.ts',
        moduleFiles: ['src/migrations/adminWechatAppOperation.ts', 'src/migrations/nativeAppPaymentAuthority.ts'],
        tableNames: ['admin_wechat_app_operation', 'native_app_payment_account', 'native_app_payment_evidence'] },
      { ownerFile: 'src/migrations/routinePaymentRuntime.ts',
        moduleFiles: ['src/migrations/routineIdentityWitness.ts', 'src/migrations/routinePaymentAttempt.ts'],
        tableNames: ['routine_identity_witness', 'routine_payment_attempt'] },
    ]);
    const owner = proof.owners.find(row => row.file === 'src/migrations/runAdminWechatAppUpgrade.ts')!;
    expect(owner.executions.map(row => row.text)).toEqual([
      'await tx.execute(sql.raw(ADMIN_WECHAT_APP_OPERATION_SQL + NATIVE_APP_PAYMENT_AUTHORITY_SQL));',
    ]);
  });

  it.each(['module-suffix', 'module-constraint', 'owner-guard', 'owner-execution'])(
    'rejects drift anywhere in the complete %s source', kind => {
      const file = kind.startsWith('module') ? 'src/migrations/adminDeliveryOperation.ts' : 'src/migrations/runAdminDeliveryUpgrade.ts';
      let source = frozenSource(file);
      if (kind === 'module-suffix') source += '\n// unreviewed successor\n';
      if (kind === 'module-constraint') source = source.replace('adlo_pk PRIMARY KEY(operation_id)', 'adlo_pk PRIMARY KEY(actor_id)');
      if (kind === 'owner-guard') source = source.replace("'read committed'", "'repeatable read'");
      if (kind === 'owner-execution') source = source.replace('sql.raw(ADMIN_DELIVERY_OPERATION_SQL)', 'sql.raw(UNREVIEWED_SQL)');
      expect(source).not.toBe(frozenSource(file));
      expect(() => verifyPostMergeDeclarationCohort(name => name === file ? source : frozenSource(name)))
        .toThrow(`Post-merge declaration source differs: ${file}`);
    },
  );

  it.each(['scope', 'column', 'primary-key', 'owner-entry', 'owner-bundle', 'interpolation', 'source-hash', 'installation-claim'])(
    'rejects a replacement %s manifest instead of recomputing expected data from current sources', kind => {
      const changed = structuredClone(proof);
      if (kind === 'scope') changed.modules.pop();
      if (kind === 'column') changed.modules[0]!.tables[0]!.columns.pop();
      if (kind === 'primary-key') changed.modules[0]!.tables[0]!.primaryKey = ['actor_id'];
      if (kind === 'owner-entry') changed.owners[0]!.entryPoints[0]!.name += 'Other';
      if (kind === 'owner-bundle') changed.atomicOwnerBundles[0]!.moduleFiles.pop();
      if (kind === 'interpolation') changed.modules[0]!.interpolations[0]!.text = '';
      if (kind === 'source-hash') changed.sourceImages[0]!.sha256 = '0'.repeat(64);
      if (kind === 'installation-claim') Object.assign(changed, { installationEquivalenceProven: true });
      expect(() => verifyPostMergeDeclarationCohort(frozenSource, changed)).toThrow('Complete post-merge declaration proof differs');
    },
  );

  it('does not accept a missing owner source as an optional declaration', () => {
    const missing = 'src/migrations/runAdminDeliveryUpgrade.ts';
    expect(() => verifyPostMergeDeclarationCohort(file => {
      if (file === missing) throw new Error('Required owner source missing');
      return frozenSource(file);
    })).toThrow('Required owner source missing');
  });
});
