import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { adminNavigationSourceItems, hasAdminNavigationMenu, hasConnectedAdminNavigation } from '../scripts/admin-navigation-source';
import { readAdminNavigationSources } from './helpers/adminNavigationSource';

const sources = readAdminNavigationSources();
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
  it('preserves all 101 historical route/permission pairs through the real render chain', () => {
    expect(hasConnectedAdminNavigation(sources)).toBe(true);
    const items = adminNavigationSourceItems(sources);
    expect(items).toHaveLength(101);
    // Original pre-grouping inventory, captured before the PR166 refactor:
    // navigation-before.json SHA256 745b2c57a667e48a98ffcccefbb6cd0fdd55705e62589cd1037767e6445aeae3.
    const pairs = items.map(item => [item.path, item.permissionPath]);
    // Use bytewise sorting, independent of locale/ICU installed on CI.
    pairs.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
    expect(createHash('sha256').update(JSON.stringify(pairs)).digest('hex')).toBe('b46be9c08cd792e9bbf0e99e399ac81aba3a725a50200f309e80f407883d0d75');
    for (const item of items) expect(hasAdminNavigationMenu(sources, item.path, item.permissionPath), item.path).toBe(true);
    expect(hasAdminNavigationMenu(sources, '/config/paid-membership', '/config')).toBe(true);
    expect(hasAdminNavigationMenu(sources, '/config/paid-membership')).toBe(false);
    expect(hasAdminNavigationMenu(sources, '/unregistered')).toBe(false);
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
