import ts from 'typescript';

/** Pure source evidence only. This module neither reads files nor runs reports,
 * product code, tests, databases, or browsers. A candidate still needs actual
 * execution receipts in the caller's audit. */
export const PRODUCT_DETAIL_DESIGN_COVERAGE_GATES = [
  'adminScreen', 'contract19', 'editor18', 'previews9', 'dedicatedRoutes',
  'permissions1594', 'sharedSettingsAuthority', 'mutationProtocol', 'genericProtection',
  'actorRecovery', 'ordinarySafeDisplay', 'displayPriceIsolation', 'realReplyPreviews',
  'communityLinkedPaging', 'actualRanks', 'realPackages', 'realRecommendations',
  'navigationAndFooter', 'sharePosterReferral', 'ordinaryCartLifecycle', 'activityConsumers', 'pcSharedApi',
] as const;
export type ProductDetailDesignGate = typeof PRODUCT_DETAIL_DESIGN_COVERAGE_GATES[number];
export type ProductDetailDesignCoverage = Record<ProductDetailDesignGate, boolean>;
export function classifyProductDetailDesignCoverage(value: Partial<ProductDetailDesignCoverage>): 'missing' | 'partial' | 'candidate' {
  if (value.adminScreen !== true) return 'missing';
  return PRODUCT_DETAIL_DESIGN_COVERAGE_GATES.every(key => value[key] === true) ? 'candidate' : 'partial';
}

export function productDetailDesignSourceFiles(): Record<string, string> {
  return {
    contract: 'view/common/productDetailDesign.ts', controller: 'view/common/productDetailDesignController.ts',
    admin: 'view/admin-ts/src/pages/setting/ProductDetailDesign.vue', preview: 'view/admin-ts/src/pages/setting/ProductDetailDesignPreview.vue',
    api: 'view/admin-ts/src/api/productDetailDesign.ts', router: 'view/admin-ts/src/router/index.ts', sidebar: 'view/admin-ts/src/layouts/AdminLayout.vue',
    adminRoutes: 'workers-ts/src/routes/adminapi.ts', v1Routes: 'workers-ts/src/routes/v1/index.ts',
    permission: 'workers-ts/src/services/admin/AdminPermissionService.ts', reader: 'workers-ts/src/services/content/ProductDetailDesignReadService.ts', theme: 'workers-ts/src/services/content/ThemeReadService.ts',
    service: 'workers-ts/src/services/admin/AdminProductDetailDesignService.ts', input: 'workers-ts/src/services/admin/AdminProductDetailDesignInput.ts',
    httpController: 'workers-ts/src/controllers/api/v1/AdminProductDetailDesignController.ts', crud: 'workers-ts/src/controllers/api/v1/AdminCrudController.ts',
    publicConfig: 'workers-ts/src/services/content/V2PublicCompatibilityService.ts', data: 'workers-ts/src/services/product/ProductDetailDesignData.ts',
    products: 'workers-ts/src/services/product/StoreProductService.ts', productController: 'workers-ts/src/controllers/api/v1/ProductController.ts',
    catalog: 'workers-ts/src/services/product/PublicCatalogService.ts', reply: 'workers-ts/src/services/product/ReplyService.ts',
    replyDao: 'workers-ts/src/dao/product/ReplyDaos.ts', discount: 'workers-ts/src/services/activity/StoreDiscountService.ts',
    cart: 'workers-ts/src/services/order/StoreCartService.ts', recovery: 'view/common/categoryCatalog.ts', activity: 'workers-ts/src/services/activity/ActivityService.ts',
    integral: 'workers-ts/src/services/activity/IntegralProductReadService.ts',
    seckillSku: 'workers-ts/src/services/activity/SeckillSkuCatalogService.ts', combinationSku: 'workers-ts/src/services/activity/CombinationSkuCatalogService.ts', presaleSku: 'workers-ts/src/services/activity/PresaleSkuCatalogService.ts',
    presaleSnapshot: 'workers-ts/src/services/activity/PresaleCatalogSnapshot.ts',
    activityController: 'workers-ts/src/controllers/api/v1/UserActivityController.ts',
    seckillApi: 'view/uniapp-ts/src/api/seckill.ts', combinationApi: 'view/uniapp-ts/src/api/combination.ts', presaleApi: 'view/uniapp-ts/src/api/presale.ts',
    seckillPurchase: 'view/uniapp-ts/src/composables/useSeckillPurchase.ts', combinationPurchase: 'view/uniapp-ts/src/composables/useCombinationPurchase.ts', presalePurchase: 'view/uniapp-ts/src/composables/usePresalePurchase.ts',
    integralPurchase: 'view/uniapp-ts/src/composables/useIntegralPurchase.ts',
    newcomer: 'workers-ts/src/services/activity/StoreNewcomerService.ts', mobileData: 'view/uniapp-ts/src/api/productDetailDesign.ts',
    mobileDecoder: 'view/uniapp-ts/src/utils/productDetailDesign.ts',
    mobileProduct: 'view/uniapp-ts/src/api/productDetail.ts', orderApi: 'view/uniapp-ts/src/api/order.ts', activityApi: 'view/uniapp-ts/src/api/activity.ts', ordinary: 'view/uniapp-ts/src/pages/goods/detail.vue',
    community: 'view/uniapp-ts/src/pages/goods/productCommunity.vue', media: 'view/uniapp-ts/src/components/productDetail/ProductMedia.vue',
    activityContent: 'view/uniapp-ts/src/components/productDetail/ActivityDetailContent.vue',
    poster: 'view/uniapp-ts/src/components/productDetail/ProductSharePoster.vue', canvas: 'view/uniapp-ts/src/components/IntegralSharePoster.vue',
    share: 'view/uniapp-ts/src/utils/ordinaryShare.ts', h5Share: 'view/uniapp-ts/src/utils/ordinaryWechatShare.ts', referral: 'view/uniapp-ts/src/composables/useOrdinaryReferral.ts',
    shareCode: 'workers-ts/src/services/product/ProductShareCodeService.ts', shareCodeController: 'workers-ts/src/controllers/api/v1/ProductShareCodeController.ts',
    officialQrcode: 'workers-ts/src/services/wechat/OfficialAccountQrcodeService.ts', miniQrcode: 'workers-ts/src/services/wechat/WechatMiniProgramCodeService.ts',
    shareScene: 'workers-ts/src/services/product/ProductShareScene.ts', wechatCallback: 'workers-ts/src/services/wechat/WechatCallbackService.ts',
    collection: 'view/uniapp-ts/src/composables/useOrdinaryCollection.ts', activityDesign: 'view/uniapp-ts/src/composables/useActivityDetailDesign.ts',
    activityMenu: 'view/uniapp-ts/src/components/productDetail/ActivityDetailMenu.vue',
    seckillPage: 'view/uniapp-ts/src/pages/activity/seckillDetail.vue', combinationPage: 'view/uniapp-ts/src/pages/activity/detail.vue',
    bargainPage: 'view/uniapp-ts/src/pages/activity/bargainDetail.vue', presalePage: 'view/uniapp-ts/src/pages/activity/presaleDetail.vue',
    integralPage: 'view/uniapp-ts/src/pages/activity/integralDetail.vue', newcomerPage: 'view/uniapp-ts/src/pages/activity/newcomerDetail.vue', pc: 'view/pc-ts/src/api/product.ts',
    mobilePages: 'view/uniapp-ts/src/pages.json',
  };
}

const compact = (value: string) => value.replace(/\s+/gu, '').replace(/"/gu, "'").replace(/,(?=[\]})])/gu, '');
const printer = ts.createPrinter({ removeComments: true });
function script(source: string): string {
  const clean = source.replace(/<!--[\s\S]*?-->/gu, '');
  if (/^\s*\/\*/u.test(clean) && /\*\/\s*$/u.test(clean)) return '';
  const match = /<script\b[^>]*>([\s\S]*?)<\/script>/iu.exec(clean);
  return match ? match[1]! : clean.includes('<template>') ? '' : clean;
}
/** AST scopes prevent an import, comment, or same-named unrelated function
 * from standing in for a required call in the actual producer/consumer. */
class Source {
  readonly tree: ts.SourceFile;
  readonly code: string;
  readonly template: string;
  private readonly scopes = new Map<string, ts.Node[]>();
  private readonly bodies = new Map<string, string>();
  constructor(source = '') {
    this.tree = ts.createSourceFile('coverage.ts', script(source), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    this.code = compact(printer.printFile(this.tree));
    const markup = source.replace(/<!--[\s\S]*?-->/gu, '').split(/<script\b/iu)[0] ?? '';
    this.template = /^\s*\/\*/u.test(markup) ? '' : compact(markup);
    const add = (name: string, node: ts.Node) => this.scopes.set(name, [...(this.scopes.get(name) ?? []), node]);
    const visit = (node: ts.Node) => {
      if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node))
        && node.name && node.body) add(node.name.getText(this.tree), node.body);
      if (ts.isVariableDeclaration(node) && node.initializer) add(node.name.getText(this.tree), node.initializer);
      ts.forEachChild(node, visit);
    };
    visit(this.tree);
  }
  nodes(name: string): ts.Node[] { return this.scopes.get(name) ?? []; }
  body(name: string): string {
    if (!this.bodies.has(name)) this.bodies.set(name, this.nodes(name).map(node => compact(printer.printNode(ts.EmitHint.Unspecified, node, this.tree))).join('\n'));
    return this.bodies.get(name)!;
  }
  has(...fragments: string[]): boolean { return fragments.every(fragment => this.code.includes(compact(fragment))); }
  in(name: string, ...fragments: string[]): boolean { const body = this.body(name); return !!body && fragments.every(fragment => body.includes(compact(fragment))); }
  html(...fragments: string[]): boolean { return fragments.every(fragment => this.template.includes(compact(fragment))); }
  imports(module: string, name: string): boolean {
    return this.tree.statements.some(node => ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
      && node.moduleSpecifier.text === module && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
      && node.importClause.namedBindings.elements.some(binding => (binding.propertyName ?? binding.name).text === name));
  }
  reexports(module: string): boolean {
    return this.tree.statements.some(node => ts.isExportDeclaration(node) && !node.exportClause
      && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === module);
  }
  call(scope: string, expression: string, ...arguments_: string[]): boolean {
    let matched = false;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && compact(node.expression.getText(this.tree)) === compact(expression)
        && arguments_.every((argument, index) => !!node.arguments[index] && compact(node.arguments[index]!.getText(this.tree)) === compact(argument))) matched = true;
      ts.forEachChild(node, visit);
    };
    for (const node of this.nodes(scope)) visit(node);
    return matched;
  }
  ordered(scope: string, ...fragments: string[]): boolean {
    const body = this.body(scope); let position = -1;
    return !!body && fragments.every(fragment => { const next = body.indexOf(compact(fragment), position + 1); if (next < 0) return false; position = next; return true; });
  }
}

const expectedDefaults: Record<string, number | number[]> = {
  navList: [0, 1, 2, 3, 4], openShare: 1, pictureConfig: 0, swiperDot: 1, showPrice: [0, 1], isOpen: [0, 1, 2],
  showSvip: 1, showRank: 1, showService: [0, 1, 2, 3], showReply: 1, replyNum: 3, showMatch: 1, matchNum: 3,
  showRecommend: 1, recommendNum: 12, menuList: [0, 1, 2], showCart: 1, showCommunity: 1, communityNum: 3,
};
function literal(node: ts.Node): number | number[] | null {
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isArrayLiteralExpression(node) && node.elements.every(ts.isNumericLiteral)) return node.elements.map(value => Number((value as ts.NumericLiteral).text));
  return null;
}
export function hasProductDetailDesignContract(source: string): boolean {
  const s = new Source(source), defaults = s.nodes('defaults')[0];
  if (!defaults || !ts.isObjectLiteralExpression(defaults) || defaults.properties.length !== 19) return false;
  const values: Record<string, unknown> = {};
  for (const property of defaults.properties) {
    if (!ts.isPropertyAssignment(property)) return false;
    values[property.name.getText(s.tree)] = literal(property.initializer);
  }
  if (JSON.stringify(values) !== JSON.stringify(expectedDefaults)) return false;
  const valueInterface = s.tree.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === 'ProductDetailDesignValue');
  if (!valueInterface || !ts.isInterfaceDeclaration(valueInterface)
    || valueInterface.members.map(member => member.name?.getText(s.tree)).join(',') !== Object.keys(expectedDefaults).join(',')) return false;
  return s.in('selection', 'value.length <= maximum', 'new Set(value).size === value.length', 'Number.isSafeInteger(item)', 'item >= 0', 'item <= last')
    && s.in('isProductDetailDesignValue', 'Object.keys(record).length !== PRODUCT_DETAIL_DESIGN_KEYS.length', 'Object.hasOwn(record,key)',
      'selection(record.navList,4)', 'selection(record.showPrice,1)', 'selection(record.isOpen,5)', 'selection(record.showService,3)', 'selection(record.menuList,4,3)',
      "['replyNum',10]", "['matchNum',10]", "['recommendNum',24]", "['communityNum',10]", 'number < 1', 'number > maximum', 'record[key] !== 0 && record[key] !== 1')
    && s.in('cloneProductDetailDesign', 'PRODUCT_DETAIL_DESIGN_KEYS.map', '[...value[key]')
    && s.in('productDetailDesignPayload', "operation:'update'", 'revision', 'value:cloneProductDetailDesign(value)');
}

/** Conservative, version-specific connections. When implementations change,
 * review their real equivalent chain before updating a gate; do not pad tokens
 * or consult test declarations to manufacture coverage. */
export function inspectProductDetailDesignCoverage(screens: readonly string[], sources: Record<string, string>): ProductDetailDesignCoverage {
  const all = Object.fromEntries(Object.entries(sources).map(([role, source]) => [role, new Source(source)]));
  const s = (role: string) => all[role] ?? new Source();
  const admin = s('admin'), c = s('controller'), data = s('data'), ordinary = s('ordinary'), reader = s('reader'), service = s('service');
  let preservedHome = false;
  try {
    const pages = (JSON.parse(sources.mobilePages ?? '') as {pages?: {path?: unknown}[]}).pages;
    preservedHome = Array.isArray(pages) && pages.length >= 97 && new Set(pages.map(page=>page.path)).size===pages.length && pages[0]?.path === 'pages/index/index'
      && pages.filter(page => page.path === 'pages/goods/productCommunity').length === 1
      && pages.findIndex(page => page.path === 'pages/goods/productCommunity') > 0;
  } catch { /* An invalid page manifest cannot establish a preserved home. */ }
  const adminScreen = screens.includes('/setting/product-detail-design')
    && admin.has('new ProductDetailDesignController(', 'read:apiProductDetailDesign', 'write:apiSaveProductDetailDesign', 'receipt:apiProductDetailDesignReceipt')
    && admin.html('<ProductDetailDesignPreview', '@click="controller.save()"');
  const contract19 = hasProductDetailDesignContract(sources.contract ?? '');
  const editor18 = admin.html(...['navList','openShare','pictureConfig','swiperDot','isOpen','showService','menuList','showCart'].map(key => `data-testid="detail-control-${key}"`),
    'detail-readonly-showPrice', 'controller.toggleSelection(', 'controller.setFlag(', 'currentModule.count && controller.setCount(', ':max="currentModule.max"', 'state.draft.menuList.length >= 3')
    && admin.has(...['showSvip','showRank','showReply','showMatch','showRecommend','showCommunity'].map(key => `flag:'${key}'`),
      "count:'replyNum',countLabel:'评价数量',max:10", "count:'matchNum',countLabel:'套餐数量',max:10", "count:'recommendNum',countLabel:'商品数量',max:24", "count:'communityNum',countLabel:'内容数量',max:10")
    && c.in('toggleSelection', 'isOpen:2', "key === 'menuList' && old.length >= 3", '[...old,value]', 'old.filter(item => item !== value)')
    && !c.body('toggleSelection').includes('.sort(') && !c.body('toggleSelection').includes('newSet(');
  const previews9 = Array.from({length:9},(_,id)=>id).every(id => s('preview').html(`detail-preview-module-${id}`, `pick(${id})`))
    && s('preview').html(...['replyNum','matchNum','recommendNum','communityNum'].map(key => `v-for="n in value.${key}"`),
      'value.recommendNum > 6', 'value.showCart', 'value.pictureConfig', 'value.swiperDot', 'value.navList', 'value.menuList');
  const dedicatedRoutes = ['adminRoutes','v1Routes'].every(role => {
    const prefix = role === 'adminRoutes' ? '' : '/admin';
    return s(role).has(`.get('${prefix}/config/product-detail-design',adminAuth,AdminProductDetailDesign.read)`,
      `.post('${prefix}/config/product-detail-design/save',adminAuth,AdminProductDetailDesign.save)`,
      `.get('${prefix}/config/product-detail-design/receipt/:operationId',adminAuth,AdminProductDetailDesign.receipt)`);
  }) && s('api').has("'/config/product-detail-design'", "'/config/product-detail-design/save'", '`/config/product-detail-design/receipt/${operationId}`')
    && s('router').has("path:'setting/product-detail-design'", "alias:'/admin/setting/pages/product_detail'", "ProductDetailDesign.vue");
  const permissions1594 = s('permission').has("key:'product_detail_design'", "matches:['config/product-detail-design']", 'manage:true',
    "menu.id===1594", "menu.authType===1", "menu.menuPath==='/admin/setting/pages/product_detail'", "menu.uniqueAuth==='admin-setting-pages-product_detail'", "resolved.add('product_detail_design.view')",
    "if(menu.id===1594&&menu.authType===1&&menu.menuPath==='/admin/setting/pages/product_detail'&&menu.uniqueAuth==='admin-setting-pages-product_detail')resolved.add('product_detail_design.view')",
    "requiredAdminPermission('POST',menu.apiUrl)?.startsWith('product_detail_design.')")
    && admin.has("auth.uniqueAuth.includes('product_detail_design.view')", "auth.uniqueAuth.includes('product_detail_design.manage')")
    && s('sidebar').html("canMenu('/setting/product-detail-design')", 'index="/setting/product-detail-design"')
    && s('sidebar').in('canMenu','allowedMenuPaths.value.has(path)');
  const sharedSettingsAuthority = reader.call('read','withTx','this.container')
    && reader.in('read', 'REPEATABLE READ, READ ONLY', 'themeDeadlines(tx)', 'return readProductDetailDesignSnapshot(tx)')
    && reader.in('productDetailDesignCatalog', 'octet_length(', 'PRODUCT_DETAIL_MAX_VALUE_BYTES', 'lower(btrim(', 'DISE_TEMPLATE_TRIM_CHARACTERS', '.limit(3)', 'themeHash(', 'xmin::text')
    && reader.in('decodeProductDetailDesign','new TextEncoder().encode(value).byteLength > PRODUCT_DETAIL_MAX_VALUE_BYTES','categoryStyleNumbersExact(value)','parseLevelActivationJson(value)')
    && reader.in('mergeProductDetailDesign','for(const key of PRODUCT_DETAIL_DESIGN_KEYS)','Object.hasOwn(saved,key)','Object.assign(value,{[key]:saved[key]})')
    && reader.in('projectProductDetailDesign','catalog.rows.length!==1','row.templateName!==PRODUCT_DETAIL_TEMPLATE_NAME','row.type!==3','row.isDel!==0','isProductDetailDesignValue(value)')
    && reader.in('projectProductDetailDesign',"value:cloneProductDetailDesign(),editable:true,issues:['product_detail_missing']", "issues:['product_detail_duplicate']", "issues:['product_detail_identity_invalid']", "issues:['product_detail_value_invalid']")
    && !reader.body('projectProductDetailDesign').includes('row.status')
    && reader.in('publicProductDetailDesign','value:cloneProductDetailDesign(snapshot.value??undefined)')
    && s('publicConfig').in('productDetail','REPEATABLE READ, READ ONLY','publicProductDetailDesign(await readProductDetailDesignSnapshot(tx))','product_detail:design.value');
  const mutationProtocol = service.ordered('save','lockDiseCatalogForMutation(tx)','productDetailDesignCatalog(tx)','catalog.revision!==canonical.revision','projectProductDetailDesign(catalog).editable','tx.update(systemDise)','tx.insert(systemLog)')
    && service.call('save','lockDiseCatalogForMutation','tx') && service.call('save','productDetailDesignCatalog','tx')
    && service.call('save','tx.update','systemDise') && service.call('save','tx.insert','systemLog')
    && service.in('save','pg_advisory_xact_lock','journals[0].actor!==id','receipt.payloadHash!==payloadHash','JSON.stringify({...saved,...canonical.value})','new TextEncoder().encode(merged).byteLength>PRODUCT_DETAIL_MAX_VALUE_BYTES')
    && service.in('receipt','eq(systemLog.adminId,id)','if(!rows.length)throw new NotFoundException','parseReceipt(rows[0].action,operationId)')
    && s('input').in('productDetailDesignInput','isProductDetailDesignValue(raw.value)','productDetailDesignPayload(raw.revision,raw.value)')
    && s('input').in('productDetailDesignInput',"keys=['operationId','revision','value']",'Object.keys(raw).length!==keys.length','!keys.includes(key)','productDetailDesignOperationId(raw.operationId)')
    && s('input').in('readProductDetailDesignBody','parseLevelActivationJson(await readBoundedUtf8Text(request,8192))')
    && s('theme').in('lockDiseCatalogForMutation','LOCK TABLE ${systemDise} IN SHARE ROW EXCLUSIVE MODE')
    && s('httpController').in('save','PRODUCT_DETAIL_DESIGN_STALE_VERSION','PRODUCT_DETAIL_DESIGN_REJECTED','operationId:error.operationId','payloadHash:error.payloadHash','},status)');
  const genericProtection = s('crud').in('parseAdminDiseSaveInput','!ADMIN_DISE_ALLOWED_SAVE_KEYS.has(key)','if(unknownKeys.length)throw', "raw.create_kind !== 'diy_page'")
    && s('crud').has("const ADMIN_DISE_ALLOWED_SAVE_KEYS = new Set(['id','create_kind','name','title','value','content','status'])")
    && s('crud').in('adminDiseDeletionProtectionReason','normalizeDiseTemplateName(row.templateName)', "templateName === 'product_detail'")
    && s('crud').ordered('adminDiseDel','lockDiseCatalogForMutation(tx)','adminDiseDeletionProtectionReason(row)','if(reason)throw new ValidateException(reason)','tx.update(systemDise)')
    && s('crud').call('adminDiseDel','adminDiseDeletionProtectionReason','row')
    && s('crud').in('adminDiseList',"rows.filter(row=>!['product_detail','member'].includes(normalizeDiseTemplateName(row.templateName)))")
    && s('crud').in('adminDiseSave','type:1', "templateName:''", 'existing.type === 3', "['suspended_window','color_change','category','product_detail','member'].includes(normalizeDiseTemplateName(existing.templateName))")
    && s('theme').in('normalizeDiseTemplateName','DISE_TEMPLATE_TRIM_CHARACTERS.includes(value[start])','DISE_TEMPLATE_TRIM_CHARACTERS.includes(value[end-1])','value.slice(start,end).toLowerCase()')
    && s('crud').ordered('adminDiseSave','lockDiseCatalogForMutation(tx)','normalizeDiseTemplateName(existing.templateName)','tx.update(systemDise)');
  const actorRecovery = c.in('freezeIntent','Object.freeze(value.input.value)','Object.freeze(value.input)','Object.freeze(value)')
    && c.in('parseDetailDesignPending','row.actor !== actor','detailDesignFingerprint(input) !== row.fingerprint','JSON.stringify(input) !== JSON.stringify(row.input)')
    && c.in('definitive','actual.data.status !== actual.status', 'data.operationId === pending.input.operationId','data.payloadHash === pending.fingerprint')
    && c.in('current','stamp.actor === actor.id','stamp.identity === actor.identity','stamp.stored === actor.stored','stamp.epoch === this.epoch')
    && c.ordered('save','normalizeDetailDesignWrite({operationId,revision:s.snapshot.revision,value:s.draft})','this.ports.confirm(','this.ports.storage.setItem(key,JSON.stringify(frozen))','this.submit(frozen)')
    && c.in('load','if(s.pending)s.draft=cloneProductDetailDesign(s.pending.input.value)','this.preserveReadonly(draft,value.value)','s.syncedReadonly')
    && c.in('preserveReadonly','result.showPrice=[...current.showPrice]','draft.isOpen.filter(item => item >= 3)','current.isOpen.forEach(','result.isOpen.splice(')
    && c.in('submit','s.rejected=value','s.draft=cloneProductDetailDesign(value.input.value)','s.needsReread=true')
    && c.in('readReceipt',"response(reason)?.status === 404",'s.retryReady=true')
    && c.in('retryOriginal','this.ports.confirm(','s.pending === value','this.submit(value)')
    && c.in('invalidate','job.controller.abort()') && !c.body('invalidate').includes('removeItem(');
  const ordinarySafeDisplay = data.in('readDetailDescription','productDetailDescriptionHtml(', 'integralDescriptionAssetReferences(description)','publicProductPictures(tx,','eq(storeProductDescription.type,type)', '.limit(2)')
    && data.in('productDetailDescriptionHtml','integralDescriptionHtml(cleaned.replace(', '(script|style|template|noscript|iframe|object)')
    && data.in('readDetailVideo','product.videoOpen!==1','canonicalizePublishedAttachmentReference(product.videoLink)','normalizeExternalVideoUrl(safe)', 'asset.relationId===relation', "asset.mime.trim().toLowerCase()==='video/mp4'", 'asset.module===1','asset.file===2')
    && s('products').in('getProductDetail','videoLink:await readDetailVideo(tx,product)','renderProductPictures(this.env?.APP_KEY,[snapshot.detail.videoLink])')
    && data.in('readDetailEnsures','eq(storeProductRelation.productId,product.id)','eq(storeProductEnsure.status,1)','eq(storeProductEnsure.relationId,product.relationId)','publicProductPictures(tx,')
    && data.in('readProductDetailExtras','value.showService.includes(3)?integralDetailSpecs(product.specs,[]):[]')
    && s('mobileDecoder').in('parseProductDetailDesignData','sanitizeArticleRichText(description)','productVideo(raw.video_link ?? raw.videoLink)','rows(raw.ensure,1000)','rows(raw.specs,100)')
    && s('mobileDecoder').call('parseProductDetailDesignData','sanitizeArticleRichText','description')
    && s('mobileProduct').imports('../utils/productDetailDesign','parseProductDetailDesignData')
    && s('mobileProduct').call('normalizeMobileGoods','parseProductDetailDesignData','raw')
    && !s('mobileDecoder').has("from '@/utils/request'") && !s('mobileDecoder').has('http.get(') && !s('mobileDecoder').has('http.post(')
    && ordinary.html('<ProductMedia', ':video="skuMedia ? \'\' : display.video"', ':picture-config="design.pictureConfig"', ':dots="design.swiperDot"', 'rich-text', ':nodes="display.description"', 'display.ensure', 'display.specs')
    && s('media').html('<video', ':autoplay="false"', ':indicator-dots="dots===1"') && s('media').has('uni.getImageInfo(', 'uni.createVideoContext(');
  const displayPriceIsolation = data.in('detailDisplayPrice','showPrice.includes(0)','showPrice.includes(1)','price:useMember?memberPrice:hasLevel?levelPrice:normal')
    && s('products').in('getProductDetail','REPEATABLE READ, READ ONLY','readProductDetailExtras(tx,product,uid,','display_price:detailDisplayPrice(extras.product_detail_design.value.showPrice,row.price,row.vip_price,','price:centsToDecimal(minimum)')
    && s('mobileProduct').in('normalizeMobileGoods','display_price:normalizeDisplayQuote(sku.display_price,sku.price)', 'normalizeSkuMembershipPrice(sku)')
    && s('mobileProduct').in('normalizeDisplayQuote','quoteMoney(row.price)','cents(price)>cents(baseMoney)','!row.enabled&&(price!==baseMoney||row.price_type!==\'\')')
    && !s('mobileProduct').body('normalizeDisplayQuote').includes('cents(price)<1n')
    && s('products').in('getProductDetail','this.skuMemberPrice(row.price,row.vip_price,product.isVip,pricing)')
    && ordinary.in('displayPrice','selectedSku.value.display_price?.price')
    && s('cart').has('line.memberUnitPriceCents * line.quantity','membershipSavingsCents')
    && !s('cart').has('product_detail_design') && !s('cart').has('showPrice') && !s('discount').has('showPrice');
  const realReplyPreviews = data.in('readProductDetailExtras','replies.replyList(product.id,1,value.replyNum,uid)','replies.replyConfig(product.id)','replyCount:stats?.sum_count??0')
    && s('reply').in('replyList','this.container.replyDao.listByProduct(productId,','limit')
    && s('replyDao').in('listByProduct','eq(storeProductReply.productId,productId)','eq(storeProductReply.status,1)','eq(storeProductReply.isDel,0)','.limit(limit)')
    && s('productController').in('detail','reply:info.reply','replyCount:info.replyCount')
    && ordinary.in('load','replies.value=(goods.display?.replies??[]).slice(0,design.value.replyNum)','total:goods.display?.replyCount??0')
    && ordinary.html('v-if="design.showReply"','v-for="r in replies"');
  const communityLinkedPaging = data.in('readProductCommunity', "cr.type='community_product'",'cr.right_id=${productId}','eq(community.isVerify,1)','eq(community.isDel,0)','COUNT(*)::int','.where(eligible)','.limit(limit).offset((page-1)*limit)')
    && data.call('readProductDetailExtras','readProductCommunity','tx','product.id','1','value.communityNum')
    && s('productController').in('productCommunity','REPEATABLE READ, READ ONLY','readProductCommunity(tx,id,page,limit)')
    && s('v1Routes').has(".get('/product/:id/community'",'ProductController.productCommunity')
    && s('mobileData').in('apiProductCommunity','http.get<unknown>(`/product/${id}/community`,{page,limit})')
    && s('mobileData').imports('../utils/productDetailDesign','parseProductCommunityData')
    && s('mobileData').call('apiProductCommunity','parseProductCommunityData','await http.get<unknown>(`/product/${id}/community`,{page,limit})','limit')
    && s('community').in('load','apiProductCommunity(productId,target,10)','list.value=result.list','count.value=result.count')
    && s('community').html('page*10>=count','@tap="load(page+1)"') && ordinary.html('design.showCommunity','display.communityCount','display.community');
  const actualRanks = data.in('readRank','storeProduct.sales','storeProduct.ficti','storeProduct.star','storeProduct.collect','publicOrdinaryProductIdentitySql()','findIndex(row=>row.id===id)','rank=index+1')
    && data.call('readProductDetailExtras','readRank','tx','product.id','uid')
    && ordinary.in('goRank','display.value.rank>0','display.value.rankType','/pages/columnGoods/rank/index?type=')
    && ordinary.call('goRank','navigate','`/pages/columnGoods/rank/index?type=${display.value.rankType}`')
    && ordinary.html('design.showRank','display.rank','@tap="goRank"');
  const realPackages = data.call('readProductDetailExtras','readDetailPackages','tx','product.id','value.matchNum','member')
    && data.in('readDetailPackages','eq(storeDiscountsProducts.productId,productId)','eq(storeDiscounts.status,1)','eq(storeDiscounts.isDel,0)','.limit(limit)','products.length!==ids.length')
    && ordinary.in('load','apiDiscountPackages(id)','packages.slice(0,design.value.matchNum)')
    && ordinary.in('buyPackage','apiDiscountCartAdd(','prepareProductCart(result,5,selected.length)')
    && s('orderApi').in('apiDiscountCartAdd', "http.post('/cart/add',{...params,type:5,new:1})")
    && s('discount').in('createDirectBuyCarts','resolveDiscountPackageSelection(scoped,')
    && s('discount').in('resolveDiscountPackageSelection','isDiscountPackageAvailable(discount,params.now)','packageSku.stock < 1 || baseSku.stock < 1','parseAmountToCents(packageSku.price)','priceCents === null')
    && ordinary.html('design.showMatch','discountPackages');
  const realRecommendations = data.call('readProductDetailExtras','readDetailRecommendations','tx','product','value.recommendNum','member')
    && data.call('readDetailRecommendations','rawCards','tx',"integralDetailIds(product.recommendList,[],'recommend_reference_invalid')",'limit','member')
    && data.in('rawCards','publicOrdinaryProductIdentitySql()','.limit(limit)')
    && ordinary.in('recommendations','display.value.recommend.slice(0,design.value.recommendNum)')
    && ordinary.in('recommendationColumns','i+=2','list.slice(i,i+2)')
    && ordinary.html('design.showRecommend','design.recommendNum<=6','v-for="column in recommendationColumns"');
  const navigationAndFooter = preservedHome && ordinary.in('navEntries','design.value.navList.map(') && ordinary.in('footerEntries','design.value.menuList.map(')
    && ordinary.in('openNav','!design.value.navList.includes(id)','switchPage(','goCart()')
    && ordinary.in('footerAction','!design.value.menuList.includes(id)','openShare()','toggleCollection()','/pages/user/kefu?productId=','goCart()')
    && ordinary.in('confirmSku',"skuMode.value==='cart'&&(!design.value.showCart||detail.value.cart_button!==1)")
    && ordinary.html('v-if="design.showCart && detail.cart_button === 1"','design.openShare')
    && s('mobileData').in('apiProductMarketing','http.get<unknown>(`/product/detail/activity/${id}`)')
    && s('mobileData').imports('../utils/productDetailDesign','parseProductMarketingData')
    && s('mobileData').call('apiProductMarketing','parseProductMarketingData','await http.get<unknown>(`/product/detail/activity/${id}`)')
    && ordinary.call('retryMarketing','apiProductMarketing','detail.value.id')
    && s('catalog').in('productActivity','REPEATABLE READ, READ ONLY','productActivityInSnapshot(')
    && s('catalog').in('productActivityInSnapshot','readProductDetailDesignSnapshot(this.container.db)','const showService = design.showService', 'showService.some((value) => value === 0)')
    && s('collection').in('toggleCollection',"http.post('/collect/del',{id:[product.id],category:'product'})", "http.post('/collect/add',{id:product.id,category:'product'})", 'owner.uid===auth.uid', 'owner.token===auth.token');
  const sharePosterReferral = ordinary.call('sharePath','ordinarySharePath','productId','authStore.isLoggedIn?authStore.uid:0')
    && ordinary.call('appShare','shareOrdinaryInApp') && ordinary.html('<ProductSharePoster', ':url="shareUrl"', ':price="displayPrice', 'display.posterTitle')
    && s('share').in('shareOrdinaryInApp','uni.getProvider(','uni.share(','current()','success:','fail:')
    && s('canvas').has('qr.addData(props.url)','qr.make()','context.drawImage(','uni.canvasToTempFilePath(', 'uni.saveImageToPhotosAlbum(', 'generation')
    && s('poster').html('<IntegralSharePoster', ':url="url"', ':price="price"', ':quote-text=', 'canvas-id="ordinary-share-poster"')
    && s('referral').in('same','value.uid===auth.uid','value.token===auth.token','value.version===auth.sessionVersion')
    && s('referral').ordered('consume','visit.started=true','apiBindSpread(visit.spid)')
    && s('referral').in('disposeReferral','intent.retired=true')
    && ordinary.has('useOrdinaryReferral(', 'disposeReferral()') && ordinary.in('copyShare','uni.setClipboardData(','success:','fail:')
    && ordinary.in('officialCodeKind', "ordinaryWechatBrowser()&&display.value.shareQrcode===1?'wechat':''", "return 'routine'")
    && ordinary.ordered('loadOfficialCode','const owner=currentView()','await apiProductShareCode(id,kind)','if(current())officialCode.value=code')
    && ordinary.in('loadOfficialCode','epoch===codeGeneration','officialCodeKind()===kind','!authStore.isLoggedIn')
    && ordinary.in('wechatShare','epoch===shareGeneration','configureOrdinaryWechatShare(','if(current())')
    && ordinary.html(':qr-image="officialCode"','(!officialCodeKind() || officialCode)')
    && s('poster').html(':qr-image="qrImage"')
    && s('mobileData').in('apiProductShareCode','http.get<unknown>(`/product/code/${id}`,{user_type:kind})')
    && s('mobileData').imports('../utils/productDetailDesign','productShareCode')
    && s('mobileData').call('apiProductShareCode','productShareCode','(value as Record<string,unknown>).code','kind')
    && s('mobileDecoder').in('productShareCode',"kind==='routine'",'data:image', "address.origin!=='https://mp.weixin.qq.com'", "address.pathname!=='/cgi-bin/showqrcode'",'address.username','address.password')
    && s('canvas').in('draw','imageInfo(productShareCode(props.qrImage,', 'if(officialImage)context.drawImage(officialImage,60,345,200,200)', 'disposed || current !== generation')
    && (s('v1Routes').has(".get('/product/code/:id',authForce,ProductShareCode.code)") || s('v1Routes').has(".get('/product/code/:id',authForce,ProductShareCodeController.code)")
      || s('v1Routes').has(".get('/product/code/:id',authMiddleware({force:true}),ProductShareCode.code)"))
    && s('shareCodeController').in('code','c.get(\'uid\')??0','categoryPublicId(c.req.param(\'id\'))','new ProductShareCodeService(',"Cache-Control",'private, no-store')
    && s('shareCode').in('snapshot','REPEATABLE READ, READ ONLY','themeDeadlines(tx)','eq(user.uid,uid)','eq(user.status,1)','eq(user.isDel,0)','publicOrdinaryProductIdentitySql()',
      'eq(systemConfig.isStore,0)', 'eq(systemConfig.menuName,\'share_qrcode\')', 'orderBy(desc(systemConfig.sort),desc(systemConfig.id)).limit(1001)',
      'rows.length>1000', 'JSON.parse(raw)', "typeof parsed==='string'||typeof parsed==='number'?String(parsed):''", "official=value==='1'")
    && s('shareCode').in('code','this.snapshot(id,uid)', 'createOrdinaryProductDataUrl(id,uid)', 'snapshot.official&&isWechat', 'createProductShareScene(id,uid,this.env.APP_KEY)', 'requestTemporaryProduct(scene)', 'throw new ServiceUnavailableException(')
    && s('shareCode').in('url',"new URL('/',origin)", 'new URLSearchParams({id:String(id),spid:String(uid)})', "url.hash='/pages/goods/detail?'+query.toString()", 'return url.href')
    && s('shareCode').call('news','this.url','verified.id','verified.uid')
    && s('shareCode').in('news','verifyProductShareScene(scene,this.env.APP_KEY)','this.snapshot(verified.id,verified.uid)','this.url(verified.id,verified.uid)',"type:'news'",'snapshot.product.storeName')
    && s('shareScene').in('signature',"crypto.subtle.sign('HMAC'", "ordinary-product-share:")
    && s('shareScene').in('verifyProductShareScene','expires<=now','expires>now+PRODUCT_SHARE_TTL_SECONDS','difference===0?{id,uid,expires}:null')
    && s('wechatCallback').in('resolveReply',"callback.source !== 'official'", "['subscribe','scan'].includes(callback.eventType)",'new ProductShareCodeService(this.container,this.env).news(callback.payload.eventKey)','if(news)return news')
    && s('officialQrcode').in('requestTemporaryProduct','boundedProductShareFetch(this.fetcher)','https://api.weixin.qq.com/cgi-bin/qrcode/create',"action_name:'QR_STR_SCENE'",'scene_str:scene','readBoundedJson(response)','https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=')
    && s('miniQrcode').in('createOrdinaryProductDataUrl','const scene=`id=${productId}&spid=${uid}`','new TextEncoder().encode(scene).byteLength>32','boundedProductShareFetch(this.fetcher)', "fetchUnlimitedCode(token,scene,'pages/goods/detail'", 'bytesToBase64(code.bytes)')
    && s('h5Share').in('signingUrl',"current.protocol!=='https:'", "current.hash=''")
    && s('h5Share').in('configureOrdinaryWechatShare',"http.get<unknown>('/wechat/config',{url:signatureUrl})", 'signingUrl()!==signatureUrl','sdk.error(', 'sdk.ready(', 'sdk.config(',
      'sdk.updateAppMessageShareData(options)','sdk.updateTimelineShareData(options)','sdk.onMenuShareAppMessage?.(options)','sdk.onMenuShareTimeline?.(options)','fail:()=>{if(same())complete(')
    && s('h5Share').call('configureOrdinaryWechatShare','sdk.updateAppMessageShareData','options')
    && s('h5Share').call('configureOrdinaryWechatShare','sdk.updateTimelineShareData','options')
    && s('h5Share').call('usableSdk', "['config','ready','error','updateAppMessageShareData','updateTimelineShareData'].every", "method=>typeof sdk[method]==='function'")
    && s('h5Share').in('usableSdk', "['onMenuShareAppMessage','onMenuShareTimeline'].every(method=>sdk[method]===undefined||typeof sdk[method]==='function')")
    && s('h5Share').call('loadSdk','usableSdk','browser.wx')
    && s('h5Share').in('loadSdk','if(usableSdk(browser.wx))return Promise.resolve(browser.wx)', 'script.onload=()=>{finish();usableSdk(browser.wx)?resolve(browser.wx):reject(')
    && s('h5Share').in('loadSdk','script.src=ORDINARY_WECHAT_SDK_URL','script.onload=','script.onerror=')
    && s('h5Share').has("ORDINARY_WECHAT_SDK_URL='https://res.wx.qq.com/open/js/jweixin-1.6.0.js'");
  const ordinaryCartLifecycle = ordinary.ordered('confirmSku',"state:'unknown'",'uni.setStorageSync(ordinaryRecoveryKey(frozen.actor),JSON.stringify(frozen))','await apiCartAdd(',"state:'acknowledged',cartId:prepared.ids[0]",'uni.setStorageSync(ordinaryRecoveryKey(frozen.actor),JSON.stringify(acknowledged))','resumeCheckout()')
    && ordinary.in('restoreOrdinaryRecovery','parseOrdinaryRecovery(raw,authStore.uid)', "row.state==='acknowledged'&&row.mode==='buy'",'prepareProductCart({id:row.cartId},0)')
    && ordinary.in('resumeCheckout','prepared.ids[0]','preparedCart.value === prepared')
    && ordinary.in('currentView','owner.version === authStore.sessionVersion','owner.token === authStore.token','owner.uid === authStore.uid','visible.value')
    && s('recovery').in('parseOrdinaryRecovery','row.actor !== actor',"row.state === 'unknown' && row.cartId !== null", "row.state === 'acknowledged' && (!Number.isSafeInteger(row.cartId)")
    && !ordinary.body('clearView').includes('removeStorageSync(') && ordinary.has('onHide(', 'onUnload(')
    && ordinary.ordered('receiveCoupon','await apiCouponReceive(id)','receivedCoupons.value.push(id)')
    && ordinary.in('receiveCoupon','const current=currentView()', 'if(current())')
    && s('orderApi').call('apiCartAdd','http.post',"'/cart/add'",'params as Record<string,unknown>')
    && s('activityApi').call('apiCouponReceive','http.post',"'/coupon/receive'",'{id}');
  const activityConsumers = data.in('readActivityDetailDesign','publicOrdinaryProductIdentitySql()','readProductDetailDesignSnapshot(tx)',
    '(activityType===6?design.showService.includes(3):!design.showService.includes(3))?integralDetailSpecs(activity.specs??base.specs,[]):[]',
    'replyService.replyList(base.id,1,design.replyNum,uid)','replyService.replyConfig(base.id)','activityType===6||activityType===7',
    'readDetailDescription(tx,baseDescription?base.id:activity.id,baseDescription?0:activityType,base)',
    'ensure=design.showService.includes(2)?await readDetailEnsures(tx,product):[]','gallery.length>20','replyCount:stats?.sum_count??0')
    && data.call('readActivityDetailDesign','readProductDetailDesignSnapshot','tx')
    && data.call('readActivityDetailDesign','readDetailEnsures','tx','product')
    && data.call('readActivityDetailDesign','replyService.replyList','base.id','1','design.replyNum','uid')
    && data.call('readActivityDetailDesign','replyService.replyConfig','base.id')
    && data.call('readActivityDetailDesign','readDetailDescription','tx','baseDescription?base.id:activity.id','baseDescription?0:activityType','base')
    && data.call('renderActivityDetailDesign','renderDetailDescription','appKey','result.description')
    && data.call('renderActivityDetailDesign','renderProductPictures','appKey','refs')
    && s('activity').in('seckillDetail','REPEATABLE READ, READ ONLY','seckillDetailSnapshot(id,now)')
    && s('activity').call('seckillDetailSnapshot','readActivityDetailDesign')
    && s('newcomer').in('detail','REPEATABLE READ, READ ONLY','renderActivityDetailDesign(')
    && s('newcomer').call('detailInSnapshot','readActivityDetailDesign')
    && s('activityDesign').in('reloadActivityDesign',"http.get<unknown>('/v2/diy/product_detail')", 'isProductDetailDesignValue(', 'cloneProductDetailDesign(')
    && s('activity').in('combinationDetail','REPEATABLE READ, READ ONLY', 'design:await readActivityDetailDesign(tx,item,3,0)', 'renderActivityDetailDesign(this.env?.APP_KEY,result.design)')
    && s('integral').in('read','REPEATABLE READ, READ ONLY', 'readIntegralProductSnapshot(tx,id)')
    && s('integral').in('readIntegralProductSnapshot','publicProductDetailDesign(await readProductDetailDesignSnapshot(tx))','!showService.includes(3)?integralDetailSpecs(activity.specs,issues):[]')
    && ['bargainPage','newcomerPage'].every(role => s(role).has('useActivityDetailDesign()')
      && s(role).html('<ProductMedia', 'activityDesign.pictureConfig', 'activityDesign.swiperDot', '<ActivityDetailMenu', ':menu="activityDesign.menuList"'))
    // The unified legacy activity page also rendered these data modules.
    // Geometry/menu alone cannot close this axis; independent bargain does
    // not stand in for type1/3/4/7's actual description/ensure/specs/replies.
    && ['seckillPage','combinationPage','presalePage','integralPage'].every(role => s(role).html('<ProductMedia', '<ActivityDetailMenu', '<ActivityDetailContent', ':data="detail.detailDisplay.data"',
      'detail.detailDisplay.data.design.pictureConfig','detail.detailDisplay.data.design.swiperDot','detail.detailDisplay.data.design.menuList'))
    && s('activityContent').html(':nodes="data.description"', 'data.design.showService.includes(2)', '!data.design.showService.includes(3)', 'data.design.showReply',
      'data.replies.slice(0,data.design.replyNum)','data.replyCount','data.replyChance','v-for="ensure in data.ensure"','v-for="(spec,index) in data.specs"',
      "specsMode==='included'?data.design.showService.includes(3):!data.design.showService.includes(3)")
    && s('activityContent').in('openService','props.data.design.showService.includes(2)', 'service.value=true')
    && s('activityContent').in('navigate','uni.navigateTo({url,fail})','owner.uid===auth.uid','owner.token===auth.token')
    && s('integralPage').html(':review-module="false"')
    && s('presalePage').html('specs-mode="included"')
    && s('mobileDecoder').in('parseActivityDetailProjection','parseProductDetailDesignData({...raw,...content,id:productId})','images:images.map(media).filter(Boolean)','images.length>galleryLimit')
    && s('mobileDecoder').call('parseActivityDetailProjection','parseProductDetailDesignData','{...raw,...content,id:productId}')
    && s('mobileData').reexports('../utils/productDetailDesign')
    && ['seckillApi','combinationApi','presaleApi','activityApi'].every(role=>s(role).imports('./productDetailDesign','parseActivityDetailProjection'))
    && s('activityApi').in('apiIntegralDetail','parseIntegralDetail(raw,id)','detailDisplay:parseActivityDetailProjection(raw,selection.storeInfo.productId,content,1000)')
    && s('seckillApi').in('apiSeckillSelection',"http.get<unknown>(`/seckill/detail/${id}`,{view:'skus'})",'detailDisplay:parseActivityDetailProjection(raw,selection.product_id)')
    && s('combinationApi').in('apiCombinationSelection',"view:'skus'",'detailDisplay:parseActivityDetailProjection(raw,selection.product_id)')
    && s('presaleApi').in('apiPresaleSelection',"http.get<unknown>(`/product/detail/${id}`,{view:'presale'})",'detailDisplay:parseActivityDetailProjection(raw,selection.product_id)')
    && s('activityController').in('seckillDetail', "view!=='skus'", "return jsonOk(c,await new SeckillSkuCatalogService(c.get('container'),c.env).read(c.get('uid')??0,c.req.param('id')))")
    && s('activityController').in('combinationDetail', "view!=='skus'", "return jsonOk(c,await new CombinationSkuCatalogService(c.get('container'),c.env).read(c.get('uid')??0,c.req.param('id'),pinkId))")
    && s('productController').in('detail', "c.req.query('view')!=='presale'", "return jsonOk(c,await new PresaleSkuCatalogService(c.get('container'),c.env).read(c.get('uid')??0,c.req.param('id')))")
    && ['seckillSku','combinationSku'].every(role => s(role).call('read','withTx','this.container')
      && s(role).in('read','REPEATABLE READ, READ ONLY','themeDeadlines(tx)', 'createContainerFromDb(tx),this.env).snapshot('))
    && s('presaleSku').call('read','withPresaleCatalogSnapshot','this.container')
    && s('presaleSnapshot').call('withPresaleCatalogSnapshot','withTx','container')
    && s('presaleSnapshot').in('withPresaleCatalogSnapshot','REPEATABLE READ, READ ONLY','statement_timeout','idle_in_transaction_session_timeout','return read(createContainerFromDb(tx))')
    && s('seckillSku').call('snapshot','readActivityDetailDesign','this.container.db','entry','1','uid')
    && s('combinationSku').call('snapshot','readActivityDetailDesign','this.container.db','entry','3','uid')
    && s('presaleSku').call('snapshot','readActivityDetailDesign','this.container.db','{...product,productId:id,images:JSON.stringify(images(product.sliderImage,product.image))}','6','uid')
    && s('presaleSku').in('images','raw.length<=65536','JSON.parse(raw)','parsed.slice(0,20).map(imageUrl).filter(Boolean)','new Set([imageUrl(primary),...values].filter(Boolean))','slice(0,20)')
    && ['seckillSku','combinationSku','presaleSku'].every(role => s(role).in('snapshot','return {design,selection:', 'publicProductPictures(this.container.db,')
      && s(role).call('read','renderActivityDetailDesign','this.env?.APP_KEY','result.design')
      && s(role).in('read','return {...result.selection,...display,skus:','renderProductPictures(this.env?.APP_KEY,result.selection.skus.map(row=>row.image))'))
    && [['seckillPurchase','apiSeckillSelection'],['combinationPurchase','apiCombinationSelection'],['presalePurchase','apiPresaleSelection'],['integralPurchase','apiIntegralDetail']].every(([role,api]) => s(role!).call('load',api!) && s(role!).in('load','detail.value=result'))
    && ['seckillPage','combinationPage','presalePage'].every(role=>s(role).in('activityGallery','detail.value.detailDisplay.images') && s(role).html(':images="activityGallery"'))
    && s('integralPage').in('gallery','detail.value?.storeInfo.images') && s('integralPage').html(':images="gallery"')
    && s('activityMenu').in('act','!props.menu.includes(id)', 'uni.switchTab(', 'uni.setClipboardData(', 'apiGoodsDetail(props.productId)');
  const pcSharedApi = s('pc').has('normalizeGoodsDetail(await getData<unknown>(request.get(`/product/detail/${id}`)))')
    && s('productController').in('detail','svc.getProductDetail(')
    && s('products').in('getProductDetail','readProductDetailExtras(tx,product,uid,','renderProductDetailExtras(this.env,')
    && s('v1Routes').has(".get('/product/detail/:id'", 'ProductController.detail');
  return {adminScreen,contract19,editor18,previews9,dedicatedRoutes,permissions1594,sharedSettingsAuthority,mutationProtocol,genericProtection,
    actorRecovery,ordinarySafeDisplay,displayPriceIsolation,realReplyPreviews,communityLinkedPaging,actualRanks,realPackages,realRecommendations,
    navigationAndFooter,sharePosterReferral,ordinaryCartLifecycle,activityConsumers,pcSharedApi};
}
