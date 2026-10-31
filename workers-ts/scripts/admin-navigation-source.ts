import ts from 'typescript';

/** Pure, version-specific evidence for the actual Admin navigation chain.
 * No file access or application execution; callers supply the three real files. */
export const ADMIN_NAVIGATION_SOURCE_FILES = {
  sidebar: 'view/admin-ts/src/layouts/AdminLayout.vue',
  sidebarNavigation: 'view/admin-ts/src/layouts/AdminSidebarNavigation.vue',
  adminNavigation: 'view/admin-ts/src/utils/adminNavigation.ts',
} as const;
export interface AdminNavigationSourceItem { path: string; permissionPath: string }
const printer = ts.createPrinter({ removeComments: true });
const compact = (value: string) => value.replace(/\s+/gu, '').replace(/"/gu, "'");
function script(source: string): string {
  const clean = source.replace(/<!--[\s\S]*?-->/gu, '');
  if (/^\s*\/\*/u.test(clean) && /\*\/\s*$/u.test(clean)) return '';
  const match = /<script\b[^>]*>([\s\S]*?)<\/script>/iu.exec(clean);
  return match ? match[1]! : clean.includes('<template>') ? '' : clean;
}
class Source {
  readonly tree: ts.SourceFile;
  constructor(source: string) { this.tree = ts.createSourceFile('navigation.ts', script(source), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS); }
  print(node: ts.Node): string { return compact(printer.printNode(ts.EmitHint.Unspecified, node, node.getSourceFile())); }
  variable(name: string): ts.VariableDeclaration | undefined {
    const values = this.tree.statements.filter(ts.isVariableStatement).flatMap(statement =>
      statement.declarationList.flags & ts.NodeFlags.Const ? [...statement.declarationList.declarations] : []);
    const matches = values.filter(node => ts.isIdentifier(node.name) && node.name.text === name);
    return matches.length === 1 ? matches[0] : undefined;
  }
  initializer(name: string, expected: string): boolean {
    const actual = this.variable(name)?.initializer;
    const reference = new Source(`const value = ${expected};`).variable('value')?.initializer;
    return !!actual && !!reference && this.print(actual) === this.print(reference);
  }
  function(name: string, expected: string): boolean {
    const matches = this.tree.statements.filter(ts.isFunctionDeclaration).filter(node => node.name?.text === name);
    const reference = new Source(expected).tree.statements.find(ts.isFunctionDeclaration);
    return matches.length === 1 && !!reference && this.print(matches[0]!) === this.print(reference);
  }
  imports(module: string, local: string, exported?: string): boolean {
    const matches = this.tree.statements.filter(ts.isImportDeclaration).filter(node =>
      ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === module && !node.importClause?.isTypeOnly);
    return matches.some(node => exported === undefined ? node.importClause?.name?.text === local
      : node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
        && node.importClause.namedBindings.elements.some(binding => !binding.isTypeOnly && binding.name.text === local && (binding.propertyName ?? binding.name).text === exported));
  }
  exportedConst(name: string): boolean {
    return this.tree.statements.some(node => ts.isVariableStatement(node)
      && node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
      && node.declarationList.flags & ts.NodeFlags.Const
      && node.declarationList.declarations.some(value => ts.isIdentifier(value.name) && value.name.text === name));
  }
}
interface Tag { name: string; attributes: Map<string, string>; ancestors: Tag[] }
/** Only real template tags count. Attribute values, comments and script strings
 * cannot manufacture an element or a parent/child iteration relationship. */
function tags(source: string): Tag[] {
  const clean = source.replace(/<!--[\s\S]*?-->/gu, '');
  const start = /<template\b[^>]*>/iu.exec(clean);
  const scriptStart = clean.search(/<script\b/iu);
  const end = clean.lastIndexOf('</template>', scriptStart < 0 ? clean.length : scriptStart);
  if (!start || end < start.index) return [];
  const markup = clean.slice(start.index + start[0].length, end).replace(/\{\{[\s\S]*?\}\}/gu, ''), result: Tag[] = [], stack: Tag[] = [];
  const token = /<(\/)?([A-Za-z][\w.-]*)(\s(?:[^"'<>]|"[^"]*"|'[^']*')*)?\s*(\/?)>/gu;
  for (const match of markup.matchAll(token)) {
    const name = match[2]!;
    if (match[1]) { if (stack.pop()?.name !== name) return []; continue; }
    const attributes = new Map<string, string>(), text = (match[3] ?? '').replace(/\/\s*$/u, '');
    let offset = 0;
    const attribute = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;
    for (const row of text.matchAll(attribute)) {
      if (text.slice(offset, row.index).trim() || attributes.has(row[1]!)) return [];
      attributes.set(row[1]!, compact(row[2] ?? row[3] ?? row[4] ?? '')); offset = row.index! + row[0].length;
    }
    if (text.slice(offset).trim()) return [];
    const tag = { name, attributes, ancestors: [...stack] }; result.push(tag);
    if (!match[4] && !/\/\s*$/u.test(match[3] ?? '') && !['img', 'input', 'br', 'hr', 'meta', 'link'].includes(name)) stack.push(tag);
  }
  return stack.length ? [] : result;
}
function live(tag: Tag): boolean {
  return [tag, ...tag.ancestors].every(value => !['v-if', 'v-else-if', 'v-else', 'v-show'].some(key => value.attributes.has(key)));
}
function setupSfc(source: string): boolean {
  const openings = [...source.replace(/<!--[\s\S]*?-->/gu, '').matchAll(/<script\b[^>]*>/giu)];
  return openings.length === 1 && compact(openings[0]![0]) === "<scriptsetuplang='ts'>";
}
function property(node: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  const matches = node.properties.filter(ts.isPropertyAssignment).filter(value =>
    (ts.isIdentifier(value.name) || ts.isStringLiteral(value.name)) && value.name.text === name);
  return matches.length === 1 ? matches[0]!.initializer : undefined;
}
function item(node: ts.Expression): AdminNavigationSourceItem | undefined {
  if (!ts.isObjectLiteralExpression(node) || node.properties.length !== 4) return undefined;
  const path = property(node, 'path'), permission = property(node, 'permissionPath');
  return path && permission && ts.isStringLiteral(path) && ts.isStringLiteral(permission)
    && path.text.startsWith('/') && permission.text.startsWith('/')
    && ['icon', 'label'].every(key => { const value = property(node, key); return !!value && ts.isStringLiteral(value) && value.text.length > 0; })
    ? { path: path.text, permissionPath: permission.text } : undefined;
}
/** Only exported, top-level literal inventories used by visibleAdminNavigation. */
export function adminNavigationSourceItems(sources: Record<string, string>): AdminNavigationSourceItem[] {
  const source = new Source(sources.adminNavigation ?? '');
  if (!['ADMIN_NAVIGATION_SHORTCUTS', 'ADMIN_NAVIGATION_SECTIONS'].every(name => source.exportedConst(name))) return [];
  const shortcuts = source.variable('ADMIN_NAVIGATION_SHORTCUTS')?.initializer;
  const sections = source.variable('ADMIN_NAVIGATION_SECTIONS')?.initializer;
  if (!shortcuts || !sections || !ts.isArrayLiteralExpression(shortcuts) || !ts.isArrayLiteralExpression(sections)) return [];
  const values: ts.Expression[] = [...shortcuts.elements], ids = new Set<string>();
  for (const section of sections.elements) {
    if (!ts.isObjectLiteralExpression(section) || section.properties.length !== 4) return [];
    const id = property(section, 'id'), items = property(section, 'items');
    if (!id || !ts.isStringLiteral(id) || ids.has(id.text) || !items || !ts.isArrayLiteralExpression(items)) return [];
    ids.add(id.text); values.push(...items.elements);
  }
  const items = values.map(item);
  if (items.some(value => !value)) return [];
  const result = items as AdminNavigationSourceItem[];
  return new Set(result.map(value => value.path)).size === result.length ? result : [];
}
export function hasConnectedAdminNavigation(sources: Record<string, string>): boolean {
  const layout = new Source(sources.sidebar ?? ''), sidebar = new Source(sources.sidebarNavigation ?? ''), inventory = new Source(sources.adminNavigation ?? '');
  const layoutTags = tags(sources.sidebar ?? ''), sidebarTags = tags(sources.sidebarNavigation ?? '');
  const mounts = layoutTags.filter(tag => tag.name === 'AdminSidebarNavigation');
  if (!setupSfc(sources.sidebar ?? '') || !setupSfc(sources.sidebarNavigation ?? '')
    || !layout.imports('./AdminSidebarNavigation.vue', 'AdminSidebarNavigation')
    || !layout.imports('@/stores/auth', 'useAuthStore', 'useAuthStore') || !layout.imports('vue', 'computed', 'computed')
    || !layout.initializer('authStore', 'useAuthStore()')
    || !layout.initializer('previewMode', `import.meta.env.DEV && new URLSearchParams(window.location.search).get('preview') === '1'`)
    || !layout.initializer('allowedMenuPaths', 'computed(() => new Set(authStore.menus.map((menu) => menu.path)))')
    || !layout.function('canMenu', `function canMenu(path: string): boolean {
      if (path === "/system/frontend-log") return authStore.isLoggedIn;
      if (previewMode || !authStore.userInfo || authStore.userInfo.level === 0) return true;
      return allowedMenuPaths.value.has(path);
    }`)
    || mounts.length !== 1 || !live(mounts[0]!) || mounts[0]!.attributes.get(':can-menu') !== 'canMenu') return false;
  if (!sidebar.imports('@/utils/adminNavigation', 'visibleAdminNavigation', 'visibleAdminNavigation')
    || !sidebar.imports('vue', 'computed', 'computed')
    || !sidebar.initializer('props', 'defineProps<{ active: string; collapsed: boolean; canMenu: (path: string) => boolean }>()')
    || !sidebar.initializer('navigation', 'computed(() => visibleAdminNavigation(props.canMenu))')
    || !inventory.function('visibleAdminNavigation', `export function visibleAdminNavigation(canMenu: (path: string) => boolean) {
      return {
        shortcuts: ADMIN_NAVIGATION_SHORTCUTS.filter(item => canMenu(item.permissionPath)),
        sections: ADMIN_NAVIGATION_SECTIONS.map(section => ({
          ...section, items: section.items.filter(item => canMenu(item.permissionPath)),
        })).filter(section => section.items.length > 0),
      };
    }`)) return false;
  const menus = sidebarTags.filter(tag => tag.name === 'el-menu' && live(tag) && tag.attributes.has('router'));
  const direct = sidebarTags.filter(tag => tag.name === 'el-menu-item' && live(tag)
    && tag.attributes.get('v-for') === 'iteminnavigation.shortcuts' && tag.attributes.get(':index') === 'item.path'
    && menus.some(menu => tag.ancestors.includes(menu)));
  const groups = sidebarTags.filter(tag => tag.name === 'el-sub-menu' && live(tag)
    && tag.attributes.get('v-for') === 'sectioninnavigation.sections' && tag.attributes.get(':index') === 'section.id'
    && menus.some(menu => tag.ancestors.includes(menu)));
  const grouped = sidebarTags.filter(tag => tag.name === 'el-menu-item' && live(tag)
    && tag.attributes.get('v-for') === 'iteminsection.items' && tag.attributes.get(':index') === 'item.path'
    && groups.some(group => tag.ancestors.includes(group)));
  return sidebarTags.filter(tag => tag.name === 'el-menu').length === 1
    && sidebarTags.filter(tag => tag.name === 'el-menu-item').length === 2
    && sidebarTags.filter(tag => tag.name === 'el-sub-menu').length === 1
    && menus.length === 1 && direct.length === 1 && groups.length === 1 && grouped.length === 1
    && adminNavigationSourceItems(sources).length > 0;
}
export function hasAdminNavigationMenu(sources: Record<string, string>, path: string, permissionPath = path): boolean {
  return hasConnectedAdminNavigation(sources)
    && adminNavigationSourceItems(sources).filter(item => item.path === path && item.permissionPath === permissionPath).length === 1;
}
