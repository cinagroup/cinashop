import { beforeConfigClassReport } from './helpers/configClassSourceBinding';
import { reverseSearchHotwordsSource } from './helpers/searchHotwordsSourceBinding';
import { createHash } from 'node:crypto';
import { readAdminProfileThenErrorPagesThenBrowserLogThenConfigClassPredecessor as readFileSync } from './helpers/wechatAppAuthorSourceBinding';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAdminProfilePredecessorApiAuditReport as buildCurrentAdminFrontendApiAuditReport } from './helpers/wechatAppAuthorSourceBinding';
const buildAdminFrontendApiAuditReport=()=>beforeConfigClassReport(buildCurrentAdminFrontendApiAuditReport());
import { liveBroadcastAuthorSourceBinding as proof, reverseLiveBroadcastAuthorSource, applyLiveBroadcastAuthorReport } from './helpers/diyLiveBroadcastAuthorSourceBinding';
import { seckillAuthorSourceBinding, reverseSeckillAuthorSource } from './helpers/diySeckillAuthorSourceBinding';
import { reverseRouteSourceFollowup, type RouteSourceFollowup } from './helpers/routeSourceIncrement';
const root=resolve(import.meta.dirname,'../..'), read=(file:string)=>reverseSearchHotwordsSource(file,readFileSync(resolve(root,file),'utf8').replace(/\r\n?/gu,'\n')),sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
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
  "workers-ts/test/helpers/diyBargainAuthorSourceBinding.ts": "e5567d34b49e8dd25278ec6f3a3c94bcd4e123a34d8a11aa34feb09cc9a11e91",
  "workers-ts/audit/diy-seckill-author-source-binding-20261025.json": "d4597335e250a2ef408f13da19bbc9de0c20a7e3fc4f639feac29fb0552e7be8",
  "workers-ts/audit/diy-seckill-author-php-parity-20261025.json": "634203d09f520c35a49cec6e97a9e58281a5813734ba2dce0a53aee0aa0f3f1b",
  "workers-ts/test/helpers/diySeckillAuthorSourceBinding.ts": "ee33279a67dc3abd24ca5335d3568d81dcba0d80b95ce4ab8034cc48809b2818"
} as const;
const fullAddFiles=[
  "view/admin-ts/src/utils/diyLiveBroadcastDefaults.ts",
  "view/admin-ts/src/utils/diyLiveBroadcastEditor.ts",
  "view/admin-ts/src/utils/diyLiveBroadcastProjection.ts",
  "view/admin-ts/src/api/diyLiveBroadcastAuthor.ts",
  "view/admin-ts/src/components/content/DiyLiveBroadcastEditor.vue",
  "view/admin-ts/src/components/content/DiyLiveBroadcastPreview.vue",
  "view/admin-ts/src/components/content/DiyLiveBroadcastPreviewCard.vue",
  "view/common/diyLiveBroadcastData.ts",
  "view/common/diyLiveBroadcast.ts",
  "view/common/diyLiveBroadcastIcon.css",
  "view/uniapp-ts/src/api/diyLiveBroadcastAuthor.ts",
  "view/uniapp-ts/src/composables/useDiyLiveBroadcast.ts",
  "view/uniapp-ts/src/components/diy/DiyLiveBroadcastWidget.vue",
  "view/uniapp-ts/src/components/diy/DiyLiveBroadcastCard.vue",
  "view/admin-ts/scripts/diy-live-broadcast-editor-model-runtime.test.cjs",
  "view/admin-ts/scripts/diy-live-broadcast-author-data-runtime.test.cjs",
  "view/admin-ts/scripts/diy-live-broadcast-editor-runtime.test.cjs",
  "view/uniapp-ts/scripts/diy-live-broadcast-author-runtime.test.cjs",
  "workers-ts/test/diy-live-broadcast-author-catalog.test.ts"
] as const;
const parityRaw=read('workers-ts/audit/diy-live-broadcast-author-php-parity-20261025.json');
const parity=JSON.parse(parityRaw) as {PHP_ref:string;PHP_sources:Array<{file:string;raw_sha256:string;lines:number}>;PHP_behavior_evidence:Array<{file:string;start_line:number;end_line:number;source:string;slice_sha256:string}>;sources:Array<RouteSourceFollowup & {file:string}>;assets:Array<{file:string;after_sha256:string;width:number;height:number;before_exists:boolean}>;default_binding:{top_level_keys:number;compact_json_sha256:string;complete_literal:Record<string,unknown>;static_image_mappings:Array<{path:string[];TS_reference:string}>};boundaries:Record<string,string>};
describe('exact live-broadcast increment preserves accepted seckill and all prior evidence',()=>{
 it('pins all36 immutable dated proofs/helpers and the full accepted seckill report',()=>{
  for(const[file,h]of Object.entries(frozen))expect(sha(read(file))).toBe(h);
  expect(proof.previous_report.sha256).toBe('cc24230caab91c9a80c8ee4eba659767f28b7f1533d6bf1e3a42976abfdec16b');
  expect(proof.previous_report.sha256).toBe(seckillAuthorSourceBinding.current_report.sha256);
  expect(sha(read(proof.previous_report.file))).toBe(proof.previous_report.sha256);
  expect(proof.sources).toHaveLength(28);expect(new Set(proof.sources.map(r=>r.file)).size).toBe(28);
  expect(reverseLiveBroadcastAuthorSource('unrelated.ts','untouched')).toBe('untouched');
 });
 it.each(proof.sources)('reconstructs the captured complete predecessor for $file',row=>{
  expect(sha(read(row.file))).toBe(row.after_sha256);const old=reverseLiveBroadcastAuthorSource(row.file,read(row.file));expect(sha(old)).toBe(row.before_sha256);
  const prior=seckillAuthorSourceBinding.sources.find(r=>r.file===row.file);
  if(prior){expect(row.before_sha256).toBe(prior.after_sha256);expect(sha(reverseSeckillAuthorSource(row.file,old))).toBe(prior.before_sha256);}
 });
 it.each(proof.sources)('rejects raw drift and moved inverse at $file',row=>{
  expect(()=>reverseLiveBroadcastAuthorSource(row.file,read(row.file)+'\n// drift\n')).toThrow();
  const changed=structuredClone(proof);changed.sources.find(r=>r.file===row.file)!.edits[0]!.after_line++;
  expect(()=>reverseLiveBroadcastAuthorSource(row.file,read(row.file),changed)).toThrow();
 });
 it('retains73 captured legacy/helper/presale modules byte for byte',()=>{
  const rows=(proof as typeof proof&{observed_unchanged_sources:Array<{file:string;sha256:string}>}).observed_unchanged_sources;expect(rows).toHaveLength(73);
  for(const row of rows){expect(sha(read(row.file))).toBe(row.sha256);expect(proof.sources.some(r=>r.file===row.file)).toBe(false);}
 });
 it('changes only one source hash and three line offsets with703/741 fully covered',()=>{
  expect(applyLiveBroadcastAuthorReport(before)).toEqual(current);expect(buildAdminFrontendApiAuditReport()).toEqual(current);
  expect(sha(read(proof.current_report.file))).toBe(proof.current_report.sha256);
  expect(current.counts).toEqual({callSites:703,pathVariants:741,registered:741,executable:741,controlledUnavailable:0,unregistered:0,unresolved:0});expect(current.backend).toEqual(before.backend);
  expect(proof.report_changes.map(r=>[r.array,r.index])).toEqual([['frontendSources',104],['calls',732],['calls',733],['calls',734]]);
  for(const row of proof.report_changes){const a={...row.before},b={...row.after};if(row.array==='calls'){expect(Number(b.line)-Number(a.line)).toBe(2);delete a.line;delete b.line;}else{delete a.sha256;delete b.sha256;}expect(a).toEqual(b);}
 });
 it.each(['counts','route','call','source','methodology'] as const)('rejects complete predecessor %s drift',kind=>{
  const changed=structuredClone(before);if(kind==='counts')changed.counts.registered++;if(kind==='route')changed.backend.registeredRoutes[0].handler='drift';if(kind==='call')changed.calls[0].line++;if(kind==='source')changed.frontendSources[0].sha256='0'.repeat(64);if(kind==='methodology')changed.methodology.scope='drift';expect(()=>applyLiveBroadcastAuthorReport(changed)).toThrow();
 });
 it.each(['counts','backend','before-row','after-row','before-hash','after-hash'] as const)('rejects report proof %s drift',kind=>{
  const changed=structuredClone(proof);if(kind==='counts')(changed.counts_unchanged as Record<string,number>).registered++;if(kind==='backend')changed.backend_unchanged=false;if(kind==='before-row')changed.report_changes[0]!.before.sha256='0'.repeat(64);if(kind==='after-row')changed.report_changes[0]!.after.sha256='0'.repeat(64);if(kind==='before-hash')changed.previous_report.sha256='0'.repeat(64);if(kind==='after-hash')changed.current_report.sha256='0'.repeat(64);expect(()=>applyLiveBroadcastAuthorReport(before,changed)).toThrow();
 });
 it.each(['duplicate','before-hash','after-hash','body','branch'] as const)('rejects source proof %s drift',kind=>{
  const changed=structuredClone(proof),row=changed.sources.find(r=>r.file.endsWith('DiyHomeRenderer.vue'))!;let source=read(row.file);if(kind==='duplicate')source+=row.edits[0]!.after_source;if(kind==='before-hash')row.before_sha256='0'.repeat(64);if(kind==='after-hash')row.after_sha256='0'.repeat(64);if(kind==='body')row.edits[0]!.after_source+='drift';if(kind==='branch')source=source.replace('DiyLiveBroadcastWidget','UnreviewedLiveBroadcastWidget');expect(()=>reverseLiveBroadcastAuthorSource(row.file,source,changed)).toThrow();
 });
});
describe('fixed PHP liveBroadcast complete default and explicit current TS contracts',()=>{
 it('pins the independent parity document and original actual public source',()=>{
  expect(sha(parityRaw)).toBe('d63d5377d339cfc1f1c3108f43d13f6cc2aa751c8946e70bbf901fd9363c35a1');expect(parity.PHP_ref).toBe('8ed2a5b139f9170dd11b0dff91803f2fd59e40a5');
  expect(parity.PHP_sources.slice(0,3).map(r=>[r.file,r.raw_sha256])).toEqual([["view/admin/src/components/mobilePage/wechat_live.vue", "7f4d8ac20845382d89a6fd8d396372032d08198bb23732e90579b27716647927"], ["view/admin/src/components/mobileConfig/c_wechat_live.vue", "3039293d89a96f687fcfdb863512c96980a9e8d49f2218ca6e38a426a0be4b0e"], ["view/uniapp/pages/index/components/liveBroadcast.vue", "142150c246dea5b1a2b14445a8b7cceaff4f6089d8f72c492baa9a56706120c2"]]);
  for(const row of parity.PHP_behavior_evidence){const source=parity.PHP_sources.find(r=>r.file===row.file)!;expect(source).toBeTruthy();expect(row.start_line).toBeGreaterThan(0);expect(row.end_line).toBeLessThanOrEqual(source.lines);expect(sha(row.source)).toBe(row.slice_sha256);expect(row.source.split('\n').length-(row.source.endsWith('\n')?1:0)).toBe(row.end_line-row.start_line+1);}
  expect(parity.PHP_behavior_evidence.some(r=>r.source.includes('room_id'))).toBe(true);expect(parity.PHP_behavior_evidence.some(r=>r.source.includes('goodsItem.price'))).toBe(true);expect(parity.PHP_behavior_evidence.some(r=>r.source.includes('filletImg'))).toBe(true);
 });
 it('retains the full21 literal with timestamp0 only, without authored image substitution',()=>{
  const literal=parity.default_binding.complete_literal;expect(parity.default_binding.top_level_keys).toBe(21);expect(Object.keys(literal)).toHaveLength(21);expect(sha(JSON.stringify(literal))).toBe('6664a484f43f723e3901d5b2439ecddb883d2fcb28d2f439ebf1fe27b0d6d829');
  const raw=read('view/admin-ts/src/utils/diyLiveBroadcastDefaults.ts'),actual=JSON.parse(raw.slice(raw.indexOf('= {')+2,raw.lastIndexOf(';')).trim());expect(actual).toEqual(literal);expect(actual.checkboxInfo.type).toEqual([0,1]);expect(actual.numberConfig.val).toBe(3);expect(actual.timestamp).toBe(0);expect(parity.default_binding.static_image_mappings).toEqual([]);expect(parity.assets).toEqual([]);
 });
 it('pins19 full additions and rejects missing or nonempty predecessors',()=>{expect(parity.sources.map(r=>r.file)).toEqual(fullAddFiles);for(const row of parity.sources){expect(sha(read(row.file))).toBe(row.after_sha256);expect(reverseRouteSourceFollowup(read(row.file),row)).toBe('');}});
 it.each(fullAddFiles)('rejects added-source drift at %s',file=>{const row=parity.sources.find(r=>r.file===file)!;expect(()=>reverseRouteSourceFollowup(read(file)+'\n// drift',row)).toThrow();});
 it('uses one explicit guest read and no author-media, login, SDK, subscription or write producer',()=>{
  const hook=read('view/uniapp-ts/src/composables/useDiyLiveBroadcast.ts'),api=read('view/uniapp-ts/src/api/diyLiveBroadcastAuthor.ts'),admin=read('view/admin-ts/src/api/diyLiveBroadcastAuthor.ts'),editor=read('view/admin-ts/src/components/content/DiyLiveBroadcastEditor.vue');
  expect(hook).toContain('apiDiyLiveBroadcastRooms(limit)');expect(hook).toContain('miniProgram && active()');expect(hook).toContain('rooms.value.includes(room)');expect(hook).toContain('nativeEpoch.value === epoch');expect(hook).toContain('liveBroadcastPluginDestination(room.room_id, uid)');expect(api).toContain('{ noAuth: true }');expect(admin).toContain("credentials: 'omit'");
  for(const source of[hook,api,admin])for(const forbidden of['requestSubscribeMessage','/pages/auth/login','post(','diyMediaLease','apiDiyPublished'])expect(source).not.toContain(forbidden);
  expect(editor).not.toContain('MediaPicker');expect(editor).not.toContain('canonical');expect(editor).toContain('receipt.source === previous');expect(editor).toContain('receipt.issued.context === contextEpoch.value');expect(editor).toContain('pending?.serial === serial');
 });
 it('binds immutable native descriptors and documents all deliberate differences',()=>{
  const card=read('view/uniapp-ts/src/components/diy/DiyLiveBroadcastCard.vue'),widget=read('view/uniapp-ts/src/components/diy/DiyLiveBroadcastWidget.vue'),hook=read('view/uniapp-ts/src/composables/useDiyLiveBroadcast.ts');
  expect(card).toContain('v-for="cover in [media.cover]"');expect(card).toContain('@load="cover.loaded"');expect(card).toContain('@error="cover.failed"');expect(card).toContain('¥{{good.price}}');expect(card).not.toContain('+5');expect(widget).toContain(':key="entry.key"');expect(widget).toContain('v-for="action in [actions]"');expect(hook).toContain('key: `${nativeEpoch.value}:${room.id}:${room.room_id}`');
  expect(parity.boundaries.differences).toContain('unconditional+5');expect(parity.boundaries.differences).toContain('cross-read');expect(parity.boundaries.navigation).toContain('unregistered');expect(parity.boundaries.catalog).toContain('Raw business URLs');
 });
});
