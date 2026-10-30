import { beforeConfigClassReport } from './helpers/configClassSourceBinding';
import { reverseSearchHotwordsSource } from './helpers/searchHotwordsSourceBinding';
import { reverseLiveBroadcastAuthorSource, applyLiveBroadcastAuthorReport, liveBroadcastAuthorSourceBinding } from './helpers/diyLiveBroadcastAuthorSourceBinding';
import { createHash } from 'node:crypto';
import { readAdminProfileThenErrorPagesThenBrowserLogThenConfigClassPredecessor as readFileSync } from './helpers/wechatAppAuthorSourceBinding';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAdminProfilePredecessorApiAuditReport as buildCurrentAdminFrontendApiAuditReport } from './helpers/wechatAppAuthorSourceBinding';
const buildAdminFrontendApiAuditReport=()=>beforeConfigClassReport(buildCurrentAdminFrontendApiAuditReport());
import { seckillAuthorSourceBinding as proof, reverseSeckillAuthorSource, applySeckillAuthorReport } from './helpers/diySeckillAuthorSourceBinding';
import { bargainAuthorSourceBinding, reverseBargainAuthorSource } from './helpers/diyBargainAuthorSourceBinding';
import { reverseRouteSourceFollowup, type RouteSourceFollowup } from './helpers/routeSourceIncrement';
const root=resolve(import.meta.dirname,'../..'), read=(file:string)=>reverseLiveBroadcastAuthorSource(file,reverseSearchHotwordsSource(file,readFileSync(resolve(root,file===proof.current_report.file?liveBroadcastAuthorSourceBinding.previous_report.file:file),'utf8').replace(/\r\n?/gu,'\n'))),sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
const before=JSON.parse(read(proof.previous_report.file)),current=JSON.parse(read(proof.current_report.file));
const frozen={
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
  "workers-ts/test/helpers/diyPointsAuthorSourceBinding.ts": "b4ec2a56e6f1792288334528ee215fa253c95deff96fb8f2822c669b6c27ada6",
  "workers-ts/audit/diy-presale-author-source-binding-20261025.json": "751fb7a9e1a2805e977d328d673f430f916984b19abd2bd7a24fd237dc6b0628",
  "workers-ts/audit/diy-presale-author-php-parity-20261025.json": "370a6fe9286dd9dc4e945599db11cf8df744404557abe7224542b5f93899838e",
  "workers-ts/test/helpers/diyPresaleAuthorSourceBinding.ts": "978133e39d8c4c0663e26eb9940e7d8781715cf6b5f55a38fc09364d6422194d",
  "workers-ts/audit/diy-combination-author-source-binding-20261025.json": "2c65f2efaf3cc9d605209e151615d6c7930c918992ac6f4e77ec9887ab0798e9",
  "workers-ts/audit/diy-combination-author-php-parity-20261025.json": "10bfa7317c987f875320d656b7da70d5f06774a5efaf76834dd0277c4c2bce45",
  "workers-ts/test/helpers/diyCombinationAuthorSourceBinding.ts": "f55080804c633c5153e572a54197561968c112416276e99dd11f6923c5507954",
  "workers-ts/audit/diy-bargain-author-source-binding-20261025.json": "cfb6680900e15dca0c247ef6e82a44066c0df608ffb6c5154ee3c62cc974d20b",
  "workers-ts/audit/diy-bargain-author-php-parity-20261025.json": "b8ac7c3ce27fbfb80ec2248144509a399c4dca47267357e48cb1332c321484d5",
  "workers-ts/test/helpers/diyBargainAuthorSourceBinding.ts": "e5567d34b49e8dd25278ec6f3a3c94bcd4e123a34d8a11aa34feb09cc9a11e91"
} as const;
const fullAddFiles=[
  "view/admin-ts/src/utils/diySeckillDefaults.ts",
  "view/admin-ts/src/utils/diySeckillEditor.ts",
  "view/admin-ts/src/utils/diySeckillProjection.ts",
  "view/admin-ts/src/api/diySeckillAuthor.ts",
  "view/admin-ts/scripts/diy-seckill-editor-model-runtime.test.cjs",
  "view/admin-ts/scripts/diy-seckill-author-data-runtime.test.cjs",
  "view/admin-ts/src/components/content/DiySeckillEditor.vue",
  "view/admin-ts/src/components/content/DiySeckillPreview.vue",
  "view/admin-ts/src/components/content/DiySeckillPreviewCard.vue",
  "view/admin-ts/src/components/content/DiySeckillPreviewMoney.vue",
  "view/admin-ts/scripts/diy-seckill-editor-runtime.test.cjs",
  "view/common/diySeckill.ts",
  "view/uniapp-ts/src/components/diy/DiySeckillWidget.vue",
  "view/uniapp-ts/src/components/diy/DiySeckillCard.vue",
  "view/uniapp-ts/src/components/diy/DiySeckillMoney.vue",
  "view/uniapp-ts/src/composables/useDiySeckill.ts",
  "view/uniapp-ts/scripts/diy-seckill-author-runtime.test.cjs",
  "workers-ts/test/diy-seckill-author-media.test.ts",
  "workers-ts/test/diy-seckill-author-catalog.test.ts",
  "view/common/diySeckillData.ts",
  "view/uniapp-ts/src/api/diySeckillAuthor.ts"
] as const;
const parityRaw=read('workers-ts/audit/diy-seckill-author-php-parity-20261025.json');
const parity=JSON.parse(parityRaw) as {PHP_ref:string;PHP_sources:Array<{file:string;raw_sha256:string;lines:number}>;PHP_behavior_evidence:Array<{file:string;start_line:number;end_line:number;source:string;slice_sha256:string}>;sources:Array<RouteSourceFollowup & {file:string}>;assets:Array<{file:string;after_sha256:string;width:number;height:number;before_exists:boolean}>;default_binding:{top_level_keys:number;compact_json_sha256:string;complete_literal:Record<string,unknown>;static_image_mappings:Array<{path:string[];TS_reference:string}>};boundaries:Record<string,string>};
describe('exact seckill increment preserves accepted bargain and all prior evidence',()=>{
 it('pins all33 immutable dated proofs/helpers and the full accepted bargain report',()=>{
  for(const[file,h]of Object.entries(frozen))expect(sha(read(file))).toBe(h);
  expect(proof.previous_report.sha256).toBe('f95be9b56d2d826f86778aca2f53e0841d2eb50c4ae0455d2fb82dd7b4c3f199');
  expect(proof.previous_report.sha256).toBe(bargainAuthorSourceBinding.current_report.sha256);
  expect(sha(read(proof.previous_report.file))).toBe(proof.previous_report.sha256);
  expect(proof.sources).toHaveLength(33);expect(new Set(proof.sources.map(r=>r.file)).size).toBe(33);
  expect(reverseSeckillAuthorSource('unrelated.ts','untouched')).toBe('untouched');
 });
 it.each(proof.sources)('reconstructs the captured complete predecessor for $file',row=>{
  expect(sha(read(row.file))).toBe(row.after_sha256);const old=reverseSeckillAuthorSource(row.file,read(row.file));expect(sha(old)).toBe(row.before_sha256);
  const prior=bargainAuthorSourceBinding.sources.find(r=>r.file===row.file);
  if(prior){expect(row.before_sha256).toBe(prior.after_sha256);expect(sha(reverseBargainAuthorSource(row.file,old))).toBe(prior.before_sha256);}
 });
 it.each(proof.sources)('rejects raw drift and moved inverse at $file',row=>{
  expect(()=>reverseSeckillAuthorSource(row.file,read(row.file)+'\n// drift\n')).toThrow();
  const changed=structuredClone(proof);changed.sources.find(r=>r.file===row.file)!.edits[0]!.after_line++;
  expect(()=>reverseSeckillAuthorSource(row.file,read(row.file),changed)).toThrow();
 });
 it('retains43 captured legacy/helper/presale modules byte for byte',()=>{
  const rows=(proof as typeof proof&{observed_unchanged_sources:Array<{file:string;sha256:string}>}).observed_unchanged_sources;expect(rows).toHaveLength(43);
  for(const row of rows){expect(sha(read(row.file))).toBe(row.sha256);expect(proof.sources.some(r=>r.file===row.file)).toBe(false);}
 });
 it('changes only one source hash and three line offsets with703/741 fully covered',()=>{
  expect(applySeckillAuthorReport(before)).toEqual(current);expect(buildAdminFrontendApiAuditReport()).toEqual(applyLiveBroadcastAuthorReport(current));
  expect(sha(read(proof.current_report.file))).toBe(proof.current_report.sha256);
  expect(current.counts).toEqual({callSites:703,pathVariants:741,registered:741,executable:741,controlledUnavailable:0,unregistered:0,unresolved:0});expect(current.backend).toEqual(before.backend);
  expect(proof.report_changes.map(r=>[r.array,r.index])).toEqual([['frontendSources',104],['calls',732],['calls',733],['calls',734]]);
  for(const row of proof.report_changes){const a={...row.before},b={...row.after};if(row.array==='calls'){expect(Number(b.line)-Number(a.line)).toBe(3);delete a.line;delete b.line;}else{delete a.sha256;delete b.sha256;}expect(a).toEqual(b);}
 });
 it.each(['counts','route','call','source','methodology'] as const)('rejects complete predecessor %s drift',kind=>{
  const changed=structuredClone(before);if(kind==='counts')changed.counts.registered++;if(kind==='route')changed.backend.registeredRoutes[0].handler='drift';if(kind==='call')changed.calls[0].line++;if(kind==='source')changed.frontendSources[0].sha256='0'.repeat(64);if(kind==='methodology')changed.methodology.scope='drift';expect(()=>applySeckillAuthorReport(changed)).toThrow();
 });
 it.each(['counts','backend','before-row','after-row','before-hash','after-hash'] as const)('rejects report proof %s drift',kind=>{
  const changed=structuredClone(proof);if(kind==='counts')(changed.counts_unchanged as Record<string,number>).registered++;if(kind==='backend')changed.backend_unchanged=false;if(kind==='before-row')changed.report_changes[0]!.before.sha256='0'.repeat(64);if(kind==='after-row')changed.report_changes[0]!.after.sha256='0'.repeat(64);if(kind==='before-hash')changed.previous_report.sha256='0'.repeat(64);if(kind==='after-hash')changed.current_report.sha256='0'.repeat(64);expect(()=>applySeckillAuthorReport(before,changed)).toThrow();
 });
 it.each(['duplicate','before-hash','after-hash','body','branch'] as const)('rejects source proof %s drift',kind=>{
  const changed=structuredClone(proof),row=changed.sources.find(r=>r.file.endsWith('DiyHomeRenderer.vue'))!;let source=read(row.file);if(kind==='duplicate')source+=row.edits[0]!.after_source;if(kind==='before-hash')row.before_sha256='0'.repeat(64);if(kind==='after-hash')row.after_sha256='0'.repeat(64);if(kind==='body')row.edits[0]!.after_source+='drift';if(kind==='branch')source=source.replace('DiySeckillWidget','UnreviewedSeckillWidget');expect(()=>reverseSeckillAuthorSource(row.file,source,changed)).toThrow();
 });
});
describe('fixed PHP seckill complete default and actual public authority',()=>{
 it('pins the independent parity document and complete PHP source family',()=>{
  expect(sha(parityRaw)).toBe('634203d09f520c35a49cec6e97a9e58281a5813734ba2dce0a53aee0aa0f3f1b');expect(parity.PHP_ref).toBe('8ed2a5b139f9170dd11b0dff91803f2fd59e40a5');
  expect(parity.PHP_sources.slice(0,3).map(r=>[r.file,r.raw_sha256])).toEqual([["view/admin/src/components/mobilePage/home_seckill.vue", "0257cf8fe9919e1554be25826d06d87d4d91706b80be45401c84998ee5beffa8"], ["view/admin/src/components/mobileConfig/c_home_seckill.vue", "0e2cd44807494ee09f6ef02803016636840509e1372a80fd0cfbabc870543426"], ["view/uniapp/pages/index/components/seckill.vue", "0c8fac4a1cb339a5298f37b8f3bf57426536b9702f785552010fc2055a781576"]]);
  for(const row of parity.PHP_behavior_evidence){const source=parity.PHP_sources.find(r=>r.file===row.file)!;expect(source).toBeTruthy();expect(row.start_line).toBeGreaterThan(0);expect(row.end_line).toBeLessThanOrEqual(source.lines);expect(sha(row.source)).toBe(row.slice_sha256);expect(row.source.split('\n').length-(row.source.endsWith('\n')?1:0)).toBe(row.end_line-row.start_line+1);}
  expect(parity.PHP_behavior_evidence.some(r=>r.source.includes('getSeckillIndexTime'))).toBe(true);expect(parity.PHP_behavior_evidence.some(r=>r.source.includes('107px'))).toBe(true);expect(parity.PHP_behavior_evidence.some(r=>r.source.includes('activity_image'))).toBe(true);
 });
 it('preserves complete53 defaults with only three explicit static image substitutions',()=>{
  const literal=parity.default_binding.complete_literal;expect(parity.default_binding.top_level_keys).toBe(53);expect(Object.keys(literal)).toHaveLength(53);expect(sha(JSON.stringify(literal))).toBe('1585380fd914c59c16da9de5ad7c978006dfaaead80ff6013b01ff6ccf0daa20');
  const raw=read('view/admin-ts/src/utils/diySeckillDefaults.ts'),actual=JSON.parse(raw.slice(raw.indexOf('= {')+2,raw.lastIndexOf(';')).trim()),expected=structuredClone(literal);for(const row of parity.default_binding.static_image_mappings)(expected[row.path[0]!] as Record<string,unknown>)[row.path[1]!]=row.TS_reference;expect(actual).toEqual(expected);expect(actual.checkboxInfo.type).toEqual([0,1,2,3]);expect(actual.numberConfig.val).toBe(3);
 });
 it('pins21 full additions and rejects missing or nonempty predecessors',()=>{expect(parity.sources.map(r=>r.file)).toEqual(fullAddFiles);for(const row of parity.sources){expect(sha(read(row.file))).toBe(row.after_sha256);expect(reverseRouteSourceFollowup(read(row.file),row)).toBe('');}});
 it.each(fullAddFiles)('rejects added-source drift at %s',file=>{const row=parity.sources.find(r=>r.file===file)!;expect(()=>reverseRouteSourceFollowup(read(file)+'\n// drift',row)).toThrow();});
 it('pins ten original PNG copies including fixed decorations without granting author slots',()=>{
  expect(parity.assets).toHaveLength(10);for(const row of parity.assets){expect(sha(readFileSync(resolve(root,row.file)))).toBe(row.after_sha256);expect(row.before_exists).toBe(false);const kind=row.file.split('/').pop();expect(row.width).toBe(kind==='seckill-bg.png'?710:kind==='seckill-lightning.png'?34:kind==='seckill-shandian.png'?24:154);expect(row.height).toBe(kind==='seckill-bg.png'?96:kind==='seckill-lightning.png'?34:kind==='seckill-shandian.png'?44:32);}
 });
 it('keeps independent anonymous two-read APIs without SDK login or purchase producers',()=>{
  const hook=read('view/uniapp-ts/src/composables/useDiySeckill.ts'),api=read('view/uniapp-ts/src/api/diySeckillAuthor.ts'),admin=read('view/admin-ts/src/api/diySeckillAuthor.ts');
  expect(hook).toContain('apiDiySeckillIndex()');expect(hook).toContain('apiDiySeckillProducts(slot.id,count)');expect(hook).toContain('if(!current(n,actor,intent))return;');expect(hook).toContain('state.cards.value.includes(product)');expect(hook).toContain('/pages/activity/seckillDetail?id=${id}');expect(hook).not.toContain('requestSubscribeMessage');expect(hook).not.toContain('/pages/auth/login');expect(hook).not.toContain('useDiyCommerceWidget');expect(api).toContain('{noAuth:true}');expect(api).not.toContain('post(');expect(admin).toContain("credentials:'omit'");expect(admin).toContain("publicData('/api/seckill/index',signal)");expect(admin).toContain('type=index');expect(admin).not.toContain('useAuthStore');
 });
 it('pins source-specific progress pricebar countdown and complete business image callback guards',()=>{
  const card=read('view/uniapp-ts/src/components/diy/DiySeckillCard.vue'),widget=read('view/uniapp-ts/src/components/diy/DiySeckillWidget.vue'),projection=read('view/common/diySeckill.ts'),hook=read('view/uniapp-ts/src/composables/useDiySeckill.ts');
  expect(card).toContain('view.layout===0');expect(card).toContain('class="seckill-progress"');expect(card).toContain('class="seckill-price-bar"');expect(card).toContain('seckillLightningLeft(product.percent)');expect(card).toContain('v-for="overlayImage in [media.overlay]"');expect(card).toContain(':key="overlayImage.key"');expect(card).toContain('@load="overlayImage.loaded"');expect(card).toContain('@error="overlayImage.failed"');expect(card).toContain('v-for="baseImage in [media.base]"');expect(card).toContain('@error="baseImage.failed"');expect(widget).toContain('v-for="action in [actions]"');expect(widget).toContain('@tap="action.more"');expect(widget).toContain('@tap="action.refresh"');expect(widget).toContain(':key="entry.media.base.key"');expect(card).not.toContain('showTag');expect(projection).toContain("percent===100?'107px'");expect(projection).toContain('borderRadius: radius(imgCorners)');expect(projection).toContain('color:numberBackground');expect(widget).toContain('state.countdown.value');expect(widget).not.toContain('selectSeckill');expect(hook).toContain('businessLoaded.value[baseKey]');expect(hook).toContain('const valid=()=>current()');expect(hook).not.toContain('/wechat/teml_ids');expect(parity.boundaries.navigation).toContain('time_id');expect(parity.boundaries.navigation).toContain('rechecks fresh schedule');
 });
 it('limits DAO source changes to the exact public list method and retains all purchase methods',()=>{
  const file='workers-ts/src/dao/activity/ActivityDaos.ts',current=read(file),old=reverseSeckillAuthorSource(file,current),start='  /** Apply the full parent/child/slot policy before stable legacy pagination. */',end='  /** 取单个秒杀活动 */',a=current.indexOf(start),b=current.indexOf(end,a),x=old.indexOf(start),y=old.indexOf(end,x);expect(a).toBeGreaterThan(0);expect(b).toBeGreaterThan(a);expect(x).toBeGreaterThan(0);expect(y).toBeGreaterThan(x);expect(current.slice(0,a)).toBe(old.slice(0,x));expect(current.slice(b)).toBe(old.slice(y));const method=current.slice(a,b);expect(method).toContain('getTableColumns(storeSeckill)');expect(method).toContain('.innerJoin(storeProduct');expect(method).toContain('eq(storeProduct.isDel, 0)');expect(method).toContain('seckillCatalogSchedulePredicate(timeId, now)');expect(method).not.toContain('storeProduct.isShow');expect(method).not.toContain('storeProduct.isVerify');
 });
 it('limits service changes to safe parent-image projection in seckillList alone',()=>{
  const file='workers-ts/src/services/activity/ActivityService.ts',current=read(file),old=reverseSeckillAuthorSource(file,current),start='  /** 按时间段取秒杀商品 */',end='  /** 秒杀详情 */',a=current.indexOf(start),b=current.indexOf(end,a),x=old.indexOf(start),y=old.indexOf(end,x);expect(a).toBeGreaterThan(0);expect(b).toBeGreaterThan(a);expect(x).toBeGreaterThan(0);expect(y).toBeGreaterThan(x);expect(current.slice(0,a)).toBe(old.slice(0,x));expect(current.slice(b)).toBe(old.slice(y));expect(current.slice(a,b)).toContain('publicSeckillTimePictures');expect(current.slice(a,b)).toContain('renderSeckillTimePictures');expect(current.slice(a,b)).toContain('activity_image:');expect(current.slice(a,b)).not.toContain('fetch(');
 });
});
