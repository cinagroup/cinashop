import { beforeConfigClassReport } from './helpers/configClassSourceBinding';
import { reverseSearchHotwordsSource } from './helpers/searchHotwordsSourceBinding';
import { reverseLiveBroadcastAuthorSource, applyLiveBroadcastAuthorReport } from './helpers/diyLiveBroadcastAuthorSourceBinding';
import { reverseSeckillAuthorSource, applySeckillAuthorReport } from './helpers/diySeckillAuthorSourceBinding';
import { reverseBargainAuthorSource, applyBargainAuthorReport } from './helpers/diyBargainAuthorSourceBinding';
import { reverseCombinationAuthorSource, applyCombinationAuthorReport, combinationAuthorSourceBinding } from './helpers/diyCombinationAuthorSourceBinding';
import { createHash } from 'node:crypto';
import { readAdminProfileThenErrorPagesThenBrowserLogThenConfigClassPredecessor as readFileSync } from './helpers/wechatAppAuthorSourceBinding';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAdminProfilePredecessorApiAuditReport as buildCurrentAdminFrontendApiAuditReport } from './helpers/wechatAppAuthorSourceBinding';
const buildAdminFrontendApiAuditReport=()=>beforeConfigClassReport(buildCurrentAdminFrontendApiAuditReport());
import { applyPresaleAuthorReport, reversePresaleAuthorSource, presaleAuthorSourceBinding as proof } from './helpers/diyPresaleAuthorSourceBinding';
import { pointsAuthorSourceBinding, reversePointsAuthorSource } from './helpers/diyPointsAuthorSourceBinding';
import { reverseRouteSourceFollowup, type RouteSourceFollowup } from './helpers/routeSourceIncrement';

const root = resolve(import.meta.dirname, '../..');
const read = (file: string) => reverseCombinationAuthorSource(file, reverseBargainAuthorSource(file, reverseSeckillAuthorSource(file, reverseLiveBroadcastAuthorSource(file,reverseSearchHotwordsSource(file,readFileSync(resolve(root, file === proof.current_report.file ? combinationAuthorSourceBinding.previous_report.file : file), 'utf8').replace(/\r\n?/gu, '\n'))))));
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const before = JSON.parse(read(proof.previous_report.file));
const current = JSON.parse(read(proof.current_report.file));
const sourceFiles = proof.sources.map(row => row.file);
const frozen = {
  "workers-ts/audit/diy-carousel-author-source-binding-20261023.json": "e09f9227d29faa4932810e66e12d4c1d57c5d4db6e233ce29284b3253b4dd0b6",
  "workers-ts/audit/diy-community-author-php-parity-20261024.json": "96b35eaa70e0ff46260b5677f5e0078d277d310af978a940a879384f05f2bb67",
  "workers-ts/audit/diy-community-author-source-binding-20261024.json": "dc461dd1511ddad0148e9831d84bbff99f323426fe0ba1045381a7456ddc1633",
  "workers-ts/audit/diy-editorial-author-php-parity-20261024.json": "d9f450b1c3ca0f108fda2d059fa414f66f308e290d2e4afb84ab9028fd0ad950",
  "workers-ts/audit/diy-editorial-author-source-binding-20261024.json": "8b43939285cfee0f58a464e2757ea335f116c53cfa42210c02e08681d6ad8579",
  "workers-ts/audit/diy-follow-author-source-binding-20261024.json": "7fac6edbe6b856c737f758c6d6952f449974e685098b065ac4c19dae0712a7d8",
  "workers-ts/audit/diy-list-author-source-binding-20261023.json": "4ddd06f3bef5ef330d46ec6289b76c81876e2d4da8d5bcd623dca73d540e3149",
  "workers-ts/audit/diy-navigation-author-source-binding-20261023.json": "91d6a8f07f1330ddabceff904a9ace6fe4c5641756b9faee838c4a117f3f99fd",
  "workers-ts/test/fixtures/diy-state-author-historical-bindings-20261024.json": "8ddc626ef49c2ada520940518c99a3b3bb803df5b1047308af9d4241ff96a7d9",
  "workers-ts/test/helpers/diyCarouselAuthorSourceBinding.ts": "68500365fa9f677dd7b937d571c734a9494d00c8ffcd9bb8cfd62292ce4afd18",
  "workers-ts/test/helpers/diyCommunityAuthorSourceBinding.ts": "14c6b27bed91b44892462e0600bde54bccd63f83db27019a26c67e23c7037c0e",
  "workers-ts/test/helpers/diyEditorialAuthorSourceBinding.ts": "051ce7caf8e73f56eee9e709d76ec7f1e1da90cbb4c27081de728d52333d68a8",
  "workers-ts/test/helpers/diyFollowAuthorSourceBinding.ts": "d95ceb5112631a497e210763962cc002dcb2c85467ae25f0c8a5038b5faab3b1",
  "workers-ts/test/helpers/diyListAuthorSourceBinding.ts": "fe89a23a69e3fc5c4491b740cce80118cf4577961b0cacdbc508b8e4b12a6e21",
  "workers-ts/test/helpers/diyNavigationAuthorSourceBinding.ts": "bcdc3fe7640973a35c50ac2804a845bf87a2abe5b5ed634a85e3f5e3466cf704",
  "workers-ts/audit/diy-promotion-author-source-binding-20261025.json": "fd3f186922cad714f642ec7b0dfc7a28ed96b5791f2cdab934d95ff697bd9b6b",
  "workers-ts/audit/diy-promotion-author-php-parity-20261025.json": "2aa9f63d0e2b2ea4e9f28586f751191488081d302ee609eb9bab17c66815104a",
  "workers-ts/test/helpers/diyPromotionAuthorSourceBinding.ts": "26a46bc8609cbafbbb2907535cdb8efcac9f22a03efda210294b785f28f6bda0",
  "workers-ts/audit/diy-coupon-author-source-binding-20261025.json": "5c3f700a231dc7840bf65d66dc857b3e7c611a48e8be311e8b735fd96e8bcbbc",
  "workers-ts/audit/diy-coupon-author-php-parity-20261025.json": "ed67ffe4e40c8f59b6f95d1f113a7b2120abe85feff690dd3e01f38110391c6e",
  "workers-ts/test/helpers/diyCouponAuthorSourceBinding.ts": "6464453af98b0063b7c61f13a3147c4ab0aeebf2782b42ec39e555e9178dfbf1",
  "workers-ts/audit/diy-points-author-source-binding-20261025.json": "cedec475e804f04130567dbf77cf860b8f2eef14847465f629e45f13e7952e7b",
  "workers-ts/audit/diy-points-author-php-parity-20261025.json": "bb7086d358c0d4b8177abd3bb72ef21627381c2edf521f80fb3b96c9ad6eaea2",
  "workers-ts/test/helpers/diyPointsAuthorSourceBinding.ts": "b4ec2a56e6f1792288334528ee215fa253c95deff96fb8f2822c669b6c27ada6"
} as const;
const fullAddFiles = [
  "view/admin-ts/src/utils/diyPresaleDefaults.ts",
  "view/admin-ts/src/utils/diyPresaleEditor.ts",
  "view/admin-ts/src/utils/diyPresaleProjection.ts",
  "view/admin-ts/src/api/diyPresaleAuthor.ts",
  "view/admin-ts/scripts/diy-presale-editor-model-runtime.test.cjs",
  "view/admin-ts/scripts/diy-presale-author-data-runtime.test.cjs",
  "view/admin-ts/src/components/content/DiyPresaleEditor.vue",
  "view/admin-ts/src/components/content/DiyPresalePreview.vue",
  "view/admin-ts/src/components/content/DiyPresalePreviewCard.vue",
  "view/admin-ts/src/components/content/DiyPresalePreviewMoney.vue",
  "view/admin-ts/scripts/diy-presale-editor-runtime.test.cjs",
  "view/common/diyPresale.ts",
  "view/uniapp-ts/src/components/diy/DiyPresaleWidget.vue",
  "view/uniapp-ts/src/components/diy/DiyPresaleCard.vue",
  "view/uniapp-ts/src/components/diy/DiyPresaleMoney.vue",
  "view/uniapp-ts/src/composables/useDiyPresale.ts",
  "view/uniapp-ts/scripts/diy-presale-author-runtime.test.cjs",
  "workers-ts/test/diy-presale-author-media.test.ts"
] as const;

describe('exact presale author increment preserves all points and earlier evidence', () => {
  it('pins every old dated proof/helper, the complete points predecessor and exact reviewed scope', () => {
    for (const [file, expected] of Object.entries(frozen)) expect(sha(read(file))).toBe(expected);
    expect(proof.previous_report.sha256).toBe('1989a3acb92e8186572b1e3a05a52c32f392432ab5c37eaef7a3066ec71a28f1');
    expect(proof.previous_report.sha256).toBe(pointsAuthorSourceBinding.current_report.sha256);
    expect(sha(read(proof.previous_report.file))).toBe(proof.previous_report.sha256);
    expect(sourceFiles).toHaveLength(22);
    expect(new Set(sourceFiles).size).toBe(22);
    expect(sourceFiles).toContain('view/admin-ts/src/pages/content/DiseList.vue');
    expect(sourceFiles).toContain('view/uniapp-ts/src/components/diy/DiyHomeRenderer.vue');
    for (const file of [
      'view/uniapp-ts/src/utils/diyCommerceConfig.ts',
      'view/uniapp-ts/src/composables/useDiyCommerceWidget.ts',
      'view/uniapp-ts/src/components/diy/DiyCommerceWidget.vue',
      'view/uniapp-ts/src/api/diyCommerce.ts',
      'view/uniapp-ts/src/composables/usePresalePurchase.ts',
    ]) expect(sourceFiles).not.toContain(file);
    expect(reversePresaleAuthorSource('unrelated/file.ts', 'unchanged exact bytes')).toBe('unchanged exact bytes');
  });

  it.each(sourceFiles)('reconstructs the captured complete predecessor at %s', file => {
    const row = proof.sources.find(item => item.file === file)!;
    expect(sha(read(file))).toBe(row.after_sha256);
    const previous = reversePresaleAuthorSource(file, read(file));
    expect(sha(previous)).toBe(row.before_sha256);
    const predecessor = pointsAuthorSourceBinding.sources.find(item => item.file === file);
    if (predecessor) {
      expect(row.before_sha256).toBe(predecessor.after_sha256);
      expect(sha(reversePointsAuthorSource(file, previous))).toBe(predecessor.before_sha256);
    }
  });

  it.each(sourceFiles)('rejects source drift and moved inverse locations at %s', file => {
    expect(() => reversePresaleAuthorSource(file, read(file) + '\n// unreviewed drift\n')).toThrow();
    const binding = structuredClone(proof), row = binding.sources.find(item => item.file === file)!;
    row.edits[0]!.after_line++;
    expect(() => reversePresaleAuthorSource(file, read(file), binding)).toThrow();
  });

  it('pins unchanged legacy Commerce/canonical/helper bytes and exact prior media predecessors', () => {
    const rows = (proof as typeof proof & { observed_unchanged_sources: Array<{file:string;sha256:string}> }).observed_unchanged_sources;
    expect(rows).toHaveLength(9); expect(new Set(rows.map(row => row.file)).size).toBe(9);
    for (const row of rows) { expect(sha(read(row.file))).toBe(row.sha256); expect(sourceFiles).not.toContain(row.file); }
    for (const file of ['workers-ts/src/services/content/DiyEditorialMediaPolicy.ts','view/uniapp-ts/src/utils/diyEditorialMediaLease.ts']) {
      const current = proof.sources.find(row => row.file === file)!;
      expect(current.before_sha256).toBe(pointsAuthorSourceBinding.sources.find(row => row.file === file)!.after_sha256);
    }
    for (const file of ['view/uniapp-ts/scripts/diy-promotion-author-runtime.test.cjs','view/uniapp-ts/scripts/diy-coupon-author-runtime.test.cjs','view/uniapp-ts/scripts/diy-points-author-runtime.test.cjs']) expect(sourceFiles).toContain(file);
  });

  it('adapts only the Dice source hash and three call lines with all703/741 retained', () => {
    expect(applyPresaleAuthorReport(before)).toEqual(current);
    expect(buildAdminFrontendApiAuditReport()).toEqual(applyLiveBroadcastAuthorReport(applySeckillAuthorReport(applyBargainAuthorReport(applyCombinationAuthorReport(current)))));
    expect(sha(read(proof.current_report.file))).toBe(proof.current_report.sha256);
    expect(current.counts).toEqual(before.counts);
    expect(current.backend).toEqual(before.backend);
    expect(current.counts).toEqual({ callSites: 703, pathVariants: 741, registered: 741, executable: 741, controlledUnavailable: 0, unregistered: 0, unresolved: 0 });
    expect(proof.report_changes.map(row => [row.array, row.index])).toEqual([['frontendSources', 104], ['calls', 732], ['calls', 733], ['calls', 734]]);
    const shifts: number[] = [];
    for (const row of proof.report_changes) {
      const a = { ...row.before }, b = { ...row.after };
      if (row.array === 'calls') { const shift = Number(b.line) - Number(a.line); expect(Number.isInteger(shift) && shift > 0).toBe(true); shifts.push(shift); delete a.line; delete b.line; }
      else { expect(a.file).toBe('view/admin-ts/src/pages/content/DiseList.vue'); delete a.sha256; delete b.sha256; }
      expect(a).toEqual(b);
    }
    expect(new Set(shifts).size).toBe(1);
  });

  it.each(['counts', 'route', 'call', 'source', 'methodology'] as const)('rejects complete API predecessor %s drift', kind => {
    const changed = structuredClone(before);
    if (kind === 'counts') changed.counts.registered++;
    if (kind === 'route') changed.backend.registeredRoutes[0].handler = 'unreviewed';
    if (kind === 'call') changed.calls[0].line++;
    if (kind === 'source') changed.frontendSources[0].sha256 = '0'.repeat(64);
    if (kind === 'methodology') changed.methodology.scope = 'unreviewed';
    expect(() => applyPresaleAuthorReport(changed)).toThrow();
  });

  it.each(['counts', 'backend', 'before-row', 'after-row', 'before-hash', 'after-hash'] as const)('rejects API proof %s drift', kind => {
    const changed = structuredClone(proof);
    if (kind === 'counts') (changed.counts_unchanged as Record<string, number>).registered++;
    if (kind === 'backend') changed.backend_unchanged = false;
    if (kind === 'before-row') changed.report_changes[0]!.before.sha256 = '0'.repeat(64);
    if (kind === 'after-row') changed.report_changes[0]!.after.sha256 = '0'.repeat(64);
    if (kind === 'before-hash') changed.previous_report.sha256 = '0'.repeat(64);
    if (kind === 'after-hash') changed.current_report.sha256 = '0'.repeat(64);
    expect(() => applyPresaleAuthorReport(before, changed)).toThrow();
  });

  it.each(['duplicate-edit', 'before-hash', 'after-hash', 'edit-body', 'branch-bypass'] as const)('rejects exact source proof %s drift', kind => {
    const binding = structuredClone(proof), row = binding.sources.find(item => item.file === 'view/uniapp-ts/src/components/diy/DiyHomeRenderer.vue')!;
    let source = read(row.file);
    if (kind === 'duplicate-edit') source += row.edits[0]!.after_source;
    if (kind === 'before-hash') row.before_sha256 = '0'.repeat(64);
    if (kind === 'after-hash') row.after_sha256 = '0'.repeat(64);
    if (kind === 'edit-body') row.edits[0]!.after_source += '// unreviewed';
    if (kind === 'branch-bypass') source = source.replace('DiyPresaleWidget', 'UnreviewedPresaleWidget');
    expect(() => reversePresaleAuthorSource(row.file, source, binding)).toThrow();
  });
});

const parityRaw = read('workers-ts/audit/diy-presale-author-php-parity-20261025.json');
const parity = JSON.parse(parityRaw) as {
  PHP_ref: string;
  PHP_sources: Array<{ file: string; raw_sha256: string }>;
  PHP_behavior_evidence: Array<{ file: string; start_line: number; end_line: number; source: string }>;
  sources: Array<RouteSourceFollowup & { file: string }>;
  assets: unknown[];
  default_binding: { top_level_keys: number; compact_json_sha256: string; complete_literal: Record<string, unknown> };
  boundaries: Record<string, string>;
};

describe('presale complete additions and fixed-PHP active four layouts/shared money/style authority', () => {
  it('pins all original sources,48 complete defaults, three static mappings and public-vs-author boundaries', () => {
    expect(sha(parityRaw)).toBe('370a6fe9286dd9dc4e945599db11cf8df744404557abe7224542b5f93899838e');
    expect(parity.PHP_ref).toBe('8ed2a5b139f9170dd11b0dff91803f2fd59e40a5');
    expect(parity.PHP_sources.map(row => [row.file,row.raw_sha256])).toEqual([
  [
    "view/admin/src/components/mobilePage/home_presale.vue",
    "235cc05ffac1136e2424420943ad1206a2597d7c878f11f3916ed07c9c74ba13"
  ],
  [
    "view/admin/src/components/mobileConfig/c_presale.vue",
    "c55aedd046e1bd87f0c2b4bfa32c52832566f81695ea9029eaf84933226a389b"
  ],
  [
    "view/uniapp/pages/index/components/presale.vue",
    "7b03688702a51fbd51815528505cbf75317fd37a7283434241d14793f5410c5c"
  ],
  [
    "view/uniapp/api/activity.js",
    "a523651afff92535cc78663a98a25198a56be24ff22415e772507db2d637a22a"
  ],
  [
    "view/uniapp/static/css/unocss.css",
    "02476cc8672acc825838b249bc1b0e7265d8cfe7954cb59a4b78aa72e5cfd523"
  ],
  [
    "view/admin/src/components/mobileConfigRight/c_checkbox.vue",
    "f467b328a297570062d95e1081131b6fe7b32ebf921b7bbb52c297f8061e80a1"
  ],
  [
    "view/admin/src/components/mobileConfigRight/c_input_item.vue",
    "47766bb6db01faef2422cd73b5c64b04aca1cdd37507b7d3ad355ed8ace67255"
  ],
  [
    "view/admin/src/components/mobileConfigRight/c_slider.vue",
    "b27efc0259cdc0952d8edc3c70325acba33a70397f26de4496a0e73ca2d54701"
  ],
  [
    "view/admin/src/components/mobileConfigRight/c_fillet.vue",
    "f2e6bc9ca72b9d0e9083397fbd7e64b9a16f0aa29e61cdad17118c1df3874648"
  ],
  [
    "view/admin/src/components/mobileConfigRight/c_radio.vue",
    "be70b5c4259c58fa75795e907894b88cca34882c531ba790ea2fa20a74daa9ce"
  ],
  [
    "view/admin/src/components/mobileConfigRight/c_upload_img.vue",
    "03bdc1e9630cb32fffa9718cec43fe00da3e1a3c2709f5e3da49357a35947dd8"
  ],
  [
    "view/admin/src/components/mobileConfigRight/c_bg_color.vue",
    "09fce161866d26130fc6bc92c519241d7a98019085e6ad9d061a198f5a49cc07"
  ],
  [
    "view/admin/src/components/mobileConfigRight/c_set_up.vue",
    "550b37766d2dfed6f018627c76032aad3dd0b9f541aba5e89dc77f74400a6488"
  ],
  [
    "view/uniapp/main.js",
    "d2b8b6e6646d6e8ac1b281b8f9a5a33faa9ab3da2ef60d295c81422655170460"
  ],
  [
    "view/uniapp/components/BaseMoney.vue",
    "152d18c871850d7a98b1bd5fbb0b31167cc2653d9e71d4d8cfaa31ad070dcef9"
  ],
  [
    "view/uniapp/components/easy-loadimage/easy-loadimage.vue",
    "cfc1a5ab46e84016f805373e320df3391f380a62baa357b8c9069c7f446cfe3e"
  ],
  [
    "view/uniapp/static/css/base.css",
    "f6e00685a3ea2819530416f3778573768f8a00d25fcf288699d9feca7b3d3075"
  ],
  [
    "view/uniapp/App.vue",
    "c8ac053899436bc7ece40b5e72896256316e8074f4bfeead434f83283906be6e"
  ]
]);
    expect(parity.default_binding.top_level_keys).toBe(48);expect(Object.keys(parity.default_binding.complete_literal)).toHaveLength(48);
    expect(parity.default_binding.compact_json_sha256).toBe('df0ecc891e16518f6bd3c2a9326920606ebf91ddb362f71f533164a22b6647fb');
    expect(sha(JSON.stringify(parity.default_binding.complete_literal))).toBe(parity.default_binding.compact_json_sha256);
    const defaults=parity.default_binding.complete_literal as Record<string,Record<string,unknown>>;
    expect(defaults.imgBgConfig!.url).toBe('@PHP_API_ROOT@/statics/images/presaleBg.png');expect(defaults.imgConfig!.url).toBe('@/assets/images/presale02.png');expect(defaults.imgColorConfig!.url).toBe('@/assets/images/presale01.png');expect(defaults.checkboxInfo!.type).toEqual([0,1,2]);
    const mappings=(parity.default_binding as typeof parity.default_binding & {static_image_mappings:Array<{path:string[];TS_reference:string}>}).static_image_mappings;
    expect(mappings.map(row=>[row.path,row.TS_reference])).toEqual([[['imgBgConfig','url'],'/static/images/diy/presale-bg.png'],[['imgConfig','url'],'/static/images/diy/presale-title.png'],[['imgColorConfig','url'],'/static/images/diy/presale-title-alt.png']]);
    const evidence=(file:string,start:number)=>parity.PHP_behavior_evidence.find(row=>row.file.endsWith(file)&&row.start_line===start)!.source;
    const template=evidence('/presale.vue',1);
    for(const marker of ['goodStyleConfig == 0','goodStyleConfig == 1','goodStyleConfig == 2','goodStyleConfig == 3','width="240rpx"','height="324rpx"','height="212rpx"','width="224rpx"','presale.png','checkboxInfo.includes(0)','checkboxInfo.includes(2)','checkboxInfo.includes(3)','v-if="!showBtn"','symbolSize="26"','integerSize="40"','decimalSize="26"','preFix="预售:"','preFix="预售价"','¥{{item.ot_price}}'])expect(template).toContain(marker);
    const computed=evidence('/presale.vue',175);
    for(const marker of ['if (this.dataConfig.fillet.type)','if (this.dataConfig.filletImg.type)','valList[3]','this.dataConfig.headerBgColor.color[0].item','this.dataConfig.goodsName.tabVal ?',"this.dataConfig.presalePriceColor.color[0].item",'this.dataConfig.presaleConfig.tabVal','this.dataConfig.goodsBntColor.color[1].item'])expect(computed).toContain(marker);
    expect(computed).not.toContain('goodsBntTxtColor');
    const behavior=evidence('/presale.vue',327);for(const marker of ['this.$config.LIMIT','getAdvancellList({','time_type:0','res.data.list','item.id','type=6'])expect(behavior).toContain(marker);
    const request=evidence('/activity.js',302);expect(request).toContain('request.get("presale/list"');expect(request).toContain('noAuth: true');
    const money=evidence('/BaseMoney.vue',1);for(const marker of ['￥','Number(newValue).toFixed(this.digits)',"replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',')",'symbolSize','integerSize','decimalSize','font-weight: 500','preFix'])expect(money).toContain(marker);
    expect(evidence('/easy-loadimage.vue',1)).toContain('width: this.width');
    expect(evidence('/base.css',147)).toContain('box-sizing: border-box');
    expect(evidence('/App.vue',296)).toContain('box-sizing: border-box');
    expect(parity.PHP_behavior_evidence.some(row=>row.file.endsWith('/unocss.css')&&row.source.includes('grid-gap: 22rpx'))).toBe(true);
    expect(parity.boundaries.adminPreview).toContain('375');expect(parity.boundaries.adminPreview).toContain('cqw');expect(parity.boundaries.adminPreview).toContain('line-height:normal');expect(parity.boundaries.checkbox).toContain('IDs0/1/2');expect(parity.boundaries.checkbox).toContain('strict numeric0');expect(parity.boundaries.metadata).toContain('goodsBntTxtColor');expect(parity.boundaries.money).toContain('26/40/26');expect(parity.boundaries.layout).toContain('contentbottom0/1');expect(parity.boundaries.lease).toContain('pure signed-ticket renewal');expect(parity.boundaries.preview).toContain('PHP LIMIT absent');
    expect(parity.sources.map(row=>row.file)).toEqual(fullAddFiles);expect(parity.sources).toHaveLength(18);expect(parity.assets).toHaveLength(8);
  });

  it.each(fullAddFiles)('pins and exactly reverses complete new source %s',file=>{
    const row=parity.sources.find(item=>item.file===file)!;expect(row.before_sha256).toBe(sha(''));expect(row.edits).toHaveLength(1);expect(row.edits[0]!.before_source).toBe('');expect(sha(read(file))).toBe(row.after_sha256);expect(reverseRouteSourceFollowup(read(file),row)).toBe('');
  });
  it.each(fullAddFiles)('rejects current or recorded full-add drift at %s',file=>{
    const row=parity.sources.find(item=>item.file===file)!;expect(()=>reverseRouteSourceFollowup(read(file)+'\n//unreviewed\n',row)).toThrow();const changed=structuredClone(row);changed.edits[0]!.after_line=2;expect(()=>reverseRouteSourceFollowup(read(file),changed)).toThrow();
  });

  it.each([
    ['presale-bg.png','public/statics/images/presaleBg.png','13bf2d6bfc6ebbdfe2c7981b61fefa3db1755d8112094f9a0804ece7693d730e'],
    ['presale-title.png','view/admin/src/assets/images/presale02.png','bcdff400fba8ad7e1436a0874e6c319253c16e566c887ed227a2131ade0db7ac'],
    ['presale-title-alt.png','view/admin/src/assets/images/presale01.png','d5ef072254794e45c47d6335a09da76e8ea4057c17a87648a8f3de12d52f9237'],
    ['presale-flash.png','view/uniapp/static/img/presale.png','f03c40e6005d5c820f263c63133146796b19378a0694eba5a998ed3d0652a4c9'],
  ])('pins exact dual-platform original PNG%s without authorizing the decorative flash',(name,original,expected)=>{
    const rows=parity.assets as Array<{file:string;PHP_file:string;after_sha256:string;before_exists:boolean;bytes:number}>;const matches=rows.filter(row=>row.file.endsWith('/'+name));expect(matches).toHaveLength(2);
    for(const row of matches){expect(row.PHP_file).toBe(original);expect(row.after_sha256).toBe(expected);expect(row.before_exists).toBe(false);const data=readFileSync(resolve(root,row.file));expect(sha(data)).toBe(expected);expect(data.byteLength).toBe(row.bytes);}
    expect(parity.default_binding.complete_literal).not.toHaveProperty('flash');
  });
});
