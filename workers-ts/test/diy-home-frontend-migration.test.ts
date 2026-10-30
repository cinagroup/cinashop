import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { createSourceFile, isCallExpression, isFunctionDeclaration, isIdentifier, isPropertyAccessExpression, isVariableDeclaration, ModuleKind, ScriptTarget, transpileModule, type Node, type VariableDeclaration } from "typescript";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const client = readFileSync(resolve(root, "../view/uniapp-ts/src/api/diy.ts"), "utf8");
const loader = readFileSync(resolve(root, "../view/uniapp-ts/src/utils/diy.ts"), "utf8");
const navigation = readFileSync(resolve(root, "../view/uniapp-ts/src/config/navigation.ts"), "utf8");
const fabSource = readFileSync(resolve(root, "../view/uniapp-ts/src/utils/fab.ts"), "utf8");
// Execute the actual frontend pure module with its actual navigation registry.
// No source-function rewrite, frontend-global mock or duplicate policy copy.
const navigationExports: Record<string, unknown> = {}, fabExports: Record<string, unknown> = {};
const compile = (source: string) => transpileModule(source, { compilerOptions: {
  module: ModuleKind.CommonJS, target: ScriptTarget.ES2022,
} }).outputText;
const commonSources = new Set(['communityRoute', 'communityShare', 'customerWorkRoute', 'customerWorkWriteoff', 'customerWorkIntent', 'userCenterDesign', 'divisionStaff', 'checkoutQuote']);
const commonExports = new Map<string, Record<string, unknown>>();
function actualCommonModule(name: string): Record<string, unknown> {
  if (!commonSources.has(name)) throw Error(`Unexpected navigation pure dependency: ${name}`);
  const known = commonExports.get(name);
  if (known) return known;
  const exports: Record<string, unknown> = {};
  commonExports.set(name, exports);
  runInNewContext(compile(readFileSync(resolve(root, `../view/common/${name}.ts`), 'utf8')), {
    exports, URL, TextEncoder, require: (dependency: string) => {
      if (!/^\.\/[A-Za-z]+$/.test(dependency)) throw Error(`Unexpected common pure dependency: ${dependency}`);
      return actualCommonModule(dependency.slice(2));
    },
  });
  return exports;
}
runInNewContext(compile(navigation), { exports: navigationExports, URL, require: (name: string) => {
  if (!['../../../common/communityRoute', '../../../common/customerWorkRoute', '../../../common/divisionStaff'].includes(name)) throw Error(`Unexpected navigation pure dependency: ${name}`);
  return actualCommonModule(name.split('/').at(-1)!);
} });
runInNewContext(compile(fabSource), { exports: fabExports, URL, require: (name: string) => {
  if (name !== "@/config/navigation") throw Error(`Unexpected FAB pure dependency: ${name}`);
  return navigationExports;
} });
function parseFabConfig(value: unknown): unknown {
  const parse = fabExports.parseFabConfig;
  if (typeof parse !== "function") throw Error("Actual FAB parser export missing");
  return Reflect.apply(parse, undefined, [value]);
}
function fabCentre(percent: number, viewport: number, height: number, dragged?: number): unknown {
  const position = fabExports.fabCentre;
  if (typeof position !== "function") throw Error("Actual FAB position export missing");
  return Reflect.apply(position, undefined, [percent, viewport, height, dragged]);
}
const renderer = readFileSync(
  resolve(root, "../view/uniapp-ts/src/components/diy/DiyHomeRenderer.vue"),
  "utf8",
);
const suspended = readFileSync(
  resolve(root, "../view/uniapp-ts/src/components/diy/DiySuspendedNavigation.vue"),
  "utf8",
);
const editorial = readFileSync(
  resolve(root, "../view/uniapp-ts/src/components/diy/DiyEditorialWidget.vue"),
  "utf8",
);
const commerce = readFileSync(
  resolve(root, "../view/uniapp-ts/src/components/diy/DiyCommerceWidget.vue"),
  "utf8",
);
const editorialConfig = readFileSync(resolve(root, "../view/uniapp-ts/src/utils/diyEditorialConfig.ts"), "utf8");
const editorialLoader = readFileSync(resolve(root, "../view/uniapp-ts/src/composables/useDiyEditorialWidget.ts"), "utf8");
const listConfig = readFileSync(resolve(root, "../view/uniapp-ts/src/utils/diyListConfig.ts"), "utf8");
const listLoader = readFileSync(resolve(root, "../view/uniapp-ts/src/composables/useDiyListWidget.ts"), "utf8");
const listWidget = readFileSync(resolve(root, "../view/uniapp-ts/src/components/diy/DiyListWidget.vue"), "utf8");
const commerceConfig = readFileSync(resolve(root, "../view/uniapp-ts/src/utils/diyCommerceConfig.ts"), "utf8");
const commerceLoader = readFileSync(resolve(root, "../view/uniapp-ts/src/composables/useDiyCommerceWidget.ts"), "utf8");
const commerceData = readFileSync(resolve(root, "../view/uniapp-ts/src/utils/diyCommerceData.ts"), "utf8");
const activityClient = readFileSync(
  resolve(root, "../view/uniapp-ts/src/api/activity.ts"),
  "utf8",
);
const homepage = readFileSync(resolve(root, "../view/uniapp-ts/src/pages/index/index.vue"), "utf8");
const microPage = readFileSync(resolve(root, "../view/uniapp-ts/src/pages/diy/detail.vue"), "utf8");
const pages = readFileSync(resolve(root, "../view/uniapp-ts/src/pages.json"), "utf8");
const main = readFileSync(resolve(root, "../view/uniapp-ts/src/main.ts"), "utf8");
const suspendedCache = readFileSync(
  resolve(root, "../view/uniapp-ts/src/utils/diySuspended.ts"),
  "utf8",
);
const suspendedPagePaths = [
  "pages/activity/bargainDetail",
  "pages/activity/detail",
  "pages/activity/index",
  "pages/activity/lottery",
  "pages/activity/lotteryRecords",
  "pages/annex/vip_active/index",
  "pages/article/detail",
  "pages/article/list",
  "pages/discover/index",
  "pages/discover/people",
  "pages/goods/commentDetail",
  "pages/goods/commentList",
  "pages/goods/list",
  "pages/goods/search",
  "pages/order/confirm",
  "pages/order/detail",
  "pages/order/express",
  "pages/order/payResult",
  "pages/order/refundApply",
  "pages/order/refundDetail",
  "pages/order/refundList",
  "pages/user/address",
  "pages/user/balanceLogs",
  "pages/user/collect",
  "pages/user/coupon",
  "pages/user/couponCenter",
  "pages/user/finance",
  "pages/user/integral",
  "pages/user/integralLogs",
  "pages/user/invoice",
  "pages/user/level",
  "pages/user/message",
  "pages/user/messageDetail",
  "pages/user/profile",
  "pages/user/recharge",
  "pages/user/sign",
  "pages/user/spread",
  "pages/user/vipOpen",
] as const;

describe("DIY-home frontend migration", () => {
  it("provides typed clients for the eight legacy contracts", () => {
    for (const route of [
      "diy/get_diy/",
      "diy/diy_version/",
      "diy/user_info",
      "diy/video_list",
      "diy/newcomer_list",
      "diy/product_rank",
      "diy/sign",
      "diy/get_suspended",
    ]) {
      expect(client).toContain(route);
    }
    expect(client).toContain("Promise<DiyPage | []>");
    expect(client).toContain("Promise<DiySuspendedConfig | []>");
    expect(parseFabConfig([])).toBeNull();
    expect(parseFabConfig({ is_show: 1, index: 1, shifting: 0,
      main_ago_image: "/main.png", main_after_image: "", button: [] }))
      .toEqual({ is_show: 1, index: 1, shifting: 0,
        main_ago_image: "/main.png", main_after_image: "", button: [] });
  });

  it("normalizes only named, visible allowlisted components in timestamp order", () => {
    expect(client).toContain('"pageFoot"');
    expect(loader).toContain("ALLOWED_COMPONENTS.has(name)");
    expect(loader).toContain("isDiyEnabled(item.isHide)");
    expect(loader).toContain("componentTimestamp(left) - componentTimestamp(right)");
    expect(loader).toContain("slice(0, MAX_COMPONENTS)");
  });

  it("fails closed on malformed page, image, color, and navigation input", () => {
    expect(loader).toContain("if (!page || Array.isArray(value)) return null");
    expect(loader).toContain("/^https:\\/\\//i.test(url)");
    expect(loader).toContain("/^\\/(?!\\/)/.test(url)");
    expect(loader).toContain("return \"\";");
    expect(navigation).toContain('"/pages/goods_details/index": { target: "/pages/goods/detail"');
    expect(loader).toContain("resolveRegisteredPageRoute(path, query)");
    expect(loader).toContain("if (!raw.startsWith(\"/pages/\")) return \"\"");
  });

  it("only emits bounded safe page background styles", () => {
    expect(loader).toContain("safeDiyColor(page.color_picker)");
    expect(loader).toContain("safeDiyImageUrl(page.bg_pic)");
    expect(loader).toContain("backgroundSize");
    expect(loader).toContain("backgroundRepeat");
  });

  it("uses version-scoped storage and never dynamically instantiates server component names", () => {
    expect(loader).toContain("apiDiyVersion(safeId)");
    expect(loader).toContain("apiDiyPage(safeId)");
    expect(loader).toContain("cinashop_diy_page_v1_");
    expect(loader).toContain("ALLOWED_COMPONENTS.has(name)");
    expect(renderer).not.toContain("<component");
    expect(renderer).not.toContain("v-html");
    expect(renderer).toContain("<DiyPresentationWidget");
    const config=readFileSync(resolve(root,'../view/uniapp-ts/src/utils/diyPresentationConfig.ts'),'utf8');
    expect(config).toContain('diyPresentationHtmlTree(html)');
    const html=readFileSync(resolve(root,'../view/common/diyPresentationHtml.ts'),'utf8');
    expect(html).toContain('const html=sanitizeDiyPresentationHtml(source)');
  });

  it("registers reachable home, micro-page, and suspended-navigation consumers", () => {
    expect(homepage).toContain("useDiyPageHost(() => 0, () => diyCommunityVisible.value)");
    expect(homepage).toContain("<DiyHomeRenderer");
    expect(homepage).toContain("<DiySuspendedNavigation");
    expect(microPage).toContain("useDiyPageHost(() => pageId.value, () => diyCommunityVisible.value)");
    expect(microPage).toContain("micro-page");
    expect(pages).toContain('"path": "pages/diy/detail"');
    expect(suspended).toContain("loadDiySuspendedConfig()");
    expect(suspended).toContain("openFabLink(url)");
    const child = { img: "/child.png", url: "/pages/index/index" };
    const base = { is_show: 1, index: 1, shifting: 0, main_ago_image: "/main.png", main_after_image: "", button: [] };
    for (const index of [1, 2]) expect(parseFabConfig({ ...base, index })).toMatchObject({ index, shifting: 0, button: [] });
    expect(parseFabConfig({ ...base, index: 3, shifting: 100, main_after_image: "/after.png", button: [child, child, child] }))
      .toMatchObject({ index: 3, shifting: 100, main_after_image: "/after.png", button: [child, child, child] });
    expect(parseFabConfig({ ...base, index: 4, main_ago_image: "", button: [child, child, child] }))
      .toMatchObject({ index: 4, main_ago_image: "", main_after_image: "", button: [child, child, child] });
    for (const change of [{ is_show: "1" }, { index: 5 }, { shifting: -1 }, { shifting: 101 }, { main_ago_image: "javascript:alert(1)" },
      { index: 3, main_after_image: "/after.png", button: [child, child] }]) expect(parseFabConfig({ ...base, ...change })).toBeNull();
    expect(parseFabConfig({ ...base, button: [{ img: "/child.png", url: "javascript:alert(1)" }] }))
      .toMatchObject({ is_show: 1, button: [{ img: "/child.png", url: "" }] });
    expect(fabCentre(0, 800, 100)).toBe(50);
    expect(fabCentre(100, 800, 100)).toBe(750);
    expect(fabCentre(50, 800, 100)).toBe(400);
    expect(fabCentre(50, 800, 100, 1000)).toBe(750);
  });

  it("mounts suspended navigation on all 38 migrated legacy destination pages", () => {
    expect(main).toContain('app.component("DiySuspendedNavigation"');
    expect(suspendedCache).toContain("apiDiySuspended()");
    expect(suspendedCache).toContain("SUSPENDED_CACHE_TTL_MS");
    expect(suspendedPagePaths).toHaveLength(38);
    for (const path of suspendedPagePaths) {
      expect(pages).toContain(`"path": "${path}"`);
      const source = readFileSync(resolve(root, `../view/uniapp-ts/src/${path}.vue`), "utf8");
      expect(source).toContain("<DiySuspendedNavigation");
    }
  });

  it("renders the four editor-owned widgets without adding dynamic code paths", () => {
    for (const name of ["news", "hotspot", "follow", "activeParty"]) {
      expect(renderer).toContain(`\"${name}\"`);
      expect(editorial).toContain(`config.kind==='${name}'`);
    }
    expect(editorial).toContain("useDiyEditorialWidget(()=>props.block,()=>props.active)");
    expect(editorialLoader).toContain("normalizeDiyEditorial(block(), theme.preset)");
    expect(editorialConfig).toContain("normalizeDiyLink");
    expect(editorialConfig).toContain("safeDiyImageUrl");
    expect(editorialConfig).toContain("import { diyThemeColor, diyThemeVariables } from './diyTheme'");
    expect(editorialConfig).toContain("diyThemeColor(block, key, index, fallback, preset)");
    const theme = readFileSync(resolve(root, "../view/uniapp-ts/src/utils/diyTheme.ts"), "utf8");
    expect(theme).toContain("import { asDiyRecord, safeDiyColor } from '@/utils/diy'");
    expect(theme).toContain("return safeDiyColor(value,");
    expect(editorial).not.toContain("v-html");
    expect(editorial).not.toContain("<component");
    expect(editorial).not.toContain("downloadFile");
  });

  it("retains complete imported news and hotspot collections while bounding party items and hotspot geometry", () => {
    // Extract exact pure declarations; never replace the production normalizer or its policies.
    const pureNames = new Set(['asDiyRecord', 'isDiyEnabled', 'safeDiyColor', 'safeDiyImageUrl', 'stringLink', 'normalizeDiyLink']);
    const pureFile = createSourceFile('diy.ts', loader, ScriptTarget.Latest, true);
    const pureDeclarations = pureFile.statements.filter(isFunctionDeclaration).filter(node => node.name && pureNames.has(node.name.text));
    expect(pureDeclarations.map(node => node.name!.text).sort()).toEqual([...pureNames].sort());
    const pureExports: Record<string, unknown> = {};
    runInNewContext(compile(pureDeclarations.map(node => node.getText(pureFile)).join('\n')), {
      exports: pureExports, API_BASE: '', resolveRegisteredPageRoute: navigationExports.resolveRegisteredPageRoute,
    });
    const dependencies = new Map<string, Record<string, unknown>>([
      ['./diy', pureExports], ['@/utils/diy', pureExports],
    ]);
    const actualModule = (source: string) => {
      const exports: Record<string, unknown> = {};
      runInNewContext(compile(source), { exports, require: (name: string) => {
        const value = dependencies.get(name);
        if (!value) throw Error(`Unexpected editorial pure dependency: ${name}`);
        return value;
      } });
      return exports;
    };
    const themeExports = actualModule(readFileSync(resolve(root, '../view/uniapp-ts/src/utils/diyTheme.ts'), 'utf8'));
    dependencies.set('./diyTheme', themeExports); dependencies.set('@/utils/diyTheme', themeExports);
    dependencies.set('./diyListConfig', actualModule(listConfig));
    const presets = actualModule(readFileSync(resolve(root, '../view/common/theme.ts'), 'utf8')).THEME_PRESETS;
    if (!Array.isArray(presets) || !presets[2]) throw Error('Actual theme preset missing');
    type Projection = {
      newsItems: { title: string; link: string }[];
      hotspotAreas: { index: number; left: number; top: number; width: number; height: number; link: string }[];
      partyItems: { title: string }[];
    };
    const normalize = (source: string, block: unknown): Projection => {
      const normalizer = actualModule(source).normalizeDiyEditorial;
      if (typeof normalizer !== 'function') throw Error('Actual editorial normalizer export missing');
      return Reflect.apply(normalizer, undefined, [block, presets[2]]) as Projection;
    };
    const link = '/pages/article/list';
    const news = { name: 'news', listConfig: { list: Array.from({ length: 24 }, (_, index) => ({
      show: index >= 10, chiild: [{ val: `完整公告${index + 1}` }, { val: link }], opaque: index,
    })) } };
    const expectedNews = Array.from({ length: 14 }, (_, index) => ({ title: `完整公告${index + 11}`, link }));
    const region = { starX: ' 1.25 ', starY: 0, areaWidth: 20, areaHeight: 10, link };
    const hotspot = { name: 'hotspot', picStyle: { list: [
      { ...region, starX: -1 }, { ...region, areaWidth: 0 }, { ...region, link: 'javascript:bad' },
      ...Array.from({ length: 33 }, (_, index) => ({ ...region, starY: index, opaque: index })),
    ] } };
    const expectedAreas = Array.from({ length: 33 }, (_, index) => ({ index: index + 3, left: 1.25, top: index, width: 20, height: 10, link }));
    const party = { name: 'activeParty', menuConfig: { list: Array.from({ length: 5 }, (_, index) => ({
      img: '/party.png', info: [{ value: `活动${index}` }, { value: '说明' }, { value: link }],
    })) } };
    const before = JSON.stringify([news, hotspot, party]);
    expect(normalize(editorialConfig, news).newsItems).toEqual(expectedNews);
    expect(normalize(editorialConfig, hotspot).hotspotAreas).toEqual(expectedAreas);
    expect(normalize(editorialConfig, party).partyItems.map(item => item.title)).toEqual(['活动0', '活动1', '活动2', '活动3']);
    expect(JSON.stringify([news, hotspot, party])).toBe(before);
    // Mutate each actual collection initializer, before and after filtering.
    // Both historical caps must be detected, including otherwise valid tail items.
    const withCollectionCap = (name: string, limit: number, afterFilter: boolean) => {
      const file = createSourceFile('diyEditorialConfig.ts', editorialConfig, ScriptTarget.Latest, true);
      const normalizer = file.statements.filter(isFunctionDeclaration).find(node => node.name?.text === 'normalizeDiyEditorial');
      if (!normalizer) throw Error('Actual editorial normalizer declaration missing');
      const declarations: VariableDeclaration[] = [];
      const visit = (node: Node) => {
        if (isVariableDeclaration(node) && isIdentifier(node.name) && node.name.text === name) declarations.push(node);
        node.forEachChild(visit);
      };
      visit(normalizer);
      if (declarations.length !== 1) throw Error(`Ambiguous actual collection: ${name}`);
      const initializer = declarations[0]!.initializer;
      if (!initializer || !isCallExpression(initializer) || !isPropertyAccessExpression(initializer.expression) || initializer.expression.name.text !== 'flatMap') throw Error(`Actual collection filter missing: ${name}`);
      const at = afterFilter ? initializer.end : initializer.expression.expression.end;
      return editorialConfig.slice(0, at) + `.slice(0, ${limit})` + editorialConfig.slice(at);
    };
    for (const afterFilter of [false, true]) {
      expect(normalize(withCollectionCap('newsItems', 10, afterFilter), news).newsItems).not.toEqual(expectedNews);
      expect(normalize(withCollectionCap('hotspotAreas', 30, afterFilter), hotspot).hotspotAreas).not.toEqual(expectedAreas);
    }
    expect(editorialConfig).toContain('slice(0, 4)');
    expect(editorialConfig).toContain('coordinates.some(');
    expect(editorialConfig).toContain('left < 0 || top < 0 || left >= 750 || width <= 0 || height <= 0');
    expect(editorialConfig).toContain('Math.min(area.width, 750 - area.left)');
    expect(editorialConfig).toContain("key === 'prConfig' ? 80 : 100");
    expect(editorialConfig).toContain('listRadius(block,');
    expect(editorialConfig).toContain("listText(listRecord(children[0]).val, '', 100)");
    expect(editorial).toContain('<DiyHotspotCanvas');
  });

  it("mounts promotion through its delegated list, coupon points presale combination bargain seckill liveBroadcast independently with no remaining Commerce families", () => {
    const registry = /const COMMERCE_WIDGET_NAMES = new Set(?:<string>)?\(\[?([\s\S]*?)\]?\)/u.exec(renderer);
    expect(registry).not.toBeNull();
    const commerceNames = [...registry![1]!.matchAll(/["']([^"']+)["']/gu)].map(match => match[1]);
    expect(commerceNames).toEqual([]);
    expect(commerceNames).not.toContain("promotionList");
    expect(commerceNames).not.toContain("coupon");
    expect(commerceNames).not.toContain("pointsMall");
    expect(commerceNames).not.toContain("presale");
    expect(commerceNames).not.toContain("combination");
    expect(commerceNames).not.toContain("bargain");
    expect(commerceNames).not.toContain("seckill");
    expect(commerceNames).not.toContain("liveBroadcast");
    expect(renderer).toMatch(/<DiyLiveBroadcastWidget\s+v-else-if="block\.name === 'liveBroadcast'"\s+:block="block"\s+:active="pageActive"\s*\/>/u);
    expect(renderer).toContain("import DiyLiveBroadcastWidget from './DiyLiveBroadcastWidget.vue'");
    const live = readFileSync(resolve(root, "../view/uniapp-ts/src/components/diy/DiyLiveBroadcastWidget.vue"), "utf8");
    const liveController = readFileSync(resolve(root, "../view/uniapp-ts/src/composables/useDiyLiveBroadcast.ts"), "utf8");
    expect(live).toContain('<DiyLiveBroadcastCard v-for="entry in entries"');
    expect(live).toContain(':media="entry.media"');
    expect(liveController).toContain('apiDiyLiveBroadcastRooms(limit)');
    expect(liveController).not.toContain('useDiyCommerceWidget');
    expect(renderer).toMatch(/<DiySeckillWidget\s+v-else-if="block\.name === 'seckill'"\s+:block="block"\s+:active="pageActive"\s*\/>/u);
    expect(renderer).toContain("import DiySeckillWidget from './DiySeckillWidget.vue'");
    const seckill = readFileSync(resolve(root, "../view/uniapp-ts/src/components/diy/DiySeckillWidget.vue"), "utf8");
    const seckillController = readFileSync(resolve(root, "../view/uniapp-ts/src/composables/useDiySeckill.ts"), "utf8");
    expect(seckill).toContain('<DiySeckillCard v-for="entry in entries"');
    expect(seckill).toContain(':media="entry.media"');
    expect(seckillController).toContain('apiDiySeckillIndex()');
    expect(seckillController).toContain('apiDiySeckillProducts(slot.id,count)');
    expect(renderer).toMatch(/<DiyBargainWidget\s+v-else-if="block\.name === 'bargain'"\s+:block="block"\s+:active="pageActive"\s*\/>/u);
    expect(renderer).toContain("import DiyBargainWidget from './DiyBargainWidget.vue'");
    const bargain = readFileSync(resolve(root, "../view/uniapp-ts/src/components/diy/DiyBargainWidget.vue"), "utf8");
    const bargainController = readFileSync(resolve(root, "../view/uniapp-ts/src/composables/useDiyBargain.ts"), "utf8");
    expect(bargain).toContain('<DiyBargainCard v-for="entry in entries"');
    expect(bargain).toContain(':tap="entry.tap"');
    expect(bargainController).toContain('useDiyCommerceWidget(()=>commerceBlock.value,controllerActive)');
    expect(bargainController).toContain('requestBargainSubscription(templateId.value,eligible,');
    expect(renderer).toMatch(/<DiyCombinationWidget\s+v-else-if="block\.name === 'combination'"\s+:block="block"\s+:active="pageActive"\s*\/>/u);
    expect(renderer).toContain("import DiyCombinationWidget from './DiyCombinationWidget.vue'");
    const combination = readFileSync(resolve(root, "../view/uniapp-ts/src/components/diy/DiyCombinationWidget.vue"), "utf8");
    const combinationController = readFileSync(resolve(root, "../view/uniapp-ts/src/composables/useDiyCombination.ts"), "utf8");
    expect(combination).toContain('<DiyCombinationCard v-for="entry in entries"');
    expect(combination).toContain(':tap="entry.tap"');
    expect(combinationController).toContain('useDiyCommerceWidget(()=>commerceBlock.value,controllerActive)');
    expect(combinationController).toContain('requestCombinationSubscription(templateIds.value,eligible,');
    expect(renderer).toMatch(/<DiyPresaleWidget\s+v-else-if="block\.name === 'presale'"\s+:block="block"\s+:active="pageActive"\s*\/>/u);
    expect(renderer).toContain("import DiyPresaleWidget from './DiyPresaleWidget.vue'");
    const presale = readFileSync(resolve(root, "../view/uniapp-ts/src/components/diy/DiyPresaleWidget.vue"), "utf8");
    const presaleController = readFileSync(resolve(root, "../view/uniapp-ts/src/composables/useDiyPresale.ts"), "utf8");
    const presalePresentation = readFileSync(resolve(root, "../view/common/diyPresale.ts"), "utf8");
    expect(presale).toContain('<DiyPresaleCard v-for="entry in entries"');
    expect(presale).toContain(':tap="entry.tap"');
    expect(presale).toContain('useDiyPresale(()=>props.block,()=>props.active)');
    expect(presaleController).toContain('useDiyCommerceWidget(()=>commerceBlock.value,controllerActive)');
    expect(presaleController).toContain('diyAuthoredPageFingerprint([block()])');
    expect(presalePresentation).toContain('export function presalePresentation');
    expect(renderer).toMatch(/<DiyPointsWidget\s+v-else-if="block\.name === 'pointsMall'"\s+:block="block"\s+:active="pageActive"\s*\/>/u);
    expect(renderer).toContain("import DiyPointsWidget from './DiyPointsWidget.vue'");
    const points = readFileSync(resolve(root, "../view/uniapp-ts/src/components/diy/DiyPointsWidget.vue"), "utf8");
    const pointsController = readFileSync(resolve(root, "../view/uniapp-ts/src/composables/useDiyPoints.ts"), "utf8");
    const pointsPresentation = readFileSync(resolve(root, "../view/common/diyPoints.ts"), "utf8");
    expect(points).toContain('<DiyPointsCard v-for="entry in entries"');
    expect(points).toContain(':tap="entry.tap"');
    expect(points).toContain('useDiyPoints(()=>props.block,()=>props.active)');
    expect(pointsController).toContain('useDiyCommerceWidget(()=>commerceBlock.value,controllerActive)');
    expect(pointsController).toContain('diyAuthoredPageFingerprint([block()])');
    expect(pointsPresentation).toContain('export function pointsPresentation');
    expect(renderer).toMatch(/<DiyCouponWidget\s+v-else-if="block\.name === 'coupon'"\s+:block="block"\s+:active="pageActive"\s*\/>/u);
    expect(renderer).toContain("import DiyCouponWidget from './DiyCouponWidget.vue'");
    const coupon = readFileSync(resolve(root, "../view/uniapp-ts/src/components/diy/DiyCouponWidget.vue"), "utf8");
    const couponController = readFileSync(resolve(root, "../view/uniapp-ts/src/composables/useDiyCoupon.ts"), "utf8");
    const couponPresentation = readFileSync(resolve(root, "../view/common/diyCoupon.ts"), "utf8");
    expect(coupon).toContain('<DiyCouponCard v-for="entry in entries"');
    expect(coupon).toContain(':tap="entry.tap"');
    expect(coupon).toContain('useDiyCoupon(()=>props.block,()=>props.active)');
    expect(couponController).toContain('useDiyCommerceWidget(block,()=>active()&&view.value.enabled)');
    expect(couponController).toContain('couponPresentation(block(),theme.preset,safeDiyColor)');
    expect(couponPresentation).toContain('export function couponPresentation');
    expect(renderer).toMatch(/<DiyPromotionWidget\s+v-else-if="block\.name === 'promotionList'"\s+:block="block"\s+:active="pageActive"\s+:header-top="headerOffset\(index\)"\s*\/>/u);
    expect(renderer).toContain("import DiyPromotionWidget from './DiyPromotionWidget.vue'");
    expect(renderer).toMatch(/<DiyCommerceWidget\s+v-else-if="isCommerceWidget\(block\)"\s+:block="block"\s+:active="pageActive"/u);
    const promotion = readFileSync(resolve(root, "../view/uniapp-ts/src/components/diy/DiyPromotionWidget.vue"), "utf8");
    const promotionController = readFileSync(resolve(root, "../view/uniapp-ts/src/composables/useDiyPromotion.ts"), "utf8");
    const projection = readFileSync(resolve(root, "../view/common/diyPromotion.ts"), "utf8");
    expect(promotion).toContain('<DiyListWidget v-if="state.productBlock.value"');
    expect(promotion).toContain(':block="state.productBlock.value" :active="state.ready()"');
    expect(promotionController).toContain('promotionProductBlock(block(), selectedTab.value)');
    expect(projection).toContain("name: 'goodList'");
    expect(projection).toContain('styleConfig: { tabVal: 1 }');
    for (const route of [
      "/seckill/index",
      "/seckill/list/",
      "/combination/list",
      "/bargain/list",
      "/store_integral/list",
      "/presale/list",
      "/v2/coupons",
      "/wechat/live",
    ]) {
      expect(activityClient).toContain(route);
    }
    expect(commerceLoader).toContain("CommerceCoupon");
    expect(commerceLoader).toContain("CommerceRoom");
    expect(commerce).not.toContain(" as any");
    expect(commerce).not.toContain("<component");
    expect(commerce).not.toContain("v-html");
  });

  it("retains complete promotion imports while bounding queries and rejecting empty product scopes", () => {
    const names = new Set(['asDiyRecord', 'isDiyEnabled', 'safeDiyColor', 'safeDiyImageUrl']);
    const pureFile = createSourceFile('diy.ts', loader, ScriptTarget.Latest, true);
    const declarations = pureFile.statements.filter(isFunctionDeclaration).filter(node => node.name && names.has(node.name.text));
    expect(declarations.map(node => node.name!.text).sort()).toEqual([...names].sort());
    const pureExports: Record<string, unknown> = {};
    runInNewContext(compile(declarations.map(node => node.getText(pureFile)).join('\n')), { exports: pureExports, API_BASE: '' });
    const dependencies = new Map<string, Record<string, unknown>>([['@/utils/diy', pureExports]]);
    const actualModule = (source: string) => {
      const exports: Record<string, unknown> = {};
      runInNewContext(compile(source), { exports, require: (name: string) => {
        const value = dependencies.get(name);
        if (!value) throw Error(`Unexpected commerce pure dependency: ${name}`);
        return value;
      } });
      return exports;
    };
    dependencies.set('@/utils/diyTheme', actualModule(readFileSync(resolve(root, '../view/uniapp-ts/src/utils/diyTheme.ts'), 'utf8')));
    const presets = actualModule(readFileSync(resolve(root, '../view/common/theme.ts'), 'utf8')).THEME_PRESETS;
    if (!Array.isArray(presets) || !presets[2]) throw Error('Actual theme preset missing');
    type Projection = { tabs: { label: string; limit: number; query: { ids: string; page: number; limit: number } | null }[]; limit: number };
    const normalize = (source: string, block: unknown): Projection => {
      const normalizer = actualModule(source).normalizeDiyCommerce;
      if (typeof normalizer !== 'function') throw Error('Actual commerce normalizer export missing');
      return Reflect.apply(normalizer, undefined, [block, presets[2]]) as Projection;
    };
    const tabs = Array.from({ length: 33 }, (_, index) => ({
      chiild: [{ val: `完整分组${index + 1}` }], tabVal: 1, goodsList: { ids: [index + 1] }, numConfig: { val: 999 },
    }));
    const block = { name: 'promotionList', tabConfig: { list: [null, [], ...tabs] } };
    const before = JSON.stringify(block);
    const expected = tabs.map((tab, index) => ({ label: tab.chiild[0]!.val, limit: 100, query: { ids: String(index + 1), page: 1, limit: 100 } }));
    const selected = (source: string) => normalize(source, block).tabs.map(({ label, limit, query }) => ({ label, limit, query }));
    expect(selected(commerceConfig)).toEqual(expected);
    expect(JSON.stringify(block)).toBe(before);
    for (const ids of [[], ['01'], Array(101).fill(1)]) {
      expect(normalize(commerceConfig, { name: 'promotionList', tabConfig: { list: [{ tabVal: 1, goodsList: { ids }, numConfig: { val: 999 } }] } }).tabs[0]!.query).toBeNull();
    }
    expect(normalize(commerceConfig, { name: 'seckill', numberConfig: { val: 999 } }).limit).toBe(10);
    expect(normalize(commerceConfig, { name: 'liveBroadcast', numberConfig: { val: 999 } }).limit).toBe(50);
    const file = createSourceFile('diyCommerceConfig.ts', commerceConfig, ScriptTarget.Latest, true);
    const promotion = file.statements.filter(isFunctionDeclaration).find(node => node.name?.text === 'promotionTabs');
    if (!promotion) throw Error('Actual promotion tab normalizer missing');
    const filters: Node[] = [];
    const visit = (node: Node) => {
      if (isCallExpression(node) && isPropertyAccessExpression(node.expression) && node.expression.name.text === 'flatMap' && isIdentifier(node.expression.expression) && node.expression.expression.text === 'raw') filters.push(node);
      node.forEachChild(visit);
    };
    visit(promotion);
    if (filters.length !== 1) throw Error('Ambiguous actual promotion filter');
    const filter = filters[0]!;
    if (!isCallExpression(filter) || !isPropertyAccessExpression(filter.expression)) throw Error('Actual promotion filter missing');
    for (const at of [filter.expression.expression.end, filter.end]) {
      const mutant = commerceConfig.slice(0, at) + '.slice(0, 12)' + commerceConfig.slice(at);
      expect(selected(mutant)).not.toEqual(expected);
    }
    expect(commerceConfig).toContain("value.length > 100");
    expect(commerceConfig).toContain("kind === 'liveBroadcast' ? 50 : 10");
    expect(commerceConfig).toContain("selected.length && limit > 0");
    expect(commerceData).toContain("safeDiyImageUrl");
    expect(commerceData).toContain("commerceInteger(row.room_id, 1)");
    expect(renderer).toContain('<DiyListWidget');
    expect(listWidget).toContain('useDiyListWidget(()=>props.block,()=>props.active)');
    expect(listLoader).toContain('normalizeDiyList(block(), theme.preset)');
    expect(listConfig).toContain("scope === 4 ? selectedIds(listChild(block, 'goodsLabel').activeValue)");
    expect(listConfig).toContain("{ store_label_id: selected.join(',') }");
  });
});
