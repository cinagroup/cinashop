import ts from 'typescript';

/** Connected source evidence only. Runtime, SQL/JWT, browser, native/provider
 * and deployment receipts remain independent acceptance inputs. */
export const USER_CENTER_DESIGN_COVERAGE_GATES = [
  'adminScreen', 'sixBlockContract', 'memberEditor', 'orderStatisticsEditor',
  'listEditors', 'previewsSix', 'assetLinkPicker', 'dedicatedRoutes',
  'permissions1592', 'sharedThreeAuthority', 'atomicMutation', 'merchantImmutable',
  'genericProtection', 'actorRecovery', 'publicProjection', 'realNineAssets',
  'memberFiveStyles', 'orderThreeStyles', 'statisticsTwoStyles', 'posterCarousel',
  'menuThreeStyles', 'menuRoleGates', 'videoCollections', 'memberCode',
  'userLifecycle', 'requestDeadline',
] as const;
export type UserCenterDesignGate = typeof USER_CENTER_DESIGN_COVERAGE_GATES[number];
export type UserCenterDesignCoverage = Record<UserCenterDesignGate, boolean>;
export function classifyUserCenterDesignCoverage(value: Partial<UserCenterDesignCoverage>): 'missing' | 'partial' | 'candidate' {
  if (value.adminScreen !== true) return 'missing';
  return USER_CENTER_DESIGN_COVERAGE_GATES.every(key => value[key] === true) ? 'candidate' : 'partial';
}
export function userCenterDesignSourceFiles(): Record<string, string> {
  return {
    contract: 'view/common/userCenterDesign.ts', controller: 'view/common/userCenterDesignController.ts',
    admin: 'view/admin-ts/src/pages/setting/UserCenterDesign.vue', preview: 'view/admin-ts/src/pages/setting/UserCenterDesignPreview.vue',
    picker: 'view/admin-ts/src/pages/setting/UserCenterDesignPicker.vue', api: 'view/admin-ts/src/api/userCenterDesign.ts',
    router: 'view/admin-ts/src/router/index.ts', sidebar: 'view/admin-ts/src/layouts/AdminLayout.vue',
    adminRoutes: 'workers-ts/src/routes/adminapi.ts', v1Routes: 'workers-ts/src/routes/v1/index.ts',
    permission: 'workers-ts/src/services/admin/AdminPermissionService.ts', input: 'workers-ts/src/services/admin/AdminUserCenterDesignInput.ts',
    service: 'workers-ts/src/services/admin/AdminUserCenterDesignService.ts', httpController: 'workers-ts/src/controllers/api/v1/AdminUserCenterDesignController.ts',
    reader: 'workers-ts/src/services/content/UserCenterDesignReadService.ts', publicReader: 'workers-ts/src/services/content/UserCenterPublicReadService.ts',
    catalog: 'workers-ts/src/services/admin/AdminUserCenterCatalogService.ts', publicCatalog: 'workers-ts/src/services/product/PublicCatalogService.ts',
    crud: 'workers-ts/src/controllers/api/v1/AdminCrudController.ts', pcBanner: 'workers-ts/src/services/admin/AdminPcBannerService.ts',
    signDay: 'workers-ts/src/services/admin/AdminSignDayConfigService.ts', recharge: 'workers-ts/src/services/admin/AdminRechargeQuotaService.ts',
    finance: 'workers-ts/src/services/user/UserFinanceReadService.ts', profile: 'workers-ts/src/services/user/UserProfileService.ts',
    profileController: 'workers-ts/src/controllers/api/v1/UserProfileController.ts', operator: 'workers-ts/src/services/order/StoreOrderWriteoffService.ts',
    collectionService: 'workers-ts/src/services/user/UserCollectCompatibilityService.ts',
    collectionController: 'workers-ts/src/controllers/api/v1/UserActivityController.ts',
    mobile: 'view/uniapp-ts/src/pages/user/index.vue', mobileConsumer: 'view/uniapp-ts/src/composables/useUserCenter.ts',
    mobileDecoder: 'view/uniapp-ts/src/utils/userCenter.ts', mobileApi: 'view/uniapp-ts/src/api/userCenter.ts',
    menus: 'view/uniapp-ts/src/components/userCenter/UserCenterMenus.vue', collection: 'view/uniapp-ts/src/pages/user/collect.vue',
    collectionConsumer: 'view/uniapp-ts/src/composables/useUserCollections.ts',
    memberCodePage: 'view/uniapp-ts/src/pages/user/memberCode.vue', navigation: 'view/uniapp-ts/src/config/navigation.ts',
    pages: 'view/uniapp-ts/src/pages.json', orderList: 'view/uniapp-ts/src/pages/order/list.vue',
    managerStatistics:'workers-ts/src/services/store/StoreManagerOrderStatisticsService.ts', managerScope:'workers-ts/src/services/store/StoreManagerScope.ts',
    managerInput:'workers-ts/src/services/store/StoreManagerOrderInput.ts', managerController:'workers-ts/src/controllers/api/v1/StoreManagerOrderController.ts',
    merchantConsumer:'view/uniapp-ts/src/composables/useMerchantOrders.ts', merchantStatsPage:'view/uniapp-ts/src/pages/merchant/statistics.vue',
    merchantOrdersPage:'view/uniapp-ts/src/pages/merchant/orders.vue', merchantApi:'view/uniapp-ts/src/api/merchantOrders.ts',
    merchantDecoder:'view/uniapp-ts/src/utils/merchantOrders.ts', workerRegistry:'workers-ts/src/services/content/FabRouteRegistry.ts',
  };
}
const compact = (value: string) => value.replace(/\s+/gu, '').replace(/"/gu, "'").replace(/,(?=[\]})])/gu, '');
const printer = ts.createPrinter({ removeComments: true });
class Source {
  readonly tree: ts.SourceFile;
  readonly code: string;
  readonly template: string;
  readonly css: string;
  private readonly scopes = new Map<string, ts.Node[]>();
  private readonly tags: Array<{ name: string; attributes: Map<string, string> }> = [];
  constructor(source = '') {
    const clean = /^\s*\/\*[\s\S]*\*\/\s*$/u.test(source) ? '' : source.replace(/<!--[\s\S]*?-->/gu, '');
    const script = /<script\b[^>]*>([\s\S]*?)<\/script>/iu.exec(clean);
    const sourceScript = script ? script[1]! : clean.includes('<template') ? '' : clean;
    this.tree = ts.createSourceFile('coverage.ts', sourceScript, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    this.code = compact(printer.printFile(this.tree));
    const head = clean.split(/<script\b|<style\b/iu)[0] ?? '';
    this.template = head.includes('<template') ? compact(head) : '';
    this.css = compact([...clean.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/giu)].map(match => match[1]).join('\n').replace(/\/\*[\s\S]*?\*\//gu, ''));
    const add = (name: string, node: ts.Node) => this.scopes.set(name, [...(this.scopes.get(name) ?? []), node]);
    const visit = (node: ts.Node) => {
      if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node)) && node.name && node.body) add(node.name.getText(this.tree), node.body);
      if (ts.isVariableDeclaration(node) && node.initializer) add(node.name.getText(this.tree), node.initializer);
      ts.forEachChild(node, visit);
    };
    visit(this.tree);
    for (const match of head.matchAll(/<([a-z][\w.-]*)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/giu)) {
      const attributes = new Map<string, string>();
      for (const attribute of match[2]!.matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) attributes.set(attribute[1]!, compact(attribute[2] ?? attribute[3] ?? ''));
      this.tags.push({ name: match[1]!, attributes });
    }
  }
  nodes(scope: string): ts.Node[] { return scope === '$root' ? [this.tree] : this.scopes.get(scope) ?? []; }
  body(scope: string): string { return this.nodes(scope).map(node => compact(printer.printNode(ts.EmitHint.Unspecified, node, this.tree))).join('\n'); }
  in(scope: string, ...fragments: string[]): boolean { const body = this.body(scope); return !!body && fragments.every(fragment => body.includes(compact(fragment))); }
  ordered(scope: string, ...fragments: string[]): boolean { let position = -1; const body = this.body(scope); return !!body && fragments.every(fragment => { const next = body.indexOf(compact(fragment), position + 1); if (next < 0) return false; position = next; return true; }); }
  call(scope: string, expression: string, ...args: string[]): boolean {
    let found = false;
    const visit = (node: ts.Node) => { if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && compact(node.expression.getText(this.tree)) === compact(ts.isNewExpression(node) ? expression.replace(/^new\s+/u, '') : expression) && args.every((arg, i) => !!node.arguments?.[i] && compact(node.arguments[i]!.getText(this.tree)) === compact(arg))) found = true; ts.forEachChild(node, visit); };
    this.nodes(scope).forEach(visit); return found;
  }
  binding(tag: string, attribute: string, expression: string): boolean { return this.tags.some(row => (tag === '*' || row.name === tag) && row.attributes.get(attribute) === compact(expression)); }
  html(...fragments: string[]): boolean { return !!this.template && fragments.every(fragment => this.template.includes(compact(fragment))); }
  styles(...fragments: string[]): boolean { return fragments.every(fragment => this.css.includes(compact(fragment))); }
  parameter(scope: string, name: string, initializer: number): boolean {
    let found = false;
    const visit = (node: ts.Node) => { if (ts.isFunctionDeclaration(node) && node.name?.text === scope && node.parameters.some(param => param.name.getText(this.tree) === name && !!param.initializer && literal(param.initializer) === initializer)) found = true; ts.forEachChild(node, visit); };
    visit(this.tree); return found;
  }
  routeMatching(pattern: RegExp): boolean {
    let found = false;
    const visit = (node: ts.Node) => { if (ts.isCallExpression(node) && /^(?:adminapiRoutes|v1Routes)\.(?:post|put|delete|patch)$/u.test(node.expression.getText(this.tree)) && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && pattern.test(node.arguments[0].text)) found = true; ts.forEachChild(node, visit); };
    visit(this.tree); return found;
  }
  rule(key: string, coverage: string): boolean {
    let found = false;
    const visit = (node: ts.Node) => { if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name) && node.name.text === key && ts.isObjectLiteralExpression(node.initializer) && node.initializer.properties.some(property => ts.isPropertyAssignment(property) && property.name.getText(this.tree) === 'coverage' && ts.isStringLiteral(property.initializer) && property.initializer.text === coverage)) found = true; ts.forEachChild(node, visit); };
    this.nodes('LEGACY_ROUTE_RULES').forEach(visit); return found;
  }
  conditionalCall(scope: string, condition: string, expression: string, argument: string): boolean {
    let found = false;
    const call = (node: ts.Node) => { if (ts.isCallExpression(node) && compact(node.expression.getText(this.tree)) === compact(expression) && !!node.arguments[0] && compact(node.arguments[0].getText(this.tree)) === compact(argument)) found = true; ts.forEachChild(node, call); };
    const visit = (node: ts.Node) => { if (ts.isIfStatement(node) && compact(node.expression.getText(this.tree)) === compact(condition)) call(node.thenStatement); ts.forEachChild(node, visit); };
    this.nodes(scope).forEach(visit); return found;
  }
  callbackCall(scope: string, outer: string, inner: string): boolean {
    let found = false;
    const child = (node: ts.Node) => { if (ts.isCallExpression(node) && compact(node.expression.getText(this.tree)) === compact(inner)) found = true; ts.forEachChild(node, child); };
    const visit = (node: ts.Node) => { if (ts.isCallExpression(node) && compact(node.expression.getText(this.tree)) === compact(outer) && node.arguments[0] && (ts.isArrowFunction(node.arguments[0]) || ts.isFunctionExpression(node.arguments[0]))) child(node.arguments[0].body); ts.forEachChild(node, visit); };
    this.nodes(scope).forEach(visit); return found;
  }
}
function literal(node: ts.Node): unknown {
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literal);
  if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties.map(property => ts.isPropertyAssignment(property) ? [property.name.getText().replace(/^['"]|['"]$/gu, ''), literal(property.initializer)] : ['', undefined]));
  return undefined;
}
export function hasUserCenterDesignContract(source: string): boolean {
  const s = new Source(source), defaults = s.nodes('defaults')[0];
  const expected = { member: { style: 1, property: [0, 1, 2, 3, 4], per_show_type: 0 }, order: { style: 1 }, orderStatic: { style: 1, is_show: 1 }, poster: { is_show: 1, list: [] }, menu: { title: '我的服务', is_show: 1, style: 1, list: [] }, merMenu: { title: '商家管理', is_show: 1, style: 1, list: [] } };
  const shape = s.tree.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === 'UserCenterDesignValue');
  return !!defaults && JSON.stringify(literal(defaults)) === JSON.stringify(expected) && !!shape && ts.isInterfaceDeclaration(shape)
    && shape.members.map(member => member.name?.getText(s.tree)).join(',') === Object.keys(expected).join(',')
    && s.call('design', 'keys', 'value', 'USER_CENTER_DESIGN_KEYS') && s.call('isUserCenterDesignValue', 'design', 'value', 'false')
    && s.call('isPublicUserCenterDesignValue', 'design', 'value', 'true') && s.in('design', 'integer(member.style,1,5)', 'toggle(member.per_show_type)', 'integer(id,0,8)', 'new Set(member.property).size!==member.property.length', 'integer(order.style,1,3)', 'integer(orderStatic.style,1,2)', 'USER_CENTER_DESIGN_LIMITS.posterItems', 'USER_CENTER_DESIGN_LIMITS.menuItems', 'USER_CENTER_DESIGN_LIMITS.merMenuItems')
    && s.in('item', "['sourceId','name','pic','url']", "['name','pic','url']", 'value.type===merchantType') && s.call('item', 'isUserCenterPublicImage', 'value.pic')
    && s.call('userCenterDesignPayload', 'cloneUserCenterDesign', 'value') && s.in('cloneUserCenterDesign', 'per_show_type:value.member.per_show_type', 'value.poster.list.map(copyPoster)', 'value.merMenu.list.map(copyMenu)');
}

/** Each positive checks calls inside its producer/consumer and live template
 * attributes. A comment, import, same word elsewhere or a fake call string
 * cannot replace the required AST CallExpression. */
export function inspectUserCenterDesignCoverage(screens: string[], sources: Record<string, string>): UserCenterDesignCoverage {
  const s = Object.fromEntries(Object.entries(userCenterDesignSourceFiles()).map(([role]) => [role, new Source(sources[role] ?? '')]));
  const { contract:c, controller:ctl, admin:a, preview:p, picker:k, api, router:r, sidebar, adminRoutes:ar, v1Routes:vr, permission:perm, input, service:w, httpController:hc, reader:read, publicReader:pub, catalog:cat, publicCatalog:pc, crud, pcBanner, signDay, recharge, profile, profileController, operator, collectionService:cs, collectionController:cc, mobile:m, mobileConsumer:u, mobileDecoder:d, mobileApi:ma, menus, collection:collect, collectionConsumer:uc, memberCodePage:code, navigation:nav } = s as Record<keyof ReturnType<typeof userCenterDesignSourceFiles>, Source>;
  const route = (method: string, suffix: string, action: string) => ar!.call('$root', `adminapiRoutes.${method}`, `'/config/user-center-design${suffix}'`, 'adminAuth', `AdminUserCenterDesign.${action}`) && vr!.call('$root', `v1Routes.${method}`, `'/admin/config/user-center-design${suffix}'`, 'adminAuth', `AdminUserCenterDesign.${action}`);
  const publicConnected = pc!.call('menuUser', 'new UserCenterPublicReadService(this.container,this.env).menu', 'uid') && pc!.call('menuUserData', 'new UserCenterPublicReadService(this.container,this.env).data', 'uid');
  const manager=(role:string)=>s[role]!;
  const merchantStatisticsConnected=manager('merchantStatsPage').call('$root','controller.read',"'statistics'",'isMerchantStatistics')
    && manager('merchantStatsPage').call('$root','controller.read',"'time'",'isMerchantPeriod','{type:periodValues[periodIndex.value]}')
    && manager('merchantStatsPage').call('$root','controller.read',"'time/chart'",'isMerchantChart','{type:periodValues[periodIndex.value]}')
    && manager('merchantStatsPage').call('$root','controller.read',"'data'",'isMerchantPaged(isMerchantDaily)','{page:1,limit:15}')
    && manager('merchantConsumer').in('read','store_id:store','authority.scope_key','consistencyKey')
    && manager('merchantConsumer').call('read','parseMerchantEnvelope') && manager('merchantApi').call('request','uni.request')
    && manager('managerController').call('statistics','s.statistics.statistics','s.uid','c.req.query()')
    && manager('managerStatistics').call('withManagerRead','requireStoreManagerScope','db','uid','storeId')
    && manager('managerStatistics').in('withManagerRead','REPEATABLE READ, READ ONLY','merchantManagementConsistencyKey')
    && manager('managerStatistics').in('statistics','store_id=${scope.store_id}','pid>=0','orderReadStatusPredicate(1)')
    && vr!.call('$root','v1Routes.get',"'/store/manager/order/statistics'",'authMiddleware({force:true})','StoreManagerOrder.statistics')
    && vr!.call('$root','v1Routes.get',"'/store/manager/order/time/chart'",'authMiddleware({force:true})','StoreManagerOrder.chart')
    && vr!.call('$root','v1Routes.get',"'/store/manager/context'",'authMiddleware({force:true})','StoreManagerOrder.context')
    && manager('merchantOrdersPage').call('$root','controller.read',"'list'",'isMerchantPaged(isMerchantOrder)','filters()')
    && manager('managerInput').in('parseManagerListQuery','status','storeId','isDel')
    && manager('merchantDecoder').in('isMerchantStatistics','current_store_fulfillments_pid_gte_0','unshipped_count')
    && nav!.rule('/pages/admin/order/index','candidate_covered') && nav!.rule('/pages/admin/orderList/index','partial_replacement')
    && manager('workerRegistry').in('$root',"'/pages/merchant/statistics'","'/pages/merchant/orders'");
  return {
    adminScreen: screens.filter(path => path === '/setting/user-center-design').length === 1 && r!.in('$root', "path:'setting/user-center-design'", "import('@/pages/setting/UserCenterDesign.vue')", "alias:'/admin/setting/pages/home'") && sidebar!.binding('el-menu-item', 'v-if', "canMenu('/setting/user-center-design')") && a!.in('canView', "auth.uniqueAuth.includes('user_center_design.view')") && a!.call('$root', 'new UserCenterDesignController') && a!.binding('UserCenterDesignPreview', ':value', 'state.draft') && a!.binding('el-button', '@click', 'controller.save()'),
    sixBlockContract: hasUserCenterDesignContract(sources.contract ?? '') && input!.call('userCenterDesignInput', 'isUserCenterDesignValue', 'body.value') && input!.call('userCenterDesignInput', 'userCenterDesignPayload', 'body.revision', 'body.value'),
    memberEditor: a!.binding('el-radio-group', ':model-value', 'state.draft.member.style') && a!.binding('el-radio-group', '@change', 'memberStyle') && a!.binding('el-checkbox', '@change', '(checked:unknown)=>controller.toggleProperty(option.id,checked)') && a!.binding('el-radio-group', ':model-value', 'state.draft.member.per_show_type') && a!.call('memberStyle', 'controller.edit') && a!.in('memberStyle', 'draft.member.style=value', 'draft.member.property=[0,1,2]') && ctl!.in('toggleProperty', 'draft.member.property', '[...old,value]', 'old.filter(item=>item!==value)') && a!.call('setToggle', 'controller.edit'),
    orderStatisticsEditor: a!.binding('el-radio-group', ':model-value', 'state.draft.order.style') && a!.binding('el-radio-group', '@change', "(value:unknown)=>setStyle('order',value)") && a!.binding('el-radio-group', ':model-value', 'state.draft.orderStatic.style') && a!.binding('el-radio-group', ':model-value', 'state.draft.orderStatic.is_show') && a!.call('setStyle', 'controller.edit') && a!.call('setToggle', 'controller.edit'),
    listEditors: a!.binding('li', 'v-for', '(item,index) in state.draft[listKey].list') && a!.binding('el-button', '@click', 'controller.move(listKey,index,-1)') && a!.binding('el-button', '@click', "controller.remove(listKey as 'poster'|'menu',index)") && a!.binding('el-input', ':model-value', 'state.draft[listKey].title') && a!.binding('el-radio-group', ':model-value', 'state.draft[listKey].is_show') && a!.binding('el-radio-group', ':model-value', 'state.draft[listKey].style') && a!.call('editItem', 'controller.edit') && a!.in('editItem', "key!=='merMenu'||field!=='url'") && a!.call('addItem', 'controller.edit') && a!.in('addItem', 'draft.poster.list.push(item)', 'draft.menu.list.push({...item,type:1})') && ctl!.in('move', '[list[index],list[next]]=[list[next]!,list[index]!]') && ctl!.in('remove', 'splice(index,1)'),
    previewsSix: ['member','order','orderStatic','poster'].every(key => p!.html(`data-testid="user-center-preview-${key}"`, `emit('select','${key}')`)) && p!.binding('div', ':class', '`member-style-${value.member.style}`') && p!.html('value.member.per_show_type', 'value.member.property', 'value.order.style', 'value.orderStatic.style', 'value.poster.list') && p!.in('menuKeys', "['menu','merMenu']") && p!.binding('button','v-for','key in menuKeys') && p!.binding('button','@click',"emit('select',key)") && p!.binding('button',':data-testid','`user-center-preview-${key}`') && p!.html('value[key].style','value[key].title','value[key].list') && p!.binding('span','v-for','item in value.member.property'),
    assetLinkPicker: a!.binding('UserCenterDesignPicker', '@choose', 'choose') && a!.call('choose', 'editItem') && k!.call('load', 'apiUserCenterAssets') && k!.call('load', 'apiUserCenterLinkTargets') && k!.call('load', 'apiUserCenterLinkCategories') && k!.binding('button', '@click', 'choose(row.canonical_url,row.preview_url)') && k!.binding('button', '@click', 'choose(row.url)') && api!.call('apiUserCenterAssets', 'request.get', '`${base}/assets`') && cat!.in('assets', 'systemAttachment', 'type', 'relationId', 'renderProductPictures') && route('get','/assets','assets') && route('get','/link-targets','targets'),
    dedicatedRoutes: route('get','','read') && route('post','/save','save') && route('get','/receipt/:operationId','receipt') && hc!.call('save', 'service(c).save') && hc!.call('save', 'readUserCenterDesignBody', 'c.req.raw') && hc!.call('receipt', 'service(c).receipt', "c.req.param('operationId')", 'actor(c)') && api!.call('apiSaveUserCenterDesign', 'request.post', '`${base}/save`', 'input'),
    permissions1592: perm!.in('$root', "key:'user_center_design'", "matches:['config/user-center-design']", 'manage:true') && perm!.in('resolveTokensWithMenus', "menu.id===1592&&menu.authType===1&&menu.menuPath==='/admin/setting/pages/home'&&menu.uniqueAuth==='admin-setting-pages-home'", "resolved.add('user_center_design.view')", "menu.uniqueAuth==='user_center_design.manage'") && a!.in('canManage', "auth.uniqueAuth.includes('user_center_design.manage')") && perm!.conditionalCall('resolveTokensWithMenus', "menu.id===1592&&menu.authType===1&&menu.menuPath==='/admin/setting/pages/home'&&menu.uniqueAuth==='admin-setting-pages-home'",'resolved.add',"'user_center_design.view'"),
    sharedThreeAuthority: read!.in('userCenterDesignCatalog', 'systemDise', 'systemGroup', 'systemGroupData', 'xmin', 'USER_CENTER_MAX_ROWS*3+1') && read!.call('userCenterDesignCatalog', 'themeHash', "{template:'member',type:3,member,groups,data}") && read!.in('projectUserCenterDesign', 'catalog.member.length>1', "row.type!==3", "row.isDel!==0", 'user_center_per_show_type_defaulted', 'user_center_${key}_defaulted', 'user_center_${module}_group_disagreement', 'user_center_${module}_group_backfill') && read!.call('projectUserCenterDesign', 'isUserCenterDesignValue', 'projected') && read!.in('read', 'REPEATABLE READ, READ ONLY') && read!.call('read', 'readUserCenterDesignSnapshot', 'tx'),
    atomicMutation: w!.call('save', 'withTx', 'this.container') && w!.call('save','lockDiseCatalogForMutation','tx') && w!.call('save','tx.update','systemDise') && w!.call('save','tx.update','systemGroupData') && w!.call('save','tx.update(systemGroupData).set','{status:0}') && w!.ordered('save', 'pg_advisory_xact_lock', 'journals.length', 'await lockDiseCatalogForMutation(tx)', 'LOCK TABLE', 'await userCenterDesignCatalog(tx)', 'catalog.revision!==canonical.revision', 'await projectUserCenterDesign(tx,catalog)', 'tx.insert(systemLog)') && w!.in('save', 'READ COMMITTED', 'journals[0].actor!==id', 'receipt.payloadHash!==payloadHash', 'systemGroupData', 'tx.update(systemDise)', 'source?.original', 'groupOriginal', "if(key==='sourceId')continue", 'catalog.data.filter(row=>row.gid===group!.id&&row.status===1)') && w!.call('save','publicProductPictures') && w!.call('save','tx.insert','systemLog') && w!.in('receipt', 'eq(systemLog.adminId,id)') && hc!.in('save', 'operationId:error.operationId', 'payloadHash:error.payloadHash'),
    merchantImmutable: w!.in('save', "module==='merMenu'", 'items.length!==old.length', 'item.sourceId===null', 'next.sourceId===item.sourceId&&next.url===item.url', 'next.type===2', 'prior.module!==module', 'seen.has(item.sourceId)') && a!.in('openPicker', "mode==='link'&&listKey.value==='merMenu'", "index===null&&listKey.value==='merMenu'") && a!.binding('el-button','v-if',"listKey!=='merMenu'") && a!.in('editItem', "key!=='merMenu'||field!=='url'"),
    genericProtection: crud!.in('adminDiseDeletionProtectionReason', "templateName==='member'") && crud!.call('adminDiseList','rows.filter',"row=>!['product_detail','member'].includes(normalizeDiseTemplateName(row.templateName))") && crud!.in('adminDiseSave', "'member'", 'normalizeDiseTemplateName(existing.templateName)') && !ar!.routeMatching(/(?:system_group(?:_data)?|group_data)(?:\/|$)/u) && !vr!.routeMatching(/(?:system_group(?:_data)?|group_data)(?:\/|$)/u) && pcBanner!.in('$root', 'pc_home_banner') && signDay!.in('$root', 'sign_day_num') && recharge!.call('mutate', 'rechargeQuotaGroup', 'tx'),
    actorRecovery: ctl!.call('save','freezeIntent') && ctl!.ordered('save','userCenterDesignFingerprint(input)','this.ports.confirm','this.ports.storage.setItem','s.pending=frozen') && ctl!.in('parseUserCenterDesignPending', 'row.actor!==actor', 'await userCenterDesignFingerprint(input)!==row.fingerprint') && ctl!.in('freezeIntent','Object.freeze') && ctl!.call('readReceipt','this.ports.receipt') && ctl!.in('readReceipt','response(reason)?.status===404', 's.retryReady=true') && ctl!.call('retryOriginal','this.submit','value') && ctl!.in('definitive', 'data.operationId===pending.input.operationId', 'data.payloadHash===pending.fingerprint') && ctl!.call('invalidate','job.controller.abort') && a!.call('syncStored','controller.invalidate'),
    publicProjection: publicConnected && pub!.call('snapshot','readUserCenterDesignSnapshot','tx') && pub!.in('snapshot','REPEATABLE READ, READ ONLY') && pub!.ordered('menu','this.snapshot(uid)','renderUserCenterDesignSnapshot(this.env,read.snapshot)','publicUserCenterDesignValue(snapshot.value!,snapshot.imagePreviews)') && pub!.in('snapshot','kept.map(entry=>entry.item)','kept.map(entry=>entry.pic)') && c!.in('publicUserCenterDesignValue','imagePreviews[key].length!==value[key].list.length') && d!.call('parseUserCenterMenu','isPublicUserCenterDesignValue','value.diy_data') && u!.call('load','parseUserCenterMenu') && u!.call('load','parseUserCenterStats'),
    realNineAssets: publicConnected && pub!.in('snapshot','now_money','integral','couponCount','collectProductCount','collectVideoCount','visit_num','brokerage_price','spread_user_count','spread_order_count', "category='video'", "category='product'", 'userUnreadMessageCount(uid)') && pub!.call('snapshot','UserFinanceReadService.commissionSummary','scoped','uid','now') && d!.call('userCenterProperties','USER_CENTER_PROPERTY_OPTIONS.filter') && d!.in('userCenterProperties','diy_data.member.property.includes(item.id)','profile[item.field', 'capabilities.promotion') && m!.binding('view','v-for','item in properties') && m!.binding('view','@tap','openProperty(item.id)') && u!.call('openProperty','go','item.url'),
    memberFiveStyles: m!.binding('view',':class','`member-style-${design.member.style}`') && m!.binding('text','v-if','design.member.per_show_type===1') && m!.html('design.member.style===1','design.member.style===2','design.member.style===3','design.member.style===4','profile?.commissionCount','commission.brokerage_price','commission.number','commission.order_num','profile?.pay_vip_status','profile.service_num','Number(profile.vip_discount)/10') && d!.in('parseUserCenterMenu','Number(profile.vip_discount)<=100') && m!.styles('.member-style-2','.member-style-3','.member-style-4','.member-style-5') && d!.in('userCenterProperties','diy_data.member.style===3||diy_data.member.style===4') && m!.binding('image',':src','media(profile?.avatar)'),
    orderThreeStyles: m!.binding('view',':class','`order-style-${design.order.style}`') && m!.binding('view','v-for','item in orderEntries') && m!.binding('view','@tap','go(item.url)') && m!.html('item.count','pendingOrder.order_id','pendingOrder.img','countdown') && m!.styles('.order-style-2','.order-style-3') && u!.in('orderEntries','unpaid_count','unshipped_count','received_count','evaluated_count','refund_count') && u!.call('countdown','userCenterCountdown') && pub!.in('snapshot','store_order','unpaid_count','unshipped_count','received_count','evaluated_count','refund_count','orderCancelHours(unpaid.type,configs)','stop_time:stopTime') && u!.in('load','stop_time','void load()') && u!.call('load','load'),
    statisticsTwoStyles: m!.binding('view',':class','`stats-style-${design.orderStatic.style}`') && m!.binding('view','v-if','merchantStats && design.orderStatic.is_show') && m!.html('merchantStats.price','merchantStats.num','merchantStats.consignment') && m!.styles('.stats-style-2') && d!.in('parseUserCenterStats','menu.capabilities.merchant','o.user_order') && pub!.in('snapshot','stores.length','store_id IN','user_order:true') && m!.binding('*','@tap',"openMerchant('statistics')") && m!.binding('*','@tap',"openMerchant('unshipped')") && u!.call('openMerchant','go') && u!.in('openMerchant','menu.capabilities.merchant','stats.order.user_order',"'/pages/merchant/orders?status=1'") && merchantStatisticsConnected,
    posterCarousel: m!.binding('swiper',':indicator-dots','design.poster.list.length>1') && m!.binding('swiper',':autoplay','true') && m!.binding('swiper',':circular','true') && m!.binding('swiper',':interval','3000') && m!.binding('swiper',':duration','500') && m!.binding('swiper-item','v-for','(item,index) in design.poster.list') && m!.binding('view','@tap',"openMenu('poster',index)") && u!.call('openMenu','go','item.url',"group!=='poster'"),
    menuThreeStyles: m!.binding('UserCenterMenus',':block','design.menu') && m!.binding('UserCenterMenus',':block','design.merMenu') && m!.binding('UserCenterMenus','@open',"index=>openMenu('menu',index)") && m!.binding('UserCenterMenus','@open',"index=>openMenu('merMenu',index)") && menus!.binding('view',':class','`menu-style-${block.style}`') && menus!.binding('template','v-for','(item,index) in block.list') && menus!.html('{{ block.title }}','{{ item.name }}') && menus!.binding('image',':src','media(item.pic)') && menus!.binding('button','open-type','contact') && menus!.styles('repeat(4,minmax(0,1fr))','.menu-style-2','grid-template-columns:1fr','.menu-style-3','repeat(3,minmax(0,1fr))'),
    menuRoleGates: pub!.in('snapshot', 'balance_func_status','member_func_status','member_card_status','brokerage_func_status','division_open','division_apply_open','store_brokerage_apply','invoice_func_status','account.isPromoter','divisionValid','operatorProfile(uid)') && pub!.in('snapshot', "original==='/pages/users/agent/apply'", "original==='/pages/users/distributor/apply'", "path==='/pages/user/invoice'", "path==='/pages/operator/writeoff'") && pub!.in('snapshot','capabilities.promotion','capabilities.paid_member','capabilities.writeoff') && u!.in('openMenu',"group==='merMenu'",'menu.capabilities.merchant','menu.capabilities.writeoff') && operator!.in('operatorProfile','storeStaff','storeDelivery') && u!.call('openOperator','go') && nav!.rule('/pages/admin/work/index','candidate_covered') && nav!.rule('/kefu/mobile_list','candidate_covered') && nav!.rule('/pages/admin/distribution/index','candidate_covered'),
    videoCollections: collect!.call('$root','useUserCollections') && uc!.call('load','scope.request',"'/collect/user'", "'GET'", '{page:next,limit:LIMIT,category}', 'true') && uc!.call('load','parseCollectionVideos','response','scope.owner.uid') && uc!.call('load','parseCollectionProducts','response') && uc!.call('remove','scope.request',"'/collect/del'", "'POST'", '{id:[id],category}', 'true') && uc!.call('$root','onLoad') && uc!.call('$root','onReachBottom') && uc!.in('load','page.value=next','count.value=data.count','if(!scope.active())return') && uc!.in('remove','await load(true)','mutationError.value=') && collect!.binding('video',':src','media(playing.video_url)') && collect!.binding('button','@tap','remove(item.id)') && uc!.in('openVideo','!row.available','row.is_fail','userCenterMedia(row.video_url)') && d!.in('collectionKind',"return'video'", "return'product'") && cs!.call('list','this.videoCollection','uid','page','limit') && cs!.in('videoCollection','userRelation.uid','userRelation.category','video','READ ONLY','renderProductPictures') && cc!.call('collectDel','svc.collectDel') && cc!.in('collectDel','stringField(body.category)') && vr!.call('$root','v1Routes.get',"'/collect/user'",'authMiddleware({ force: true })','UserActivityController.collectList'),
    memberCode: m!.binding('view','@tap',"go('/pages/user/memberCode')") && code!.call('$root','useUserCenter','{autoMemberCode:true}') && code!.binding('view','v-for','(row,r) in qrRows') && code!.binding('view','v-for','(dark,c) in row') && code!.binding('button','@tap','getMemberCode') && code!.html('snapshot.menu.profile.now_money','snapshot.menu.profile.couponCount','snapshot.menu.profile.integral','codeDeadline') && u!.call('getMemberCode','scope.request',"'/user/rand_code'", "'GET'", '{}', 'true') && u!.in('getMemberCode','row.actor_uid!==scope.owner.uid','row.expires_at<=now','codeDeadline.value=row.expires_at') && u!.call('qrRows','qr.addData','code.value') && u!.in('load','codeDeadline.value*1000', "code.value=''" ) && profileController!.call('randCode','service(c).paymentCodeSnapshot','uid(c)') && profile!.in('paymentCodeSnapshot','expires_at','actor_uid','current!==code','await validActor()') && vr!.call('$root','v1Routes.get',"'/user/rand_code'", 'authMiddleware({ force: true })', 'UserProfileController.randCode'),
    userLifecycle: u!.call('$root','watch') && u!.call('$root','onShow') && u!.callbackCall('$root','onHide','clear') && u!.callbackCall('$root','onUnload','clear') && u!.call('clear','requests?.abort') && u!.call('clear','closeCode') && u!.in('clear','snapshot.value=null','generation++') && u!.call('login','uni.navigateTo',"{url:'/pages/auth/login'}") && u!.call('logout','scope.request',"'/logout'", "'GET'", '{}', 'true') && u!.ordered('logout','scope.owner','clear()','scope.active()','auth.clear()') && ma!.in('active','auth.uid===owner.uid','auth.token===owner.token','auth.sessionVersion===owner.version') && m!.binding('button','@tap','logout'),
    requestDeadline: ma!.parameter('createUserCenterRequests','deadlineMs',12000) && ma!.call('request','setTimeout') && ma!.call('request','uni.request') && ma!.in('request','timeout:deadlineMs','finish(undefined,new RequestError','task?.abort()','if(done)return','if(!active()){cancel();return;}') && ma!.call('abort','cancel') && ma!.in('finish','clearTimeout(timer)','pending.delete(cancel)'),
  };
}
