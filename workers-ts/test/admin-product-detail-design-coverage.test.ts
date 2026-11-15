import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PRODUCT_DETAIL_DESIGN_COVERAGE_GATES, classifyProductDetailDesignCoverage,
  hasProductDetailDesignContract, inspectProductDetailDesignCoverage, productDetailDesignSourceFiles,
  type ProductDetailDesignGate,
} from '../scripts/product-detail-design-coverage';

const screens = ['/setting/product-detail-design'];
const sources = Object.fromEntries(Object.entries(productDetailDesignSourceFiles()).map(([role, file]) => [role, existsSync(resolve('..',file)) ? readFileSync(resolve('..', file), 'utf8') : '']));
const baseline = inspectProductDetailDesignCoverage(screens, sources);
function mutation(role: string, before: string, after: string) {
  expect(sources[role]?.includes(before), `${role}: actual mutation target`).toBe(true);
  return { ...sources, [role]: sources[role]!.split(before).join(after) };
}
type Mutant = [string, string, string, string, ProductDetailDesignGate];
const mutants: Mutant[] = [
  ["navigation actual layout permission prop", "sidebar", ":can-menu=\"canMenu\"", ":can-menu=\"() => true\"", "permissions1594"],
  ["navigation actual per-item permission filter", "adminNavigation", "section.items.filter(item => canMenu(item.permissionPath))", "section.items", "permissions1594"],
  ["navigation actual menu route", "adminNavigation", "\"path\": \"/setting/product-detail-design\"", "\"path\": \"/setting/unregistered-product-detail-design\"", "permissions1594"],
  ["navigation actual template consumption", "sidebarNavigation", "v-for=\"item in section.items\"", "v-for=\"item in []\"", "permissions1594"],

  ['Admin readonly showPrice preserved', 'admin', 'data-testid="detail-readonly-showPrice"', 'data-testid="missing-readonly-showPrice"', 'editor18'],
  ['Admin count actual control', 'admin', 'currentModule.count && controller.setCount(currentModule.count, value)', 'void currentModule.count', 'editor18'],
  ['Admin count range', 'admin', "count:'recommendNum',countLabel:'商品数量',max:24", "count:'recommendNum',countLabel:'商品数量',max:100", 'editor18'],
  ['Admin historical controls remain opaque', 'controller', 'navList: 4, isOpen: 2, showService: 3', 'navList: 4, isOpen: 5, showService: 3', 'editor18'],
  ['Admin preserve array order', 'controller', '[...old, value]', '[...old, value].sort()', 'editor18'],
  ['Admin nine actual previews', 'preview', 'data-testid="detail-preview-module-8"', 'data-testid="detail-preview-module-99"', 'previews9'],
  ['Admin preview actual count', 'preview', 'v-for="n in value.communityNum"', 'v-for="n in 3"', 'previews9'],
  ['Admin preview recommendation threshold', 'preview', 'value.recommendNum > 6', 'value.recommendNum > 12', 'previews9'],
  ['bound catalog', 'reader', '.limit(3)', '.limit(1)', 'sharedSettingsAuthority'],
  ['duplicate catalog', 'reader', 'catalog.rows.length!==1', 'false', 'sharedSettingsAuthority'],
  ['normalized identity catalog', 'reader', 'lower(btrim(', 'lower(', 'sharedSettingsAuthority'],
  ['bounded JSON', 'reader', 'new TextEncoder().encode(value).byteLength > PRODUCT_DETAIL_MAX_VALUE_BYTES', 'false', 'sharedSettingsAuthority'],
  ['missing actual server default', 'reader', "value:cloneProductDetailDesign(),editable:true,issues:['product_detail_missing']", "value:null,editable:false,issues:['product_detail_missing']", 'sharedSettingsAuthority'],
  ['old status zero remains valid', 'reader', "if(row.id<=0||", "if(row.status!==1||row.id<=0||", 'sharedSettingsAuthority'],
  ['numeric loss guard', 'reader', 'categoryStyleNumbersExact(value)', 'true', 'sharedSettingsAuthority'],
  ['public known-key intersection', 'reader', 'for (const key of PRODUCT_DETAIL_DESIGN_KEYS)', 'for (const key of Object.keys(saved))', 'sharedSettingsAuthority'],
  ['public frozen projection', 'reader', 'value:cloneProductDetailDesign(snapshot.value??undefined)', 'value:snapshot.value', 'sharedSettingsAuthority'],
  ['public RR authority call', 'publicConfig', 'publicProductDetailDesign(await readProductDetailDesignSnapshot(tx))', '({value:{}})', 'sharedSettingsAuthority'],
  ['catalog lock before write', 'service', 'await lockDiseCatalogForMutation(tx);', '', 'mutationProtocol'],
  ['a string cannot replace the actual catalog lock', 'service', 'await lockDiseCatalogForMutation(tx);', 'const fake = "lockDiseCatalogForMutation(tx)";', 'mutationProtocol'],
  ['revision compare', 'service', 'catalog.revision!==canonical.revision', 'false', 'mutationProtocol'],
  ['damaged write rejection', 'service', '!projectProductDetailDesign(catalog).editable', 'false', 'mutationProtocol'],
  ['opaque extensions preserved', 'service', 'JSON.stringify({...saved,...canonical.value})', 'JSON.stringify(canonical.value)', 'mutationProtocol'],
  ['actor-bound journal', 'service', 'journals[0].actor!==id', 'false', 'mutationProtocol'],
  ['payload-bound journal', 'service', 'receipt.payloadHash!==payloadHash', 'false', 'mutationProtocol'],
  ['journal actual insertion', 'service', 'await tx.insert(systemLog)', 'await fakeJournal(systemLog)', 'mutationProtocol'],
  ['actual HTTP proof hash', 'httpController', 'payloadHash:error.payloadHash', 'payloadHash:null', 'mutationProtocol'],
  ['actual table fence', 'theme', 'LOCK TABLE ${systemDise} IN SHARE ROW EXCLUSIVE MODE', 'SELECT 1', 'mutationProtocol'],
  ['complete request fields', 'input', 'Object.keys(raw).length!==keys.length', 'false', 'mutationProtocol'],
  ['legacy view only', 'permission', "resolved.add('product_detail_design.view')", "resolved.add('product_detail_design.manage')", 'permissions1594'],
  ['legacy installed identity', 'permission', 'menu.id === 1594 && menu.authType === 1', 'menu.id === 1595 && menu.authType === 1', 'permissions1594'],
  ['dedicated read route', 'adminRoutes', "'/config/product-detail-design', adminAuth, AdminProductDetailDesign.read", "'/config/unrelated-detail-design', adminAuth, AdminProductDetailDesign.read", 'dedicatedRoutes'],
  ['generic deletion normalized identity', 'crud', 'templateName === "product_detail"', 'templateName === "other"', 'genericProtection'],
  ['generic deletion actually invokes protection', 'crud', 'const reason = adminDiseDeletionProtectionReason(row)', 'const reason = null', 'genericProtection'],
  ['generic list protects same identity', 'crud', "rows.filter(row=>!['product_detail','member'].includes(normalizeDiseTemplateName(row.templateName)))", 'rows', 'genericProtection'],
  ['generic saved normalized identity', 'crud', '["suspended_window", "color_change", "category", "product_detail", "member"]', '["suspended_window", "color_change", "other", "member"]', 'genericProtection'],
  ['requested identity strict whitelist', 'crud', '!ADMIN_DISE_ALLOWED_SAVE_KEYS.has(key)', 'false', 'genericProtection'],
  ['new generic immutable identity', 'crud', 'templateName: "",', 'templateName: body.templateName,', 'genericProtection'],
  ['generic normalization actually trims', 'theme', 'value.slice(start, end).toLowerCase()', 'value.toLowerCase()', 'genericProtection'],
  ['immutable full value', 'controller', 'Object.freeze(value.input.value)', 'void value.input.value', 'actorRecovery'],
  ['restored actor', 'controller', 'row.actor !== actor', 'false', 'actorRecovery'],
  ['restored payload digest', 'controller', 'await detailDesignFingerprint(input) !== row.fingerprint', 'false', 'actorRecovery'],
  ['proof actual status', 'controller', 'actual.data.status !== actual.status', 'false', 'actorRecovery'],
  ['proof UUID', 'controller', 'data.operationId === pending.input.operationId', 'true', 'actorRecovery'],
  ['proof payload', 'controller', 'data.payloadHash === pending.fingerprint', 'true', 'actorRecovery'],
  ['unknown intent does not drift', 'controller', 'if (s.pending) s.draft = cloneProductDetailDesign(s.pending.input.value)', 'if (s.pending) s.draft = cloneProductDetailDesign()', 'actorRecovery'],
  ['fresh readonly showPrice', 'controller', 'result.showPrice = [...current.showPrice]', 'result.showPrice = [...draft.showPrice]', 'actorRecovery'],
  ['fresh historical ordinals', 'controller', 'current.isOpen.forEach(', 'draft.isOpen.forEach(', 'actorRecovery'],
  ['retry exact frozen UUID', 'controller', 'await this.submit(value);\n  }\n  invalidate()', 'await this.save();\n  }\n  invalidate()', 'actorRecovery'],
  ['description sanitizer actual call', 'data', "productDetailDescriptionHtml(rows[0]?.description??'')", "/* productDetailDescriptionHtml(rows[0]?.description??'') */ (rows[0]?.description??'')", 'ordinarySafeDisplay'],
  ['description owner validation', 'data', 'publicProductPictures(tx,refs.map(image=>({...owner(product),image})))', 'unsafePictures(tx,refs)', 'ordinarySafeDisplay'],
  ['actual ordinary specs', 'data', 'value.showService.includes(3)?integralDetailSpecs(product.specs,[] ):[]', '[]', 'ordinarySafeDisplay'],
  ['sanitized rich text consumer', 'mobileDecoder', 'description: sanitizeArticleRichText(description)', 'description', 'ordinarySafeDisplay'],
  ['ordinary actual pure decoder call', 'mobileProduct', 'display: parseProductDetailDesignData(raw)', 'display: undefined', 'ordinarySafeDisplay'],
  ['ordinary pure decoder dependency', 'mobileProduct', "from '../utils/productDetailDesign'", "from './productDetailDesign'", 'ordinarySafeDisplay'],
  ['pure decoder rejects HTTP runtime dependency', 'mobileDecoder', 'function text(value:', "import {http} from '@/utils/request';\nfunction text(value:", 'ordinarySafeDisplay'],
  ['real body rendering', 'ordinary', ':nodes="display.description"', ':nodes="\'\'"', 'ordinarySafeDisplay'],
  ['video consumer', 'ordinary', ':video="skuMedia ? \'\' : display.video"', 'video=""', 'ordinarySafeDisplay'],
  ['video actual shared policy dependency', 'data', "from './ProductVideoPolicy'", "from './UnprovedVideoPolicy'", 'ordinarySafeDisplay'],
  ['video actual shared policy call', 'data', 'return resolveProductVideoReference(tx,product.videoLink,product,{allowLegacyRelative:true})', 'return product.videoLink', 'ordinarySafeDisplay'],
  ['video actual reference normalization', 'videoPolicy', 'reference = normalizeProductVideoReference(value, options)', 'reference = String(value)', 'ordinarySafeDisplay'],
  ['video actual owner validation', 'videoPolicy', 'asset.relationId !== owner.relationId', 'false', 'ordinarySafeDisplay'],
  ['video actual MIME validation', 'videoPolicy', "asset.mime.trim().toLowerCase() !== 'video/mp4'", 'false', 'ordinarySafeDisplay'],
  ['video actual product-library module', 'videoPolicy', 'asset.module !== 1', 'false', 'ordinarySafeDisplay'],
  ['video actual file type', 'videoPolicy', 'asset.file !== 2', 'false', 'ordinarySafeDisplay'],
  ['video actual supplier status', 'videoPolicy', 'eq(systemSupplier.isShow, 1)', 'eq(systemSupplier.isShow, 0)', 'ordinarySafeDisplay'],
  ['video real backend read', 'products', 'videoLink: await readDetailVideo(tx,product)', 'videoLink:product.videoLink', 'ordinarySafeDisplay'],
  ['SKU display calculation', 'products', 'display_price:detailDisplayPrice(', 'display_price:missingDisplayPrice(', 'displayPriceIsolation'],
  ['selected SKU independent display', 'mobileProduct', 'display_price:normalizeDisplayQuote(sku.display_price,sku.price)', 'display_price:undefined', 'displayPriceIsolation'],
  ['legal zero-cent display retained', 'mobileProduct', 'if(cents(price)>cents(baseMoney)', 'if(cents(price)<1n||cents(price)>cents(baseMoney)', 'displayPriceIsolation'],
  ['selected SKU rendering', 'ordinary', 'selectedSku.value.display_price?.price', 'selectedSku.value.price', 'displayPriceIsolation'],
  ['financial policy untouched', 'cart', 'export class StoreCartService', 'const showPrice = []; export class StoreCartService', 'displayPriceIsolation'],
  ['reply actual read', 'data', 'replies.replyList(product.id,1,value.replyNum,uid,0,false)', 'emptyReplies(product.id)', 'realReplyPreviews'],
  ['reply count actual read', 'data', 'replies.replyConfig(product.id)', '({sum_count:0})', 'realReplyPreviews'],
  ['reply configured limit', 'data', 'replies.replyList(product.id,1,value.replyNum,uid,0,false)', 'replies.replyList(product.id,1,3,uid,0,false)', 'realReplyPreviews'],
  ['reply output not overwritten', 'productController', 'reply: info.reply ?? []', 'reply: []', 'realReplyPreviews'],
  ['community actual relation', 'data', "cr.type='community_product'", "cr.type='community_user'", 'communityLinkedPaging'],
  ['community product relation', 'data', 'cr.right_id=${productId}', 'cr.right_id=1', 'communityLinkedPaging'],
  ['community actual limit', 'data', '.limit(limit).offset((page-1)*limit)', '.limit(10).offset(0)', 'communityLinkedPaging'],
  ['community page actual API', 'community', 'apiProductCommunity(productId,target,10)', 'fakeCommunity(productId,target,10)', 'communityLinkedPaging'],
  ['community returned count consumed', 'community', 'count.value=result.count', 'count.value=0', 'communityLinkedPaging'],
  ['community actual pure parse after HTTP', 'mobileData', 'return parseProductCommunityData(await http.get<unknown>', 'return fakeCommunity(await http.get<unknown>', 'communityLinkedPaging'],
  ['rank database result', 'data', 'rows.findIndex(row=>row.id===id)', '-1', 'actualRanks'],
  ['rank actual call', 'data', 'await readRank(tx,product.id,uid)', '({rank:1,rank_type:1,rank_name:\'榜单\'})', 'actualRanks'],
  ['rank link actual type', 'ordinary', 'display.value.rankType}', '1}', 'actualRanks'],
  ['package configured limit', 'data', 'readDetailPackages(tx,product.id,value.matchNum,member)', 'readDetailPackages(tx,product.id,3,member)', 'realPackages'],
  ['package real quote validation', 'discount', 'parseAmountToCents(packageSku.price)', '100', 'realPackages'],
  ['package actual add', 'ordinary', 'await apiDiscountCartAdd({', 'await fakePackageCart({', 'realPackages'],
  ['recommend configured limit', 'data', 'readDetailRecommendations(tx,product,value.recommendNum,member)', 'readDetailRecommendations(tx,product,12,member)', 'realRecommendations'],
  ['recommend actual data', 'ordinary', 'display.value.recommend.slice(0,design.value.recommendNum)', '[]', 'realRecommendations'],
  ['recommend threshold', 'ordinary', 'design.recommendNum<=6', 'design.recommendNum<=12', 'realRecommendations'],
  ['recommend two rows', 'ordinary', 'columns.push(list.slice(i,i+2))', 'columns.push(list.slice(i,i+1))', 'realRecommendations'],
  ['nav configured ordering', 'ordinary', 'design.value.navList.map(', '[0,1,2,3,4].map(', 'navigationAndFooter'],
  ['footer configured choices', 'ordinary', 'design.value.menuList.map(', '[0,1,2].map(', 'navigationAndFooter'],
  ['global add-cart gate', 'ordinary', "skuMode.value==='cart'&&(!design.value.showCart||detail.value.cart_button!==1)", "skuMode.value==='cart'&&detail.value.cart_button!==1", 'navigationAndFooter'],
  ['real marketing API route', 'mobileData', '`/product/detail/activity/${id}`', '`/product/activity/${id}`', 'navigationAndFooter'],
  ['marketing actual pure parse after HTTP', 'mobileData', 'return parseProductMarketingData(await http.get<unknown>', 'return fakeMarketing(await http.get<unknown>', 'navigationAndFooter'],
  ['collection actual mutation', 'collection', "http.post('/collect/add',{id:product.id,category:'product'})", "fakeCollect(product.id)", 'navigationAndFooter'],
  ['unknown ledger before mutation', 'ordinary', 'uni.setStorageSync(ordinaryRecoveryKey(frozen.actor),JSON.stringify(frozen))', 'void frozen', 'ordinaryCartLifecycle'],
  ['acknowledged same cart', 'ordinary', "state:'acknowledged',cartId:prepared.ids[0]", "state:'acknowledged',cartId:1", 'ordinaryCartLifecycle'],
  ['refresh same cart', 'ordinary', 'prepareProductCart({id:row.cartId},0)', 'prepareProductCart({id:1},0)', 'ordinaryCartLifecycle'],
  ['coupon real API', 'couponFlow', 'await r.claim(couponId)', 'await Promise.resolve(1)', 'ordinaryCartLifecycle'],
  ['late actor fence', 'ordinary', 'owner.uid === authStore.uid', 'true', 'ordinaryCartLifecycle'],
  ['cart actual API', 'orderApi', '"/cart/add", params as Record<string, unknown>', '"/cart/mock", params as Record<string, unknown>', 'ordinaryCartLifecycle'],
  ['coupon actual API', 'couponApi', "'coupon/receive', 'POST', { id: couponId }, true", "'coupon/mock', 'POST', { id: couponId }, true", 'ordinaryCartLifecycle'],
  ['coupon actual page delegation', 'ordinary', 'reactive(useProductCoupons(', 'reactive(fakeProductCoupons(', 'ordinaryCartLifecycle'],
  ['coupon product visibility and design admission', 'ordinary', 'visible.value&&marketingVisible.value&&design.value.showService.includes(0)', 'true', 'ordinaryCartLifecycle'],
  ['coupon card actual owner prop', 'ordinary', ':owner-uid="authStore.uid"', ':owner-uid="0"', 'ordinaryCartLifecycle'],
  ['coupon card real claim tap', 'couponCard', '@tap="coupons.claim(item.id)"', '@tap="coupons.wallet"', 'ordinaryCartLifecycle'],
  ['coupon card actual claim admission', 'couponCard', ':disabled="!coupons.canClaim(item)"', ':disabled="false"', 'ordinaryCartLifecycle'],
  ['coupon card real receipt tap', 'couponCard', '@tap="coupons.check"', '@tap="coupons.load(false)"', 'ordinaryCartLifecycle'],
  ['coupon page and generation fence', 'couponFlow', 'epoch === generation && id === productId.value', 'true', 'ordinaryCartLifecycle'],
  ['coupon persisted actor fence', 'couponFlow', "(Number(uni.getStorageSync('uni_uid')) || 0) === auth.uid", 'true', 'ordinaryCartLifecycle'],
  ['coupon pending journal blocks a second grant', 'couponFlow', 'journal(auth.uid) === null', 'true', 'ordinaryCartLifecycle'],
  ['coupon journal owner identity', 'couponFlow', 'row.uid !== uid', 'false', 'ordinaryCartLifecycle'],
  ['coupon durable journal before grant', 'couponFlow', 'save(row); state.pending = row;', 'state.pending = row;', 'ordinaryCartLifecycle'],
  ['coupon journal durable readback', 'couponFlow', 'uni.getStorageSync(productCouponClaimKey(row.uid)) !== raw', 'false', 'ordinaryCartLifecycle'],
  ['coupon journal attempt identity', 'couponFlow', 'live.attempt === row.attempt', 'true', 'ordinaryCartLifecycle'],
  ['coupon journal issue identity', 'couponFlow', 'live.couponId === row.couponId', 'true', 'ordinaryCartLifecycle'],
  ['coupon journal product identity', 'couponFlow', 'live.productId === row.productId', 'true', 'ordinaryCartLifecycle'],
  ['coupon late grant owner fence', 'couponFlow', 'const ownedId = await r.claim(couponId); if (!r.active() || !sameJournal(row)) return;', 'const ownedId = await r.claim(couponId); if (!sameJournal(row)) return;', 'ordinaryCartLifecycle'],
  ['coupon original product receipt', 'couponFlow', 'r.receipt(row.productId, row.couponId)', 'r.receipt(productId.value, row.couponId)', 'ordinaryCartLifecycle'],
  ['coupon late receipt owner fence', 'couponFlow', 'const receipt = await r.receipt(row.productId, row.couponId); if (!r.active() || !sameJournal(row)) return;', 'const receipt = await r.receipt(row.productId, row.couponId); if (!sameJournal(row)) return;', 'ordinaryCartLifecycle'],
  ['coupon recovery must not resend', 'couponFlow', 'const receipt = await r.receipt(row.productId, row.couponId);', 'await r.claim(row.couponId); const receipt = await r.receipt(row.productId, row.couponId);', 'ordinaryCartLifecycle'],
  ['coupon only clear the matching journal', 'couponFlow', "if (!sameJournal(row)) throw Error('原领取记录已变化，请重新核对');", '', 'ordinaryCartLifecycle'],
  ['coupon real exclusive grant delegation', 'couponFlow', 'await exclusive(uid, async () => {', 'await fakeExclusive(uid, async () => {', 'ordinaryCartLifecycle'],
  ['coupon authenticated claim request', 'couponApi', "r.request('coupon/receive', 'POST', { id: couponId }, true)", "r.request('coupon/receive', 'POST', { id: couponId }, false)", 'ordinaryCartLifecycle'],
  ['coupon actual receipt GET', 'couponApi', '`product/detail/${productId}/coupons/${couponId}/receipt`', '`product/detail/${productId}/coupons/${couponId}/fake`', 'ordinaryCartLifecycle'],
  ['coupon receipt expected actor', 'couponApi', '{ uid: r.owner.uid, productId, couponId }', '{ uid: 0, productId, couponId }', 'ordinaryCartLifecycle'],
  ['coupon receipt decoded owner fence', 'couponContract', 'row.uid !== expected.uid || row.productId !== expected.productId || row.couponId !== expected.couponId', 'row.productId !== expected.productId || row.couponId !== expected.couponId', 'ordinaryCartLifecycle'],
  ['coupon receipt decoded product fence', 'couponContract', 'row.productId !== expected.productId || row.couponId !== expected.couponId', 'row.couponId !== expected.couponId', 'ordinaryCartLifecycle'],
  ['coupon receipt decoded issue fence', 'couponContract', 'row.couponId !== expected.couponId', 'false', 'ordinaryCartLifecycle'],
  ['coupon request actor uid fence', 'couponRequests', 'auth.uid===owner.uid', 'true', 'ordinaryCartLifecycle'],
  ['coupon request token fence', 'couponRequests', 'auth.token===owner.token', 'true', 'ordinaryCartLifecycle'],
  ['coupon request session fence', 'couponRequests', 'auth.sessionVersion===owner.version', 'true', 'ordinaryCartLifecycle'],
  ['coupon real request transport', 'couponRequests', 'task=uni.request({', 'task=fakeRequest({', 'ordinaryCartLifecycle'],
  ['PC authority actual API', 'pc', '`/product/detail/${id}`', '`/pc/product/detail/${id}`', 'pcSharedApi'],
  ['backend extras actual read', 'products', 'await readProductDetailExtras(tx,product,uid,pricing.paidMemberActive)', '({})', 'pcSharedApi'],
  ['activity inverse specs retained', 'data', '(activityType===6?design.showService.includes(3):!design.showService.includes(3))', 'design.showService.includes(3)', 'activityConsumers'],
  ['activity shared settings actual request', 'activityDesign', "http.get<unknown>('/v2/diy/product_detail')", "http.get<unknown>('/v2/diy/home')", 'activityConsumers'],
  ['activity real menu consumer', 'bargainPage', ':menu="activityDesign.menuList"', ':menu="[]"', 'activityConsumers'],
  ['activity integral shared snapshot', 'integral', 'publicProductDetailDesign(await readProductDetailDesignSnapshot(tx))', '({value:{}})', 'activityConsumers'],
  ['activity real ensures call', 'data', 'await readDetailEnsures(tx,product)', '[]', 'activityConsumers'],
  ['activity real reply call', 'data', 'replyService.replyList(base.id,1,design.replyNum,uid,0,false)', 'emptyReplies(base.id)', 'activityConsumers'],
  ['activity real reply count call', 'data', 'replyService.replyConfig(base.id)', '({sum_count:0})', 'activityConsumers'],
  ['activity actual description call', 'data', 'readDetailDescription(tx,baseDescription?base.id:activity.id,baseDescription?0:activityType,base)', 'emptyDescription(base.id)', 'activityConsumers'],
  ['activity description real signing', 'data', 'renderDetailDescription(appKey,result.description)', 'Promise.resolve(result.description)', 'activityConsumers'],
  ['activity image real signing', 'data', 'renderProductPictures(appKey,refs)', 'Promise.resolve(refs)', 'activityConsumers'],
  ['selection seckill actual snapshot design', 'seckillSku', 'readActivityDetailDesign(this.container.db,entry,1,uid)', 'emptyDesign(entry)', 'activityConsumers'],
  ['selection combination actual snapshot design', 'combinationSku', 'readActivityDetailDesign(this.container.db,entry,3,uid)', 'emptyDesign(entry)', 'activityConsumers'],
  ['selection presale actual snapshot design', 'presaleSku', 'readActivityDetailDesign(this.container.db,{...product,productId:id,images:JSON.stringify(images(product.sliderImage,product.image))},6,uid)', 'emptyDesign(product)', 'activityConsumers'],
  ['selection presale normalized optional gallery', 'presaleSku', 'images:JSON.stringify(images(product.sliderImage,product.image))', 'images:"[]"', 'activityConsumers'],
  ['selection string is not a design call', 'seckillSku', 'await readActivityDetailDesign(this.container.db,entry,1,uid)', '"readActivityDetailDesign(this.container.db,entry,1,uid)"', 'activityConsumers'],
  ['selection seckill RR authority', 'seckillSku', 'REPEATABLE READ, READ ONLY', 'READ COMMITTED', 'activityConsumers'],
  ['selection combination RR authority', 'combinationSku', 'REPEATABLE READ, READ ONLY', 'READ COMMITTED', 'activityConsumers'],
  ['selection presale RR authority', 'presaleSnapshot', 'REPEATABLE READ, READ ONLY', 'READ COMMITTED', 'activityConsumers'],
  ['selection presale real snapshot wrapper', 'presaleSku', 'withPresaleCatalogSnapshot(this.container,', 'fakeSnapshot(this.container,', 'activityConsumers'],
  ['selection presale bounded transaction', 'presaleSnapshot', 'idle_in_transaction_session_timeout', 'idle_other_timeout', 'activityConsumers'],
  ['selection seckill returns actual design', 'seckillSku', 'return {design,selection:', 'return {selection:', 'activityConsumers'],
  ['selection combination returns actual design', 'combinationSku', 'return {design,selection:', 'return {selection:', 'activityConsumers'],
  ['selection presale returns actual design', 'presaleSku', 'return {design,selection:', 'return {selection:', 'activityConsumers'],
  ['selection seckill renders actual design', 'seckillSku', 'renderActivityDetailDesign(this.env?.APP_KEY,result.design)', 'fakeRender(result.design)', 'activityConsumers'],
  ['selection combination renders actual design', 'combinationSku', 'renderActivityDetailDesign(this.env?.APP_KEY,result.design)', 'fakeRender(result.design)', 'activityConsumers'],
  ['selection presale renders actual design', 'presaleSku', 'renderActivityDetailDesign(this.env?.APP_KEY,result.design)', 'fakeRender(result.design)', 'activityConsumers'],
  ['selection returns actual display', 'presaleSku', 'return {...result.selection,...display,skus:', 'return {...result.selection,skus:', 'activityConsumers'],
  ['selection route passes real signing env', 'activityController', 'new SeckillSkuCatalogService(c.get("container"),c.env)', 'new SeckillSkuCatalogService(c.get("container"))', 'activityConsumers'],
  ['selection presale route passes real signing env', 'productController', 'new PresaleSkuCatalogService(c.get("container"),c.env)', 'new PresaleSkuCatalogService(c.get("container"))', 'activityConsumers'],
  ['selection seckill actual view', 'seckillApi', "view: 'skus'", "view: 'mock'", 'activityConsumers'],
  ['selection presale actual view', 'presaleApi', "view: 'presale'", "view: 'mock'", 'activityConsumers'],
  ['selection seckill returns projection', 'seckillApi', 'detailDisplay:parseActivityDetailProjection(raw,selection.product_id)', 'detailDisplay:{}', 'activityConsumers'],
  ['selection combination returns projection', 'combinationApi', 'detailDisplay:parseActivityDetailProjection(raw,selection.product_id)', 'detailDisplay:{}', 'activityConsumers'],
  ['selection presale returns projection', 'presaleApi', 'detailDisplay:parseActivityDetailProjection(raw,selection.product_id)', 'detailDisplay:{}', 'activityConsumers'],
  ['selection projection actual parse', 'mobileDecoder', 'parseProductDetailDesignData({...raw,...content,id:productId})', 'emptyProjection(productId)', 'activityConsumers'],
  ['selection projection actual gallery', 'mobileDecoder', 'images:images.map(media).filter(Boolean)', 'images:[]', 'activityConsumers'],
  ['selection pure decoder actual reexport', 'mobileData', "export * from '../utils/productDetailDesign'", "export * from '../utils/unrelated'", 'activityConsumers'],
  ['selection load assigns actual response', 'seckillPurchase', 'detail.value = result;', 'detail.value = null;', 'activityConsumers'],
  ['selection combination load assigns response', 'combinationPurchase', 'detail.value = result;', 'detail.value = null;', 'activityConsumers'],
  ['selection presale load assigns response', 'presalePurchase', 'detail.value = result;', 'detail.value = null;', 'activityConsumers'],
  ['selection integral load assigns response', 'integralPurchase', 'detail.value = result;', 'detail.value = null;', 'activityConsumers'],
  ['selection actual rich text', 'activityContent', ':nodes="data.description"', ':nodes="\'\'"', 'activityConsumers'],
  ['selection actual ensure rendering', 'activityContent', 'v-for="ensure in data.ensure"', 'v-for="ensure in []"', 'activityConsumers'],
  ['selection actual reply limit', 'activityContent', 'data.replies.slice(0,data.design.replyNum)', 'data.replies.slice(0,3)', 'activityConsumers'],
  ['selection actual specs rendering', 'activityContent', 'v-for="(spec,index) in data.specs"', 'v-for="(spec,index) in []"', 'activityConsumers'],
  ['selection presale positive specs mode', 'presalePage', 'specs-mode="included"', 'specs-mode="excluded"', 'activityConsumers'],
  ['selection integral retains old no-reply subset', 'integralPage', ':review-module="false"', ':review-module="true"', 'activityConsumers'],
  ['selection actual seckill content binding', 'seckillPage', ':data="detail.detailDisplay.data"', ':data="{}"', 'activityConsumers'],
  ['selection actual combination content binding', 'combinationPage', ':data="detail.detailDisplay.data"', ':data="{}"', 'activityConsumers'],
  ['selection actual presale content binding', 'presalePage', ':data="detail.detailDisplay.data"', ':data="{}"', 'activityConsumers'],
  ['selection actual integral content binding', 'integralPage', ':data="detail.detailDisplay.data"', ':data="{}"', 'activityConsumers'],
  ['selection actual seckill full gallery', 'seckillPage', '...detail.value.detailDisplay.images', '...[]', 'activityConsumers'],
  ['selection actual combination full gallery', 'combinationPage', '...detail.value.detailDisplay.images', '...[]', 'activityConsumers'],
  ['selection actual presale full gallery', 'presalePage', '...detail.value.detailDisplay.images', '...[]', 'activityConsumers'],
  ['official code genuine provider call', 'shareCode', '.requestTemporaryProduct(scene)', '.fakeTemporaryProduct(scene)', 'sharePosterReferral'],
  ['mini code genuine provider call', 'shareCode', '.createOrdinaryProductDataUrl(id,uid)', '.fakeOrdinaryProductDataUrl(id,uid)', 'sharePosterReferral'],
  ['share actor fresh snapshot', 'shareCode', 'eq(user.uid,uid)', 'sql`TRUE`', 'sharePosterReferral'],
  ['share product current publication', 'shareCode', 'publicOrdinaryProductIdentitySql()', 'sql`TRUE`', 'sharePosterReferral'],
  ['share callback current publication', 'shareCode', 'this.snapshot(verified.id,verified.uid)', 'this.snapshot(1,1)', 'sharePosterReferral'],
  ['official platform-scoped config winner', 'shareCode', 'orderBy(desc(systemConfig.sort),desc(systemConfig.id)).limit(1001)', 'orderBy(desc(systemConfig.id)).limit(1)', 'sharePosterReferral'],
  ['official scalar config decode', 'shareCode', "typeof parsed==='string'||typeof parsed==='number'?String(parsed):''", "String(parsed)", 'sharePosterReferral'],
  ['official callback real H5 hash route', 'shareCode', "url.hash='/pages/goods/detail?'+query.toString()", "url.search=query.toString()", 'sharePosterReferral'],
  ['official callback true referrer query', 'shareCode', 'id:String(id),spid:String(uid)', 'id:String(id),spid:"1"', 'sharePosterReferral'],
  ['official callback real news', 'wechatCallback', '.news(callback.payload.eventKey)', '.fakeNews(callback.payload.eventKey)', 'sharePosterReferral'],
  ['official callback signed scene', 'shareCode', 'verifyProductShareScene(scene,this.env.APP_KEY)', '({id:1,uid:1})', 'sharePosterReferral'],
  ['official scene expiry', 'shareScene', 'expires<=now', 'false', 'sharePosterReferral'],
  ['official scene actual HMAC', 'shareScene', "crypto.subtle.sign('HMAC',key", "crypto.subtle.sign('NONE',key", 'sharePosterReferral'],
  ['official provider actual endpoint', 'officialQrcode', 'https://api.weixin.qq.com/cgi-bin/qrcode/create', 'https://example.invalid/qrcode/create', 'sharePosterReferral'],
  ['official actual provider scene', 'officialQrcode', 'scene_str:scene', 'scene_str:"other"', 'sharePosterReferral'],
  ['mini provider canonical product path', 'miniQrcode', "fetchUnlimitedCode(token, scene, 'pages/goods/detail'", "fetchUnlimitedCode(token, scene, 'pages/goods_details/index'", 'sharePosterReferral'],
  ['mini provider real referrer', 'miniQrcode', 'const scene = `id=${productId}&spid=${uid}`', 'const scene = `id=${productId}`', 'sharePosterReferral'],
  ['mini provider actual ordinary delegation', 'miniQrcode', "return this.codeDataUrl(credentials, null, token => this.fetchUnlimitedCode(token, scene, 'pages/goods/detail', '商品详情'));", 'return null;', 'sharePosterReferral'],
  ['mini provider actual token loader delegation', 'miniQrcode', 'await this.fetchWithTokenRefresh(credentials, load)', 'await fakeMiniCode(credentials, load)', 'sharePosterReferral'],
  ['mini provider loader actually called', 'miniQrcode', 'await load(accessToken)', 'await fakeMiniCode(accessToken)', 'sharePosterReferral'],
  ['mini provider source credentials fence', 'miniQrcode', 'withRoutineCredentials(this.container, this.env, credentials.stamp,', "withRoutineCredentials(this.container, this.env, 'other',", 'sharePosterReferral'],
  ['mini provider actual unlimited-code endpoint', 'miniQrcode', "this.fetchCode('getwxacodeunlimit', token,", "this.fetchCode('fakecode', token,", 'sharePosterReferral'],
  ['mini provider actual bounded reader delegation', 'miniQrcode', 'await readLegacyShareProvider(this.fetcher, url,', 'await fakeShareProvider(this.fetcher, url,', 'sharePosterReferral'],
  ['mini provider actual official host', 'miniQrcode', 'https://api.weixin.qq.com/wxa/${endpoint}', 'https://example.invalid/wxa/${endpoint}', 'sharePosterReferral'],
  ['mini provider bounded image allowance', 'miniQrcode', 'MAX_CODE_BYTES = 1024 * 1024', 'MAX_CODE_BYTES = 1024 * 1024 * 100', 'sharePosterReferral'],
  ['mini provider bounded json allowance', 'miniQrcode', 'json: 32 * 1024, image: MAX_CODE_BYTES, timeout: 8_000', 'json: 32 * 1024 * 100, image: MAX_CODE_BYTES, timeout: 8_000', 'sharePosterReferral'],
  ['mini provider bounded deadline', 'miniQrcode', 'timeout: 8_000', 'timeout: 800_000', 'sharePosterReferral'],
  ['mini provider returned image validation', 'miniQrcode', 'legacyShareDataImage(`data:${contentType};base64,${bytesToBase64(bytes)}`)', 'fakeShareDataImage(`data:${contentType};base64,${bytesToBase64(bytes)}`)', 'sharePosterReferral'],
  ['mini bounded reader actual fetch', 'miniProvider', 'await fetcher(input,{...init,signal:controller.signal,redirect:\'manual\'})', 'await fakeFetch(input,{...init,signal:controller.signal,redirect:\'manual\'})', 'sharePosterReferral'],
  ['mini bounded reader manual redirect mode', 'miniProvider', "redirect:'manual'", "redirect:'follow'", 'sharePosterReferral'],
  ['mini bounded reader rejects redirects', 'miniProvider', 'response.redirected || response.status >= 300 && response.status < 400', 'false', 'sharePosterReferral'],
  ['mini bounded reader actually refuses redirected response', 'miniProvider', "throw new ServiceUnavailableException('分享接口重定向，请稍后重试')", 'void response', 'sharePosterReferral'],
  ['mini bounded reader rejects oversize headers', 'miniProvider', 'Number(length) > limit', 'false', 'sharePosterReferral'],
  ['mini bounded reader actual stream', 'miniProvider', 'reader = response.body.getReader()', 'reader = fakeReader()', 'sharePosterReferral'],
  ['mini bounded reader actual streamed reads', 'miniProvider', 'await reader.read()', 'await fakeRead()', 'sharePosterReferral'],
  ['mini bounded reader rejects oversize stream', 'miniProvider', 'if (size > limit)', 'if (false)', 'sharePosterReferral'],
  ['mini bounded reader actually refuses oversize response', 'miniProvider', "throw new ValidateException('分享接口返回数据过大')", 'void response', 'sharePosterReferral'],
  ['mini bounded reader abort signal', 'miniProvider', 'signal:controller.signal', 'signal:undefined', 'sharePosterReferral'],
  ['mini bounded reader actual deadline timer', 'miniProvider', 'timer = setTimeout(', 'timer = fakeTimeout(', 'sharePosterReferral'],
  ['mini bounded reader deadline actually rejects', 'miniProvider', "reject(new ServiceUnavailableException('分享图片读取超时，请稍后重试'))", 'void reader', 'sharePosterReferral'],
  ['mini bounded reader explicit deadline race', 'miniProvider', 'Promise.race([operation,timeout])', 'Promise.all([operation,timeout])', 'sharePosterReferral'],
  ['mini bounded reader cancels timed-out stream', 'miniProvider', 'void reader?.cancel().catch(() => undefined)', 'void reader', 'sharePosterReferral'],
  ['mini bounded reader releases stream', 'miniProvider', 'reader.releaseLock()', 'void reader', 'sharePosterReferral'],
  ['official code authenticated route', 'v1Routes', "'/product/code/:id', authMiddleware({ force: true })", "'/product/code/:id', authMiddleware({ force: false })", 'sharePosterReferral'],
  ['official code typed API', 'mobileData', 'return productShareCode((value as Record<string,unknown>).code,kind)', 'return String((value as Record<string,unknown>).code)', 'sharePosterReferral'],
  ['official code pure provider host', 'mobileDecoder', "address.origin!=='https://mp.weixin.qq.com'", 'false', 'sharePosterReferral'],
  ['official code actual configured branch', 'ordinary', "display.value.shareQrcode===1?'wechat':''", "false?'wechat':''", 'sharePosterReferral'],
  ['official code late actor fence', 'ordinary', 'epoch===codeGeneration&&officialCodeKind()===kind', 'true', 'sharePosterReferral'],
  ['official code actual page data', 'ordinary', 'if(current())officialCode.value=code', 'if(current())officialCode.value=""', 'sharePosterReferral'],
  ['official code actual poster binding', 'poster', ':qr-image="qrImage"', 'qr-image=""', 'sharePosterReferral'],
  ['official code actual canvas image', 'canvas', 'context.drawImage(officialImage,60,345,200,200)', 'context.fillRect(60,345,200,200)', 'sharePosterReferral'],
  ['H5 SDK actual signing config', 'h5Share', "http.get<unknown>('/wechat/config',{url:signatureUrl})", "http.get<unknown>('/wechat/config',{url:data.url})", 'sharePosterReferral'],
  ['H5 SDK placeholder is not a usable provider', 'h5Share', "typeof sdk[method]==='function'", 'Boolean(sdk)', 'sharePosterReferral'],
  ['H5 SDK complete actual five-method shape', 'h5Share', "['config','ready','error','updateAppMessageShareData','updateTimelineShareData']", "['config','ready','error']", 'sharePosterReferral'],
  ['H5 SDK bootstrap actually checks provider shape', 'h5Share', 'if(usableSdk(browser.wx))return Promise.resolve(browser.wx)', 'if(browser.wx)return Promise.resolve(browser.wx)', 'sharePosterReferral'],
  ['H5 SDK loaded provider must pass shape', 'h5Share', 'usableSdk(browser.wx)?resolve(browser.wx):reject(', 'browser.wx?resolve(browser.wx):reject(', 'sharePosterReferral'],
  ['H5 SDK real friend metadata', 'h5Share', 'sdk.updateAppMessageShareData(options)', 'void options', 'sharePosterReferral'],
  ['H5 SDK real timeline metadata', 'h5Share', 'sdk.updateTimelineShareData(options)', 'void options', 'sharePosterReferral'],
  ['H5 SDK real error callback', 'h5Share', 'sdk.error(', 'fakeError(', 'sharePosterReferral'],
  ['H5 SDK real ready callback', 'h5Share', 'sdk.ready(', 'fakeReady(', 'sharePosterReferral'],
  ['H5 SDK stale page fence', 'h5Share', 'signingUrl()!==signatureUrl', 'false', 'sharePosterReferral'],
  ['referral real bind', 'referral', 'await apiBindSpread(visit.spid)', 'await Promise.resolve()', 'sharePosterReferral'],
  ['referral actor binding', 'referral', 'value.uid === auth.uid', 'true', 'sharePosterReferral'],
  ['native app genuine callback', 'share', 'uni.share({', 'fakeShare({', 'sharePosterReferral'],
];

describe('pure product-detail full-contract source coverage', () => {
  it('classifies only all required axes as candidate and never treats declarations as execution receipts', () => {
    const complete = Object.fromEntries(PRODUCT_DETAIL_DESIGN_COVERAGE_GATES.map(key => [key, true]));
    expect(classifyProductDetailDesignCoverage(complete)).toBe('candidate');
    for (const key of PRODUCT_DETAIL_DESIGN_COVERAGE_GATES) {
      const removed = { ...complete }; delete removed[key];
      expect(classifyProductDetailDesignCoverage(removed), key).toBe(key === 'adminScreen' ? 'missing' : 'partial');
      expect(classifyProductDetailDesignCoverage({ ...complete, [key]: false }), key).toBe(key === 'adminScreen' ? 'missing' : 'partial');
    }
    expect(classifyProductDetailDesignCoverage({ adminScreen: true })).toBe('partial');
    expect(PRODUCT_DETAIL_DESIGN_COVERAGE_GATES.some(key => /passed|browser|runtime|test/i.test(key))).toBe(false);
  });

  it('requires every current real connection and downgrades a page-only implementation', () => {
    const coverage = inspectProductDetailDesignCoverage(screens, sources);
    expect(Object.keys(coverage)).toEqual([...PRODUCT_DETAIL_DESIGN_COVERAGE_GATES]);
    for (const key of PRODUCT_DETAIL_DESIGN_COVERAGE_GATES) expect(coverage[key], key).toBe(true);
    expect(classifyProductDetailDesignCoverage(coverage)).toBe('candidate');
    expect(classifyProductDetailDesignCoverage(inspectProductDetailDesignCoverage([], sources))).toBe('missing');
    expect(classifyProductDetailDesignCoverage(inspectProductDetailDesignCoverage(screens, { admin: sources.admin!, preview: sources.preview! }))).toBe('partial');
  });

  it('does not count commented code, empty producers, imports, or declared tests as a working implementation', () => {
    const comments = Object.fromEntries(Object.entries(sources).map(([role, source]) => [role,
      source.includes('<template>') ? `<!-- ${source.replace(/-->/gu,'')} -->` : `/* ${source.replace(/\*\//gu,'')} */`]));
    expect(classifyProductDetailDesignCoverage(inspectProductDetailDesignCoverage(screens, comments))).toBe('missing');
    const pagesOnly = { ...sources, reader: "import {readProductDetailDesignSnapshot} from './authority';\n// All tests pass\n" };
    expect(inspectProductDetailDesignCoverage(screens, pagesOnly).sharedSettingsAuthority).toBe(false);
    expect(classifyProductDetailDesignCoverage(inspectProductDetailDesignCoverage(screens, {}))).toBe('missing');
  });

  it('preserves the actual home when adding the community route', () => {
    const manifest = JSON.parse(sources.mobilePages!);
    expect(manifest.pages[0].path).toBe('pages/index/index');
    const community = manifest.pages.find((page: {path:string}) => page.path === 'pages/goods/productCommunity');
    const broken = {...sources,mobilePages:JSON.stringify({...manifest,pages:[community,...manifest.pages.filter((page:{path:string})=>page!==community)]})};
    expect(inspectProductDetailDesignCoverage(screens,broken).navigationAndFooter).toBe(false);
    expect(classifyProductDetailDesignCoverage(inspectProductDetailDesignCoverage(screens,broken))).toBe('partial');
  });

  it('allows new independent registered consumers while preserving all product connections', () => {
    const manifest=JSON.parse(sources.mobilePages!);
    const extra={...sources,mobilePages:JSON.stringify({...manifest,pages:[...manifest.pages,{path:'pages/sourceAudit/extra'}]})};
    expect(inspectProductDetailDesignCoverage(screens,extra).navigationAndFooter).toBe(true);
    const duplicates={...sources,mobilePages:JSON.stringify({...manifest,pages:[...manifest.pages,manifest.pages[0]]})};
    expect(inspectProductDetailDesignCoverage(screens,duplicates).navigationAndFooter).toBe(false);
  });

  it.each([
    ['server default', 'recommendNum: 12', 'recommendNum: 6'],
    ['historical isOpen', 'selection(record.isOpen, 5)', 'selection(record.isOpen, 2)'],
    ['nav range', 'selection(record.navList, 4)', 'selection(record.navList, 5)'],
    ['menu range', 'selection(record.menuList, 4, 3)', 'selection(record.menuList, 4, 5)'],
    ['reply count', "['replyNum', 10]", "['replyNum', 100]"],
    ['package count', "['matchNum', 10]", "['matchNum', 100]"],
    ['recommend count', "['recommendNum', 24]", "['recommendNum', 100]"],
    ['community count', "['communityNum', 10]", "['communityNum', 100]"],
    ['zero count', 'number < 1', 'number < 0'],
    ['duplicate selections', 'new Set(value).size === value.length', 'true'],
    ['extra key rejection', 'Object.keys(record).length !== PRODUCT_DETAIL_DESIGN_KEYS.length', 'false'],
    ['exact known-key presence', 'Object.hasOwn(record, key)', 'true'],
    ['full19 payload', 'value: cloneProductDetailDesign(value)', 'value: {showCart:value.showCart}'],
  ])('rejects wrong %s in the actual nineteen-field contract', (_label, before, after) => {
    expect(hasProductDetailDesignContract(sources.contract!)).toBe(true);
    const broken = mutation('contract', before, after);
    expect(hasProductDetailDesignContract(broken.contract!)).toBe(false);
    expect(inspectProductDetailDesignCoverage(screens, broken).contract19).toBe(false);
  });

  it.each(mutants)('downgrades loss of %s', (_label, role, before, after, axis) => {
    expect(baseline[axis], `${axis} actual baseline connection`).toBe(true);
    const coverage = inspectProductDetailDesignCoverage(screens, mutation(role, before, after));
    expect(coverage[axis], `${role}/${axis}`).toBe(false);
    expect(classifyProductDetailDesignCoverage(coverage)).toBe('partial');
  });

  it.each(['type', 'template_name', 'is_diy', 'showPrice', 'operationId', 'revision'])('rejects generic admission of protected field %s despite legitimate row-appearance fields', key => {
    expect(baseline.genericProtection).toBe(true);
    const prefix = 'const ADMIN_DISE_ALLOWED_SAVE_KEYS = new Set([';
    const changed = mutation('crud', prefix, `${prefix}${JSON.stringify(key)},`);
    // A detached copy of the valid declaration cannot restore executable
    // whitelist evidence after a protected key was admitted.
    changed.crud += '\n/* ' + sources.crud!.slice(sources.crud!.indexOf(prefix), sources.crud!.indexOf(']);', sources.crud!.indexOf(prefix)) + 3) + ' */';
    const coverage = inspectProductDetailDesignCoverage(screens, changed);
    expect(coverage.genericProtection).toBe(false);
    expect(classifyProductDetailDesignCoverage(coverage)).toBe('partial');
  });

  it('requires real provider and activity producers even when their pages and imports exist', () => {
    const noActivity = { ...sources, activity: "import {readActivityDetailDesign} from './ProductDetailDesignData';" };
    expect(inspectProductDetailDesignCoverage(screens, noActivity).activityConsumers).toBe(false);
    const noProvider = { ...sources, shareCode: '', officialQrcode: '', miniQrcode: '', h5Share: '' };
    expect(inspectProductDetailDesignCoverage(screens, noProvider).sharePosterReferral).toBe(false);
  });
});
