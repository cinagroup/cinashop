import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const FIXED_ROLE_FIXTURE_ROOTS = [
  'test/helpers/customerOriginalPaymentRuntimeFixture.ts',
  'test/helpers/customerFinancialRuntimeFixture.ts',
  'test/helpers/managerRuntimePrivilegeFixture.ts',
] as const;

// Keep the complete former Manager project, including its two bootstrap files
// which do not import a fixed-role factory themselves.
export const LEGACY_MANAGER_TEST_FILES = [
  'test/manager-runtime-privileges-native.test.ts',
  'test/manager-runtime-provision-postgres.test.ts',
  'test/manager-routine-payment-runtime-native.test.ts',
  'test/manager-routine-payment-provision-native.test.ts',
  'test/manager-runtime-bootstrap-postgres.test.ts',
  'test/manager-runtime-capabilities-bootstrap-postgres.test.ts',
] as const;

export interface FixedRoleDynamicRisk {
  file: string;
  line: number;
  expression: string;
}
export interface FixedRoleTestReason {
  fixtureRoots: string[];
  dynamicImports: FixedRoleDynamicRisk[];
  legacyManager: boolean;
}
export interface FixedRoleTestSelection {
  files: string[];
  reasons: Record<string, FixedRoleTestReason>;
  dynamicRisks: FixedRoleDynamicRisk[];
}

const portable = (value: string) => value.split(sep).join('/');
const codeExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const dataExtensions = new Set(['.json', '.css', '.scss', '.sass', '.less', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.wasm', '.html', '.txt', '.sql', '.tgz']);
const inside = (root: string, file: string) => {
  const path = relative(root, file);
  return path === '' || (!path.startsWith('..' + sep) && path !== '..' && !isAbsolute(path));
};

/** Local import graph only: no module is evaluated or provider/fixture started.
 * Unknown dynamic targets are roots of the same conservative serial closure.
 * This schedules shared-role setup outside concurrent files' beforeAll queues;
 * it does not establish the cause of a historical collision. */
export function collectFixedRoleTestFiles(
  workersRoot: string,
  options: { fixtureRoots?: readonly string[]; legacyFiles?: readonly string[] } = {},
): FixedRoleTestSelection {
  const root = realpathSync(workersRoot), repository = dirname(root);
  const roots = (options.fixtureRoots ?? FIXED_ROLE_FIXTURE_ROOTS).map(file => resolve(root, file));
  const legacy = (options.legacyFiles ?? LEGACY_MANAGER_TEST_FILES).map(file => resolve(root, file));
  const entries = readdirSync(resolve(root, 'test'), { withFileTypes: true })
    .filter(file => file.isFile() && file.name.endsWith('.test.ts'))
    .map(file => resolve(root, 'test', file.name)).sort();
  for (const file of [...roots, ...legacy]) {
    if (!existsSync(file) || !statSync(file).isFile()) throw Error(`Missing fixed-role scheduling input: ${file}`);
  }
  const entrySet = new Set(entries);
  for (const file of legacy) if (!entrySet.has(file)) throw Error(`Legacy Manager file is not a top-level test entry: ${file}`);
  const reverse = new Map<string, Set<string>>(), risks = new Map<string, FixedRoleDynamicRisk[]>();
  const visited = new Set<string>(), pending = [...entries, ...roots];
  const label = (file: string) => portable(relative(root, file));
  // Resolve repeated imports once during this live scan only. A later call must
  // see added files, changed imports and retargeted symlinks without stale state.
  const localTargets = new Map<string, string | null>();
  const fileStatus = new Map<string, boolean>();
  const realpaths = new Map<string, string>();
  const isFile = (file: string) => {
    if (!fileStatus.has(file)) fileStatus.set(file, existsSync(file) && statSync(file).isFile());
    return fileStatus.get(file)!;
  };

  const localTarget = (from: string, specifier: string): string | null => {
    if (specifier.startsWith('node:') || /^(?:data|https?):/u.test(specifier)) return null;
    if (!specifier.startsWith('.') && !specifier.startsWith('@/') && !specifier.startsWith('file:') && !isAbsolute(specifier)) return null;
    // Raw assets have no evaluated import graph; ordinary local code must resolve.
    const raw = specifier.replace(/\?(?:raw|url)$/u, '');
    if (raw !== specifier) return null;
    const base = raw.startsWith('@/') ? resolve(root, 'src', raw.slice(2))
      : raw.startsWith('file:') ? fileURLToPath(raw) : resolve(dirname(from), raw);
    if (localTargets.has(base)) return localTargets.get(base)!;
    const emitted = /\.[cm]?jsx?$/u.test(base) ? base.replace(/\.[cm]?jsx?$/u, '') : base;
    const candidates = [base, ...['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.d.ts', '.d.mts', '.d.cts'].map(ext => emitted + ext),
      ...['index.ts', 'index.tsx', 'index.mts', 'index.js', 'index.mjs', 'index.cjs'].map(name => resolve(base, name))];
    const found = candidates.find(isFile);
    if (!found) throw Error(`Unresolved local scheduling import in ${label(from)}: ${specifier}`);
    const actual = realpaths.get(found) ?? realpathSync(found);
    realpaths.set(found, actual);
    if (actual.split(sep).includes('node_modules') || dataExtensions.has(extname(actual))) { localTargets.set(base, null); return null; }
    if (!inside(repository, actual)) throw Error(`Local scheduling import leaves the repository: ${label(from)} -> ${specifier}`);
    localTargets.set(base, actual);
    return actual;
  };

  while (pending.length) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    if (!codeExtensions.has(extname(file))) {
      // An evaluated local format we cannot parse (for example a Vue script)
      // cannot silently conceal a fixture edge. Its importers are serialized.
      risks.set(file, [{ file: label(file), line: 1, expression: `unparsed local module ${extname(file) || '(no extension)'}` }]);
      continue;
    }
    const text = readFileSync(file, 'utf8');
    // All text/position queries below supply source explicitly; parent links
    // are unnecessary for this read-only import inspection.
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
    const parseDiagnostics = (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
    if (parseDiagnostics.length) throw Error(`Cannot parse scheduling imports in ${label(file)}: ${ts.flattenDiagnosticMessageText(parseDiagnostics[0].messageText, ' ')}`);
    const literal = (node: ts.Expression): string | null => {
      if (ts.isStringLiteralLike(node)) return node.text;
      if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return literal(node.expression);
      // Only a direct URL expression is statically known. Bound identifiers stay
      // conservative: a file-wide name lookup cannot establish lexical scope.
      if (ts.isPropertyAccessExpression(node) && node.name.text === 'href') {
        const value = node.expression;
        if (ts.isNewExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === 'URL'
          && value.arguments?.length === 2 && value.arguments[1].getText(source) === 'import.meta.url') {
          return literal(value.arguments[0]);
        }
      }
      return null;
    };
    const externalPrefix = (node: ts.Expression): boolean => {
      if (ts.isTemplateExpression(node)) return /^(?:data|node|https?):/u.test(node.head.text);
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const prefix = literal(node.left);
        return prefix !== null && /^(?:data|node|https?):/u.test(prefix) || externalPrefix(node.left);
      }
      return false;
    };
    const add = (specifier: string) => {
      const target = localTarget(file, specifier);
      if (!target) return;
      const parents = reverse.get(target) ?? new Set<string>();
      parents.add(file); reverse.set(target, parents); pending.push(target);
    };
    const unknown = (node: ts.Node, expression: string) => {
      const risk = { file: label(file), line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, expression };
      const current = risks.get(file) ?? []; current.push(risk); risks.set(file, current);
    };
    const visit = (node: ts.Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        if (!ts.isStringLiteralLike(node.moduleSpecifier)) throw Error(`Nonliteral static scheduling import in ${label(file)}`);
        add(node.moduleSpecifier.text);
      }
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression) {
        const target = literal(node.moduleReference.expression);
        if (target === null) unknown(node, node.moduleReference.expression.getText(source)); else add(target);
      }
      if (ts.isCallExpression(node)) {
        const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
        const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
        const isGlob = ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'glob'
          && node.expression.getText(source) === 'import.meta.glob';
        if (isImport || isRequire) {
          const value = node.arguments[0], target = value && literal(value);
          if (target !== null && target !== undefined) add(target);
          else if (!value || !externalPrefix(value)) unknown(node, value?.getText(source) ?? '(missing target)');
        } else if (isGlob) unknown(node, node.getText(source));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  const importers = (seed: string) => {
    const reached = new Set([seed]), queue = [seed];
    while (queue.length) for (const parent of reverse.get(queue.pop()!) ?? []) {
      if (!reached.has(parent)) { reached.add(parent); queue.push(parent); }
    }
    return reached;
  };
  const reasons: Record<string, FixedRoleTestReason> = {};
  const reason = (file: string) => reasons[label(file)] ??= { fixtureRoots: [], dynamicImports: [], legacyManager: false };
  for (const fixture of roots) for (const entry of importers(fixture)) if (entrySet.has(entry)) reason(entry).fixtureRoots.push(label(fixture));
  for (const [module, findings] of risks) for (const entry of importers(module)) if (entrySet.has(entry)) reason(entry).dynamicImports.push(...findings);
  for (const file of legacy) reason(file).legacyManager = true;
  const files = Object.keys(reasons).sort();
  for (const file of files) {
    reasons[file].fixtureRoots.sort();
    reasons[file].dynamicImports.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  }
  return { files, reasons, dynamicRisks: [...risks.values()].flat().sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line) };
}
