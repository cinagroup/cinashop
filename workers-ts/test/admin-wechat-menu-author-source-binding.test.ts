import { createHash } from 'node:crypto';
import { readWechatBaseAuthorPredecessor as readFileSync } from './helpers/wechatAppAuthorSourceBinding';
import { wechatBaseAuthorPredecessorExecFileSync as execFileSync } from './helpers/wechatAppAuthorSourceBinding';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildWechatBaseAuthorPredecessorApiAuditReport as buildAdminFrontendApiAuditReport } from './helpers/wechatAppAuthorSourceBinding';
import { normalizeWechatMenu, wechatMenuProviderButtons } from '../../view/common/wechatMenu';
import { wechatMenuAuthorSourceBinding as bound, reverseWechatMenuAuthorSource, reverseWechatMenuAuthorPredecessorPublication,
  readWechatMenuAuthorPredecessor, readBargainRecordsPredecessor, buildWechatMenuAuthorPredecessorApiAuditReport,
  wechatMenuAuthorPredecessorExecFileSync, bargainRecordsPredecessorExecFileSync, bargainRecordsSourceBinding } from './helpers/wechatAppAuthorSourceBinding';

const root = resolve(import.meta.dirname, '../..');
const sha = (raw: string | Uint8Array) => createHash('sha256').update(raw).digest('hex');
const read = (file: string) => readFileSync(resolve(root, file), 'utf8');
const strip = (source: string) => source.replace(/^import[\s\S]*?;\n/gmu, '');
type Origin = { file: string; sha256: string; raw_utf8: string };
type Member = { path: string; bytes: number; sha256: string };
type Generated = Member & { origin: string };
const proof = bound as typeof bound & {
  baseline_manifest: Origin; predecessor_receipt: Origin; normalized_helper_sha256: string;
  controlled_source_manifest: Member[]; publication_outputs_excluded: string[]; generated_outputs_excluded_prefixes: string[];
  predecessor_generated_outputs: Generated[]; predecessor_source_report: Origin;
};

describe('complete official-account menu author source and immutable predecessor evidence', () => {
  for (const row of proof.sources) {
    it('binds whole current and prior source ' + row.file, () => {
      const raw = read(row.file), before = reverseWechatMenuAuthorSource(row.file, raw);
      expect(sha(raw)).toBe(row.after_sha256); expect(sha(before)).toBe(row.before_sha256);
      expect(readWechatMenuAuthorPredecessor(resolve(root, row.file), 'utf8')).toBe(before);
      expect(before.replace(row.edits[0]!.before_source, () => row.edits[0]!.after_source)).toBe(raw);
    });
    it('rejects changed current and forged complete predecessor ' + row.file, () => {
      const raw = read(row.file);
      for (const altered of [raw.slice(1), raw + '\n', raw + raw]) expect(() => reverseWechatMenuAuthorSource(row.file, altered)).toThrow();
      const forged = { ...proof, sources: proof.sources.map(item => item === row ? { ...item, before_sha256: '0'.repeat(64) } : item) };
      expect(() => reverseWechatMenuAuthorSource(row.file, raw, forged)).toThrow();
    });
    if (proof.predecessor_readports.includes(row.file)) it('preserves old assertions and negative fixtures ' + row.file, () => {
      const edit = row.edits[0]!; expect(strip(edit.after_source)).toBe(strip(edit.before_source));
      expect(edit.after_source).not.toBe(edit.before_source); expect(edit.after_source).not.toContain("from './helpers/bargainRecordsSourceBinding'");
      expect(edit.after_source).not.toContain('from "./helpers/bargainRecordsSourceBinding"');
    });
  }
  for (const row of proof.full_additions) it('binds complete new file ' + row.file, () => {
    const bytes = readFileSync(resolve(root, row.file)); expect(bytes.byteLength).toBe(row.bytes); expect(sha(bytes)).toBe(row.sha256);
    expect(proof.sources.some(item => item.file === row.file)).toBe(false);
  });
  for (const row of proof.PHP_sources) it('retains complete fixed PHP authority ' + row.file, () => {
    expect(proof.PHP_ref).toBe('8ed2a5b139f9170dd11b0dff91803f2fd59e40a5');
    expect(sha(row.raw_utf8)).toBe(row.sha256); expect(Buffer.byteLength(row.raw_utf8)).toBe(row.bytes); expect(row.git_blob).toMatch(/^[a-f0-9]{40}$/u);
  });
  const frozen = Object.entries(proof.frozen_predecessor_evidence);
  for (let i = 0; i < frozen.length; i += 64) it('preserves immutable predecessor evidence chunk ' + i, () => {
    for (const [file, hash] of frozen.slice(i, i + 64)) expect(sha(readFileSync(resolve(root, file))), file).toBe(hash);
  });
  const observed = Object.entries(proof.observed_unchanged);
  for (let i = 0; i < observed.length; i += 32) it('retains mature untouched consumers chunk ' + i, () => {
    for (const [file, hash] of observed.slice(i, i + 32)) expect(sha(readFileSync(resolve(root, file))), file).toBe(hash);
  });
  it('binds the true8057 baseline and exact whole changed/new controlled partition', () => {
    expect(proof.baseline).toEqual({ file_count: 8057, sha256: '6e2f04b37d8ff0f2670675f7f09aa012df6ab2f88f1b49c573ab9f18c3e98514' });
    expect(sha(proof.baseline_manifest.raw_utf8)).toBe(proof.baseline.sha256);
    const before = JSON.parse(proof.baseline_manifest.raw_utf8) as Member[], byName = new Map(before.map(row => [row.path, row]));
    expect(byName.size).toBe(8057); expect(frozen).toHaveLength(1742); expect(proof.predecessor_readports).toHaveLength(36);
    expect(new Set(proof.predecessor_readports).size).toBe(36);
    const inventory = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0');
    const names = [...new Set([...inventory, ...before.map(row => row.path)])].filter(file => file && !proof.publication_outputs_excluded.includes(file)
      && !proof.generated_outputs_excluded_prefixes.some(prefix => file.startsWith(prefix))).sort();
    expect(proof.controlled_source_manifest.map(row => row.path)).toEqual(names);
    const changed: string[] = [], added: string[] = [];
    for (const row of proof.controlled_source_manifest) {
      const bytes = readFileSync(resolve(root, row.path)); expect(bytes.byteLength, row.path).toBe(row.bytes); expect(sha(bytes), row.path).toBe(row.sha256);
      if (!byName.has(row.path)) added.push(row.path); else if (byName.get(row.path)!.sha256 !== row.sha256) changed.push(row.path);
    }
    expect(proof.sources.map(row => row.file)).toEqual(changed); expect(proof.full_additions.map(row => row.file)).toEqual(added);
  });
  it('binds only the new helper self-proof pin normalization and keeps the Bargain helper immutable', () => {
    const raw = read('workers-ts/test/helpers/wechatMenuAuthorSourceBinding.ts');
    expect(raw).toMatch(/const WECHAT_MENU_AUTHOR_PROOF_SHA='[a-f0-9]{64}';/u);
    expect(sha(raw.replace(/const WECHAT_MENU_AUTHOR_PROOF_SHA='[a-f0-9]{64}';/u, "const WECHAT_MENU_AUTHOR_PROOF_SHA='<PIN>';"))).toBe(proof.normalized_helper_sha256);
    expect(sha(read('workers-ts/test/helpers/bargainRecordsSourceBinding.ts'))).toBe('703cffbdf2f7d5018af316ac9db9687f604e84bf767c72073068e427ac54f5ea');
  });
  it('retains five full physical publication origins and both exact ledger byte bridges', () => {
    expect(Object.keys(proof.predecessor_publication_origins).sort()).toEqual([
      'bargain_accepted_manifest', 'bargain_before_manifest', 'bargain_receipt', 'bargain_validation_manifest', 'wechat_before_manifest',
    ]);
    for (const origin of Object.values(proof.predecessor_publication_origins)) {
      expect(sha(origin.raw_utf8)).toBe(origin.sha256); expect(readFileSync(origin.file, 'utf8')).toBe(origin.raw_utf8);
    }
    expect(proof.predecessor_publication.map(row => row.file)).toEqual(['MIGRATION_AUDIT.md', 'MIGRATION_CHECKLIST.md']);
    const validation = new Map((JSON.parse(proof.predecessor_publication_origins.bargain_validation_manifest!.raw_utf8) as Member[]).map(row => [row.path, row]));
    const accepted = new Map((JSON.parse(proof.predecessor_publication_origins.bargain_accepted_manifest!.raw_utf8) as Member[]).map(row => [row.path, row]));
    for (const row of proof.predecessor_publication) {
      expect(readFileSync(row.validation_origin, 'utf8')).toBe(row.validation_source); expect(readFileSync(row.accepted_origin, 'utf8')).toBe(row.accepted_source);
      expect(sha(row.validation_source)).toBe(validation.get(row.file)!.sha256); expect(sha(row.accepted_source)).toBe(accepted.get(row.file)!.sha256);
      expect(reverseWechatMenuAuthorPredecessorPublication(row.file, row.accepted_source)).toBe(row.validation_source);
      for (const altered of [row.accepted_source + '\n', row.validation_source, row.accepted_source.slice(1)]) expect(() => reverseWechatMenuAuthorPredecessorPublication(row.file, altered)).toThrow();
      expect(readWechatMenuAuthorPredecessor(resolve(root, row.file), 'utf8')).toBe(row.validation_source);
    }
    expect(bargainRecordsSourceBinding.baseline.file_count).toBe(8033);
  });
  it('keeps the8057 outer and8033 inner inventory commands distinct with exact argument allowlists', () => {
    const args = ['ls-files', '-co', '--exclude-standard', '-z'], options = { cwd: root, encoding: 'utf8' };
    expect(wechatMenuAuthorPredecessorExecFileSync('git', args, options).split('\0').filter(Boolean)).toHaveLength(8057);
    expect(bargainRecordsPredecessorExecFileSync('git', args, options).split('\0').filter(Boolean)).toHaveLength(8033);
    expect(() => wechatMenuAuthorPredecessorExecFileSync('git', ['status'], options)).toThrow();
    expect(() => wechatMenuAuthorPredecessorExecFileSync('git', args, { ...options, cwd: resolve(root, '..') })).toThrow();
  });
  it('routes327 immediate and321 deeper generated members to exact physical predecessor bytes', () => {
    expect(proof.predecessor_generated_outputs).toHaveLength(327);
    const before = JSON.parse(proof.baseline_manifest.raw_utf8) as Member[];
    expect(proof.predecessor_generated_outputs.map(row => row.path)).toEqual(before.filter(row => row.path.startsWith('view/admin-ts/dist/')).map(row => row.path));
    for (const row of proof.predecessor_generated_outputs) {
      const actual = readWechatMenuAuthorPredecessor(resolve(root, row.path)); expect(actual.byteLength).toBe(row.bytes); expect(sha(actual)).toBe(row.sha256);
      expect(sha(readFileSync(row.origin))).toBe(row.sha256);
    }
    const inner = (bargainRecordsSourceBinding as typeof bargainRecordsSourceBinding & { predecessor_generated_outputs: Generated[] }).predecessor_generated_outputs;
    expect(inner).toHaveLength(321);
    for (const row of inner) { const actual = readBargainRecordsPredecessor(resolve(root, row.path)); expect(actual.byteLength).toBe(row.bytes); expect(sha(actual)).toBe(row.sha256); }
    expect(() => readWechatMenuAuthorPredecessor(resolve(root, 'view/admin-ts/dist/not-a-pinned-member.js'))).toThrow();
  });
  it('binds the actual accepted4877 identity report and receipt without moving older Supplier facts', () => {
    expect(sha(proof.predecessor_receipt.raw_utf8)).toBe('ec50d860adf649c2094e1098c218e1c8bd006b245d5d954a9246a7b9e6120914');
    expect(JSON.parse(proof.predecessor_receipt.raw_utf8)).toMatchObject({ status: 'accepted', counts: { source: 4877 } });
    expect(readFileSync(proof.predecessor_source_report.file, 'utf8')).toBe(proof.predecessor_source_report.raw_utf8);
    expect(sha(proof.predecessor_source_report.raw_utf8)).toBe(proof.predecessor_source_report.sha256);
    const report = JSON.parse(proof.predecessor_source_report.raw_utf8) as { testResults: Array<{ name: string; assertionResults: Array<{ fullName: string; status: string }> }> };
    const ids = report.testResults.flatMap(file => file.assertionResults.filter(row => row.status === 'passed').map(row => file.name.split('/workers-ts/').at(-1) + '\0' + row.fullName));
    expect(report.testResults).toHaveLength(36); expect(ids).toHaveLength(4877); expect(new Set(ids).size).toBe(4877);
  });
  it('executes the current API AST before all archived report hops and retains every complete prior variant', () => {
    const current = buildAdminFrontendApiAuditReport(), previous = buildWechatMenuAuthorPredecessorApiAuditReport();
    expect(sha(JSON.stringify(current, null, 2) + '\n')).toBe(proof.current_report.sha256);
    expect(current.counts.unregistered).toBe(0); expect(current.counts.unresolved).toBe(0); expect(previous.counts.callSites).toBe(795); expect(previous.calls).toHaveLength(833);
    expect(proof.retired_api_calls).toEqual([]); for (const old of previous.calls) expect(current.calls).toContainEqual(old);
    expect(current.calls.filter(row => row.source.endsWith('/api/wechatMenu.ts'))).toHaveLength(6);
  });
  it('retains inactive local author fields while provider projection sends only active actions and complete child groups', () => {
    const draft = normalizeWechatMenu([{ name: '父', type: 'click', key: 'inactive', url: 'https://example.test/kept', sub_button: [
      { name: '子', type: 'view', url: 'https://example.test/current', key: 'kept' },
    ] }]);
    expect(draft[0]!.key).toBe('inactive'); expect(draft[0]!.sub_button![0]!.key).toBe('kept');
    expect(wechatMenuProviderButtons(draft)).toEqual([{ name: '父', sub_button: [{ name: '子', type: 'view', url: 'https://example.test/current' }] }]);
    expect(() => normalizeWechatMenu([])).toThrow(); expect(() => normalizeWechatMenu([{ name: '原', type: 'scancode_push', key: 'x' }])).toThrow();
  });
  it('binds durable admission before the single nonretrying provider dispatch and outcome-specific signatures', () => {
    const service = read('workers-ts/src/services/admin/AdminWechatMenuService.ts');
    expect(service.indexOf('if (admitted.replayed)')).toBeLessThan(service.indexOf('this.provider.create('));
    expect(service).toContain("this.hash('admission'"); expect(service).toContain("this.hash('outcome'");
    expect(service).toContain('row.operation_id'); expect(service).toContain('SET CONSTRAINTS ALL IMMEDIATE'); expect(service).toContain('RETURNING *');
    expect(service).toContain('accepted_unstored'); expect(service).toContain('observed_match'); expect(service).toContain('current.accountStamp !== start.account_stamp');
  });
  it('uses fresh private authority/config and exact session-bound observation rather than cache token authority', () => {
    const service = read('workers-ts/src/services/admin/AdminWechatMenuService.ts'), provider = read('workers-ts/src/services/wechat/OfficialAccountMenuProvider.ts');
    expect(service).toContain('authorizeAdminLegacyProductRead'); expect(service).toContain('assertAdminLegacyProductReadDeadline');
    expect(service).toContain("FROM public.system_config"); expect(service).toContain('actor.authVersion, actor.expiresAt');
    expect(provider).toContain("const ORIGIN = 'https://api.weixin.qq.com'"); expect(provider).toContain('64 * 1024');
    expect(provider).toContain('10_000'); expect(provider).toContain("redirect: 'error'"); expect(provider).toContain('fatal: true');
    expect(provider).not.toContain('errmsg'); expect(provider).not.toContain('CONFIG_KV'); expect(provider).not.toContain('SystemConfigService');
  });
  it('binds explicit original-command sealing without a new publish or silent local journal deletion', () => {
    const api = read('view/admin-ts/src/api/wechatMenu.ts'), page = read('view/admin-ts/src/pages/content/WechatMenuAuthor.vue');
    expect(api).toContain('apiResolveMissingWechatMenu'); expect(api).toContain('/resolve-missing`');
    expect(api).toContain('resolve-missing`, input, { signal }');
    expect(page).toContain('actions.resolveMissing'); expect(page).toContain('localPending.value !== sealPayload');
    expect(page).toContain('JSON.stringify(readPending()) !== JSON.stringify(payload)');
    expect(page).toContain('await apiResolveMissingWechatMenu(payload, request.signal)');
    expect(page).toContain("if (result.state !== 'unknown') await load()");
    expect(page).toContain('已经受理的未知请求不能取消');
    expect(read('view/admin-ts/scripts/wechat-menu-runtime.test.cjs')).toContain('a pre-admission409 and receipt404 can explicitly seal the exact original command');
  });
  it('keeps the exact additive receipt catalog App-closed, Admin-select-insert-only and explicitly maintained', () => {
    const addon = read('workers-ts/src/migrations/adminWechatMenuOperation.ts'), upgrade = read('workers-ts/src/migrations/runAdminWechatMenuUpgrade.ts');
    expect(addon).toContain("app: [], admin: ['SELECT', 'INSERT']"); expect(addon).toContain('PRIMARY KEY(operation_id,phase)');
    expect(addon).toContain('731656'); expect(addon).toContain('awmo_immutable_rows'); expect(addon).toContain('awmo_immutable_truncate');
    expect(upgrade).toContain('GRANT SELECT, INSERT'); expect(upgrade).toContain('inspectRuntimeBusinessProfileInTransaction');
    expect(upgrade).not.toMatch(/CREATE ROLE|GRANT (?:UPDATE|DELETE|ALL)/u);
  });
  it('binds the real alias, exact permission family, loop-local event leases and current runtime test host', () => {
    const router = read('view/admin-ts/src/router/index.ts'), page = read('view/admin-ts/src/pages/content/WechatMenuAuthor.vue');
    expect(router).toContain('/admin/app/wechat/setting/menus/index'); expect(router).toContain('WechatMenuAuthor.vue');
    expect(read('workers-ts/src/services/admin/AdminPermissionService.ts')).toContain("controller === 'application.wechat_menus'");
    expect(page).toContain('v-for="actions in [controls]"'); expect(page).toContain('observationEpoch'); expect(page).toContain('selectionEpoch');
    expect(page.indexOf('persist(payload)')).toBeLessThan(page.indexOf('await apiPublishWechatMenu(payload'));
    expect(read('view/admin-ts/scripts/wechat-menu-runtime.test.cjs')).toContain("require('./helpers/bargain-records-runtime.cjs')");
    expect(read('view/admin-ts/scripts/helpers/bargain-records-runtime.cjs')).toContain('cacheHandlers:true');
  });
});
