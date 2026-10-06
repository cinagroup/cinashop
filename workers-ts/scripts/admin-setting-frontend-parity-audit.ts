import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from 'node:module';
import ts from 'typescript';
const { parse: parseThemeSfc } = createRequire(import.meta.url)('../../view/admin-ts/node_modules/@vue/compiler-sfc') as typeof import('../../view/admin-ts/node_modules/@vue/compiler-sfc');
import { productDetailDesignSourceFiles, inspectProductDetailDesignCoverage, classifyProductDetailDesignCoverage } from './product-detail-design-coverage';
import { userCenterDesignSourceFiles, inspectUserCenterDesignCoverage, classifyUserCenterDesignCoverage } from './user-center-design-coverage';

type Status = "candidate" | "partial" | "missing" | "retired" | "unreviewed";

interface InventoryRoute {
  source: string;
  line: number;
  path: string;
  title: string | null;
  component: string;
  surface: string;
}

interface Inventory {
  legacy: { routes: InventoryRoute[] };
  target?: { routes: InventoryRoute[] };
}

interface Review {
  status: Status;
  targetScreens: string[];
  targetApis: string[];
  covered: string[];
  remaining: string[];
  evidence: string[];
}

/** A page alone cannot close the legacy four-switch/six-credential workflow. */
export interface CityDeliverySettingsCoverage {
  adminScreen: boolean;
  tenKeys: boolean;
  conditionalFlags: boolean;
  secretIntents: boolean;
  encryptedStorage: boolean;
  commonResolver: boolean;
  providerQueries: boolean;
  callbackIdentity: boolean;
  pickerConsumer: boolean;
  permissions: boolean;
  genericWriteProtection: boolean;
  atomicConfirm: boolean;
  recovery: boolean;
  safeProjection: boolean;
}

export function classifyCityDeliverySettingsCoverage(coverage: CityDeliverySettingsCoverage): Status {
  if (coverage.adminScreen && coverage.tenKeys && coverage.conditionalFlags && coverage.secretIntents
    && coverage.encryptedStorage && coverage.commonResolver && coverage.providerQueries && coverage.callbackIdentity
    && coverage.pickerConsumer && coverage.permissions && coverage.genericWriteProtection && coverage.atomicConfirm
    && coverage.recovery && coverage.safeProjection) return "candidate";
  return coverage.adminScreen || coverage.commonResolver || coverage.atomicConfirm ? "partial" : "missing";
}

/** Compare the real shared key inventories; arbitrary matching text is insufficient. */
export function hasCityDeliveryTenKeys(source: string): boolean {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const inventories: [string, string[]][] = [
    ["CITY_DELIVERY_FLAG_KEYS", ["city_delivery_status", "self_delivery_status", "dada_delivery_status", "uu_delivery_status"]],
    ["CITY_DELIVERY_CREDENTIAL_KEYS", ["dada_app_key", "dada_app_sercret", "dada_source_id", "uupt_appkey", "uupt_app_id", "uupt_open_id"]],
  ];
  return inventories.every(([name, expected]) => {
    const literal = new RegExp(`export\\s+const\\s+${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(code)?.[1];
    if (literal === undefined) return false;
    const values = [...literal.matchAll(/(['"])([^'"]*)\1/g)].map(match => match[2]);
    return values.length === expected.length && new Set(values).size === values.length
      && expected.every(value => values.includes(value));
  });
}

/** Read/receipt DTOs expose state and actions, never plaintext or sealed values. */
export function hasCityDeliveryMetadataOnlyDtos(source: string): boolean {
  const state = /export\s+interface\s+CityDeliveryCredentialState\s*\{([^}]*)\}/.exec(source)?.[1];
  const receipt = /export\s+interface\s+CityDeliverySettingsReceipt\s*\{([^}]*)\}/.exec(source)?.[1];
  if (!state || !receipt) return false;
  const fields = [...state.matchAll(/^\s*(\w+)\??\s*:/gm)].map(match => match[1]);
  return fields.length === 3 && ["configured", "source", "issues"].every(field => fields.includes(field))
    && /credentials\s*:\s*Record<CityDeliveryCredentialKey,\s*CityDeliveryCredentialState>/.test(source)
    && /actions\s*:\s*CityDeliveryCredentialActions/.test(receipt)
    && !/\b(?:credentials|value|ciphertext|envelope|secret)\??\s*:/.test(receipt);
}

/** Inspect connected implementations, not the presence of a replacement page. */
export function inspectCityDeliverySettingsCoverage(targetScreens: string[], sources: Record<string, string>): CityDeliverySettingsCoverage {
  const code = (name: string) => (sources[name] ?? "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const has = (name: string, ...tokens: string[]) => tokens.every(token => code(name).replace(/"/g, "'").includes(token.replace(/"/g, "'")));
  const routeSuffixes = [["get", ""], ["post", "/intent"], ["get", "/intent/:requestId"], ["post", "/confirm"], ["get", "/request/:requestId"]];
  const routes = routeSuffixes.every(([method, suffix]) => has("routes", `adminapiRoutes.${method}("/config/city-delivery${suffix}"`)
    && has("v1Routes", `v1Routes.${method}("/admin/config/city-delivery${suffix}"`));
  const flagSetter = /\bsetFlag\([^)]*\)\s*\{([^\n]*)\}/.exec(code("controller"))?.[1] ?? "";
  const callback = code("callback");
  const callbackReadLock = /export\s+async\s+function\s+lockCityConfigForRead\b[\s\S]*?(?=\nexport\s)/.exec(code("resolver"))?.[0] ?? "";
  const sharedReadDomain = /pg_advisory_xact_lock_shared\s*\(\s*\$\{CITY_DELIVERY_SETTINGS_LOCK_NAMESPACE\}\s*,\s*0\s*\)/.test(callbackReadLock)
    && !callbackReadLock.includes("LOCK TABLE");
  const callbackFence = (callback.match(/await lockCityConfigForRead\(tx\)/g)?.length ?? 0) >= 2
    && (callback.match(/await readCityDeliverySettingsInTx\(tx, this\.env\)/g)?.length ?? 0) >= 2;
  return {
    adminScreen: targetScreens.filter(path => path === "/setting/city-delivery-settings").length === 1
      && has("page", "CityDeliverySettingsController", "editorDisabled", "CityDeliveryCredentialField"),
    tenKeys: hasCityDeliveryTenKeys(code("contract")) && has("input", "CITY_DELIVERY_FLAG_KEYS", "CITY_DELIVERY_CREDENTIAL_KEYS", "cityPrepareInput", "cityConfirmInput"),
    conditionalFlags: has("page", "city_delivery_status", "dada_delivery_status", "uu_delivery_status", "v-if")
      && flagSetter.includes("this.state.draft.flags[key] = value") && !/credentials|forgetInputs|emptyDraft/.test(flagSetter)
      && has("picker", "city_delivery_status", "self_delivery_status", "dada_delivery_status", "uu_delivery_status"),
    secretIntents: has("input", "action === 'replace'", "action === 'keep'", "action === 'clear'", "CITY_DELIVERY_CREDENTIAL_BYTE_LIMITS")
      && has("api", "cityDeliveryJournal", "actions: cityDeliveryActions(input)", "client_nonce") && has("service", "CITY_DELIVERY_INTENT_TYPE", "expires_at", "codec.seal", "codec.digest"),
    encryptedStorage: has("codec", "CITY_DELIVERY_CONFIG_KEY", "'HKDF'", "'AES-GCM'", "'HMAC'", "crypto.getRandomValues", "additionalData", "tagLength: 128")
      && has("resolver", "cityCredentialAad", "credential_cipher_invalid", "legacy_plaintext_not_adopted", "credential_authority_shadowed", "state.source = 'cleared'"),
    commonResolver: has("resolver", "readCityDeliverySettingsInTx", "systemConfig.sort", "systemConfig.id", "xmin", "limit(1001)", "REPEATABLE READ, READ ONLY")
      && has("service", "readCityDeliverySettingsInTx"),
    providerQueries: has("dada", "DadaCityCredentials", "this.resolve ? await this.resolve() : this.config()")
      && has("uu", "UuCityCredentials", "this.resolve ? await this.resolve() : this.config()")
      && has("callback", "new CityDeliverySettingsResolver", "new DadaCityDeliveryProvider", "new UuCityDeliveryProvider", "settings.dada()", "settings.uu()"),
    callbackIdentity: callbackFence && sharedReadDomain && has("callback", "completedUuCallbackReplay", "candidate.clientId === current.values.uupt_open_id",
      "callback.clientId !== current.values.uupt_open_id", "callback.source !== 'callback'", "event.source !== 'callback'",
      "['APPLIED', 'APPLIED_NOOP', 'SUPERSEDED', 'IGNORED']", "event.payloadHash !== callback.payloadHash",
      "outboxes.length !== 1", "outboxes[0].status !== 'COMPLETED'", "outboxes[0].replayKey !== event.replayKey", "historicalReplay: true"),
    pickerConsumer: has("picker", "CityDeliverySettingsResolver", ".flags()", "city && (self || dada || uu)", "city && enabled(globals.self_delivery_status)", "city && enabled(globals.dada_delivery_status)", "city && enabled(globals.uu_delivery_status)"),
    permissions: has("permission", 'key: "city_delivery_settings"', 'matches: ["config/city-delivery"]', "1490",
      'menu.authType === 1', 'menu.menuPath === "/admin/setting/city/delivery/setting"', 'menu.uniqueAuth === "setting-city-delivery-setting"', 'resolved.add("city_delivery_settings.view")'),
    genericWriteProtection: has("batch", "isCityConfigKey(key) ? '/config/city-delivery'", "if (endpoint) throw")
      && has("config", "if (isCityCredentialKey(menuName)) throw", "if (names.some(isCityCredentialKey)) throw")
      && has("crud", "list.filter(row => !isCityCredentialKey(row.menuName))", "Object.keys(body ?? {}).some(isCityConfigKey)")
      && has("log", "systemLog.type} NOT IN", "CITY_DELIVERY_PRIVATE_LOG_TYPES.map", "from(systemLog).where(predicate)"),
    atomicConfirm: routes && has("service", "READ COMMITTED", "lockCityConfigForMutation", "pg_advisory_xact_lock", "CITY_DELIVERY_SETTINGS_LOCK_NAMESPACE",
      "CityDeliverySettingsStaleVersion", "CITY_DELIVERY_RECEIPT_TYPE", "tx.insert(systemLog)")
      && has("resolver", "SHARE ROW EXCLUSIVE MODE")
      && has("service", "LOCK TABLE ${storeDeliveryOrder}, ${cityDeliveryCallbackEvent}, ${cityDeliveryCallbackOutbox}, ${cityDeliveryReconciliationCase} IN SHARE ROW EXCLUSIVE MODE",
        "assertCredentialRotationSafe(tx", "notInArray(cityDeliveryCallbackEvent.status", "cityDeliveryCallbackOutbox.status} <> 'COMPLETED'", "cityDeliveryReconciliationCase.status} <> 'RESOLVED'"),
    recovery: has("controller", "cityDeliveryPendingKey", "scope.valid", "actor().manage", "readIntent", "readReceipt", "confirmPrepared", "cityDeliveryConfirmInput(original)", "phase: 'confirm-unknown'")
      && has("api", "assertCityDeliveryResponse", "isCityDeliveryRollback", "CITY_DELIVERY_SETTINGS_REJECTED", "CITY_DELIVERY_SETTINGS_STALE_VERSION", "body.data.client_nonce === pending.client_nonce"),
    safeProjection: hasCityDeliveryMetadataOnlyDtos(code("contract")) && has("api", "exact(field, ['configured', 'source', 'issues'])")
      && has("service", "cityActions", "snapshot") && has("log", "CITY_DELIVERY_PRIVATE_LOG_TYPES.map", "systemLog.type} NOT IN"),
  };
}

function cityDeliverySettingsCoverage(inventory: Inventory): { coverage: CityDeliverySettingsCoverage; evidence: string[]; gaps: string[] } {
  const files: Record<string, string> = {
    contract: "view/common/cityDeliverySettings.ts", page: "view/admin-ts/src/pages/setting/CityDeliverySettings.vue",
    controller: "view/admin-ts/src/pages/setting/cityDeliverySettingsController.ts", api: "view/admin-ts/src/api/cityDeliverySettings.ts",
    input: "workers-ts/src/services/admin/AdminCityDeliverySettingsInput.ts", service: "workers-ts/src/services/admin/AdminCityDeliverySettingsService.ts",
    codec: "workers-ts/src/services/delivery/CityDeliverySecretCodec.ts", resolver: "workers-ts/src/services/delivery/CityDeliverySettingsResolver.ts",
    dada: "workers-ts/src/services/delivery/DadaCityDeliveryProvider.ts", uu: "workers-ts/src/services/delivery/UuCityDeliveryProvider.ts",
    callback: "workers-ts/src/services/delivery/CityDeliveryCallbackService.ts", picker: "workers-ts/src/services/store/StoreMobileOrderService.ts",
    permission: "workers-ts/src/services/admin/AdminPermissionService.ts", batch: "workers-ts/src/services/system/AdminConfigBatchService.ts",
    log: "workers-ts/src/services/admin/AdminSystemLogReadService.ts", config: "workers-ts/src/services/system/SystemConfigService.ts",
    crud: "workers-ts/src/controllers/api/v1/AdminCrudController.ts", routes: "workers-ts/src/routes/adminapi.ts", v1Routes: "workers-ts/src/routes/v1/index.ts",
  };
  const sources = Object.fromEntries(Object.entries(files).map(([key, file]) => {
    const path = resolve(workerRoot, "..", file);
    return [key, existsSync(path) ? readFileSync(path, "utf8") : ""];
  }));
  const coverage = inspectCityDeliverySettingsCoverage((inventory.target?.routes ?? []).filter(route => route.surface === "page").map(route => route.path), sources);
  const explanations: Record<keyof CityDeliverySettingsCoverage, string> = {
    adminScreen: "完整十键的独立配送设置页、只读与锁定编辑状态尚未接入",
    tenKeys: "四开关及六凭据的完整共享字段和严格请求校验尚未接入，历史dada_app_sercret拼写必须保留",
    conditionalFlags: "总开关/方式开关的条件显示、关闭保留凭据以及旧发货选择语义尚未完整承接",
    secretIntents: "六凭据keep/replace/clear、服务器加密不可变意图、到期与非敏感浏览器恢复尚未完整接入",
    encryptedStorage: "专用部署密钥、随机AES-GCM与AAD、HMAC摘要、明确清除阻止Env回落尚未完整保护",
    commonResolver: "十键缺行/别名/重复winner与共同SQL快照权威尚未完整接入，不能仅保存后仍读旧Env",
    providerQueries: "达达/UU真实query消费者仍未共同使用保存后的凭据权威",
    callbackIdentity: "UU回调身份与receive事务的共享域锁后fresh配置复核或已完成旧账号精确重放边界尚未接入，轮换不得放过迟到身份",
    pickerConsumer: "发货选择器仍未消费共同四开关投影",
    permissions: "独立city_delivery_settings.view/manage与1490精确旧页面仅查看映射尚未接入",
    genericWriteProtection: "通用配置元数据/批量写入仍可绕过十键写域或通用读取/日志泄漏秘密",
    atomicConfirm: "fresh CAS、全在途provider轮换保护、表级phantom边界和原子UUID确认回执尚未完整接入",
    recovery: "管理员身份隔离、未知准备/确认恢复、匹配400/409证明和原请求重试尚未完整接入",
    safeProjection: "状态/动作投影尚未完整隔离明文、密文或低熵秘密摘要",
  };
  return { coverage, gaps: Object.entries(explanations).filter(([key]) => !coverage[key as keyof CityDeliverySettingsCoverage]).map(([, value]) => value),
    evidence: ["cinashop-php/view/admin/src/pages/setting/cityDelivery/setting.vue", "cinashop-php/app/services/system/config/SystemConfigServices.php:1798",
      "cinashop-php/public/install/crmeb.sql:8009", "cinashop-php/public/install/crmeb.sql:8251", "cinashop-php/public/install/crmeb.sql:9549",
      "cinashop-php/crmeb/services/DeliverySevices.php:35", "cinashop-php/app/common/controller/Order.php:596", ...Object.values(files)] };
}

/** Source gates for the complete category layout workflow. Execution receipts
 * belong to acceptance evidence, not this code-only classification. */
export interface ProductCategoryStyleCoverage {
  adminScreen: boolean;
  tenLayoutMatrix: boolean;
  sharedStyleAuthority: boolean;
  dedicatedWrite: boolean;
  permissions: boolean;
  genericWriteProtection: boolean;
  recovery: boolean;
  publicTaxonomy: boolean;
  categoryScopes: boolean;
  publishedProducts: boolean;
  safeSkuPurchase: boolean;
  cartRecovery: boolean;
  draftFilters: boolean;
  paginationSort: boolean;
  treeScrollSelection: boolean;
  cartLayoutBoundary: boolean;
  actorLifecycle: boolean;
}

export function classifyProductCategoryStyleCoverage(coverage: ProductCategoryStyleCoverage): Status {
  if (!coverage.adminScreen) return "missing";
  const required: Array<keyof ProductCategoryStyleCoverage> = ["adminScreen", "tenLayoutMatrix", "sharedStyleAuthority", "dedicatedWrite", "permissions",
    "genericWriteProtection", "recovery", "publicTaxonomy", "categoryScopes", "publishedProducts", "safeSkuPurchase", "cartRecovery", "draftFilters",
    "paginationSort", "treeScrollSelection", "cartLayoutBoundary", "actorLifecycle"];
  return required.every(key => coverage[key] === true) ? "candidate" : "partial";
}

export function categoryAuditCode(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/<!--[^]*?-->/g, "");
}

/** These are ordinal layouts; counting ten arbitrary array entries is unsafe. */
export function hasProductCategoryStyleMatrix(source: string): boolean {
  const code = categoryAuditCode(source), literal = /PRODUCT_CATEGORY_STYLES\s*=\s*Object\.freeze\(\[([^]*?)\]\s*as\s+const\)/.exec(code)?.[1];
  if (!literal) return false;
  const rows = [...literal.matchAll(/\{\s*level:\s*(\d+),\s*index:\s*(\d+),\s*key:\s*['"]([^'"]+)['"],\s*template:\s*(\d+)\s*\}/g)]
    .map(row => `${row[1]}/${row[2]}/${row[3]}/${row[4]}`);
  const expected = ["2/0/1-2/1", "2/1/2-2/3", "2/2/3-2/2", "2/3/2-2-1/2", "2/4/3-2-1/3", "2/5/4-2/4", "3/0/1-3/1", "3/1/2-3/2", "3/2/3-3/2", "3/3/4-3/4"];
  return rows.length === 10 && rows.every((value, index) => value === expected[index])
    && /PRODUCT_CATEGORY_STYLE_DEFAULT[^\n]*Object\.freeze\(\{\s*level:\s*2,\s*index:\s*1\s*\}\)/.test(code)
    && /v\.index\s*<=\s*\(v\.level\s*===\s*2\s*\?\s*5\s*:\s*3\)/.test(code);
}

export function productCategoryStyleSourceFiles(): Record<string, string> {
  return {
    contract: "view/common/productCategoryStyle.ts", controller: "view/common/productCategoryStyleController.ts",
    page: "view/admin-ts/src/pages/setting/ProductCategoryStyle.vue", preview: "view/admin-ts/src/pages/setting/ProductCategoryStylePreview.vue",
    api: "view/admin-ts/src/api/productCategoryStyle.ts", input: "workers-ts/src/services/admin/AdminProductCategoryStyleInput.ts",
    service: "workers-ts/src/services/admin/AdminProductCategoryStyleService.ts", reader: "workers-ts/src/services/content/ProductCategoryStyleReadService.ts",
    publicConfig: "workers-ts/src/services/content/V2PublicCompatibilityService.ts", permission: "workers-ts/src/services/admin/AdminPermissionService.ts",
    crud: "workers-ts/src/controllers/api/v1/AdminCrudController.ts", routes: "workers-ts/src/routes/adminapi.ts", v1Routes: "workers-ts/src/routes/v1/index.ts",
    taxonomy: "workers-ts/src/services/product/StoreCategoryService.ts", categoryPolicy: "workers-ts/src/services/product/PublicCategoryPolicy.ts",
    products: "workers-ts/src/services/product/StoreProductService.ts", productDao: "workers-ts/src/dao/product/StoreProductDao.ts",
    searcher: "workers-ts/src/models/searchers/product.ts",
    ordinary: "workers-ts/src/services/product/OrdinaryProductReadData.ts", cards: "workers-ts/src/services/product/PublicProductCardData.ts",
    catalog: "view/common/categoryCatalog.ts", uniApi: "view/uniapp-ts/src/api/product.ts", skuDecoder: "view/uniapp-ts/src/api/productDetail.ts",
    consumer: "view/uniapp-ts/src/pages/goods/cate.vue", list: "view/uniapp-ts/src/pages/goods/list.vue", ordinaryPage: "view/uniapp-ts/src/pages/goods/detail.vue",
    reads: "view/uniapp-ts/src/composables/useCategoryCatalog.ts", purchase: "view/uniapp-ts/src/composables/useCategoryPurchase.ts",
    productCard: "view/uniapp-ts/src/components/category/CategoryProductCard.vue", sku: "view/uniapp-ts/src/components/category/CategorySkuSelection.vue",
    cartSheet: "view/uniapp-ts/src/components/category/CategoryCartSheet.vue",
  };
}

/** Require connected current implementations, not comments or legacy fixtures. */
export function inspectProductCategoryStyleCoverage(targetScreens: string[], sources: Record<string, string>): ProductCategoryStyleCoverage {
  const code = (key: string) => categoryAuditCode(sources[key] ?? "").replace(/"/g, "'").replace(/\s+/g, " ");
  const has = (key: string, ...tokens: string[]) => tokens.every(token => code(key).includes(token.replace(/"/g, "'").replace(/\s+/g, " ")));
  const read = code("reads"), consumer = code("consumer");
  const publicRead = /readPublic\(\) \{ return withTx\(this\.container, async tx => \{(.*?)\}\); \}/.exec(code("reader"))?.[1] ?? "";
  const modalSync = /function syncNativeTabbar\(force = false\) \{(.*?)\} function retryNativeTabbar\(\)/.exec(consumer)?.[1] ?? "";
  const nativeTabbar = has("consumer", "watch([visible, modalOpen, () => auth.sessionVersion], () => syncNativeTabbar(), { flush: 'sync' })",
    "function retryNativeTabbar() { if (visible.value) syncNativeTabbar(true); }", "v-if=\"visible && tabbarError\"", "@tap=\"retryNativeTabbar\"")
    && ["const hide = visible.value && modalOpen.value", "const generation = ++tabbarGeneration, owner = { visible: visible.value, version: auth.sessionVersion, token: auth.token, uid: auth.uid }",
      "tabbarDesired = hide", "if (!force && hide === tabbarApplied && !pending) return",
      "const current = () => owner.visible && visible.value && generation === tabbarGeneration && hide === tabbarDesired",
      "owner.version === auth.sessionVersion && owner.token === auth.token && owner.uid === auth.uid",
      "const fail = () => { if (current()) { tabbarPending.value = false; tabbarError.value = hide ?",
      "const api = hide ? uni.hideTabBar : uni.showTabBar", "if (typeof api !== 'function') { fail(); return; }",
      "api({ animation: false, success: () => { if (current()) { tabbarApplied = hide; tabbarPending.value = false; tabbarError.value = ''; } }, fail })",
      "catch { fail(); }"].every(token => modalSync.includes(token));
  const routes = [["get", ""], ["post", "/save"], ["get", "/receipt/:operationId"]].every(([method, suffix]) =>
    has("routes", `adminapiRoutes.${method}('/config/product-category-style${suffix}', adminAuth, AdminProductCategoryStyle.`)
    && has("v1Routes", `v1Routes.${method}('/admin/config/product-category-style${suffix}', adminAuth, AdminProductCategoryStyle.`));
  const matrix = hasProductCategoryStyleMatrix(sources.contract ?? "")
    && has("catalog", "if (style.index === 0) return 'tree'", "style.index === (style.level === 2 ? 5 : 3)", "return 'filter-products'",
      "style.level === 2 && (style.index === 1 || style.index === 4)", "return 'side-products'", "return 'top-products'",
      "style.level === 2 ? style.index === 1 || style.index === 3 : style.index === 1")
    && ["tree", "top-products", "side-products", "filter-products"].every(template => consumer.includes(`template === '${template}'`) || consumer.includes(`template==='${template}'`))
    && has("consumer", "useCategoryCatalog()", "useCategoryPurchase(visible)", "CategoryProductCard", "CategorySkuSelection", "CategoryCartSheet")
    && has("page", "PRODUCT_CATEGORY_STYLES.filter(row => row.level === state.selected.level)", "ProductCategoryStylePreview", "state.selected.index");
  return {
    adminScreen: targetScreens.filter(path => path === "/setting/product-category-style").length === 1
      && has("page", "ProductCategoryStyleController", "controller.editorDisabled", "controller.setLevel", "controller.select", "controller.save()"),
    tenLayoutMatrix: matrix,
    sharedStyleAuthority: has("reader", "PRODUCT_CATEGORY_TEMPLATE_NAME = 'category'", "lower(btrim", ".limit(3)", "xmin::text",
      "row.type !== 3", "category_style_missing", "category_style_duplicate", "category_style_identity_invalid", "category_style_value_invalid",
      "saved ? { ...PRODUCT_CATEGORY_STYLE_DEFAULT, ...saved } : null",
      "return { ...(snapshot.configured ? extensions : null), ...(snapshot.value ?? PRODUCT_CATEGORY_STYLE_DEFAULT), configured: snapshot.configured, issues: [...snapshot.issues] }")
      && ["SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY", "await themeDeadlines(tx)",
        "const catalog = await productCategoryStyleCatalog(tx), snapshot = projectProductCategoryStyle(catalog)",
        "return publicProductCategoryStyle(snapshot, snapshot.configured ? decodeProductCategoryStyle(catalog.rows[0].value) : null)"].every(token => publicRead.includes(token))
      && has("publicConfig", "return withTx(this.container,async tx=>{", "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY", "await themeDeadlines(tx)",
        "const catalog=await productCategoryStyleCatalog(tx),category=projectProductCategoryStyle(catalog)",
        "product_category:publicProductCategoryStyle(category,category.configured?decodeProductCategoryStyle(catalog.rows[0].value):null)")
      && has("uniApi", "parseCategoryStyle(await http.get<unknown>('/v2/diy/product_detail'))") && read.includes("apiCategoryStyle()"),
    dedicatedWrite: routes && has("input", "isProductCategoryStyleValue", "productCategoryStyleCanonical", "['operationId', 'revision', 'level', 'index']")
      && has("service", "READ COMMITTED", "pg_advisory_xact_lock", "lockDiseCatalogForMutation(tx)", "catalog.revision !== canonical.revision",
        "ProductCategoryStyleStaleVersion", "projectProductCategoryStyle(catalog).editable", "...saved, level: canonical.level, index: canonical.index",
        "tx.insert(systemDise)", "type: 3", "tx.insert(systemLog)", "systemLog.adminId", "payloadHash"),
    permissions: has("permission", "key: 'product_category_style'", "matches: ['config/product-category-style']",
      "menu.id === 1593 && menu.authType === 1", "menu.menuPath === '/admin/setting/pages/product_category'",
      "menu.uniqueAuth === 'admin-setting-pages-product_category'", "resolved.add('product_category_style.view')")
      && has("page", "'product_category_style.view'", "'product_category_style.manage'"),
    genericWriteProtection: has("crud", "existing.type === 3", "['suspended_window', 'color_change', 'category', 'product_detail', 'member'].includes(normalizeDiseTemplateName(existing.templateName))",
      "templateName === 'category'", "const reason = adminDiseDeletionProtectionReason(row)", "if (reason) throw", "lockDiseCatalogForMutation(tx)"),
    recovery: has("controller", "categoryStylePendingKey", "categoryStyleFingerprint", "row.actor !== actor", "data.operationId === pending.input.operationId",
      "data.payloadHash === pending.fingerprint", "[400, 409].includes", "controller.abort()", "stamp.identity === actor.identity", "stamp.stored === actor.stored",
      "setLevel(level: unknown)", "this.state.selected = { level, index: 0 }", "readingReceipt", "retryReady")
      && has("api", "normalizeCategoryStyleWrite", "parseCategoryStyleReceipt"),
    publicTaxonomy: has("categoryPolicy", ".type=0", ".relation_id=0", ".is_show=1", "category_parent.is_show=1", "category_root.is_show=1",
      "category_parent.level=1", "category_root.level=0")
      && has("taxonomy", "REPEATABLE READ, READ ONLY", "PUBLIC_CATEGORY_LIMIT + 1", "publicCategoryIdentitySql", "await publicProductPictures(tx,", "await renderProductPictures(",
        "accepted.has(row.pid)", "big_pic: pictures[index * 2 + 1]") && !code("taxonomy").includes("cacheSet("),
    categoryScopes: has("categoryPolicy", "['cid', 'sid', 'tid', 'selectId']", "query.getAll(key)", "values.length !== 1", "validatePublicCategoryFilters",
      "sid.pid !== query.cid", "tid.pid !== sid.id", "publicCategoryRelationSelection")
      && has("products", "validatePublicCategoryFilters", "if (cid) where.cid = cid", "if (sid) where.sid = sid", "if (tid) where.tid = tid")
      && has("productDao", "storeProductSearchers", "this.buildWhere(where)")
      && has("searcher", "publicCategoryRelationSelection(id, 'cid')", "publicCategoryRelationSelection(id, 'sid')", "publicCategoryRelationSelection(Number(value), 'tid')")
      && has("catalog", "categoryScopeForPath", "{ tid: path[2].id }", "categoryListUrl")
      && has("list", "categoryQuery", "apiCategoryProducts"),
    publishedProducts: has("products", "isShow: 1", "isDel: 0", "isVerify: 1", "publicCatalog: true", "await decoratePublicProductCards(")
      && has("searcher", "publicCatalog: (value) => value ? publicOrdinaryProductIdentitySql() : undefined")
      && has("ordinary", ".is_show=1", ".is_del=0", ".is_verify=1", "public_owner_store.is_store=1", "public_owner_supplier.is_show=1",
        "public_parent.type=0", "public_parent.relation_id=0")
      && has("cards", "eq(storeCart.uid, uid)", "await publicProductPictures(tx,", "await renderProductPictures("),
    safeSkuPurchase: has("ordinary", "readOrdinaryProductSnapshot", "eq(storeProductAttrValue.productId, id)", "eq(storeProductAttrValue.type, type)",
      "eq(storeProductAttrValue.isRetired, 0)", "ORDINARY_PRODUCT_SKU_LIMIT + 1", "new Set(unique).size !== unique.length", "Math.min(counter(row.stock), counter(product.stock))", "await publicProductPictures(tx,")
      && has("products", "await readOrdinaryProductSnapshot(tx, id, uid, type)")
      && !/storeProductAttrValue\.(?:cost|brokerage|code|diskInfo)\b/.test(code("ordinary"))
      && has("skuDecoder", "seen.has(sku.unique)", "Number.isSafeInteger(sku.stock)", "categoryImage(sku.image)")
      && has("purchase", "apiGoodsDetail(id)", "special(detail.value)", "unique: sku.value.unique", "Math.min(sku.value?.stock", "prepareProductCart(await apiCartAdd(input), 0)")
      && has("sku", "selected", "maximum", "confirm"),
    cartRecovery: has("purchase", "state: 'unknown'", "state: 'acknowledged'", "actor: auth.uid", "uni.setStorageSync", "recoveryKey", "cartId: null",
      "row?.state === 'unknown'", "prepareProductCart", "continueCheckout", "await cart.updateQuantity", "await cart.removeItem", "await apiCartDel(ids)")
      && has("catalog", "ordinaryRecoveryKey", "parseOrdinaryRecovery", "row.actor !== actor", "row.state === 'unknown' && row.cartId !== null")
      && has("ordinaryPage", "ordinaryRecoveryKey", "parseOrdinaryRecovery", "ordinaryLocked", "ordinaryRecovery.value !== null", "ordinaryRecoveryInvalid.value")
      && has("consumer", "purchase.continueCheckout", "purchase.checkoutCart", "purchase.reread", "confirmClear"),
    draftFilters: has("reads", "draft.value = { ...scope.value }", "draft.value = value", "scope.value = { ...draft.value }", "applyFilter", "resetFilter", "toggleExpanded",
      "drawer.value = null") && has("consumer", "drawer==='filter'", "@tap=\"resetFilter\"", "@tap=\"applyFilter\"", "expanded.includes(group.id)", "group.children.slice(0,3)",
      "modalOpen = computed(() => drawer.value !== null || purchase.opened.value || purchase.cartOpen.value)")
      && nativeTabbar,
    paginationSort: has("reads", "page: requestedPage, limit: 10", "requestedPage * 10 < result.count", "new Set(products.value.map(item => item.id))",
      "salesOrder: 'desc'", "priceOrder:", "is_big:", "request !== listGeneration")
      && has("consumer", "@scrolltolower=\"readProducts()\"", "@tap=\"setSort('sales')\"", "price_asc", "price_desc")
      && has("list", "onReachBottom", "apiCategoryProducts"),
    treeScrollSelection: has("reads", "getStorageSync('cate_selected')", "categoryPath(tree.value, id)", "removeStorageSync('cate_selected')")
      && has("consumer", ":scroll-into-view=\"scrollTarget\"", "@scroll=\"treeScroll\"", "function choosePrimary", "function treeScroll", "cate-section-", "createSelectorQuery"),
    cartLayoutBoundary: matrix && /const miniCart = computed\(\(\) => template\.value === 'top-products' \|\| template\.value === 'side-products'\)/.test(consumer)
      && has("consumer", "v-if=\"miniCart && !loading && tree.length\"", "v-if=\"template === 'filter-products'\"", "@tap=\"goCart\"")
      && has("reads", "uni.switchTab({ url: '/pages/cart/index' })"),
    actorLifecycle: has("reads", "auth.sessionVersion", "auth.token", "auth.uid", "visible.value && !disposed.value", "life === generation", "onShow", "onHide(suspend)", "onUnload",
      "cart.cancelPending()", "watch(() => auth.sessionVersion")
      && has("purchase", "auth.sessionVersion", "auth.token", "auth.uid", "life === generation", "watch(visible", "watch(() => auth.sessionVersion"),
  };
}

function productCategoryStyleCoverage(inventory: Inventory) {
  const files = productCategoryStyleSourceFiles();
  const sources = Object.fromEntries(Object.entries(files).map(([key, file]) => {
    const path = resolve(workerRoot, "..", file); return [key, existsSync(path) ? readFileSync(path, "utf8") : ""];
  }));
  const coverage = inspectProductCategoryStyleCoverage((inventory.target?.routes ?? []).filter(route => route.surface === "page").map(route => route.path), sources);
  const explanations: Record<keyof ProductCategoryStyleCoverage, string> = {
    adminScreen: "十种真实分类样式的专用Admin选择/预览/保存页尚未接入", tenLayoutMatrix: "二级六样式、三级四样式与实际四模板/大小商品排列的精确消费矩阵尚未完整接入",
    sharedStyleAuthority: "固定category/type3、缺行默认2/1及重复/身份/损坏诊断尚未与公开配置和客户端共同读取",
    dedicatedWrite: "严格等级/索引、目录锁后fresh CAS、未知扩展保留和仅POST首次初始化尚未原子接入",
    permissions: "独立product_category_style.view/manage与1593精确旧path/auth仅查看映射尚未接入",
    genericWriteProtection: "通用DIY保存/删除仍能绕过category专用写域", recovery: "actor隔离、UUID原请求恢复及匹配400/409失败证明尚未接入",
    publicTaxonomy: "三层平台分类父级可见性、孤儿/外部归属拒绝和同快照安全资产尚未完整接入",
    categoryScopes: "真实cid/sid/tid父子范围、第三层商品关联和列表落点尚未完整接入",
    publishedProducts: "商品审核/可见/归属边界或actor购物车数量与安全媒体投影尚未完整接入",
    safeSkuPurchase: "实际商品SKU身份/库存/安全报价读取、特殊购买转详情与真实cart入口尚未完整接入",
    cartRecovery: "SKU加购未知结果的持久actor保护、数量/清空/继续同cart结算尚未完整接入，重新读列表不是未知加购成功证明",
    draftFilters: "T4筛选草稿与应用/重置、三层选择/展开及tabbar恢复尚未完整接入",
    paginationSort: "真实商品分页、去重、销量/价格排序和大图模式尚未完整接入",
    treeScrollSelection: "T1滚动选择联动与cate_selected一次定位尚未完整接入",
    cartLayoutBoundary: "仅六种T2/T3 mini-cart与两种T4购物车入口尚未按旧矩阵接入",
    actorLifecycle: "分类/产品/SKU/购物车的可见生命周期、账号/generation隔离和迟到响应防护尚未完整接入",
  };
  return { coverage, gaps: Object.entries(explanations).filter(([key]) => !coverage[key as keyof ProductCategoryStyleCoverage]).map(([, value]) => value),
    evidence: ["cinashop-php/view/admin/src/pages/setting/devise/goodClass.vue:64", "cinashop-php/public/install/crmeb.sql:9620",
      "cinashop-php/app/services/diy/DiyServices.php:588", "cinashop-php/view/uniapp/pages/goods_cate/goods_cate.vue:26",
      ...[1, 2, 3, 4].map(number => `cinashop-php/view/uniapp/pages/goods_cate/template${number}.vue`), ...Object.values(files)] };
}

/** Evidence for the whole legacy theme screen, not merely a registered page. */
export interface ThemeStyleCoverage {
  adminScreen: boolean;
  sixPresetTokens: boolean;
  registeredPages: number;
  themedPages: number;
  consumerStyles: boolean;
  lifecycle: boolean;
  diy: boolean;
  commonRead: boolean;
  dedicatedWrite: boolean;
  permissions: boolean;
  genericWriteProtection: boolean;
  recovery: boolean;
}

export function classifyThemeStyleCoverage(coverage: ThemeStyleCoverage): Status {
  if (coverage.adminScreen && coverage.sixPresetTokens && coverage.registeredPages >= 96
    && coverage.themedPages === coverage.registeredPages && coverage.consumerStyles && coverage.lifecycle && coverage.diy
    && coverage.commonRead && coverage.dedicatedWrite && coverage.permissions
    && coverage.genericWriteProtection && coverage.recovery) return "candidate";
  return coverage.adminScreen || coverage.commonRead || coverage.dedicatedWrite ? "partial" : "missing";
}

/** Static literals are checked against legacy App.setTheme, without executing product code. */
export function hasLegacyThemePresets(source: string): boolean {
  const expected = [
    ["天空蓝", "#1DB0FC", "#FD502F", "rgba(58,139,236,0.5)", "rgba(9,139,243,0.1)", "#22CAFD", "#5ACBFF"],
    ["生鲜绿", "#42CA4D", "#FF7600", "rgba(108,198,94,0.5)", "rgba(66,202,77,0.1)", "#FE960F", "#4DEA4D"],
    ["热情红", "#e93323", "#e93323", "rgba(233,51,35,0.5)", "rgba(233,51,35,0.1)", "#FE960F", "#FF7931"],
    ["魅力粉", "#FF448F", "#FF448F", "rgba(255,68,143,0.5)", "rgba(255,68,143,0.1)", "#282828", "#FF67AD"],
    ["活力橙", "#FE5C2D", "#FE5C2D", "rgba(254,92,45,0.5)", "rgba(254,92,45,0.1)", "#FDB000", "#FF9451"],
    ["高端金", "#E0A558", "#DA8C18", "rgba(224,165,88,0.5)", "rgba(224,165,88,0.1)", "#1A1A1A", "#FFCD8C"],
  ];
  const literal = /THEME_PRESETS[^=]*=\s*Object\.freeze\(\[([\s\S]*?)\]\s*\.map\(/.exec(source)?.[1];
  if (!literal) return false;
  const rows = [...literal.matchAll(/\{([^{}]*)\}/g)];
  const roles = ["name", "theme", "priceColor", "minorColor", "minorColorT", "bntColor", "gradient"];
  return rows.length === 6 && rows.every((row, index) => {
    if (!new RegExp(`(?:^|,)\\s*status\\s*:\\s*${index + 1}\\s*(?:,|$)`).test(row[1])) return false;
    const fields = [...row[1].matchAll(/\b(\w+)\s*:\s*(['"])([^'"]*)\2/g)];
    if (fields.length !== roles.length || new Set(fields.map(field => field[1])).size !== roles.length) return false;
    return roles.every((role, position) => fields.find(field => field[1] === role)?.[3]
      .replace(/\s/g, "").toLowerCase() === expected[index][position].replace(/\s/g, "").toLowerCase());
  });
}

/** Only actual compiled SFC imports and a complete root host qualify. The
 * reviewed MerchantShell, DeliveryShell or CustomerWorkShell must enclose its real default slot in
 * the fixed ThemePage component; comments, lookalike names and detached hosts
 * cannot establish this connection. No general wrapper-name allowlist. */
export function hasRegisteredThemeHost(pageSource: string, merchantShellSource: string, deliveryShellSource = "", customerWorkShellSource = ""): boolean {
  function host(source: string, modulePath: string) {
    const parsed = parseThemeSfc(source, { filename: 'theme-host.vue' });
    if (parsed.errors.length || !parsed.descriptor.scriptSetup || !parsed.descriptor.template?.ast) return null;
    const script = ts.createSourceFile('theme-host.ts', parsed.descriptor.scriptSetup.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const imports = script.statements.filter(ts.isImportDeclaration).filter(statement =>
      ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === modulePath
      && statement.importClause?.name && !statement.importClause.isTypeOnly);
    if (imports.length !== 1) return null;
    const binding = imports[0].importClause!.name!.text;
    if (script.statements.some(statement =>
      ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === binding)
      || (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === binding)) return null;
    const roots = parsed.descriptor.template.ast.children.filter(node => node.type !== 3 && (node.type !== 2 || node.content.trim()));
    if (roots.length !== 1 || roots[0].type !== 1 || roots[0].tagType !== 1 || roots[0].tag !== binding) return null;
    const root = roots[0];
    if (root.props.some(prop => prop.type === 7 && ['if', 'else', 'else-if', 'for'].includes(prop.name))) return null;
    return root;
  }
  if (host(pageSource, '@/components/ThemePage.vue')) return true;
  const wrapper = host(pageSource, '@/components/merchantOrders/MerchantShell.vue') ? merchantShellSource
    : host(pageSource, '@/components/deliveryWorkbench/DeliveryShell.vue') ? deliveryShellSource
    : host(pageSource, '@/components/customerWork/CustomerWorkShell.vue') ? customerWorkShellSource : '';
  const shell = wrapper ? host(wrapper, '@/components/ThemePage.vue') : null;
  if (!shell) return false;
  function hasDefaultSlot(node: NonNullable<typeof shell>['children'][number]): boolean {
    if (node.type !== 1) return false;
    if (node.tag === 'slot' && !node.props.some(prop =>
      prop.type === 6 && prop.name === 'name'
      || prop.type === 7 && prop.name === 'bind' && (!prop.arg || prop.arg.type !== 4 || prop.arg.content === 'name'))) return true;
    return node.children.some(child => child.type === 1 && hasDefaultSlot(child));
  }
  return hasDefaultSlot(shell);
}

function themeStyleCoverage(inventory: Inventory): { coverage: ThemeStyleCoverage; evidence: string[]; gaps: string[] } {
  const root = resolve(workerRoot, "..");
  const read = (file: string) => existsSync(resolve(root, file)) ? readFileSync(resolve(root, file), "utf8") : "";
  const contains = (file: string, ...tokens: string[]) => tokens.every(token => read(file).includes(token));
  const page = "view/admin-ts/src/pages/setting/ThemeSettings.vue";
  const controller = "view/admin-ts/src/pages/setting/themeSettingsController.ts";
  const service = "workers-ts/src/services/admin/AdminThemeSettingsService.ts";
  const reader = "workers-ts/src/services/content/ThemeReadService.ts";
  const permission = "workers-ts/src/services/admin/AdminPermissionService.ts";
  const generic = "workers-ts/src/controllers/api/v1/AdminCrudController.ts";
  const palette = "view/common/theme.ts";
  let paths: string[] = [];
  try {
    const registry = JSON.parse(read("view/uniapp-ts/src/pages.json")) as { pages?: { path: string }[]; subPackages?: { root: string; pages: { path: string }[] }[] };
    paths = [...(registry.pages ?? []).map(entry => entry.path), ...(registry.subPackages ?? []).flatMap(group => group.pages.map(entry => `${group.root}/${entry.path}`))];
    if (new Set(paths).size !== paths.length || paths.some(path => !/^pages\/[\w/-]+$/.test(path))) paths = [];
  } catch { /* Missing/corrupt registration is a coverage gap, never a candidate. */ }
  const merchantShell = read('view/uniapp-ts/src/components/merchantOrders/MerchantShell.vue');
  const deliveryShell = read('view/uniapp-ts/src/components/deliveryWorkbench/DeliveryShell.vue');
  const customerWorkShell = read('view/uniapp-ts/src/components/customerWork/CustomerWorkShell.vue');
  const themedPaths = paths.filter(path => hasRegisteredThemeHost(read(`view/uniapp-ts/src/${path}.vue`), merchantShell, deliveryShell, customerWorkShell));
  const routesRegistered = [["get", ""], ["get", "/request/:requestId"], ["post", ""]].every(([method, suffix]) =>
    contains("workers-ts/src/routes/adminapi.ts", `adminapiRoutes.${method}("/setting/theme-style${suffix}"`)
    && contains("workers-ts/src/routes/v1/index.ts", `v1Routes.${method}("/admin/setting/theme-style${suffix}"`));
  const mutation = read(service), crud = read(generic);
  const saveBody = crud.slice(crud.indexOf("export async function adminDiseSave"), crud.indexOf("export async function adminDiseDel"));
  const deleteBody = crud.slice(crud.indexOf("export async function adminDiseDel"));
  const fenceFirst = (body: string) => body.includes("await lockDiseCatalogForMutation(tx)") && body.indexOf("await lockDiseCatalogForMutation(tx)") < body.indexOf('.for("update")');
  const coverage: ThemeStyleCoverage = {
    adminScreen: inventory.target?.routes.filter(route => route.surface === "page" && route.path === "/setting/theme-style").length === 1
      && contains(page, "THEME_PRESETS", "ThemeSettingsController", "editorDisabled", "ThemePreview"),
    sixPresetTokens: hasLegacyThemePresets(read(palette)) && contains(palette, "--view-${role}", "minorColorT", "bntColor", "gradient"),
    registeredPages: paths.length,
    themedPages: themedPaths.length,
    consumerStyles: contains("view/uniapp-ts/src/App.vue", "var(--view-theme", "var(--view-priceColor")
      && contains("view/uniapp-ts/src/pages/goods/detail.vue", "var(--view-minorColor,", "var(--view-minorColorT,", "var(--view-bntColor,")
      && contains("view/uniapp-ts/src/pages/user/index.vue", "var(--view-gradient,"),
    lifecycle: contains("view/uniapp-ts/src/App.vue", "useThemeStore", "onLaunch", "onShow", "refresh", "onHide", "pause")
      && contains("view/uniapp-ts/src/components/ThemePage.vue", ':style="theme.style"', "onShow", "syncPlatform")
      && contains("view/uniapp-ts/src/stores/theme.ts", "apiTheme", "generation", "stale", "CACHE_KEY", "setTabBarStyle"),
    diy: contains("view/uniapp-ts/src/utils/diyTheme.ts", "diyCustomTone", "toneConfig", "preset[role]", "safeDiyColor")
      && contains("view/uniapp-ts/src/utils/diyTheme.ts", "'--view-theme': main", "'--view-priceColor': price", "'--view-gradient': gradient", "couponMoneyColor")
      && contains("view/uniapp-ts/src/components/diy/DiyHomeRenderer.vue", "useThemeStore", "diyThemeVariables")
      && contains("view/uniapp-ts/src/components/diy/DiyCommerceWidget.vue", "diyThemeColor")
      && contains("view/uniapp-ts/src/components/diy/DiyEditorialWidget.vue", "diyThemeColor"),
    commonRead: contains(reader, "THEME_TEMPLATE_NAME = 'color_change'", "theme_duplicate", "theme_identity_invalid", "theme_status_invalid", "valueBytes", "REPEATABLE READ, READ ONLY")
      && contains("workers-ts/src/services/content/V2PublicCompatibilityService.ts", "new ThemeReadService", "product_category_level", "theme_issues")
      && contains("workers-ts/src/services/admin/AdminSignDayConfigService.ts", "readThemeSnapshot"),
    dedicatedWrite: routesRegistered && mutation.includes("READ COMMITTED") && mutation.includes("pg_advisory_xact_lock")
      && mutation.includes("await lockDiseCatalogForMutation(tx)") && mutation.includes("catalog.revision !== canonical.revision")
      && mutation.includes("value: String(canonical.status)") && mutation.includes("status: 0, isShow: 0") && mutation.includes("await tx.insert(systemLog)"),
    permissions: contains(permission, 'key: "theme_settings"', 'matches: ["setting/theme-style"]', "[1035, 1075]", 'menu.authType === 1', 'menu.menuPath === "/admin/setting/theme_style"', 'menu.uniqueAuth === "admin-setting-theme_style"', 'resolved.add("theme_settings.view")'),
    genericWriteProtection: fenceFirst(saveBody) && fenceFirst(deleteBody) && saveBody.includes('"color_change"')
      && contains(generic, 'if (templateName === "color_change") return'),
    recovery: contains(controller, "themePendingKey", "isThemeStale", "isThemeRejected", "assertThemeReceipt", "readReceipt", "retryOriginal", "scope.valid", "actor().manage")
      && contains("view/admin-ts/src/api/themeSettings.ts", "request_id", "revision", "payload_hash", "themeFingerprint", "themeDraftKey"),
  };
  const explanations: Record<Exclude<keyof ThemeStyleCoverage, "registeredPages" | "themedPages">, string> = {
    adminScreen: "六选一专用管理、六色实际预览和只读/锁定编辑状态尚未完整接入",
    sixPresetTokens: "六种旧预设的theme/priceColor/minorColor/minorColorT/bntColor/gradient精确值尚未完整消费",
    consumerStyles: "价格、主按钮、辅按钮、选择边框/背景和会员渐变仍缺少实际CSS角色消费",
    lifecycle: "启动、显示、隐藏与缓存/迟到响应隔离和跨端页面宿主尚未完整接入",
    diy: "DIY默认主题角色与自定义toneConfig颜色优先语义尚未完整接入",
    commonRead: "公开color_change与签到缺少共同有界只读主题权威或异常诊断",
    dedicatedWrite: "固定主题写域、fresh CAS、首次POST初始化与原子UUID回执尚未完整保护",
    permissions: "独立theme_settings双权与1035/1075精确旧页面查看映射尚未完整接入",
    genericWriteProtection: "通用DIY保存/删除仍可能绕过主题专用写域或采用相反锁序",
    recovery: "管理员隔离、未知提交回执、匹配400/409证明及原请求重试尚未完整接入",
  };
  const gaps = Object.entries(explanations).filter(([key]) => !coverage[key as keyof typeof explanations]).map(([, explanation]) => explanation);
  if (paths.length < 96 || themedPaths.length !== paths.length) gaps.push(`实际注册${paths.length}页中仅${themedPaths.length}页具有共同主题宿主，完整合同要求当前注册页全部覆盖`);
  return { coverage, gaps, evidence: ["cinashop-php/view/admin/src/pages/setting/themeStyle/index.vue", "cinashop-php/view/uniapp/App.vue:250",
    page, "view/admin-ts/src/pages/setting/ThemePreview.vue", controller, "view/admin-ts/src/api/themeSettings.ts", palette,
    "view/uniapp-ts/src/pages.json", "view/uniapp-ts/src/App.vue", "view/uniapp-ts/src/pages/goods/detail.vue", "view/uniapp-ts/src/pages/user/index.vue", "view/uniapp-ts/src/components/ThemePage.vue", "view/uniapp-ts/src/components/merchantOrders/MerchantShell.vue", "view/uniapp-ts/src/components/deliveryWorkbench/DeliveryShell.vue", "view/uniapp-ts/src/stores/theme.ts",
    "view/uniapp-ts/src/utils/diyTheme.ts", "view/uniapp-ts/src/components/diy/DiyHomeRenderer.vue", reader, service, permission, generic] };
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workerRoot = resolve(scriptDir, "..");
const userCenterDesignFollowup = process.argv.includes("--user-center-design-followup");
const productDetailDesignFollowup = process.argv.includes("--product-detail-design-followup") || userCenterDesignFollowup;
const productCategoryStyleFollowup = process.argv.includes("--product-category-style-followup") || productDetailDesignFollowup;
const cityDeliverySettingsFollowup = process.argv.includes("--city-delivery-settings-followup") || productCategoryStyleFollowup;
const themeStyleFollowup = process.argv.includes("--theme-style-followup") || cityDeliverySettingsFollowup;
const integralDetailFollowup = process.argv.includes("--integral-detail-followup") || themeStyleFollowup;
const fabSettingsFollowup = process.argv.includes("--fab-settings-followup") || integralDetailFollowup;
const distributorLevelsFollowup = process.argv.includes("--distributor-levels-followup") || fabSettingsFollowup;
const pcBannerFollowup = process.argv.includes("--pc-banner-followup") || distributorLevelsFollowup;
const cityDeliveryRecordsFollowup = process.argv.includes("--city-delivery-records-followup") || pcBannerFollowup;
const shippingSettingsFollowup = process.argv.includes("--shipping-settings-followup") || cityDeliveryRecordsFollowup;
const speechcraftFollowup = process.argv.includes("--speechcraft-followup") || shippingSettingsFollowup;
const feedbackFollowup = process.argv.includes("--feedback-followup") || speechcraftFollowup;
const writeoffFollowup = process.argv.includes("--writeoff-followup") || feedbackFollowup;
const inventoryName = userCenterDesignFollowup
  ? "admin-frontend-inventory-user-center-design-followup-20261003.json"
  : productDetailDesignFollowup
  ? "admin-frontend-inventory-product-detail-design-followup-20261002.json"
  : productCategoryStyleFollowup
  ? "admin-frontend-inventory-product-category-style-followup-20261002.json"
  : cityDeliverySettingsFollowup
  ? "admin-frontend-inventory-city-delivery-settings-followup-20261002.json"
  : themeStyleFollowup
  ? "admin-frontend-inventory-theme-style-followup-20261001.json"
  : integralDetailFollowup
  ? "admin-frontend-inventory-integral-detail-followup-20261001.json"
  : fabSettingsFollowup
  ? "admin-frontend-inventory-fab-settings-followup-20261001.json"
  : distributorLevelsFollowup
  ? "admin-frontend-inventory-distributor-levels-followup-20261001.json"
  : pcBannerFollowup
  ? "admin-frontend-inventory-pc-banner-followup-20261001.json"
  : cityDeliveryRecordsFollowup
  ? "admin-frontend-inventory-city-delivery-records-followup-20261001.json"
  : shippingSettingsFollowup
  ? "admin-frontend-inventory-shipping-settings-followup-20261001.json"
  : feedbackFollowup
  ? "admin-frontend-inventory.json"
  : writeoffFollowup ? "admin-frontend-inventory-writeoff-followup-20260928.json" : "admin-frontend-inventory.json";
const outputName = userCenterDesignFollowup
  ? "admin-legacy-setting-route-parity-user-center-design-followup-20261003.json"
  : productDetailDesignFollowup
  ? "admin-legacy-setting-route-parity-product-detail-design-followup-20261002.json"
  : productCategoryStyleFollowup
  ? "admin-legacy-setting-route-parity-product-category-style-followup-20261002.json"
  : cityDeliverySettingsFollowup
  ? "admin-legacy-setting-route-parity-city-delivery-settings-followup-20261002.json"
  : themeStyleFollowup
  ? "admin-legacy-setting-route-parity-theme-style-followup-20261001.json"
  : integralDetailFollowup
  ? "admin-legacy-setting-route-parity-integral-detail-followup-20261001.json"
  : fabSettingsFollowup
  ? "admin-legacy-setting-route-parity-fab-settings-followup-20261001.json"
  : distributorLevelsFollowup
  ? "admin-legacy-setting-route-parity-distributor-levels-followup-20261001.json"
  : pcBannerFollowup
  ? "admin-legacy-setting-route-parity-pc-banner-followup-20261001.json"
  : cityDeliveryRecordsFollowup
  ? "admin-legacy-setting-route-parity-city-delivery-records-followup-20261001.json"
  : shippingSettingsFollowup
  ? "admin-legacy-setting-route-parity-shipping-settings-followup-20261001.json"
  : speechcraftFollowup
  ? "admin-legacy-setting-route-parity-speechcraft-followup-20260928.json"
  : feedbackFollowup ? "admin-legacy-setting-route-parity-feedback-followup-20260928.json"
  : writeoffFollowup ? "admin-legacy-setting-route-parity-writeoff-followup-20260928.json" : "admin-legacy-setting-route-parity.json";
const inventoryFile = resolve(workerRoot, "audit", inventoryName);
const outputFile = resolve(workerRoot, "audit", outputName);

const reviews: Record<string, Review> = {
  "/admin/setting/system/create": {
    status: "candidate",
    targetScreens: ["/config/forms（新增/编辑表单）"],
    targetApis: [
      "GET /adminapi/form/index",
      "GET /adminapi/form/info/:id",
      "POST /adminapi/form/save/:id",
      "POST /adminapi/form/update_name/:id",
      "GET|PUT /adminapi/form/set_show/:id/:is_show",
      "DELETE /adminapi/form/del/:id",
      "GET /adminapi/form/data/:id",
    ],
    covered: [
      "系统表单定义、组件白名单、提交数据校验和订单不可变快照已迁移",
      "后台 CRUD、启停、数据列表及商品选择接口已迁移",
      "新版 Admin 提供10类受控组件、拖拽/按钮排序、字段设置和用户端预览",
      "兼容旧编辑器按时间戳键保存的对象形状，并按时间戳恢复组件顺序",
      "保存时拒绝未知组件、重复ID、重复/越界选项及无效默认值",
    ],
    remaining: ["需在获批窗口对生产历史模板形状及真实商品下单做只读/端到端核验"],
    evidence: [
      "view/admin-ts/src/pages/config/SystemForms.vue",
      "cinashop-php/view/admin/src/store/modules/admin/modules/mobildConfig.js:26",
      "cinashop-php/view/admin/src/pages/setting/systemForm/create.vue:667",
      "workers-ts/src/services/system/SystemMetadataService.ts",
      "workers-ts/src/services/order/OrderSystemFormService.ts",
      "workers-ts/test/system-form-migration.test.ts",
    ],
  },
  "/admin/setting/system_form": {
    status: "candidate",
    targetScreens: ["/config/forms"],
    targetApis: [
      "GET /adminapi/form/index",
      "GET /adminapi/form/info/:id",
      "POST /adminapi/form/save/:id",
      "GET|PUT /adminapi/form/set_show/:id/:is_show",
      "DELETE /adminapi/form/del/:id",
    ],
    covered: [
      "名称/状态筛选、15条分页、新增、编辑、启停和删除",
      "列表不加载完整模板JSON，详情按需读取且所有响应禁止缓存",
      "停用和删除前检查仍关联的商品、秒杀、拼团、砍价和积分商品",
      "写入使用短事务、固定锁、精确回读和不含表单内容的管理员审计",
    ],
    remaining: ["需用生产历史引用关系验证停用/删除保护"],
    evidence: [
      "view/admin-ts/src/pages/config/SystemForms.vue",
      "workers-ts/src/services/system/SystemMetadataService.ts",
      "workers-ts/src/controllers/api/v1/AdminCrudController.ts",
      "workers-ts/migrations/0128_system_form_reference_indexes.sql",
    ],
  },
  "/admin/setting/system_form/data": {
    status: "candidate",
    targetScreens: ["/config/forms（提交数据抽屉）"],
    targetApis: ["GET /adminapi/form/data/:id"],
    covered: [
      "按用户、来源、关联ID和提交时间筛选并20条分页",
      "模板字段逐项安全文本展示，不执行HTML或加载外部图片",
      "最多5000条的CSV导出并防止公式注入",
      "含手机号的响应设置 private, no-store",
    ],
    remaining: ["需对生产提交量、历史异常JSON和受限角色做只读验收"],
    evidence: [
      "view/admin-ts/src/pages/config/SystemForms.vue",
      "workers-ts/src/services/system/SystemMetadataService.ts",
      "workers-ts/src/controllers/api/v1/AdminCrudController.ts",
    ],
  },
  "/admin/setting/system_config": {
    status: "partial",
    targetScreens: [
      "/config",
      "/config/commerce",
      "/config/newcomer",
      "/config/runtime-content",
    ],
    targetApis: [
      "GET|POST /adminapi/config/commerce",
      "GET|POST /adminapi/config/user/register",
      "GET|POST /adminapi/config/runtime_content",
    ],
    covered: [
      "以字段白名单拆分商城运行、新人运营与客户端内容三类专用设置",
      "服务端 config.view/config.manage 权限隔离",
      "通用配置页不读取整表或返回支付、微信及第三方凭据",
    ],
    remaining: [
      "旧动态配置分类仍有大量业务域未逐项迁移",
      "通用配置分类和任意键编辑器因越权覆盖与凭据泄露风险保持停用",
    ],
    evidence: [
      "view/admin-ts/src/pages/ConfigList.vue",
      "view/admin-ts/src/pages/config/CommerceSettings.vue",
      "view/admin-ts/src/pages/config/NewcomerSettings.vue",
      "view/admin-ts/src/pages/config/RuntimeContent.vue",
    ],
  },
  "/admin/setting/shop/base": {
    status: "candidate",
    targetScreens: ["/config/commerce（基础设置）"],
    targetApis: [
      "GET|POST /adminapi/config/commerce",
      "GET /api/site_config",
      "GET /api/share",
    ],
    covered: [
      "站点开关、名称、HTTPS 地址、联系电话和备案号",
      "四类品牌图片、登录轮播图、favicon、悬浮菜单、短视频、商品列表视频和海报标题",
      "素材中心选择/上传后只保存稳定R2引用，公开消费时生成短期签名",
      "Admin登录页消费轮播图与登录LOGO，Admin和PC动态应用favicon与站点品牌",
      "微信分享三字段由新版/api/share提供，并由UniApp首页分享钩子及PC元信息消费",
      "管理员登录使用4 KiB正文上限、来源/账号双层Durable Object限流和统一失败响应",
      "固定12位新管理员密码/bcrypt cost 12、响应安全头及字段白名单取代旧可编辑过滤开关",
      "HTTPS/站内素材路径校验、短事务、回读、审计与配置缓存失效",
    ],
    remaining: ["需在发布后用生产历史素材引用、真实微信分享与限流响应做只读/端到端验收"],
    evidence: [
      "view/admin-ts/src/pages/config/CommerceSettings.vue",
      "view/admin-ts/src/pages/Login.vue",
      "view/pc-ts/src/layouts/DefaultLayout.vue",
      "view/uniapp-ts/src/pages/index/index.vue",
      "workers-ts/src/services/system/AdminCommerceSettingsService.ts",
      "workers-ts/src/services/system/PublicBrandingService.ts",
      "workers-ts/src/middleware/admin-login-security.ts",
      "workers-ts/src/middleware/security-headers.ts",
    ],
  },
  "/admin/setting/shop/product": {
    status: "candidate",
    targetScreens: ["/config/commerce（商品与交易）", "/product"],
    targetApis: ["GET|POST /adminapi/config/commerce", "GET /adminapi/product/list?status=5"],
    covered: [
      "警戒库存阈值读写",
      "阈值变更时同步重算商品和普通 SKU 的 is_police，并同步 is_sold",
      "原商品 status=5 库存预警筛选契约保持可执行",
    ],
    remaining: ["需在获批窗口对生产商品量验证 5 秒事务上限"],
    evidence: [
      "workers-ts/src/services/system/AdminCommerceSettingsService.ts",
      "workers-ts/src/models/searchers/product.ts",
    ],
  },
  "/admin/setting/document": {
    status: "candidate",
    targetScreens: ["/setting/print"],
    targetApis: [
      "GET /adminapi/print/list",
      "GET /adminapi/print/form/:id",
      "POST /adminapi/print/save/:id",
      "POST|PUT /adminapi/print/set_status/:id/:status",
      "DELETE /adminapi/print/del/:id",
    ],
    covered: [
      "名称关键词和打印平台筛选",
      "15 条分页",
      "新增、编辑、启停、删除和就绪状态",
      "平台作用域 supplier_id=0 与供应商作用域隔离",
      "提供商密钥只写不回显",
    ],
    remaining: ["需在获批窗口对生产 Hyperdrive 做只读数据形状核验"],
    evidence: [
      "view/admin-ts/src/pages/setting/PrintOperations.vue",
      "workers-ts/src/services/system/PrintDocumentManagementService.ts",
    ],
  },
  "/admin/setting/document/config": {
    status: "retired",
    targetScreens: [],
    targetApis: [],
    covered: ["确认旧页面是误复制的商品规格代码，不是可工作的单据设置"],
    remaining: [],
    evidence: [
      "cinashop-php/view/admin/src/pages/setting/document/config.vue:82",
      "cinashop-php/view/admin/src/pages/setting/document/config.vue:192",
      "cinashop-php/view/admin/src/pages/setting/document/config.vue:202",
      "cinashop-php/view/admin/src/pages/setting/document/config.vue:215",
    ],
  },
  "/admin/setting/document/content": {
    status: "candidate",
    targetScreens: ["/setting/print（打印内容弹窗）"],
    targetApis: [
      "GET /adminapi/print/content/:id",
      "POST /adminapi/print/save_content/:id",
    ],
    covered: [
      "标题、配送、备注、商品、运费、优惠、支付、订单、自定义内容开关",
      "规格编码依赖商品明细",
      "二维码站内路径和 50 字底部提示",
      "小票实时预览",
    ],
    remaining: ["需用真实打印机做物理小票版式验收"],
    evidence: [
      "view/admin-ts/src/pages/setting/PrintOperations.vue",
      "workers-ts/src/services/system/PrintDocumentManagementService.ts",
    ],
  },
  "/admin/setting/shop/trade": {
    status: "candidate",
    targetScreens: ["/config/commerce（商品与交易）", "/refund", "UniApp /pages/order/refundDetail"],
    targetApis: ["GET|POST /adminapi/config/commerce", "GET /adminapi/refund/detail/:id", "GET /api/order/refund/detail/:id"],
    covered: [
      "7 类未支付/临期小时、自动收货、自动评价和售后期限",
      "退货理由及退货收货人、电话、地址兼容字段",
      "订单取消策略、定时维护、售后期限和退货理由已消费对应配置",
      "次卡按上海时区扫描临期与过期窗口，经Queue、事务外箱及幂等投递发送短信和站内信",
      "次卡提醒沿用旧is_advent_sms/is_expire_sms标志及reminder_brink_death/expiration_reminder通知标识",
      "售后详情按门店、供应商、平台顺序解析退货收件信息，并在新版Admin和UniApp状态4/5展示",
    ],
    remaining: [
      "生产当前无次卡行、提醒配置及两类通知模板，无法验证真实临期/过期投递与失败重试",
      "生产3条有效售后均为平台范围但没有状态4/5，且平台退货姓名、电话、地址均未配置",
      "需配置生产通知/退货信息，并用真实短信、Queue、平台/门店/供应商售后及受限角色完成E2E",
    ],
    evidence: [
      "view/admin-ts/src/pages/config/CommerceSettings.vue",
      "view/admin-ts/src/pages/refund/RefundList.vue",
      "view/uniapp-ts/src/pages/order/refundDetail.vue",
      "workers-ts/src/services/payment/OrderPaymentPolicy.ts",
      "workers-ts/src/services/order/ScheduledMaintenanceService.ts",
      "workers-ts/src/services/order/SecondCardReminderService.ts",
      "workers-ts/src/services/order/OrderNotificationOutboxService.ts",
      "workers-ts/src/services/order/RefundReturnContactService.ts",
      "workers-ts/src/services/order/StoreOrderRefundService.ts",
      "workers-ts/migrations/0129_second_card_reminder_indexes.sql",
      "workers-ts/test/integration/SecondCardReminderAuditWorker.ts",
      "workers-ts/test/second-card-reminder-migration.test.ts",
    ],
  },
  "/admin/setting/shop/pay": {
    status: "candidate",
    targetScreens: ["/config/commerce（支付设置）"],
    targetApis: ["GET|POST /adminapi/config/commerce"],
    covered: [
      "余额功能、余额支付、微信、支付宝和线下支付业务开关",
      "同时展示数据库开关与当前 Worker Secret 组合后的实际可用状态",
      "商户号与商户API证书序列号作为受格式约束的非密钥字段进入Admin白名单",
      "公众号/H5/PC、小程序与App按各自AppID单独就绪，并共享一套APIv3商户凭据",
      "小程序使用标准 /v3/pay/transactions/jsapi；旧独立小程序商户号分支明确退休",
      "页面、响应和操作日志均不包含支付私钥、证书或 API Key",
    ],
    remaining: [
      "生产支付公开配置、三种AppID及全部微信部署Secret当前均未配置",
      "生产5条site_url含2种值，仍需DB-003运营确认后统一",
      "需配置真实商户并完成三profile下单、支付/退款回调和受限角色E2E",
    ],
    evidence: [
      "view/admin-ts/src/pages/config/CommerceSettings.vue",
      "workers-ts/src/services/payment/PaymentReadinessService.ts",
      "workers-ts/src/services/system/AdminCommerceSettingsService.ts",
      "workers-ts/src/services/wechat/WechatPayService.ts",
      "workers-ts/test/payment-readiness.test.ts",
      "workers-ts/test/integration/PaymentPublicConfigAuditWorker.ts",
    ],
  },
  "/admin/setting/shop/agreemant": {
    status: "candidate",
    targetScreens: ["/config/runtime-content（政策与入驻协议）"],
    targetApis: [
      "GET /adminapi/setting/get_user_agreement/:type",
      "POST /adminapi/setting/set_user_agreement/:type",
      "GET|POST /adminapi/config/runtime_content",
    ],
    covered: [
      "隐私、用户、注销、供应商入驻和代理商入驻五类协议",
      "兼容旧 user_agreement/:type 公共读取契约",
      "Admin 不执行或 v-html 预览协议 HTML",
    ],
    remaining: ["需在获批窗口对生产 legacy_cache 五类键做只读形状核验"],
    evidence: [
      "view/admin-ts/src/pages/config/RuntimeContent.vue",
      "workers-ts/src/services/system/LegacyContentService.ts",
    ],
  },
  "/admin/setting/shop/division": {
    status: "candidate",
    targetScreens: ["/config/commerce（事业部）", "/division"],
    targetApis: [
      "GET|POST /adminapi/config/commerce",
      "GET /adminapi/agent/division/list",
      "GET /adminapi/agent/division/apply/list",
    ],
    covered: [
      "事业部团队和代理商自助申请两个旧开关",
      "关闭团队时禁止保存开启的申请开关",
      "客户端入口按两个开关和当前用户事业部身份共同判定",
      "事业部成员、代理商、员工、分佣与申请审核使用独立管理页",
    ],
    remaining: ["需在获批窗口对生产开关与已有事业部角色做只读一致性核验"],
    evidence: [
      "view/admin-ts/src/pages/config/CommerceSettings.vue",
      "view/admin-ts/src/pages/agent/DivisionManagement.vue",
      "workers-ts/src/services/product/PublicCatalogService.ts",
    ],
  },
  "/admin/setting/notification/index": {
    status: "partial",
    targetScreens: ["/setting/notification"],
    targetApis: [
      "GET /adminapi/notification/order-config",
      "GET /adminapi/notification/list",
      "GET /adminapi/notification/deliveries",
    ],
    covered: ["四类订单通知渠道矩阵、提供商模板目录与持久投递台账"],
    remaining: [
      "旧 system_notification type=1 会员消息目录",
      "旧 system_notification type=2 平台消息目录",
      "短信、公众号、模板消息和企业微信渠道总览",
    ],
    evidence: [
      "view/admin-ts/src/pages/setting/NotificationList.vue",
      "workers-ts/src/services/order/OrderNotificationAdminService.ts",
    ],
  },
  "/admin/setting/notification/notificationEdit": {
    status: "partial",
    targetScreens: ["/setting/notification"],
    targetApis: [
      "PUT /adminapi/notification/order-config/:mark",
      "POST /adminapi/notification/save",
    ],
    covered: ["四类订单通知的站内、短信、微信开关编辑"],
    remaining: [
      "按旧消息目录逐项编辑",
      "企业微信渠道编辑",
      "远端模板同步的安全替代流程",
    ],
    evidence: [
      "view/admin-ts/src/pages/setting/NotificationList.vue",
      "workers-ts/src/services/order/OrderNotificationAdminService.ts",
    ],
  },
};

// The remaining routes were compared against their legacy component and the new Admin
// router, page, and Worker route. A shared old component is not proof of shared parity.
const newRouter = "view/admin-ts/src/router/index.ts";
const adminApiRoutes = "workers-ts/src/routes/adminapi.ts";
const legacyRouter = "cinashop-php/view/admin/src/router/modules/setting.js";

function addReview(
  path: string,
  status: Exclude<Status, "unreviewed">,
  targetScreens: string[],
  targetApis: string[],
  covered: string[],
  remaining: string[],
  evidence: string[],
): void {
  if (reviews[path]) throw new Error(`Duplicate review: ${path}`);
  reviews[path] = { status, targetScreens, targetApis, covered, remaining, evidence };
}

addReview("/admin/setting/third_party", "missing", [], [], [],
  ["旧页按 third 类型加载第三方身份配置动态表单；新版无对应受控管理页或字段合同"],
  ["cinashop-php/view/admin/src/pages/setting/third_party/index.vue", "cinashop-php/view/admin/src/pages/setting/shop/buildData.js", newRouter, adminApiRoutes]);
addReview("/admin/setting/distribution/deliver", "missing", [], [], [],
  ["旧页按 deliver 类型加载发货设置动态表单；运费模板和订单发货页不替代这组发货配置"],
  ["cinashop-php/view/admin/src/pages/setting/distribution/deliver.vue", "cinashop-php/view/admin/src/pages/setting/shop/buildData.js", newRouter]);
addReview("/admin/setting/system_role/index", "partial", ["/system（角色权限）"],
  ["GET /adminapi/system_role/list", "POST /adminapi/system_role/save", "DELETE /adminapi/system_role/del/:id", "GET /adminapi/system_menus/tree"],
  ["新版可列出、新增、编辑、删除角色并选择已有权限树节点"],
  ["旧页的角色状态切换、筛选和完整权限规则管理尚无对应操作；需验证历史角色权限映射"],
  ["cinashop-php/view/admin/src/pages/setting/systemRole/index.vue", "view/admin-ts/src/pages/system/SystemList.vue", adminApiRoutes]);
addReview("/admin/setting/system_admin/index", "partial", ["/system（管理员）"],
  ["GET /adminapi/system_admin/list", "POST /adminapi/system_admin/save"],
  ["新版可列出、新增、编辑管理员及角色关联，并以受控密码字段保存"],
  ["旧页账号启停和筛选未在新版页面提供；真实主管理员及受限角色仍需端到端核验"],
  ["cinashop-php/view/admin/src/pages/setting/systemAdmin/index.vue", "view/admin-ts/src/pages/system/SystemList.vue", adminApiRoutes]);
addReview("/admin/setting/system_menus/index", "missing", [], ["GET /adminapi/system_menus/tree"], [],
  ["新版权限树仅供角色授权读取，缺旧页菜单规则列表、新增、编辑与显隐操作"],
  ["cinashop-php/view/admin/src/pages/setting/systemMenus/index.vue", "view/admin-ts/src/pages/system/SystemList.vue", adminApiRoutes]);
addReview("/admin/setting/system_config/:type?/:tab_id?", "partial",
  ["/config", "/config/commerce", "/config/newcomer", "/config/runtime-content"],
  ["GET|POST /adminapi/config/commerce", "GET|POST /adminapi/config/user/register", "GET|POST /adminapi/config/runtime_content"],
  ["新版以白名单页面承接商城、新人和客户端内容中的部分旧动态配置"],
  ["旧应用设置按 type/tab 加载的其他分类及动态提交动作未逐字段承接，不能把受限配置入口等同原任意表单"],
  ["cinashop-php/view/admin/src/pages/setting/setSystem/index.vue", "view/admin-ts/src/pages/ConfigList.vue", "view/admin-ts/src/pages/config/CommerceSettings.vue"]);
addReview("/admin/setting/system_config/payment/:type?/:tab_id?", "partial", ["/config/commerce（支付设置）"],
  ["GET|POST /adminapi/config/commerce"],
  ["新版承接支付开关、公开商户号和证书序列号，运行时凭据经 Secret 提供"],
  ["旧动态支付配置的每个 tab 与渠道字段尚未一一确认；密钥类字段不得移入 Admin 表单"],
  ["cinashop-php/view/admin/src/pages/setting/setSystem/index.vue", "view/admin-ts/src/pages/config/CommerceSettings.vue", "workers-ts/src/services/system/AdminCommerceSettingsService.ts"]);
addReview("/admin/setting/membership_level/index", "missing", [],
  ["GET /adminapi/agent/level_task"], [],
  ["旧页管理分销等级和等级任务；新版 /level 是会员等级，agent/level_task 仅有后端接口，没有对应 Admin 操作页"],
  ["cinashop-php/view/admin/src/pages/setting/membershipLevel/index.vue", "view/admin-ts/src/pages/level/LevelList.vue", newRouter, adminApiRoutes]);
addReview("/admin/setting/system_config_message/:type?/:tab_id?", "partial", ["/setting/notification"],
  ["GET /adminapi/notification/order-config", "PUT /adminapi/notification/order-config/:mark"],
  ["新版可配置已迁移订单通知的站内、短信及微信渠道"],
  ["旧短信开关动态分类和会员/平台通知目录未全部迁移"],
  ["cinashop-php/view/admin/src/pages/setting/setSystem/index.vue", "view/admin-ts/src/pages/setting/NotificationList.vue", adminApiRoutes]);
addReview("/admin/setting/system_config_logistics/:type?/:tab_id?", "partial", ["/shipping", "/express", "/setting/waybill"],
  ["GET /adminapi/shipping_template/list", "GET /adminapi/express/list"],
  ["运费模板、快递公司与电子面单有专用页面"],
  ["旧物流配置动态字段及发货参数未按 tab 逐项承接"],
  ["cinashop-php/view/admin/src/pages/setting/setSystem/index.vue", "view/admin-ts/src/pages/shipping/ShippingTemplates.vue", "view/admin-ts/src/pages/express/ExpressList.vue"]);
addReview("/admin/setting/sms/sms_config/index", "partial", ["/setting/notification（提供商就绪状态）"],
  ["GET /adminapi/sms/config"],
  ["新版展示短信提供商是否已由 Worker Secret 配齐，并有订单短信模板管理"],
  ["旧页通过第三方 iframe 接收并提交一号通 accessKey/secretKey；新版没有一号通账户配置或迁移流程，不能将其视作已退休"],
  ["cinashop-php/view/admin/src/pages/setting/smsConfig/index.vue", "view/admin-ts/src/pages/setting/NotificationList.vue", adminApiRoutes]);

// These 16 paths all use the same legacy group-data editor, with distinct group IDs.
const groupDataTopics: Array<[string, string]> = [
  ["index/:id", "首页导航按钮"], ["slide/:id", "首页幻灯片"], ["sign/:id", "签到天数配置"],
  ["order/:id", "订单详情动态图"], ["user/:id", "个人中心菜单"], ["new/:id", "首页滚动新闻"],
  ["search/:id", "热门搜索"], ["hot/:id", "热门榜单推荐"], ["new_product/:id", "首发新品推荐"],
  ["promotion/:id", "促销单品推荐"], ["poster/:id", "个人中心分销海报"], ["best/:id", "精品推荐"],
  ["activity/:id", "首页活动区域图片"], ["system/:id", "首页配置"], ["hot_money/:id", "首页超值爆款"],
  ["", "数据配置目录"],
];
for (const [suffix, title] of groupDataTopics) {
  const path = "/admin/setting/system_group_data" + (suffix ? "/" + suffix : "");
  addReview(path, "missing", [], [], [],
    ["旧" + title + "使用 group_data 动态表头、列表、新增、编辑和启停；新版没有该组数据的 Admin 编辑页或同等写入合同"],
    ["cinashop-php/view/admin/src/pages/system/group/list.vue:196", "cinashop-php/view/admin/src/api/system.js:142", newRouter, adminApiRoutes]);
}

addReview("/admin/setting/merchant/system_store/index", "partial", ["/operations/store（门店管理）"],
  ["GET /adminapi/merchant/store"],
  ["新版可管理门店实体、营业/自提状态和配送人员"],
  ["旧门店设置动态表单的键配置、定位服务参数和开关未全部对应；门店列表不能替代设置表单"],
  ["cinashop-php/view/admin/src/pages/setting/systemStore/index.vue", "view/admin-ts/src/pages/operations/StoreOperations.vue", adminApiRoutes]);
addReview("/admin/setting/freight/express/index", "partial", ["/express"],
  ["GET /adminapi/express/list", "POST /adminapi/express/save", "DELETE /adminapi/express/del/:id"],
  ["新版快递公司支持列表、新增、编辑、显隐字段和删除"],
  ["旧页的一键同步快递公司动作没有新版 Admin 操作或 Worker 路由"],
  ["cinashop-php/view/admin/src/pages/setting/freight/index.vue:186", "view/admin-ts/src/pages/express/ExpressList.vue", adminApiRoutes]);
addReview("/admin/setting/store_service/index", "partial", ["/kefu"],
  ["GET /adminapi/service/sessions", "GET /adminapi/service/chat", "POST /adminapi/service/send"],
  ["新版可浏览客服会话并回复用户"],
  ["旧页客服人员列表、添加、编辑、状态和会话记录筛选未在新版页面实现"],
  ["cinashop-php/view/admin/src/pages/setting/storeService/index.vue", "view/admin-ts/src/pages/kefu/KefuList.vue", adminApiRoutes]);
addReview("/admin/setting/store_service/speechcraft", "partial", [],
  ["GET|POST /adminapi/wechat/speechcraft", "GET /adminapi/wechat/speechcraft/categories", "PUT|DELETE /adminapi/wechat/speechcraft/:id"],
  ["Worker 有话术及分类数据接口"],
  ["旧页分类、搜索、分页和话术增改删没有新版 Admin 操作页"],
  ["cinashop-php/view/admin/src/pages/setting/storeService/speechcraft.vue", adminApiRoutes, newRouter]);
addReview("/admin/setting/store_service/feedback", "partial", [],
  ["GET /adminapi/feedback", "GET|PUT|DELETE /adminapi/feedback/:id"],
  ["Worker 有留言列表、详情、处理和删除接口"],
  ["旧页按时间和内容筛选、查看状态、备注处理及删除没有新版 Admin 页面"],
  ["cinashop-php/view/admin/src/pages/setting/storeService/feedback.vue", adminApiRoutes, newRouter]);
addReview("/admin/setting/freight/city/list", "missing", [], ["GET /adminapi/shipping_template/city_list"], [],
  ["新版只向运费编辑器提供只读城市候选，缺旧城市树新增、编辑和清缓存管理"],
  ["cinashop-php/view/admin/src/pages/setting/cityDada/index.vue", "view/admin-ts/src/pages/shipping/ShippingTemplateEditor.vue", adminApiRoutes]);
addReview("/admin/setting/freight/shipping_templates/list", "candidate", ["/shipping"],
  ["GET /adminapi/shipping_template/list", "GET /adminapi/shipping_template/:id/edit", "POST /adminapi/shipping_template/save", "DELETE /adminapi/shipping_template/del/:id"],
  ["新版支持模板搜索、分页、添加、完整地区计费/包邮/禁配编辑及受保护删除"],
  ["需对生产历史模板地区层级、引用保护和受限角色完成验收"],
  ["cinashop-php/view/admin/src/pages/setting/shippingTemplates/index.vue", "view/admin-ts/src/pages/shipping/ShippingTemplates.vue", "view/admin-ts/src/pages/shipping/ShippingTemplateEditor.vue", adminApiRoutes]);
addReview("/admin/setting/merchant/system_store/list", "candidate", ["/operations/store（门店）"],
  ["GET /adminapi/merchant/store", "POST /adminapi/merchant/store/:id"],
  ["新版门店支持关键词/状态筛选、分页、新增、编辑、营业/自提状态及回收恢复"],
  ["需以生产历史门店和受限角色核对地址、经纬度、可见性与回收关系"],
  ["cinashop-php/view/admin/src/pages/setting/storeList/index.vue", "view/admin-ts/src/pages/operations/StoreOperations.vue", adminApiRoutes]);
addReview("/admin/setting/merchant/system_store_staff/index", "candidate", ["/operations/store（店员与核销）"],
  ["GET /adminapi/merchant/store_staff", "POST /adminapi/merchant/store_staff/save/:id", "DELETE /adminapi/merchant/store_staff/del/:id"],
  ["新版店员支持门店/关键词筛选、分页、增改、核销资格、启停和删除"],
  ["需以生产关联用户、门店和受限角色验证核销资格"],
  ["cinashop-php/view/admin/src/pages/setting/clerkList/index.vue", "view/admin-ts/src/pages/operations/StoreOperations.vue", adminApiRoutes]);
if (writeoffFollowup) {
  addReview("/admin/setting/merchant/system_verify_order/index", "partial", ["/operations/writeoff-orders"],
    ["GET /adminapi/merchant/verify_order", "GET /adminapi/merchant/verify_order/stores", "GET /adminapi/merchant/verify/spread_info/:uid"],
    ["独立只读核销订单页与双前缀 Worker 合同承接旧列表、门店选项和推荐人详情；列表按旧 status=6 订单范围读取，提供日期、字段、门店筛选和分页。"],
    ["旧推荐人弹窗直接展示身份证 card_id，新受限详情有意不返回该敏感字段，故不能算完整旧屏合同。",
      "旧自定义日期使用含结束日次日 00:00:00 的闭区间；新查询收紧为结束日之后的排他上界，该边界存在有意差异。",
      "新门店选项最多 500 条、列表偏移最多 10000；旧接口无同样显式上限，规模边界需以历史数据核对。",
      "仍需真实历史订单、受限角色浏览器和生产规模核对；当前仅是本地只读覆盖。"],
    ["cinashop-php/view/admin/src/pages/setting/verifyOrder/index.vue", "cinashop-php/view/admin/src/components/referrerInfo/index.vue",
      "cinashop-php/app/controller/admin/v1/merchant/SystemVerifyOrder.php", "cinashop-php/app/dao/order/StoreOrderDao.php",
      "view/admin-ts/src/pages/operations/WriteoffOrders.vue", "view/admin-ts/src/api/writeoffOrders.ts",
      "workers-ts/src/services/admin/AdminWriteoffOrderReadService.ts", "workers-ts/src/controllers/api/v1/AdminWriteoffOrderReadController.ts", newRouter, adminApiRoutes]);
} else {
  addReview("/admin/setting/merchant/system_verify_order/index", "missing", [], [], [],
    ["旧页按核销时间、订单/用户/商品及门店查询核销订单记录；新版订单详情虽可执行核销，但无对应核销记录列表"],
    ["cinashop-php/view/admin/src/pages/setting/verifyOrder/index.vue", "view/admin-ts/src/pages/order/OrderDetail.vue", "view/admin-ts/src/pages/operations/StoreOperations.vue", newRouter]);
}
addReview("/admin/setting/pages/special", "partial", ["/content/dise"],
  ["GET /adminapi/dise/list", "POST /adminapi/dise/save"],
  ["新版可查看和编辑已有 DIY 页面原始 JSON"],
  ["旧专题页 type=2 创建与图形设计流程未恢复；新版新增固定为停用的 type=1 首页"],
  ["cinashop-php/view/admin/src/pages/setting/special/list.vue", "view/admin-ts/src/pages/content/DiseList.vue"]);
addReview("/admin/setting/pages/links", "partial", ["/config/runtime-content（UniApp 页面路径表）"],
  ["GET /adminapi/diy/get_url"],
  ["新版可只读查看页面名称、路径和参数"],
  ["旧页生成的示例地址与一键复制按钮未恢复"],
  ["cinashop-php/view/admin/src/pages/setting/devise/links.vue", "view/admin-ts/src/pages/config/RuntimeContent.vue", adminApiRoutes]);
addReview("/admin/setting/pages/template", "partial", ["/content/dise"],
  ["GET /adminapi/dise/list", "POST /adminapi/dise/save"],
  ["新版可读写已有 DIY 页的原始 value JSON"],
  ["旧 iframe 预览、组件右侧配置和视觉交互编辑器未恢复"],
  ["cinashop-php/view/admin/src/pages/setting/devise/template.vue", "view/admin-ts/src/pages/content/DiseList.vue"]);
addReview("/admin/setting/system_group_data/kf_adv", "candidate", ["/config/runtime-content（客服页面内容）"],
  ["GET|POST /adminapi/config/runtime_content", "GET /adminapi/setting/get_kf_adv", "POST /adminapi/setting/set_kf_adv"],
  ["新版读写同一客服 HTML 内容，并保留旧读取/保存别名"],
  ["需核验生产历史 HTML 与客户端展示；新版采用原始 HTML 文本编辑"],
  ["cinashop-php/view/admin/src/pages/system/group/kfAdv.vue", "view/admin-ts/src/pages/config/RuntimeContent.vue", "workers-ts/src/services/system/LegacyContentService.ts"]);
addReview("/admin/setting/userAgreement/index", "candidate", ["/config/runtime-content（隐私协议）"],
  ["GET|POST /adminapi/config/runtime_content", "GET /adminapi/setting/get_user_agreement/:type"],
  ["新版可编辑隐私协议 HTML 并通过旧公共协议合同读取"],
  ["旧页面请求 type=undefined 是旧缺参错误；需核对生产 privacy 历史内容与客户端读取"],
  ["cinashop-php/view/admin/src/pages/setting/userAgreement/index.vue", "cinashop-php/view/admin/src/api/system.js:519", "cinashop-php/app/controller/admin/v1/system/config/SystemGroupData.php:388", "view/admin-ts/src/pages/config/RuntimeContent.vue", "workers-ts/src/services/system/LegacyContentService.ts"]);
addReview("/admin/setting/system_group_data/pc/:id", "missing", [], [], [],
  ["旧 PC 主页轮播使用通用 group_data 行编辑器；新版未提供对应 PC 轮播行管理"],
  ["cinashop-php/view/admin/src/pages/system/group/list.vue", "cinashop-php/view/admin/src/pages/system/group/pc.vue", newRouter]);
addReview("/admin/setting/system_config_member_right/:type?/:tab_id?", "missing", [], [], [],
  ["旧会员权益按动态配置 tab 编辑；新版付费会员业务页没有对应权益配置管理"],
  ["cinashop-php/view/admin/src/pages/setting/setSystem/index.vue", "view/admin-ts/src/pages/user/PaidMembership.vue", newRouter]);
addReview("/admin/setting/delivery_service/index", "candidate", ["/operations/store（配送员）"],
  ["GET /adminapi/order/delivery/index", "POST /adminapi/order/delivery/save", "PUT /adminapi/order/delivery/update/:id", "DELETE /adminapi/order/delivery/del/:id"],
  ["新版配送员支持关键词筛选、分页、新增、编辑、启停和删除，并供订单发货选择"],
  ["需以生产配送员身份、受限角色和真实配送订单验证"],
  ["cinashop-php/view/admin/src/pages/setting/deliveryService/index.vue", "view/admin-ts/src/pages/operations/StoreOperations.vue", "view/admin-ts/src/pages/order/OrderList.vue", adminApiRoutes]);
addReview("/admin/setting/city/delivery/setting", "missing", [], [], [],
  ["旧 city_deliver 动态配置表单尚无新版同城配送平台、计价或范围设置页"],
  ["cinashop-php/view/admin/src/pages/setting/cityDelivery/setting.vue", "cinashop-php/view/admin/src/pages/setting/shop/buildData.js", newRouter]);
addReview("/admin/setting/city/delivery/record", "missing", [], [], [],
  ["旧页查询达达/UU 跑腿配送记录、状态与取消发单；新版无同城第三方配送记录页"],
  ["cinashop-php/view/admin/src/pages/setting/cityDelivery/record.vue", newRouter, adminApiRoutes]);
addReview("/admin/setting/platform/index", "partial", ["/dashboard", "/operations/store"],
  ["GET /adminapi/order/list", "GET /adminapi/merchant/store"],
  ["新版有真实业务总览和门店管理；旧首页自身的泛用订单/用户图表有 API 调用"],
  ["旧门店卡片读取初始化的 extractStatistics，未见加载；新版也无对应门店维度首页统计合同"],
  ["cinashop-php/view/admin/src/pages/platform/index/index.vue", "view/admin-ts/src/pages/Dashboard.vue", "view/admin-ts/src/pages/operations/StoreOperations.vue"]);
addReview("/admin/setting/platform/list/index", "retired", [], [],
  ["旧门店列表页写死示例 orderList，挂载和查询动作为空，操作链接无处理器"], [],
  ["cinashop-php/view/admin/src/pages/platform/list/index.vue:100", "cinashop-php/view/admin/src/pages/platform/list/index.vue:105", legacyRouter]);
addReview("/admin/setting/platform/order/index", "retired", [], [],
  ["旧门店订单页使用固定示例订单，挂载/搜索为空且真实 getList 已注释"], [],
  ["cinashop-php/view/admin/src/pages/platform/order/index.vue:195", "cinashop-php/view/admin/src/pages/platform/order/index.vue:250", legacyRouter]);
addReview("/admin/setting/platform/bill/index", "retired", [], [],
  ["旧账单记录页使用固定示例数据且真实 getList 已注释"], [],
  ["cinashop-php/view/admin/src/pages/platform/bill/index.vue:149", "cinashop-php/view/admin/src/pages/platform/bill/index.vue:155", legacyRouter]);
addReview("/admin/setting/platform/setting/index", "retired", [], [],
  ["旧财务设置页 save() 为空实现，不存在可保存的设置合同"], [],
  ["cinashop-php/view/admin/src/pages/platform/setting/index.vue:88", "cinashop-php/view/admin/src/pages/platform/setting/index.vue:89", legacyRouter]);
addReview("/admin/setting/storage", "partial", ["/assets"],
  ["GET /adminapi/config/storage", "GET /adminapi/config/storage/config"],
  ["新版素材中心可管理 R2 资产，Worker 可只读报告存储状态"],
  ["旧本地/云存储供应商切换、同步和凭据写入操作未在新版 Admin 迁移；生产配置需独立核验"],
  ["cinashop-php/view/admin/src/pages/setting/storage/index.vue", "view/admin-ts/src/pages/system/AttachmentLibrary.vue", adminApiRoutes]);
addReview("/admin/setting/pages/devise", "partial", ["/content/dise"],
  ["GET /adminapi/dise/list", "POST /adminapi/dise/save"],
  ["新版可列出、新增并编辑原始 DIY JSON，且保留独立旧版 content"],
  ["旧店铺装修页面的模板选择、实时预览和可视组件编辑器没有对应实现"],
  ["cinashop-php/view/admin/src/pages/setting/devise/list.vue", "cinashop-php/view/admin/src/pages/setting/devise/template.vue", "view/admin-ts/src/pages/content/DiseList.vue"]);
addReview("/admin/setting/pages/home", "missing", [], [], [],
  ["旧个人中心可视配置会员、订单、广告与菜单模块；新版没有这些模块的结构化编辑合同"],
  ["cinashop-php/view/admin/src/pages/setting/devise/users.vue", "view/admin-ts/src/pages/content/DiseList.vue", newRouter]);
addReview("/admin/setting/pages/product_category", "missing", [], [], [],
  ["旧 product_category_diy 可选二/三级分类与样式；新版商品分类 CRUD 不管理此客户端页面样式"],
  ["cinashop-php/view/admin/src/pages/setting/devise/goodClass.vue", "view/admin-ts/src/pages/category/CategoryList.vue", newRouter]);
addReview("/admin/setting/pages/product_detail", "missing", [], [], [],
  ["旧 product_detail_diy 可视配置商品详情模块显隐与样式；新版商品 CRUD 不编辑此页面结构"],
  ["cinashop-php/view/admin/src/pages/setting/devise/newGoods.vue", "view/admin-ts/src/pages/product/ProductForm.vue", newRouter]);
addReview("/admin/setting/theme_style", "missing", [], [], [],
  ["旧页读写客户端主题色；新版没有主题风格读写入口或同名受控配置字段"],
  ["cinashop-php/view/admin/src/pages/setting/themeStyle/index.vue", "view/admin-ts/src/pages/config/CommerceSettings.vue", newRouter]);
addReview("/admin/setting/system_visualization_data", "partial", ["/config/runtime-content（开屏广告）"],
  ["GET|POST /adminapi/config/runtime_content", "GET /adminapi/diy/open_adv/info", "POST /adminapi/diy/open_adv/add"],
  ["新版覆盖启用、图片/视频、时长、间隔、图片跳转和说明字段"],
  ["旧拖拽排序、实时轮播预览、素材选择和页面链接选择器尚未恢复；需验证历史素材"],
  ["cinashop-php/view/admin/src/pages/system/group/visualization.vue", "view/admin-ts/src/pages/config/RuntimeContent.vue", adminApiRoutes]);
addReview("/admin/setting/pc_group_data", "partial", ["/config/runtime-content（客服 HTML）"],
  ["GET|POST /adminapi/config/runtime_content"],
  ["旧 PC 配置中的客服 HTML 可由新版客户端内容页编辑"],
  ["旧 pc_logo、pc_home_banner 与 PC 首页配置写入流程没有专用替代页"],
  ["cinashop-php/view/admin/src/pages/system/group/pc.vue", "view/admin-ts/src/pages/config/RuntimeContent.vue", "workers-ts/src/services/system/AdminCommerceSettingsService.ts"]);
addReview("/admin/setting/pages/fab", "partial", ["/config/commerce（悬浮菜单开关）"],
  ["GET|POST /adminapi/config/commerce"],
  ["新版仅承接悬浮菜单启停开关"],
  ["旧 suspended_window_diy 的四种风格、位置、图片、按钮及跳转配置均无新版编辑页"],
  ["cinashop-php/view/admin/src/pages/setting/devise/fab.vue", "view/admin-ts/src/pages/config/CommerceSettings.vue", "workers-ts/src/services/system/AdminCommerceSettingsService.ts"]);

if (feedbackFollowup) {
  reviews["/admin/setting/store_service/feedback"] = {
    status: "candidate",
    targetScreens: ["/kefu/feedback"],
    targetApis: ["GET /adminapi/feedback", "GET /adminapi/feedback/:id", "PUT /adminapi/feedback/:id", "DELETE /adminapi/feedback/:id"],
    covered: ["独立反馈页恢复姓名/手机号/内容关键词、时间及处理状态筛选、15条分页、处理备注和确认删除；只读与管理分别由 feedback.view/manage 授权，客服会话权限不代授。"],
    remaining: ["仅本地候选；生产历史反馈、手机号查询口径、受限角色和发布后处理流程仍待验收。"],
    evidence: ["cinashop-php/view/admin/src/pages/setting/storeService/feedback.vue", "view/admin-ts/src/pages/kefu/Feedback.vue", "view/admin-ts/src/api/feedback.ts", "workers-ts/src/services/message/CustomerServiceCatalogService.ts", "workers-ts/src/services/admin/AdminPermissionService.ts", adminApiRoutes, newRouter],
  };
}
if (speechcraftFollowup) {
  reviews["/admin/setting/store_service/speechcraft"] = {
    status: "candidate",
    targetScreens: ["/kefu/speechcraft"],
    targetApis: [
      "GET /adminapi/wechat/speechcraft", "GET /adminapi/wechat/speechcraft/:id",
      "POST /adminapi/wechat/speechcraft", "PUT /adminapi/wechat/speechcraft/:id",
      "DELETE /adminapi/wechat/speechcraft/:id",
      "GET /adminapi/wechat/speechcraft/categories", "POST /adminapi/wechat/speechcraft/categories",
      "PUT /adminapi/wechat/speechcraft/categories/:id", "DELETE /adminapi/wechat/speechcraft/categories/:id",
    ],
    covered: ["独立话术页恢复平台 kefu_id=0 的全部/分类/未分类筛选、默认10条分页、详情及话术和分类增改删；另提供标题模糊与内容精确搜索。分类使用 owner_id=0/type=0/group=1，删除后保留历史话术并标识已删除分类，不静默改写旧行。只读与管理分别由 speechcraft.view/manage 授权，客服会话权限不代授。"],
    remaining: ["仅本地候选；生产历史分类和孤儿话术、受限角色、客服端读取及发布后操作仍待验收。"],
    evidence: ["cinashop-php/view/admin/src/pages/setting/storeService/speechcraft.vue", "cinashop-php/app/controller/admin/v1/message/service/StoreServiceSpeechcraft.php", "cinashop-php/app/controller/admin/v1/message/service/StoreServiceSpeechcraftCate.php", "view/admin-ts/src/pages/kefu/Speechcraft.vue", "view/admin-ts/src/api/speechcraft.ts", "workers-ts/src/services/message/CustomerServiceCatalogService.ts", "workers-ts/src/controllers/api/v1/CustomerServiceCatalogController.ts", "workers-ts/src/services/admin/AdminPermissionService.ts", "workers-ts/test/admin-speechcraft-service.test.ts", "workers-ts/test/admin-speechcraft-http.test.ts", "workers-ts/test/admin-speechcraft-frontend.test.ts", adminApiRoutes, newRouter],
  };
}

if (shippingSettingsFollowup) {
  reviews["/admin/setting/distribution/deliver"] = {
    status: "candidate",
    targetScreens: ["/setting/shipping"],
    targetApis: ["GET|POST /adminapi/config/shipping", "GET /adminapi/config/shipping/cities", "GET /adminapi/config/shipping/receipts/:requestId"],
    covered: [
      "完整旧发货设置四键：全场包邮、按分精度门槛、线下支付包邮及到店自提；关闭保留门槛和提货点",
      "维护最大ID未删除默认提货点的名称、手机号、真实省市区/可选街道、详细地址、营业时间和坐标；开启显式启用该行，首次保存才新增",
      "独立shipping_settings.view/manage，旧1359精确路径/auth只授查看；原子配置/提货点版本及UUID回执，未知结果刷新后先查且真实404才主动原样重试",
      "真实邮费SQL计价保持折后券积分前阈值及线下/会员优先序；所有自提报价和建单消费SQL双开关，绑定提货点资料并用共享锁和末端重验拒绝漂移",
    ],
    remaining: ["仅本地未发布候选；生产角色、Hyperdrive、地图provider定位、真机、历史区域/提货点及规模争用和正式发布仍待验收；同城配送配置与记录及整个设置/下单父项继续开放"],
    evidence: ["cinashop-php/view/admin/src/pages/setting/distribution/deliver.vue", "cinashop-php/app/services/system/config/SystemConfigServices.php:1747", "cinashop-php/app/services/store/SystemStoreServices.php:270", "view/admin-ts/src/pages/setting/ShippingSettings.vue", "view/admin-ts/src/api/shippingSettings.ts", "workers-ts/src/services/admin/AdminShippingSettingsService.ts", "workers-ts/src/services/order/CheckoutPickupPolicy.ts", "workers-ts/src/services/order/StoreOrderCreateService.ts", "workers-ts/docs/admin-shipping-settings.md", "workers-ts/audit/admin-shipping-settings-acceptance-20261001.json"],
  };
}
if (cityDeliveryRecordsFollowup) {
  reviews["/admin/setting/city/delivery/record"] = {
    status: "partial",
    targetScreens: ["/setting/city-delivery-records"],
    targetApis: ["GET /adminapi/city_delivery/records", "GET /adminapi/city_delivery/records/:id", "GET /adminapi/city_delivery/stores"],
    covered: [
      "本地配送记录恢复真实时间、门店、平台、状态、配送/原订单号筛选及稳定分页；count与list在同一有界只读快照，literal关键词不继承旧空搜索器或无筛选count错误",
      "按平台/门店/供应商owner类型精确关联，保留隐藏或删除主体、孤儿记录及多次发单；原单仅在旧owner优先规则及uid一致时投影，不因ID碰巧相等串接",
      "明确状态0及历史1/未知值诊断，按原始米换算公里，金额保留十进制字符串，创建时间取真实add_time；详情为本地记录快照且排除核销码/密钥/配送商原始payload",
      "独立city_delivery_record.view，旧1491精确路径/auth只映射查看；账号或权限变化丢弃迟到结果，错误保留并标识旧快照，桌面及窄屏可操作",
    ],
    remaining: [
      "完整旧页取消发单仍未承接；取消费用证据、未知外部提交恢复、取消/完成回调竞争及原订单恢复需要独立持久协议和真实配送商规范，不以只读列表或通用查询接口代替",
      "配送商实时详情/取消理由、发单与商户账户联调、独立生产角色/Hyperdrive、历史资料和规模验收及发布继续开放；本批只读基础为partial，整体设置/履约父项不关闭",
    ],
    evidence: ["cinashop-php/view/admin/src/pages/setting/cityDelivery/record.vue", "cinashop-php/app/services/order/StoreDeliveryOrderServices.php",
      "view/admin-ts/src/pages/setting/CityDeliveryRecords.vue", "view/admin-ts/src/api/cityDeliveryRecords.ts",
      "workers-ts/src/services/admin/AdminCityDeliveryRecordService.ts", "workers-ts/src/controllers/api/v1/AdminCityDeliveryRecordController.ts",
      "workers-ts/src/services/admin/AdminPermissionService.ts", "workers-ts/src/models/schema/order_delivery.ts",
      "workers-ts/docs/admin-city-delivery-records.md", "workers-ts/audit/admin-city-delivery-records-acceptance-20261001.json"],
  };
}
if (fabSettingsFollowup) {
  reviews["/admin/setting/pages/fab"] = {
    status: "partial",
    targetScreens: ["/setting/fab", "Uniapp 首页悬浮按钮"],
    targetApis: ["GET|POST /adminapi/setting/fab", "GET /adminapi/setting/fab/request/:requestId",
      "GET /adminapi/setting/fab/link-categories", "GET /adminapi/setting/fab/link-targets", "GET /api/diy/get_suspended"],
    covered: [
      "六键配置、0至100位置、四样式与前后图片条件、样式一二0至5项及三四3至5项、有序素材和链接编辑，历史扩展属性按明确原按钮合并",
      "独立fab_settings查看管理权限、旧1612精确页面path/auth只映射查看；通用dise保存检查已锁行，拒绝专用配置绕过",
      "全集版本、管理员与UUID原子回执，匹配真正409及写入前400回滚证明；缺行GET不初始化，重复/模糊身份/不可安全合并历史配置明确诊断",
      "实际基础/个人/分销/营销及商品、分类、活动、文章、预售、专题链接选择，必要资料投影、搜索分页与不可执行目标诊断",
      "公开共同读取、平台素材签名、四种布局开合拖动及滚动收起；安全外链H5真实打开及MP/APP专页，跨小程序保留并按平台明确可用性",
    ],
    remaining: [
      "旧积分商品type4仍没有可执行登记详情落点，选择器保持不可选诊断；不能以普通商品或积分账户替代，因此整屏继续partial",
      "本地native、HTTP、类型、构建与合成浏览器结果不替代生产配置/规模、Hyperdrive、真机、外部网页域名设置及发布验收，这些门槛继续开放",
    ],
    evidence: ["cinashop-php/view/admin/src/pages/setting/devise/fab.vue", "cinashop-php/view/admin/src/components/linkaddress/index.vue",
      "view/admin-ts/src/pages/setting/FabSettings.vue", "view/admin-ts/src/api/fabSettings.ts",
      "view/uniapp-ts/src/components/diy/DiySuspendedNavigation.vue", "view/uniapp-ts/src/utils/fab.ts",
      "workers-ts/src/services/admin/AdminFabSettingsService.ts", "workers-ts/src/services/content/FabReadService.ts",
      "workers-ts/src/services/admin/AdminFabLinkCatalogService.ts", "workers-ts/docs/admin-fab-settings.md"],
  };
  for (const file of ["view/admin-ts/src/pages/setting/FabSettings.vue", "view/admin-ts/src/api/fabSettings.ts",
    "workers-ts/src/services/admin/AdminFabSettingsService.ts", "workers-ts/src/services/content/FabReadService.ts",
    "workers-ts/src/services/admin/AdminFabLinkCatalogService.ts", "workers-ts/src/controllers/api/v1/AdminFabLinkCatalogController.ts"])
    if (!existsSync(resolve(workerRoot, "..", file))) throw new Error(`FAB evidence missing: ${file}`);
  for (const [method, suffix] of [["get", ""], ["post", ""], ["get", "/request/:requestId"],
    ["get", "/link-categories"], ["get", "/link-targets"]]) {
    if (!readFileSync(resolve(workerRoot, "src/routes/adminapi.ts"), "utf8").includes(`adminapiRoutes.${method}("/setting/fab${suffix}"`)
      || !readFileSync(resolve(workerRoot, "src/routes/v1/index.ts"), "utf8").includes(`v1Routes.${method}("/admin/setting/fab${suffix}"`))
      throw new Error(`FAB API unregistered: ${method} ${suffix}`);
  }
}
if (pcBannerFollowup) {
  reviews["/admin/setting/system_group_data/pc/:id"] = {
    status: "candidate",
    targetScreens: ["/setting/pc-banner", "PC商城首页"],
    targetApis: ["GET|POST /adminapi/setting/pc-banners", "GET|PUT|DELETE /adminapi/setting/pc-banners/:id",
      "PATCH /adminapi/setting/pc-banners/:id/status", "GET /adminapi/setting/pc-banners/request/:requestId", "GET /api/pc/get_banner"],
    covered: [
      "固定按pc_home_banner配置名定位，支持全部旧动态metadata字段、分页和显隐筛选、新增编辑排序显隐删除以及平台素材选择；管理条数没有10条上限",
      "普通JSON保留未知根键及字段包装附加属性，损坏行明确诊断且只能显隐或删除，损坏metadata阻止写入；只读不初始化，首次新增在同一事务建组",
      "独立pc_home_banner.view/manage，组与行版本CAS、actor绑定UUID回执以及提交结果恢复，使用既有正式运行权限而无需DDL或扩大grant",
      "PC首页实际轮播按sort DESC/id DESC取旧前10窗口，平台图片按真实归属解析和签名，安全跳转及桌面窄屏交互完成本地验证",
    ],
    remaining: ["需发布窗口核对生产历史metadata、图片对象及Hyperdrive规模；PC商城其他LOGO/客服/批量拖拽父页仍为partial"],
    evidence: ["cinashop-php/view/admin/src/router/modules/setting.js:557", "cinashop-php/app/services/system/config/SystemGroupDataServices.php:174",
      "cinashop-php/view/PC/pages/index.vue:10", "view/admin-ts/src/pages/system/PcBannerList.vue", "view/admin-ts/src/api/pcBanner.ts",
      "view/pc-ts/src/pages/Home.vue", "workers-ts/src/services/admin/AdminPcBannerService.ts", "workers-ts/src/services/pc/PcBannerReadService.ts"],
  };
}
const inventory = JSON.parse(readFileSync(inventoryFile, "utf8")) as Inventory;
if (integralDetailFollowup) {
  const review = reviews["/admin/setting/pages/fab"]!;
  review.covered.push("积分商品旧type4链接保留真实活动身份，接入独立详情和共同SKU/数量选择，库存与现金积分沿服务器购物车和统一结算消费；售罄可查看详情，不能用普通商品页替代");
  review.remaining = [
    "微信正式小程序码、原生微信提供商真机调起及相册权限、真实多端推荐和分享体验仍须验收；普通网页二维码及积分详情来访绑定不能代替这些合同",
    "本地SQL、类型、构建和合成浏览器不替代生产角色、Hyperdrive、规模、真机、外部网页域名配置和发布验收",
  ];
  review.evidence.push("view/uniapp-ts/src/pages/activity/integralDetail.vue", "view/uniapp-ts/src/composables/useIntegralPurchase.ts",
    "view/common/integralPurchase.ts", "workers-ts/src/services/activity/IntegralProductReadService.ts");
  for (const file of review.evidence.filter(file => file.includes("integralDetail") || file.includes("IntegralPurchase") || file.includes("integralPurchase") || file.includes("IntegralProductReadService")))
    if (!existsSync(resolve(workerRoot, "..", file))) throw new Error(`Integral detail evidence missing: ${file}`);
}
if (fabSettingsFollowup && inventory.target?.routes.filter(route => route.surface === "page" && route.path === "/setting/fab").length !== 1)
  throw new Error("FAB inventory must contain exactly one dedicated screen");
if (distributorLevelsFollowup) {
  reviews["/admin/setting/membership_level/index"] = {
    status: "candidate",
    targetScreens: ["/setting/distributor-levels", "/setting/distributor-levels/tasks/:levelId?", "Uniapp /pages/users/user_distribution_level/index"],
    targetApis: ["GET|POST /adminapi/agent/levels", "GET|PUT|DELETE /adminapi/agent/levels/:id", "PATCH /adminapi/agent/levels/:id/status",
      "GET /adminapi/agent/levels/request/:requestId", "GET|POST /adminapi/agent/level-tasks", "GET|PUT|DELETE /adminapi/agent/level-tasks/:id",
      "GET /adminapi/agent/level-tasks/parents", "PATCH /adminapi/agent/level-tasks/:id/status", "GET /adminapi/agent/level-tasks/request/:requestId",
      "GET /api/agent/level_list", "GET /api/agent/level_task_list"],
    covered: [
      "独立分销等级七字段、平台背景素材、真实佣金基础比例/上浮、grade ASC/id DESC列表、分页筛选、编辑显隐与保留用户等级和完成证据的级联软删除",
      "任务五指标、严格阈值与启用等级同类型递增、完成记录保护、is_must历史值只读和全部有效任务完成语义；任务自己的筛选分页刷新",
      "独立agent_level与agent_level_task权限、972精确旧菜单双查看和任务单独最小父选择器，旧管理API全部委托版本/UUID合同且无无版本写旁路",
      "actor绑定UUID回执、完整目录CAS和匹配HTTP409/领域校验HTTP400回滚证明；孤儿任务可独立确认软删除，原始写入/任务完成采用真实语句触发器并发fence，维护入口只授予Admin窄列和INSERT",
      "Uniapp真实独立进度入口、赠予等级完成语义与不降级、平台图签名；注册/绑定后自动评估及持久付款后置任务重试，实际佣金消费者继续读取分销等级",
    ],
    remaining: ["需维护发布窗口安装精确权限forward，并以生产历史等级/任务/素材、真实注册支付、Hyperdrive和设备完成E2E；本机合成支付不是provider验收"],
    evidence: ["cinashop-php/view/admin/src/pages/setting/membershipLevel/index.vue", "cinashop-php/app/services/agent/AgentLevelServices.php",
      "cinashop-php/app/services/agent/AgentLevelTaskServices.php", "view/admin-ts/src/pages/setting/DistributorCatalog.vue",
      "view/uniapp-ts/src/pages/users/user_distribution_level/index.vue", "workers-ts/src/services/admin/AdminDistributorLevelService.ts",
      "workers-ts/src/services/agent/AgentLevelTaskService.ts", "workers-ts/src/services/agent/AgentLevelRegistrationEffects.ts",
      "workers-ts/src/migrations/runAgentLevelRuntimeUpgrade.ts", "workers-ts/docs/admin-distributor-levels.md"],
  };
  // The old city setting form contains four feature flags and six provider
  // credentials. It has no pricing/range fields. Preserve historical reports.
  reviews["/admin/setting/city/delivery/setting"].remaining = ["旧city_deliver的四个功能开关及六个达达/UU凭据仍缺完整独立配置表单和真实provider验证"];
  if (inventory.target?.routes.filter(route => route.surface==="page" && route.path==="/setting/distributor-levels").length!==1
    || inventory.target?.routes.filter(route=>route.surface==="page" && route.path.startsWith("/setting/distributor-levels/tasks/")).length!==1)
    throw Error("Distributor inventory must contain exactly two independent business screens");
  for(const file of ["view/admin-ts/src/api/distributorLevels.ts", "view/admin-ts/src/pages/setting/DistributorLevels.vue",
    "view/admin-ts/src/pages/setting/DistributorLevelTasks.vue", "view/uniapp-ts/src/pages/users/user_distribution_level/index.vue",
    "workers-ts/src/services/admin/AdminDistributorLevelService.ts", "workers-ts/src/migrations/runAgentLevelRuntimeUpgrade.ts"])
    if(!existsSync(resolve(workerRoot,"..",file)))throw Error(`Distributor evidence missing: ${file}`);
}
if (pcBannerFollowup) {
  if (inventory.target?.routes.filter(route => route.surface === "page" && route.path === "/setting/pc-banner").length !== 1)
    throw new Error("PC banner inventory must contain exactly one dedicated screen");
  for (const file of ["view/admin-ts/src/pages/system/PcBannerList.vue", "view/admin-ts/src/api/pcBanner.ts", "view/pc-ts/src/api/pcBanner.ts",
    "workers-ts/src/services/admin/AdminPcBannerService.ts", "workers-ts/src/controllers/api/v1/AdminPcBannerController.ts", "workers-ts/src/services/pc/PcBannerReadService.ts"])
    if (!existsSync(resolve(workerRoot, "..", file))) throw new Error(`PC banner evidence missing: ${file}`);
  for (const [method, route] of [["get", ""], ["post", ""], ["get", "/request/:requestId"], ["get", "/:id"],
    ["put", "/:id"], ["patch", "/:id/status"], ["delete", "/:id"]]) {
    if (!readFileSync(resolve(workerRoot, "src/routes/adminapi.ts"), "utf8").includes(`adminapiRoutes.${method}("/setting/pc-banners${route}"`)
      || !readFileSync(resolve(workerRoot, "src/routes/v1/index.ts"), "utf8").includes(`v1Routes.${method}("/admin/setting/pc-banners${route}"`))
      throw new Error(`PC banner API unregistered: ${method} ${route}`);
  }
}
if (cityDeliveryRecordsFollowup) {
  if (inventory.target?.routes.filter(route => route.surface === "page" && route.path === "/setting/city-delivery-records").length !== 1)
    throw new Error("City delivery records inventory must contain exactly one dedicated screen");
  for (const file of ["view/admin-ts/src/pages/setting/CityDeliveryRecords.vue", "view/admin-ts/src/api/cityDeliveryRecords.ts",
    "workers-ts/src/services/admin/AdminCityDeliveryRecordService.ts", "workers-ts/src/controllers/api/v1/AdminCityDeliveryRecordController.ts"])
    if (!existsSync(resolve(workerRoot, "..", file))) throw new Error(`City delivery records evidence missing: ${file}`);
  for (const path of ["/city_delivery/records", "/city_delivery/records/:id", "/city_delivery/stores"]) {
    if (!readFileSync(resolve(workerRoot, "src/routes/adminapi.ts"), "utf8").includes(`adminapiRoutes.get("${path}"`)
      || !readFileSync(resolve(workerRoot, "src/routes/v1/index.ts"), "utf8").includes(`v1Routes.get("/admin${path}"`))
      throw new Error(`City delivery records API unregistered: GET ${path}`);
  }
}
if (shippingSettingsFollowup) {
  if (inventory.target?.routes.filter(route => route.surface === "page" && route.path === "/setting/shipping").length !== 1)
    throw new Error("Shipping settings inventory must contain exactly one dedicated screen");
  for (const file of ["view/admin-ts/src/pages/setting/ShippingSettings.vue", "view/admin-ts/src/api/shippingSettings.ts",
    "workers-ts/src/services/admin/AdminShippingSettingsService.ts", "workers-ts/src/services/order/CheckoutPickupPolicy.ts"])
    if (!existsSync(resolve(workerRoot, "..", file))) throw new Error(`Shipping settings evidence missing: ${file}`);
  for (const [method, path] of [["get", "/config/shipping"], ["post", "/config/shipping"],
    ["get", "/config/shipping/cities"], ["get", "/config/shipping/receipts/:requestId"]]) {
    if (!readFileSync(resolve(workerRoot, "src/routes/adminapi.ts"), "utf8").includes(`adminapiRoutes.${method}("${path}"`)
      || !readFileSync(resolve(workerRoot, "src/routes/v1/index.ts"), "utf8").includes(`v1Routes.${method}("/admin${path}"`))
      throw new Error(`Shipping settings API unregistered: ${method} ${path}`);
  }
}
if (writeoffFollowup) {
  const target = inventory.target?.routes.filter((route) => route.surface === "page"
    && route.path === "/operations/writeoff-orders") ?? [];
  if (target.length !== 1) throw new Error("Dated inventory lacks the dedicated writeoff-order screen");
  for (const file of [
    "view/admin-ts/src/pages/operations/WriteoffOrders.vue",
    "view/admin-ts/src/api/writeoffOrders.ts",
    "workers-ts/src/services/admin/AdminWriteoffOrderReadService.ts",
    "workers-ts/src/controllers/api/v1/AdminWriteoffOrderReadController.ts",
  ]) {
    if (!existsSync(resolve(workerRoot, "..", file))) throw new Error(`Writeoff evidence missing: ${file}`);
  }
  const adminRoutes = readFileSync(resolve(workerRoot, "src/routes/adminapi.ts"), "utf8");
  const v1Routes = readFileSync(resolve(workerRoot, "src/routes/v1/index.ts"), "utf8");
  for (const path of ["/merchant/verify_order", "/merchant/verify_order/stores",
    "/merchant/verify/spread_info/:uid", "/merchant/verify_badge"]) {
    if (!adminRoutes.includes(`adminapiRoutes.get("${path}"`)) throw new Error(`Writeoff API unregistered: ${path}`);
    if (!v1Routes.includes(`v1Routes.get("/admin${path}"`)) throw new Error(`Writeoff alias unregistered: ${path}`);
  }
  const permissionSource = readFileSync(resolve(workerRoot, "src/services/admin/AdminPermissionService.ts"), "utf8");
  if (!permissionSource.includes('key: "writeoff_order"')) throw new Error("Writeoff read permission absent");
}
if (feedbackFollowup) {
  const target = inventory.target?.routes.filter((route) => route.surface === "page"
    && route.path === "/kefu/feedback") ?? [];
  if (target.length !== 1) throw new Error("Dated inventory lacks the dedicated feedback screen");
  for (const file of ["view/admin-ts/src/pages/kefu/Feedback.vue", "view/admin-ts/src/api/feedback.ts",
    "workers-ts/src/services/message/CustomerServiceCatalogService.ts"]) {
    if (!existsSync(resolve(workerRoot, "..", file))) throw new Error(`Feedback evidence missing: ${file}`);
  }
  const permissionSource = readFileSync(resolve(workerRoot, "src/services/admin/AdminPermissionService.ts"), "utf8");
  if (!permissionSource.includes('key: "feedback"')) throw new Error("Feedback permission absent");
}
if (speechcraftFollowup) {
  const target = inventory.target?.routes.filter((route) => route.surface === "page"
    && route.path === "/kefu/speechcraft") ?? [];
  if (target.length !== 1) throw new Error("Dated inventory lacks the dedicated speechcraft screen");
  for (const file of ["view/admin-ts/src/pages/kefu/Speechcraft.vue", "view/admin-ts/src/api/speechcraft.ts",
    "workers-ts/src/services/message/CustomerServiceCatalogService.ts",
    "workers-ts/src/controllers/api/v1/CustomerServiceCatalogController.ts",
    "workers-ts/test/admin-speechcraft-service.test.ts",
    "workers-ts/test/admin-speechcraft-http.test.ts",
    "workers-ts/test/admin-speechcraft-frontend.test.ts"]) {
    if (!existsSync(resolve(workerRoot, "..", file))) throw new Error(`Speechcraft evidence missing: ${file}`);
  }
  const adminRoutes = readFileSync(resolve(workerRoot, "src/routes/adminapi.ts"), "utf8");
  const v1Routes = readFileSync(resolve(workerRoot, "src/routes/v1/index.ts"), "utf8");
  for (const [method, path] of [
    ["get", "/wechat/speechcraft"], ["get", "/wechat/speechcraft/:id"],
    ["post", "/wechat/speechcraft"], ["put", "/wechat/speechcraft/:id"],
    ["delete", "/wechat/speechcraft/:id"], ["get", "/wechat/speechcraft/categories"],
    ["post", "/wechat/speechcraft/categories"], ["put", "/wechat/speechcraft/categories/:id"],
    ["delete", "/wechat/speechcraft/categories/:id"],
  ]) {
    if (!adminRoutes.includes(`adminapiRoutes.${method}("${path}"`)) throw new Error(`Speechcraft API unregistered: ${method} ${path}`);
    if (!v1Routes.includes(`v1Routes.${method}("/admin${path}"`)) throw new Error(`Speechcraft alias unregistered: ${method} ${path}`);
  }
  const permissionSource = readFileSync(resolve(workerRoot, "src/services/admin/AdminPermissionService.ts"), "utf8");
  if (!permissionSource.includes('key: "speechcraft"')) throw new Error("Speechcraft permission absent");
}
let themeContract: ReturnType<typeof themeStyleCoverage> | undefined;
if (themeStyleFollowup) {
  themeContract = themeStyleCoverage(inventory);
  const { coverage, gaps, evidence } = themeContract;
  const covered: string[] = [];
  if (coverage.adminScreen) covered.push("专用六选一管理与六色预览，编辑服从查看/管理权限与锁定状态");
  if (coverage.sixPresetTokens) covered.push("六种预设保留旧theme/priceColor/minorColor/minorColorT/bntColor/gradient精准六token，不以单个主色替代");
  if (coverage.registeredPages >= 96 && coverage.themedPages === coverage.registeredPages && coverage.lifecycle) covered.push(`实际${coverage.registeredPages}/${coverage.registeredPages}注册页使用共同主题宿主，启动/显示刷新、缓存失效与迟到响应隔离，H5及MP/APP页面变量和原生tabbar共同消费`);
  if (coverage.diy) covered.push("DIY默认品牌角色跟随主题，toneConfig自定义颜色优先保留，布局/内容/业务状态色没有被统一替换");
  if (coverage.commonRead) covered.push("公开color_change保留status/navigation/product_category_level，签到读取共同SQL权威，缺行/重复/身份/值异常保留诊断");
  if (coverage.dedicatedWrite && coverage.genericWriteProtection) covered.push("固定color_change/type3专用写入，RC与有界目录锁后fresh CAS，仅POST首次初始化；保留行status/isShow和未知元数据，通用DIY保存删除不能绕过");
  if (coverage.permissions) covered.push("独立theme_settings.view/manage；1035/1075精确旧path/auth只授查看，现代明确管理授权不借PC1036、genericdise或空鉴权API");
  if (coverage.recovery) covered.push("管理员隔离的UUID原子回执、匹配400/409证明、未知提交恢复与原请求原样重试");
  reviews["/admin/setting/theme_style"] = {
    status: classifyThemeStyleCoverage(coverage),
    targetScreens: coverage.adminScreen ? ["/setting/theme-style", `Uniapp实际${coverage.registeredPages}页与DIY消费者`] : [],
    targetApis: ["GET|POST /adminapi/setting/theme-style", "GET /adminapi/setting/theme-style/request/:requestId", "GET /api/v2/diy/color_change/color_change"],
    covered,
    remaining: [...gaps, "本地SQL、JWT、类型、四端构建和合成浏览器不等于生产角色迁移、Hyperdrive规模、真机或正式发布；旧PC没有六色主题消费证据，不扩大本合同"],
    evidence,
  };
}
let citySettingsContract: ReturnType<typeof cityDeliverySettingsCoverage> | undefined;
if (cityDeliverySettingsFollowup) {
  citySettingsContract = cityDeliverySettingsCoverage(inventory);
  const { coverage, gaps, evidence } = citySettingsContract;
  const covered: string[] = [];
  if (coverage.adminScreen) covered.push("独立同城配送设置页已接入只读与锁定编辑状态");
  if (coverage.commonResolver) covered.push("共同SQL配送配置读取已具有有界候选、sort/id winner和快照诊断");
  if (coverage.atomicConfirm) covered.push("专用prepare/confirm/receipt路由与配置确认事务、在途轮换保护已接入");
  if (coverage.adminScreen && coverage.tenKeys) covered.push("旧city_deliver完整四开关与六凭据专用管理，保留dada_app_sercret历史键和空历史值诊断；旧页只定义此十键");
  if (coverage.conditionalFlags && coverage.pickerConsumer) covered.push("总开关与自主/达达/UU方式条件显示，关闭开关保留凭据动作和输入；发货选择器沿总开关且相应方式的真实共同投影");
  if (coverage.secretIntents && coverage.encryptedStorage && coverage.safeProjection) covered.push("六凭据显式keep/replace/clear；专用密钥AES-GCM服务器意图和HMAC证明，本设置snapshot/intent/receipt只给配置状态/动作，浏览器仅保存非敏感恢复记录；明确清除阻止Env回落");
  if (coverage.commonResolver && coverage.providerQueries && coverage.callbackIdentity) covered.push("SQL有界winner/别名/重复与Env兼容来源共同权威，真实达达/UU query及UU回调身份同步消费；UU验签和receive在专用共享advisory域锁后fresh重核身份，与专用配置管理排他域互斥，不要求App配置写权限");
  if (coverage.atomicConfirm && coverage.genericWriteProtection) covered.push("prepare不改变有效配置，confirm在有界统一锁序后fresh CAS，阻止在途attempt/event/outbox/reconciliation凭据变更；确认DML和UUID回执原子提交，通用配置写入/读取/日志旁路封闭");
  if (coverage.permissions) covered.push("独立city_delivery_settings.view/manage，1490精确旧path/auth只授查看，不由315共享save_basics空鉴权或通用config借得管理");
  if (coverage.recovery) covered.push("管理员与请求generation隔离，未知准备/确认读取原intent与receipt，只有匹配400/409回滚证明释放，保持原请求幂等重试");
  reviews["/admin/setting/city/delivery/setting"] = {
    status: classifyCityDeliverySettingsCoverage(coverage), targetScreens: coverage.adminScreen ? ["/setting/city-delivery-settings"] : [],
    targetApis: ["GET /adminapi/config/city-delivery", "POST /adminapi/config/city-delivery/intent", "GET /adminapi/config/city-delivery/intent/:requestId",
      "POST /adminapi/config/city-delivery/confirm", "GET /adminapi/config/city-delivery/request/:requestId"],
    covered, remaining: [...gaps, "既有UU回调event.client_id继续保存openId业务身份验签证据，本批没有迁移为摘要，不声称全部数据库零明文身份；新设置/准备意图的密文与状态投影保持独立范围",
      "UU配置读者使用合作运行时共享advisory域锁，不取得配置表SHARE锁；外部maintenance或直连SQL若不遵循此域协议，必须停流并协调轮换，本批不宣称保护非合作写入者",
      "本地SQL/JWT、受控provider fetch、类型/构建和合成浏览器不证明生产密钥/角色迁移、真实provider账号或正式发布；配送记录取消/收费/未知外部提交仍沿独立partial合同"], evidence,
  };
}

let categoryStyleContract: ReturnType<typeof productCategoryStyleCoverage> | undefined;
if (productCategoryStyleFollowup) {
  categoryStyleContract = productCategoryStyleCoverage(inventory);
  const { coverage, gaps, evidence } = categoryStyleContract, covered: string[] = [];
  if (coverage.adminScreen && coverage.tenLayoutMatrix) covered.push("旧二级六种、三级四种样式全部预览/选择/保存，四套实际模板按准确序号消费；切换分类等级从样式0开始，缺行服务器默认保持2/1");
  if (coverage.sharedStyleAuthority && coverage.dedicatedWrite) covered.push("固定category/type3共同有界读取与诊断，严格矩阵、锁后fresh CAS、保留未知扩展和行生命周期；仅POST首次初始化、原子UUID回执");
  if (coverage.permissions && coverage.genericWriteProtection && coverage.recovery) covered.push("独立查看/管理域，旧1593精确path/auth仅查看；通用DIY保存/删除不能绕过，actor隔离原请求恢复及匹配400/409回滚证明");
  if (coverage.publicTaxonomy && coverage.categoryScopes && coverage.publishedProducts) covered.push("真实三层平台分类与cid/sid/tid父子商品关联，隐藏父级/孤儿/外部归属/未审核商品不可公开，图片按持久归属验证与新鲜签名");
  if (coverage.safeSkuPurchase && coverage.cartRecovery) covered.push("商品列表连接真实SKU详情和cart权威，安全报价/库存/规格/购物车数量与清空/同cart结算；未知加购按actor持久保留，不把重新读列表当成功证明");
  if (coverage.draftFilters && coverage.paginationSort && coverage.treeScrollSelection) covered.push("分类导航/更多、T4三层筛选草稿应用重置与展开，实际分页/销量价格排序/大小图，T1滚动联动及cate_selected定位");
  if (coverage.cartLayoutBoundary && coverage.actorLifecycle) covered.push("仅六种T2/T3布局mini-cart、两种T4独立购物车入口；分类/产品/SKU/cart的账号与可见generation隔离，迟到响应不污染新身份");
  reviews["/admin/setting/pages/product_category"] = {
    status: classifyProductCategoryStyleCoverage(coverage), targetScreens: coverage.adminScreen ? ["/setting/product-category-style", "Uniapp /pages/goods/cate（十种实际布局）"] : [],
    targetApis: ["GET /adminapi/config/product-category-style", "POST /adminapi/config/product-category-style/save", "GET /adminapi/config/product-category-style/receipt/:operationId",
      "GET /api/v2/diy/product_detail", "GET /api/category", "GET /api/products", "GET /api/product/detail/:id", "既有真实cart与checkout接口"],
    covered, remaining: [...gaps, "source gate与实际本地SQL/JWT、runtime、四端build和合成浏览器材料分别验收；源代码齐全不声称这些执行已通过，更不证明生产角色、Hyperdrive规模、真机或正式发布",
      "该旧布局由Uniapp消费，无旧PC十布局消费证据；保留当前购物车/checkout正式权威，不把示例Admin预览或商品列表金额当购买报价"], evidence,
  };
  // Refine two stale descriptions only in this new dated follow-up. Neither
  // semantic classification is upgraded by the presence of another page.
  reviews["/admin/setting/system_group_data/sign/:id"].remaining = ["/marketing/sign-day-config已有同名固定签到天数组专用管理；旧动态group_data入口映射与扩展metadata全合同尚未独立验收，保留missing，勿重复称专用编辑器不存在；此组不是实际签到奖励配置"];
  reviews["/admin/setting/system_group_data/sign/:id"].evidence.push("view/admin-ts/src/pages/marketing/SignDayConfig.vue", "workers-ts/src/services/admin/AdminSignDayConfigService.ts");
  reviews["/admin/setting/pc_group_data"].remaining = ["pc_home_banner已由独立专用页完整承接并在本台账独立candidate；PC Logo与其余完整首页配置仍未对应，PC商城整屏保持partial"];
}

let productDetailDesignContract: { coverage: ReturnType<typeof inspectProductDetailDesignCoverage>; gaps: string[]; evidence: string[] } | undefined;
if (productDetailDesignFollowup) {
  const files = productDetailDesignSourceFiles();
  const sources = Object.fromEntries(Object.entries(files).map(([role,file]) => {
    const absolute=resolve(workerRoot,'..',file);return [role,existsSync(absolute)?readFileSync(absolute,'utf8'):''];
  }));
  const coverage=inspectProductDetailDesignCoverage((inventory.target?.routes??[]).filter(route=>route.surface==='page').map(route=>route.path),sources);
  const gaps=Object.entries(coverage).filter(([,value])=>!value).map(([name])=>`商品详情合同尚缺少实际连接：${name}`);
  const evidence=['cinashop-php/view/admin/src/pages/setting/devise/newGoods.vue','cinashop-php/view/uniapp/pages/goods_details/index.vue','cinashop-php/view/uniapp/pages/activity/goods_details/index.vue',...Object.values(files)];
  productDetailDesignContract={coverage,gaps,evidence};
  const covered:string[]=[];
  if(coverage.adminScreen&&coverage.contract19&&coverage.editor18&&coverage.previews9)covered.push('完整十九字段、九模块编辑与真实预览；只读showPrice及历史隐藏ordinal按原顺序保留，空导航/底栏及最大数量合法');
  if(coverage.sharedSettingsAuthority&&coverage.dedicatedRoutes&&coverage.mutationProtocol&&coverage.genericProtection)covered.push('固定product_detail/type3有界共同读取、损坏诊断；fresh CAS与actor UUID原子回执，保留私有扩展及行生命周期，通用读写删除旁路封闭');
  if(coverage.permissions1594&&coverage.actorRecovery)covered.push('独立view/manage及精确1594旧菜单仅查看；未知提交锁住原意图，真实匹配400/409和原404收据明确恢复');
  if(coverage.ordinarySafeDisplay&&coverage.displayPriceIsolation&&coverage.realReplyPreviews&&coverage.communityLinkedPaging)covered.push('普通详情同RR公开安全投影、独立展示会员价、真实评价与关联晒单分页；持久资产归属核验、正文安全过滤并在SQL后签名');
  if(coverage.actualRanks&&coverage.realPackages&&coverage.realRecommendations)covered.push('真实销量/好评/收藏排行、有效搭配套餐和推荐商品按配置数量消费，无示例金额或虚构名次');
  if(coverage.navigationAndFooter&&coverage.sharePosterReferral&&coverage.ordinaryCartLifecycle)covered.push('导航和底栏动作、网页/公众号/小程序分享及推荐人、收藏和客服真实连接；隐藏加购仍可真实SKU立即购买，未知cart按账号恢复');
  if(coverage.activityConsumers&&coverage.pcSharedApi)covered.push('秒杀/拼团/积分沿旧反向参数子集，预售沿普通正向参数，实际SKU接口承接同一展示快照；PC沿共同普通商品API，其UI不记作完整DIY布局');
  reviews['/admin/setting/pages/product_detail']={status:classifyProductDetailDesignCoverage(coverage),targetScreens:coverage.adminScreen?['/setting/product-detail-design','Uniapp /pages/goods/detail']:[],targetApis:['GET /adminapi/config/product-detail-design','POST /adminapi/config/product-detail-design/save','GET /adminapi/config/product-detail-design/receipt/:operationId','GET /api/v2/diy/product_detail','GET /api/product/detail/:id','GET /api/product/:id/community','GET /api/product/code/:id','既有真实cart与checkout接口'],covered,remaining:[...gaps,'Source gate与实际SQL/JWT、受控provider、运行时、构建和浏览器材料分别验收；尚需生产历史配置/资产、真实微信账号、MP/APP真机和正式发布验证，不能用源代码齐全代替这些检查','剩余checklist父项沿原范围保持未完成；本批没有执行生产DDL、grants、部署或外部账号操作'],evidence};
}

let userCenterDesignContract: { coverage: ReturnType<typeof inspectUserCenterDesignCoverage>; gaps: string[]; evidence: string[] } | undefined;
if (userCenterDesignFollowup) {
  const files = userCenterDesignSourceFiles();
  const sources = Object.fromEntries(Object.entries(files).map(([role, file]) => {
    const absolute = resolve(workerRoot, '..', file); return [role, existsSync(absolute) ? readFileSync(absolute, 'utf8') : ''];
  }));
  const coverage = inspectUserCenterDesignCoverage((inventory.target?.routes ?? []).filter(route => route.surface === 'page').map(route => route.path), sources);
  const gaps = Object.entries(coverage).filter(([, value]) => !value).map(([name]) => `个人中心合同尚缺少实际连接：${name}`);
  const evidence = ['cinashop-php/view/admin/src/pages/setting/devise/users.vue', 'cinashop-php/app/services/diy/DiyServices.php', 'cinashop-php/app/controller/api/v1/PublicController.php', 'cinashop-php/view/uniapp/pages/user/index.vue', 'workers-ts/docs/user-center-design-contract-review-20261003.md', ...Object.values(files)];
  userCenterDesignContract = { coverage, gaps, evidence };
  const covered: string[] = [];
  if (coverage.adminScreen && coverage.sixBlockContract && coverage.memberEditor && coverage.orderStatisticsEditor && coverage.listEditors && coverage.previewsSix) covered.push('完整会员/订单/统计/广告/我的服务/商家管理六模块与全部合法样式、显示、标题、资产、列表字段编辑/预览；空列表合法，历史视频资产4与隐藏字段保留');
  if (coverage.assetLinkPicker && coverage.dedicatedRoutes && coverage.permissions1592) covered.push('真实平台素材和注册页面链接选择、双Admin前缀专用读/保存/actor回执；1592精确旧path/auth仅授view，manage独立明确授权');
  if (coverage.sharedThreeAuthority && coverage.atomicMutation && coverage.merchantImmutable && coverage.genericProtection && coverage.actorRecovery) covered.push('member+routine_my_banner+routine_my_menus共同只读快照、锁后collection CAS与原子UUID回执；保留opaque与隐藏行，merchant source/长度/URL/type锁内固定；通用DIY保护，账号隔离原意图恢复');
  if (coverage.publicProjection && coverage.realNineAssets && coverage.memberFiveStyles) covered.push('public严格去sourceId并按角色过滤/安全图片同序签名；真实当前用户九资产、消息、五会员风格与佣金/会员能力消费');
  if (coverage.orderThreeStyles && coverage.posterCarousel && coverage.menuThreeStyles && coverage.videoCollections) covered.push('三订单风格、五实际计数和到期重读；真实广告轮播与两菜单三布局；商品/视频收藏分页、取消、失效状态与实际视频播放');
  if (coverage.memberCode && coverage.userLifecycle && coverage.requestDeadline) covered.push('本地会员付款码真实账号与TTL校验、实际QR、过期清除；login/logout/session/可见生命周期隔离与可中止请求期限');
  reviews['/admin/setting/pages/home'] = {
    status: classifyUserCenterDesignCoverage(coverage), targetScreens: coverage.adminScreen ? ['/setting/user-center-design', 'Uniapp /pages/user/index', 'Uniapp /pages/user/collect', 'Uniapp /pages/user/memberCode'] : [],
    targetApis: ['GET /adminapi/config/user-center-design', 'POST /adminapi/config/user-center-design/save', 'GET /adminapi/config/user-center-design/receipt/:operationId', 'GET /adminapi/config/user-center-design/assets', 'GET /adminapi/config/user-center-design/link-targets', 'GET /api/menu/user', 'GET /api/menu/date', 'GET /api/collect/user', 'POST /api/collect/del', 'GET /api/user/rand_code'],
    covered, remaining: [...gaps, '旧客服订单工作台、客服端与配送管理目标尚无等价实际入口；核销角色/API不等价管理角色。运营统计真实数值与样式已接，旧管理入口未完成，维持partial', '本地会员码为当前账号有界付款码QR；MP/微信H5旧routineUrl/wechatUrl provider行为、真实原生客服/外部小程序/真机与生产账号仍开放', '通用system_group/system_group_data CRUD原本没有注册，当前仅独立固定group writer；不将不存在的入口计为已修复合同', 'Source gate与真实SQL/JWT、运行时、构建、浏览器和受控provider证据分别验收；生产DDL/grants/数据迁移/部署未由源码推导，未完成父项保持开放'], evidence,
  };
}

const legacyRoutes = inventory.legacy.routes.filter((route) => (
  route.surface === "page" && route.path.startsWith("/admin/setting")
));
if (legacyRoutes.length !== 76) {
  throw new Error(`Expected 76 legacy setting business routes, found ${legacyRoutes.length}`);
}
if (new Set(legacyRoutes.map((route) => route.path)).size !== legacyRoutes.length) {
  throw new Error("Legacy setting route inventory contains duplicate paths");
}

const inventoryPaths = new Set(legacyRoutes.map((route) => route.path));
for (const path of Object.keys(reviews)) {
  if (!inventoryPaths.has(path)) throw new Error(`Review path missing from inventory: ${path}`);
}

const routes = legacyRoutes.map((route) => {
  const review = reviews[route.path];
  if (!review) throw new Error(`Missing semantic review: ${route.path}`);
  if (
    !review.evidence.length
    || (review.status !== "missing" && !review.covered.length)
    || (!review.covered.length && !review.remaining.length)
  ) {
    throw new Error(`Review lacks evidence or conclusion: ${route.path}`);
  }
  return {
    legacy: {
      path: route.path,
      title: route.title,
      component: route.component,
      source: `${route.source}:${route.line}`,
    },
    ...review,
  };
});

const statuses: Status[] = ["candidate", "partial", "missing", "retired", "unreviewed"];
const statusCounts = Object.fromEntries(statuses.map((status) => [
  status,
  routes.filter((route) => route.status === status).length,
])) as Record<Status, number>;
const report = {
  version: 1,
  generatedFrom: `audit/${inventoryName}`,
  methodology: {
    scope: "Legacy Admin business-page routes under /admin/setting.",
    status: {
      candidate: "Local code and UI evidence cover the reviewed legacy workflow; production verification may remain.",
      partial: "A useful subset exists, but material legacy workflow or channel coverage is absent.",
      missing: "Reviewed route has no viable target replacement.",
      retired: "Reviewed legacy route is intentionally not migrated because it is broken, duplicated, or obsolete.",
      unreviewed: "Inventory only; no semantic parity conclusion has been made.",
    },
    reviewBasis: "For all 76 routes, compare the legacy component and API with the new Admin router, page, Worker route and consumer. A useful API-only subset may be partial; a read-only lookup is not proof of parity. A business screen with no viable Admin replacement is missing. Retired requires evidence of a broken or inert old screen. This batch is a code-only audit and does not assert production parity.",
    productionAccess: userCenterDesignFollowup
      ? 'This source-only follow-up inspects every field and actual consumer of the six-module personal centre, all three authorities, exact menu 1592 permissions, merchant source immutability and actor recovery. Every scoped call/template gate is required for candidate. Missing merchant management targets and statistic actions remain partial; local payment-code QR does not assert legacy provider parity. Prior raw reports and every unfinished parent remain open.'
      : productDetailDesignFollowup
      ? "This source-only follow-up gates all nineteen product-detail fields and nine modules, protected CAS settings, actual ordinary and legacy activity consumers, authenticated share-code providers and current product callbacks. Every connected source gate is required; SQL/JWT, controlled provider, runtime, fresh builds and browser receipts are independent. No production DDL/grants, live provider account, physical device or deployment acceptance is inferred. Historical raw reports remain immutable."
      : productCategoryStyleFollowup
      ? "This code-only follow-up gates the complete ten-layout category workflow: dedicated protected editor, three-level public taxonomy, real visible product/SKU/cart consumers, draft filters, pagination/sort, T1 scrolling and actor-bound recovery. All source gates are required for candidate; actual SQL/JWT, runtime, four-platform build and browser receipts are separate acceptance inputs. No production role/grant, Hyperdrive, device, PC category-layout or deployment acceptance is asserted; historical flags/reports retain their original bytes and conclusions."
      : cityDeliverySettingsFollowup
      ? "This follow-up reviews the complete legacy four-switch/six-credential city settings screen, encrypted immutable server intents, a shared live provider resolver and closed generic write/read paths. Every source gate must be present before candidate classification. Local PostgreSQL/JWT, controlled provider fetch and synthetic browser evidence do not assert production key/role migration, provider account acceptance, dispatch/cancellation or deployment; historical flags and raw reports retain their original conclusions."
      : themeStyleFollowup
      ? `This theme follow-up reviews the complete six-preset/six-role contract, all ${themeContract?.coverage.registeredPages ?? 0} registered Uniapp page hosts, DIY tone precedence and a dedicated protected writer. Source coverage remains missing or partial until every gate is present. Local PostgreSQL/JWT and synthetic browser evidence do not assert production role migration, new production grants, Hyperdrive, device or release acceptance; historical flags and raw evidence retain their original conclusions.`
      : fabSettingsFollowup
      ? "This FAB follow-up uses owned local PostgreSQL/JWT roles and browser fixtures only. Dedicated catalog selection is bounded read-only; no production grants, DDL, providers, Hyperdrive, MP/APP device acceptance or deployment is claimed. Historical raw evidence stays unchanged and source increments are declared separately."
      : cityDeliveryRecordsFollowup
      ? "This follow-up uses local synthetic PostgreSQL/JWT roles and browser fixtures only. City delivery reads are bounded READ ONLY snapshots. No production Hyperdrive, provider cancellation, real account or deployment acceptance is claimed; prior dated snapshots retain their original evidence."
      : "Token-protected temporary Workers used the configured Hyperdrive for bounded aggregate checks. The second-card audit applied a preconditioned outbox whitelist and two partial indexes, then verified an idempotent second pass. The payment audit used a READ ONLY transaction and returned only presence, format, length, distinct-value and aggregate counts; no payment DDL/DML ran. Every temporary Worker was deleted and no main Worker or frontend was deployed.",
  },
  ...(themeContract ? { themeStyleContract: { status: classifyThemeStyleCoverage(themeContract.coverage), coverage: themeContract.coverage, gaps: themeContract.gaps } } : {}),
  ...(citySettingsContract ? { cityDeliverySettingsContract: { status: classifyCityDeliverySettingsCoverage(citySettingsContract.coverage), coverage: citySettingsContract.coverage, gaps: citySettingsContract.gaps } } : {}),
  ...(categoryStyleContract ? { productCategoryStyleContract: { status: classifyProductCategoryStyleCoverage(categoryStyleContract.coverage), coverage: categoryStyleContract.coverage, gaps: categoryStyleContract.gaps,
    evidenceBoundary: "Source-only connected coverage; actual runtime/browser/native receipts are not inferred from file existence or test declarations." } } : {}),
  ...(productDetailDesignContract ? { productDetailDesignContract: { status: classifyProductDetailDesignCoverage(productDetailDesignContract.coverage),coverage:productDetailDesignContract.coverage,gaps:productDetailDesignContract.gaps,evidenceBoundary:'Source-only; real execution and live-account/device acceptance must be bound separately.' } } : {}),
  ...(userCenterDesignContract ? { userCenterDesignContract: { status: classifyUserCenterDesignCoverage(userCenterDesignContract.coverage), coverage: userCenterDesignContract.coverage, gaps: userCenterDesignContract.gaps, evidenceBoundary: 'Source-only scoped calls and actual template attributes. Independent runtime/build/browser/SQL and provider evidence is not inferred.' } } : {}),
  summary: {
    legacyRoutes: routes.length,
    reviewed: routes.length - statusCounts.unreviewed,
    ...statusCounts,
  },
  routes,
};

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (process.argv.includes("--write")) {
  mkdirSync(dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, serialized, "utf8");
  console.log(`Wrote ${outputFile}`);
} else {
  process.stdout.write(serialized);
}
