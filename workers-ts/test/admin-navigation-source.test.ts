import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { adminNavigationSourceItems, hasAdminNavigationMenu, hasConnectedAdminNavigation } from '../scripts/admin-navigation-source';
import { readAdminNavigationSources } from './helpers/adminNavigationSource';

const sources = readAdminNavigationSources();
const routerSource = readFileSync(resolve(import.meta.dirname, '../../view/admin-ts/src/router/index.ts'), 'utf8');
// Independent two-parent contract: the main parent 8cdf74a8 contains the
// original 101 pairs, whose hash stays below. These sixteen pairs occur in
// checkpoint d715da71's inline AdminLayout navigation. Frontend-log used its
// explicit isLoggedIn gate there; the connected canMenu branch preserves it.
const addedPairs = [
  ['/activity/bargain-records', '/activity/bargain-records'],
  ['/activity/bargain-statistics', '/activity/bargain-statistics'],
  ['/config/classes', '/config'],
  ['/config/pc', '/config/pc'],
  ['/content/wechat-app', '/content/wechat-app'],
  ['/content/wechat-base', '/content/wechat-base'],
  ['/content/wechat-menu', '/content/wechat-menu'],
  ['/content/wechat-open', '/content/wechat-open'],
  ['/order/delivery-people', '/order'],
  ['/product/ensures', '/product'],
  ['/product/hotwords', '/product'],
  ['/product/parameters', '/product'],
  ['/product/rules', '/product'],
  ['/product/units', '/product'],
  ['/system/frontend-log', '/system/frontend-log'],
  ['/system/menu-rules', '/system/menu-rules'],
] as const;

// Inspect the actual exported router's literal route array and real lazy
// component imports. Comments, detached path strings and unused arrays cannot
// establish registration under the same AdminLayout tested by the menu chain.
function registeredAdminRoutes(source: string): string[] {
  const tree = ts.createSourceFile('router.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const variables = tree.statements.filter(ts.isVariableStatement)
    .filter(statement => statement.declarationList.flags & ts.NodeFlags.Const)
    .flatMap(statement => [...statement.declarationList.declarations]);
  const variable = (name: string) => {
    const matches = variables.filter(node => ts.isIdentifier(node.name) && node.name.text === name);
    return matches.length === 1 ? matches[0]!.initializer : undefined;
  };
  const property = (object: ts.ObjectLiteralExpression, name: string) => {
    const matches = object.properties.filter(ts.isPropertyAssignment).filter(node =>
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === name);
    return matches.length === 1 ? matches[0]!.initializer : undefined;
  };
  const lazyImport = (node: ts.Expression | undefined): string | undefined => {
    if (!node || !ts.isArrowFunction(node) || !ts.isCallExpression(node.body)
      || node.body.expression.kind !== ts.SyntaxKind.ImportKeyword || node.body.arguments.length !== 1) return undefined;
    const target = node.body.arguments[0];
    return target && ts.isStringLiteral(target) ? target.text : undefined;
  };
  const importsRouter = tree.statements.filter(ts.isImportDeclaration).some(node =>
    ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === 'vue-router'
    && node.importClause && !node.importClause.isTypeOnly && node.importClause.namedBindings
    && ts.isNamedImports(node.importClause.namedBindings) && node.importClause.namedBindings.elements.some(binding =>
      !binding.isTypeOnly && binding.name.text === 'createRouter' && (binding.propertyName ?? binding.name).text === 'createRouter'));
  const router = variable('router'), routes = variable('routes');
  if (!importsRouter || !router || !ts.isCallExpression(router) || !ts.isIdentifier(router.expression)
    || router.expression.text !== 'createRouter' || router.arguments.length !== 1
    || !routes || !ts.isArrayLiteralExpression(routes)) return [];
  const options = router.arguments[0];
  if (!options || !ts.isObjectLiteralExpression(options)
    || !options.properties.some(node => ts.isShorthandPropertyAssignment(node) && node.name.text === 'routes')
    || !tree.statements.some(node => ts.isExportAssignment(node) && !node.isExportEquals
      && ts.isIdentifier(node.expression) && node.expression.text === 'router')) return [];
  const layouts = routes.elements.filter(ts.isObjectLiteralExpression).filter(node => {
    const path = property(node, 'path');
    return path && ts.isStringLiteral(path) && path.text === '/' && lazyImport(property(node, 'component')) === '@/layouts/AdminLayout.vue';
  });
  if (layouts.length !== 1) return [];
  const children = property(layouts[0]!, 'children');
  if (!children || !ts.isArrayLiteralExpression(children)) return [];
  return children.elements.filter(ts.isObjectLiteralExpression).flatMap(node => {
    const path = property(node, 'path'), component = lazyImport(property(node, 'component'));
    return path && ts.isStringLiteral(path) && component?.startsWith('@/pages/') && component.endsWith('.vue')
      ? [path.text.startsWith('/') ? path.text : `/${path.text}`] : [];
  });
}

function mutation(role: string, before: string, after: string): Record<string, string> {
  expect(sources[role]?.includes(before), `${role}: actual mutation target`).toBe(true);
  return { ...sources, [role]: sources[role]!.replace(before, after) };
}
type Mutant = [name: string, role: string, before: string, after: string];
const mutants: Mutant[] = [
  ['layout import resolves to actual sidebar', 'sidebar', "'./AdminSidebarNavigation.vue'", "'./UnusedSidebar.vue'"],
  ['layout mounts imported sidebar', 'sidebar', '<AdminSidebarNavigation :active=', '<UnusedSidebar :active='],
  ['layout forwards actual permission function', 'sidebar', ':can-menu="canMenu"', ':can-menu="() => true"'],
  ['layout forwards permission prop at all', 'sidebar', ':can-menu="canMenu"', ''],
  ['layout hidden mount is not coverage', 'sidebar', '<AdminSidebarNavigation :active=', '<AdminSidebarNavigation v-if="false" :active='],
  ['layout uses script setup imports', 'sidebar', '<script setup lang="ts">', '<script lang="ts">'],
  ['layout auth store import', 'sidebar', 'from "@/stores/auth"', 'from "@/stores/fakeAuth"'],
  ['layout actual auth store initialization', 'sidebar', 'const authStore = useAuthStore();', 'const authStore = useFakeAuthStore();'],
  ['layout allowed menu paths source', 'sidebar', 'authStore.menus.map((menu) => menu.path)', 'authStore.menus.map((menu) => menu.label)'],
  ['layout membership guard', 'sidebar', 'return allowedMenuPaths.value.has(path);', 'return true;'],
  ['frontend log cannot bypass login', 'sidebar', 'if (path === "/system/frontend-log") return authStore.isLoggedIn;', 'if (path === "/system/frontend-log") return true;'],
  ['frontend log cannot admit logged-out sessions', 'sidebar', 'if (path === "/system/frontend-log") return authStore.isLoggedIn;', 'if (path === "/system/frontend-log") return !authStore.isLoggedIn;'],
  ['layout root exception remains restricted', 'sidebar', 'authStore.userInfo.level === 0', 'authStore.userInfo.level >= 0'],
  ['layout preview remains development only', 'sidebar', 'import.meta.env.DEV && new URLSearchParams', 'true && new URLSearchParams'],
  ['sidebar resolves actual inventory import', 'sidebarNavigation', "from '@/utils/adminNavigation'", "from '@/utils/fakeNavigation'"],
  ['sidebar passes actual canMenu to filter', 'sidebarNavigation', 'visibleAdminNavigation(props.canMenu)', 'visibleAdminNavigation(() => true)'],
  ['sidebar uses actual computed navigation', 'sidebarNavigation', 'const navigation = computed(() => visibleAdminNavigation(props.canMenu));', 'const disconnected = computed(() => visibleAdminNavigation(props.canMenu));\nconst navigation = computed(() => ({shortcuts:[],sections:[]}));'],
  ['sidebar declares permission prop', 'sidebarNavigation', 'canMenu: (path: string) => boolean', 'unused: (path: string) => boolean'],
  ['shortcut per-item permission filter', 'adminNavigation', 'ADMIN_NAVIGATION_SHORTCUTS.filter(item => canMenu(item.permissionPath))', 'ADMIN_NAVIGATION_SHORTCUTS'],
  ['section per-item permission filter', 'adminNavigation', 'section.items.filter(item => canMenu(item.permissionPath))', 'section.items'],
  ['permissionPath rather than route controls filtering', 'adminNavigation', 'section.items.filter(item => canMenu(item.permissionPath))', 'section.items.filter(item => canMenu(item.path))'],
  ['detached filter does not prove returned menu', 'adminNavigation', 'items: section.items.filter(item => canMenu(item.permissionPath))', 'items: section.items, unused: section.items.filter(item => canMenu(item.permissionPath))'],
  ['filter function must remain exported', 'adminNavigation', 'export function visibleAdminNavigation', 'function visibleAdminNavigation'],
  ['literal inventory must remain exported', 'adminNavigation', 'export const ADMIN_NAVIGATION_SECTIONS', 'const ADMIN_NAVIGATION_SECTIONS'],
  ['shortcut template consumes actual result', 'sidebarNavigation', 'v-for="item in navigation.shortcuts"', 'v-for="item in []"'],
  ['group template consumes actual result', 'sidebarNavigation', 'v-for="section in navigation.sections"', 'v-for="section in []"'],
  ['grouped item template consumes filtered group', 'sidebarNavigation', 'v-for="item in section.items"', 'v-for="item in []"'],
  ['rendered item index uses actual route', 'sidebarNavigation', ':index="item.path"', ':index="item.label"'],
  ['hidden grouped items are not coverage', 'sidebarNavigation', 'v-for="item in section.items"', 'v-if="false" v-for="item in section.items"'],
  ['router menu is actually enabled', 'sidebarNavigation', 'unique-opened router background-color=', 'unique-opened background-color='],
  ['extra ungated item is rejected', 'sidebarNavigation', '</el-menu>', '<el-menu-item index="/ungated" /></el-menu>'],
  ['interpolation string cannot manufacture item', 'sidebarNavigation', `<el-menu-item v-for="item in navigation.shortcuts" :key="item.path" :index="item.path" :aria-label="item.label">
      <el-icon><component :is="item.icon" /></el-icon>
      <template #title><span>{{ item.label }}</span></template>
    </el-menu-item>`, `{{ '<el-menu-item v-for="item in navigation.shortcuts" :index="item.path"></el-menu-item>' }}`],
  ['attribute string cannot manufacture item', 'sidebarNavigation', '<el-menu-item v-for="item in navigation.shortcuts" :key="item.path" :index="item.path" :aria-label="item.label">', '<div title=\'<el-menu-item v-for="item in navigation.shortcuts" :index="item.path">\'>'],
];

describe('connected Admin navigation source evidence', () => {
  it('preserves the main parent 101 pairs and the checkpoint 16 additions through the real render chain', () => {
    expect(hasConnectedAdminNavigation(sources)).toBe(true);
    const items = adminNavigationSourceItems(sources);
    expect(items).toHaveLength(117);
    expect(new Set(items.map(item => item.path)).size).toBe(117);
    // Original pre-grouping inventory, captured before the PR166 refactor:
    // navigation-before.json SHA256 745b2c57a667e48a98ffcccefbb6cd0fdd55705e62589cd1037767e6445aeae3.
    const addedPaths = new Set<string>(addedPairs.map(([path]) => path));
    const additions = items.filter(item => addedPaths.has(item.path)).map(item => [item.path, item.permissionPath]);
    expect(additions.sort()).toEqual(addedPairs.map(pair => [...pair]).sort());
    const pairs = items.filter(item => !addedPaths.has(item.path)).map(item => [item.path, item.permissionPath]);
    expect(pairs).toHaveLength(101);
    // Use bytewise sorting, independent of locale/ICU installed on CI.
    pairs.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
    expect(createHash('sha256').update(JSON.stringify(pairs)).digest('hex')).toBe('b46be9c08cd792e9bbf0e99e399ac81aba3a725a50200f309e80f407883d0d75');
    for (const item of items) expect(hasAdminNavigationMenu(sources, item.path, item.permissionPath), item.path).toBe(true);
    expect(hasAdminNavigationMenu(sources, '/config/paid-membership', '/config')).toBe(true);
    expect(hasAdminNavigationMenu(sources, '/config/paid-membership')).toBe(false);
    expect(hasAdminNavigationMenu(sources, '/unregistered')).toBe(false);
  });
  it.each(addedPairs)('connects added menu %s to its exact permission and registered Admin page', (path, permissionPath) => {
    expect(hasAdminNavigationMenu(sources, path, permissionPath)).toBe(true);
    if (path !== permissionPath) expect(hasAdminNavigationMenu(sources, path, path)).toBe(false);
    const routes = registeredAdminRoutes(routerSource);
    expect(routes.filter(route => route === path || route === `${path}/:id?`)).toHaveLength(1);
  });
  it('does not count route strings detached from the exported router or its actual Admin layout', () => {
    expect(routerSource).toContain('  routes,');
    expect(registeredAdminRoutes(routerSource.replace('  routes,', '  routes: [],'))).toEqual([]);
    expect(routerSource).toContain('export default router;');
    expect(registeredAdminRoutes(routerSource.replace('export default router;', 'export default createRouter({history:createWebHistory(),routes:[]});'))).toEqual([]);
    expect(routerSource).toContain('import("@/layouts/AdminLayout.vue")');
    expect(registeredAdminRoutes(routerSource.replace('import("@/layouts/AdminLayout.vue")', 'import("@/layouts/UnusedLayout.vue")'))).toEqual([]);
  });
  it('accepts comments and formatting without requiring frozen whole-file hashes', () => {
    const formatted = { ...sources, adminNavigation: `/* non-evidence comment */\n${sources.adminNavigation!.replace('canMenu(item.permissionPath)', 'canMenu( /* real call */ item.permissionPath )')}` };
    expect(hasConnectedAdminNavigation(formatted)).toBe(true);
  });
  it.each(mutants)('rejects %s', (_name, role, before, after) => {
    const changed = mutation(role, before, after);
    expect(hasConnectedAdminNavigation(changed)).toBe(false);
    expect(hasAdminNavigationMenu(changed, '/setting/product-detail-design')).toBe(false);
  });
  it.each([
    ['missing route', '"path": "/finance/commissions"', '"path": "/finance/unregistered-commissions"'],
    ['changed permission', '"permissionPath": "/finance/commissions"', '"permissionPath": "/config"'],
    ['missing permission', '"permissionPath": "/finance/commissions", ', ''],
  ])('rejects %s without counting a disconnected route string', (_name, before, after) => {
    const changed = mutation('adminNavigation', before, after);
    expect(hasAdminNavigationMenu(changed, '/finance/commissions')).toBe(false);
  });
  it('rejects duplicate routes and comments in place of actual definitions', () => {
    const duplicate = mutation('adminNavigation', '"path": "/statistic"', '"path": "/dashboard"');
    expect(adminNavigationSourceItems(duplicate)).toEqual([]);
    expect(hasConnectedAdminNavigation(duplicate)).toBe(false);
    for (const role of Object.keys(sources)) {
      const comments = { ...sources, [role]: `/* ${sources[role]!.replace(/\*\//gu, '* /')} */` };
      expect(hasConnectedAdminNavigation(comments), role).toBe(false);
    }
  });
});
