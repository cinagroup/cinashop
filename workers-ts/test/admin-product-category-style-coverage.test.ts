import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

type Status = 'candidate' | 'partial' | 'missing';
interface Gates {
  classifyProductCategoryStyleCoverage(value: Record<string, boolean>): Status;
  hasProductCategoryStyleMatrix(source: string): boolean;
  productCategoryStyleSourceFiles(): Record<string, string>;
  inspectProductCategoryStyleCoverage(screens: string[], sources: Record<string, string>): Record<string, boolean>;
}
/** Importing the historical standalone CLI would execute report generation.
 * Extract its real pure functions; no report or product module is executed. */
function gates(): Gates {
  const source = readFileSync('scripts/admin-setting-frontend-parity-audit.ts', 'utf8');
  const tree = ts.createSourceFile('category-audit.ts', source, ts.ScriptTarget.Latest, true);
  const names = new Set(['classifyProductCategoryStyleCoverage', 'categoryAuditCode', 'hasProductCategoryStyleMatrix',
    'productCategoryStyleSourceFiles', 'inspectProductCategoryStyleCoverage']);
  const selected = tree.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && !!node.name && names.has(node.name.text));
  expect(selected).toHaveLength(names.size);
  const result = ts.transpileModule(selected.map(node => node.getText(tree)).join('\n'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  const sandbox = { exports: {} }; runInNewContext(result.outputText, sandbox, { timeout: 1000 });
  return sandbox.exports as Gates;
}
const screens = ['/setting/product-category-style'];
function currentSources(gate: Gates) {
  return Object.fromEntries(Object.entries(gate.productCategoryStyleSourceFiles()).map(([role, file]) => [role, readFileSync(resolve('..', file), 'utf8')]));
}
function mutated(source: Record<string, string>, role: string, before: string, after: string) {
  expect(source[role].includes(before), `${role} current connection`).toBe(true);
  return { ...source, [role]: source[role].split(before).join(after) };
}
function loses(gate: Gates, sources: Record<string, string>, role: string, before: string, after: string, axis: string) {
  const coverage = gate.inspectProductCategoryStyleCoverage(screens, mutated(sources, role, before, after));
  expect(coverage[axis], `${role}/${axis}`).toBe(false);
  expect(gate.classifyProductCategoryStyleCoverage(coverage)).toBe('partial');
}

describe('complete legacy product-category layout source coverage', () => {
  it('requires every named gate, keeps an absent editor missing, and never infers execution receipts', () => {
    const gate = gates(), coverage = gate.inspectProductCategoryStyleCoverage(screens, currentSources(gate));
    expect(Object.keys(coverage)).toHaveLength(17);
    const complete = Object.fromEntries(Object.keys(coverage).map(key => [key, true]));
    expect(gate.classifyProductCategoryStyleCoverage(complete)).toBe('candidate');
    for (const key of Object.keys(complete)) {
      const missing = { ...complete }; delete missing[key];
      expect(gate.classifyProductCategoryStyleCoverage(missing), key).toBe(key === 'adminScreen' ? 'missing' : 'partial');
      expect(gate.classifyProductCategoryStyleCoverage({ ...complete, [key]: false }), key).toBe(key === 'adminScreen' ? 'missing' : 'partial');
    }
    expect(gate.classifyProductCategoryStyleCoverage({ adminScreen: true })).toBe('partial');
    expect(gate.classifyProductCategoryStyleCoverage({ ...complete, adminScreen: false })).toBe('missing');
    expect(Object.keys(coverage).some(key => /passed|browser|runtime|native/i.test(key))).toBe(false);
  });

  it('checks the exact ten legacy ordinals, four templates and server default rather than an array length', () => {
    const gate = gates(), source = currentSources(gate).contract;
    expect(gate.hasProductCategoryStyleMatrix(source)).toBe(true);
    for (const broken of [source.replace("key: '3-2-1', template: 3", "key: '3-2-1', template: 2"),
      source.replace("{ level: 3, index: 3, key: '4-3', template: 4 },", ''),
      source.replace('Object.freeze({ level: 2, index: 1 })', 'Object.freeze({ level: 2, index: 0 })'),
      source.replace("key: '1-3'", "key: '1-2'")]) expect(gate.hasProductCategoryStyleMatrix(broken)).toBe(false);
    expect(gate.hasProductCategoryStyleMatrix(`/* ${source.replace(/\*\//g, '')} */`)).toBe(false);
  });

  it('connects all current implementations and rejects page-only or commentary-only replacements', () => {
    const gate = gates(), sources = currentSources(gate), coverage = gate.inspectProductCategoryStyleCoverage(screens, sources);
    expect(Object.entries(coverage).filter(([, value]) => !value)).toEqual([]);
    expect(gate.classifyProductCategoryStyleCoverage(coverage)).toBe('candidate');
    expect(gate.classifyProductCategoryStyleCoverage(gate.inspectProductCategoryStyleCoverage([], sources))).toBe('missing');
    const comments = Object.fromEntries(Object.entries(sources).map(([key, source]) => [key, `/* ${source.replace(/\*\//g, '')} */`]));
    expect(gate.classifyProductCategoryStyleCoverage(gate.inspectProductCategoryStyleCoverage(screens, comments))).toBe('missing');
  });

  it('requires the fixed shared read, fresh protected writer and exact legacy view permission', () => {
    const gate = gates(), source = currentSources(gate);
    loses(gate, source, 'publicConfig', 'const catalog=await productCategoryStyleCatalog(tx),category=projectProductCategoryStyle(catalog)', 'const catalog=await productCategoryStyleCatalog(tx),category={value:{level:2,index:1}}', 'sharedStyleAuthority');
    loses(gate, source, 'publicConfig', 'product_category:publicProductCategoryStyle(category,category.configured?decodeProductCategoryStyle(catalog.rows[0].value):null)', 'product_category:{level:2,index:1}', 'sharedStyleAuthority');
    loses(gate, source, 'reader', 'saved ? { ...PRODUCT_CATEGORY_STYLE_DEFAULT, ...saved } : null', 'saved', 'sharedStyleAuthority');
    loses(gate, source, 'reader', 'return publicProductCategoryStyle(snapshot, snapshot.configured ? decodeProductCategoryStyle(catalog.rows[0].value) : null)',
      'return publicProductCategoryStyle(snapshot, null)', 'sharedStyleAuthority');
    // read() still contains RR READ ONLY; it must not substitute for the actual public method's isolation.
    loses(gate, source, 'reader', 'readPublic() { return withTx(this.container, async tx => {\n    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);',
      'readPublic() { return withTx(this.container, async tx => {\n    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`);', 'sharedStyleAuthority');
    loses(gate, source, 'reader', '.limit(3)', '.limit(1)', 'sharedStyleAuthority');
    loses(gate, source, 'service', 'catalog.revision !== canonical.revision', 'false', 'dedicatedWrite');
    loses(gate, source, 'service', '...saved, level: canonical.level', 'level: canonical.level', 'dedicatedWrite');
    loses(gate, source, 'permission', "resolved.add('product_category_style.view')", "resolved.add('product_category_style.manage')", 'permissions');
  });

  it('does not close the screen while a generic deletion or save bypass remains', () => {
    const gate = gates(), source = currentSources(gate);
    loses(gate, source, 'crud', 'templateName === "category"', 'templateName === "other"', 'genericWriteProtection');
    loses(gate, source, 'crud', '["suspended_window", "color_change", "category", "product_detail", "member"]', '["suspended_window", "color_change", "product_detail", "member"]', 'genericWriteProtection');
    loses(gate, source, 'controller', 'data.payloadHash === pending.fingerprint', 'true', 'recovery');
    loses(gate, source, 'controller', 'row.actor !== actor', 'false', 'recovery');
  });

  it('rejects lost parent visibility, third-level scope and product publication boundaries', () => {
    const gate = gates(), source = currentSources(gate);
    loses(gate, source, 'categoryPolicy', 'category_root.is_show=1', 'TRUE', 'publicTaxonomy');
    loses(gate, source, 'categoryPolicy', 'tid.pid !== sid.id', 'false', 'categoryScopes');
    loses(gate, source, 'products', 'if (tid) where.tid = tid', '', 'categoryScopes');
    loses(gate, source, 'searcher', "publicCategoryRelationSelection(Number(value), 'tid')", "publicCategoryRelationSelection(Number(value), 'cid')", 'categoryScopes');
    loses(gate, source, 'products', 'isVerify: 1', 'isVerify: -1', 'publishedProducts');
    loses(gate, source, 'cards', 'eq(storeCart.uid, uid)', 'sql`TRUE`', 'publishedProducts');
    loses(gate, source, 'taxonomy', 'publicProductPictures(tx', 'unsafePictures(tx', 'publicTaxonomy');
    loses(gate, source, 'cards', 'publicProductPictures(tx', 'unsafePictures(tx', 'publishedProducts');
    loses(gate, source, 'products', 'await decoratePublicProductCards(', 'await unvalidatedCards(', 'publishedProducts');
  });

  it('requires real active SKU identity, safe media and durable unknown-cart protection', () => {
    const gate = gates(), source = currentSources(gate);
    loses(gate, source, 'ordinary', 'eq(storeProductAttrValue.isRetired, 0)', 'sql`TRUE`', 'safeSkuPurchase');
    loses(gate, source, 'ordinary', 'new Set(unique).size !== unique.length', 'false', 'safeSkuPurchase');
    loses(gate, source, 'ordinary', 'publicProductPictures(tx', 'unsafePictures(tx', 'safeSkuPurchase');
    loses(gate, source, 'products', 'await readOrdinaryProductSnapshot(tx, id, uid, type)', 'await legacyProductSnapshot(tx, id, uid, type)', 'safeSkuPurchase');
    loses(gate, source, 'ordinary', 'price: storeProductAttrValue.price', 'price: storeProductAttrValue.price, cost: storeProductAttrValue.cost', 'safeSkuPurchase');
    loses(gate, source, 'purchase', "row?.state === 'unknown'", "row?.state === 'acknowledged'", 'cartRecovery');
    loses(gate, source, 'purchase', 'actor: auth.uid', 'actor: 0', 'cartRecovery');
    loses(gate, source, 'catalog', 'row.actor !== actor', 'false', 'cartRecovery');
    loses(gate, source, 'ordinaryPage', 'ordinaryRecovery.value !== null', 'false', 'cartRecovery');
  });

  it('preserves applied versus draft filters, bounded paging/sort, T1 scrolling and exactly the six mini-carts', () => {
    const gate = gates(), source = currentSources(gate);
    loses(gate, source, 'reads', 'scope.value = { ...draft.value }', 'scope.value = {}', 'draftFilters');
    loses(gate, source, 'consumer', 'const hide = visible.value && modalOpen.value', 'const hide = modalOpen.value', 'draftFilters');
    loses(gate, source, 'consumer', 'const api = hide ? uni.hideTabBar : uni.showTabBar', 'const api = uni.showTabBar', 'draftFilters');
    loses(gate, source, 'consumer', 'drawer.value !== null || purchase.opened.value || purchase.cartOpen.value', 'drawer.value !== null', 'draftFilters');
    loses(gate, source, 'consumer', '() => syncNativeTabbar(),', '() => void 0,', 'draftFilters');
    loses(gate, source, 'consumer', 'generation === tabbarGeneration && hide === tabbarDesired', 'true', 'draftFilters');
    loses(gate, source, 'consumer', 'owner.visible && visible.value &&', 'true &&', 'draftFilters');
    loses(gate, source, 'consumer', "}, fail });", "}, fail: () => {} });", 'draftFilters');
    loses(gate, source, 'reads', 'requestedPage * 10 < result.count', 'true', 'paginationSort');
    loses(gate, source, 'consumer', '@scroll="treeScroll"', '', 'treeScrollSelection');
    loses(gate, source, 'reads', "removeStorageSync('cate_selected')", "removeStorageSync('other')", 'treeScrollSelection');
    loses(gate, source, 'consumer', "template.value === 'top-products' || template.value === 'side-products'", "template.value !== 'tree'", 'cartLayoutBoundary');
    loses(gate, source, 'reads', "uni.switchTab({ url: '/pages/cart/index' })", 'void 0', 'cartLayoutBoundary');
  });

  it('requires actor and visible-generation protection through category reads and purchasing', () => {
    const gate = gates(), source = currentSources(gate);
    loses(gate, source, 'reads', 'life === generation', 'true', 'actorLifecycle');
    loses(gate, source, 'purchase', 'life === generation', 'true', 'actorLifecycle');
    loses(gate, source, 'reads', 'onHide(suspend)', 'onHide(() => {})', 'actorLifecycle');
  });
});
