import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
const root = resolve(import.meta.dirname, '..'), script = resolve(root, 'scripts/run-local-finance-postgres.mjs');
function admission(file: string) {
  const r = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', file], { cwd: root, encoding: 'utf8', timeout: 10000 });
  expect(r.error).toBeUndefined(); expect(r.status).not.toBe(0); expect(r.stdout).toBe(''); return r.stderr;
}
function literal(text: string) {
  const file = ts.createSourceFile(script, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS); let admitted = false;
  function visit(node: ts.Node) {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Set'
      && node.arguments?.some(x => ts.isArrayLiteralExpression(x) && x.elements.some(y => ts.isStringLiteral(y) && y.text === 'test/diy-page-settings-postgres.test.ts'))) admitted = true;
    ts.forEachChild(node, visit);
  }
  visit(file); return admitted;
}
describe('owned page-settings native runner exact admission', () => {
  it('admits its exact native file up to trusted-bin lookup', () => { expect(admission('test/diy-page-settings-postgres.test.ts')).toContain('ENOENT'); });
  it.each(['test/diy-page-settings-postgres.test.ts.extra', 'test/diy-page-settings-extra-postgres.test.ts', 'test/../test/diy-page-settings-postgres.test.ts'])('rejects nonliteral file %s before native command work', file => { expect(admission(file)).not.toContain('ENOENT'); });
  it('requires executable Set membership, not a commented name', () => {
    const source = readFileSync(script, 'utf8'); expect(literal(source)).toBe(true);
    expect(literal(source.replace("    'test/diy-page-settings-postgres.test.ts',", "    // 'test/diy-page-settings-postgres.test.ts',"))).toBe(false);
  });
});

// Follow executable nodes from the admitted literal to the child process.
// A detached string/import/comment never satisfies this Browser contract.
function pageSettingsBrowserWiring(text: string): boolean {
  const file = ts.createSourceFile(script, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declarations = new Map<string, ts.VariableDeclaration[]>();
  function collect(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const values = declarations.get(node.name.text) ?? []; values.push(node); declarations.set(node.name.text, values);
    }
    ts.forEachChild(node, collect);
  }
  collect(file);
  const variable = (name: string) => { const values = declarations.get(name); return values?.length === 1 ? values[0].initializer : undefined; };
  const unwrap = (node: ts.Expression): ts.Expression => ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;
  const identifier = (node: ts.Expression, name: string) => ts.isIdentifier(unwrap(node)) && (unwrap(node) as ts.Identifier).text === name;
  const string = (node: ts.Expression, value: string) => ts.isStringLiteral(unwrap(node)) && (unwrap(node) as ts.StringLiteral).text === value;
  const number = (node: ts.Expression, value: number) => ts.isNumericLiteral(unwrap(node)) && Number((unwrap(node) as ts.NumericLiteral).text) === value;
  const terms = (input: ts.Expression, operator: ts.BinaryOperator): ts.Expression[] => {
    const node = unwrap(input); return ts.isBinaryExpression(node) && node.operatorToken.kind === operator ? [...terms(node.left, operator), ...terms(node.right, operator)] : [node];
  };
  const equal = (input: ts.Expression, left: (node: ts.Expression) => boolean, right: (node: ts.Expression) => boolean) => {
    const node = unwrap(input); return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken && left(node.left) && right(node.right);
  };
  const mode = variable('diyPageSettingsBrowser'), allow = variable('allowed'), umbrella = variable('productPurchaseAdmissionBrowser'), command = variable('commandArgs'), child = variable('testRun');
  if (!mode || !allow || !umbrella || !command || !child) return false;
  const guards = terms(mode, ts.SyntaxKind.AmpersandAmpersandToken);
  if (guards.length !== 3 || !identifier(guards[0], 'schemaMaintenance') || !equal(guards[1], node => {
    node = unwrap(node); return ts.isPropertyAccessExpression(node) && identifier(node.expression, 'tests') && node.name.text === 'length';
  }, node => number(node, 1)) || !equal(guards[2], node => {
    node = unwrap(node); return ts.isElementAccessExpression(node) && identifier(node.expression, 'tests') && !!node.argumentExpression && number(node.argumentExpression, 0);
  }, node => string(node, 'audit:diy-page-settings-browser'))) return false;
  const allowed = unwrap(allow);
  if (!ts.isNewExpression(allowed) || !identifier(allowed.expression, 'Set') || allowed.arguments?.length !== 1
    || !ts.isArrayLiteralExpression(allowed.arguments[0]) || !allowed.arguments[0].elements.some(node => ts.isStringLiteral(node) && node.text === 'audit:diy-page-settings-browser')) return false;
  let checkedMembership = false;
  function membership(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && identifier(node.expression.expression, 'assert') && node.expression.name.text === 'ok') {
      const every = node.arguments[0];
      if (every && ts.isCallExpression(every) && ts.isPropertyAccessExpression(every.expression) && identifier(every.expression.expression, 'tests') && every.expression.name.text === 'every') {
        const callback = every.arguments[0];
        if (callback && ts.isArrowFunction(callback) && callback.parameters.length === 1 && ts.isIdentifier(callback.parameters[0].name) && !ts.isBlock(callback.body)) {
          const check = unwrap(callback.body);
          if (ts.isCallExpression(check) && ts.isPropertyAccessExpression(check.expression) && identifier(check.expression.expression, 'allowed') && check.expression.name.text === 'has'
            && check.arguments.length === 1 && identifier(check.arguments[0], callback.parameters[0].name.text)) checkedMembership = true;
        }
      }
    }
    ts.forEachChild(node, membership);
  }
  membership(file); if (!checkedMembership) return false;
  if (!terms(umbrella, ts.SyntaxKind.BarBarToken).some(node => identifier(node, 'diyPageSettingsBrowser'))) return false;
  const branch = (input: ts.Expression): ts.Expression | undefined => {
    const node = unwrap(input); if (!ts.isConditionalExpression(node)) return undefined;
    return identifier(node.condition, 'diyPageSettingsBrowser') ? node.whenTrue : branch(node.whenFalse);
  };
  const dispatched = branch(command), wanted = ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.diy-page-settings-browser.config.ts', '--maxWorkers=1'];
  if (!dispatched || !ts.isArrayLiteralExpression(dispatched) || dispatched.elements.length !== wanted.length
    || dispatched.elements.some((node, index) => !ts.isStringLiteral(node) || node.text !== wanted[index])) return false;
  const spawned = unwrap(child);
  if (!ts.isCallExpression(spawned) || !identifier(spawned.expression, 'spawnSync') || spawned.arguments.length !== 3
    || !ts.isPropertyAccessExpression(spawned.arguments[0]) || !identifier(spawned.arguments[0].expression, 'process') || spawned.arguments[0].name.text !== 'execPath'
    || !identifier(spawned.arguments[1], 'commandArgs') || !ts.isObjectLiteralExpression(spawned.arguments[2])) return false;
  const options = spawned.arguments[2], property = (object: ts.ObjectLiteralExpression, name: string) => object.properties.find((node): node is ts.PropertyAssignment => ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === name)?.initializer;
  const timeout = property(options, 'timeout'), env = property(options, 'env');
  if (!timeout || !env) return false;
  const multiplied = unwrap(timeout);
  if (!ts.isBinaryExpression(multiplied) || multiplied.operatorToken.kind !== ts.SyntaxKind.AsteriskToken || !number(multiplied.right, 60_000)) return false;
  const duration = branch(multiplied.left); if (!duration || !number(duration, 50)) return false;
  const environment = unwrap(env);
  if (!ts.isConditionalExpression(environment) || !identifier(environment.condition, 'unitGate') || !ts.isObjectLiteralExpression(environment.whenFalse)) return false;
  return environment.whenFalse.properties.some(node => {
    if (!ts.isSpreadAssignment(node)) return false; const value = unwrap(node.expression);
    return ts.isConditionalExpression(value) && identifier(value.condition, 'diyPageSettingsBrowser') && ts.isObjectLiteralExpression(value.whenTrue)
      && !!property(value.whenTrue, 'TEST_DIY_PAGE_SETTINGS_BROWSER') && string(property(value.whenTrue, 'TEST_DIY_PAGE_SETTINGS_BROWSER')!, '1')
      && ts.isObjectLiteralExpression(value.whenFalse) && value.whenFalse.properties.length === 0;
  });
}

describe('owned page-settings Browser runner executable AST contract', () => {
  const source = readFileSync(script, 'utf8');
  it('connects its exact literal, bounded mode, umbrella, dedicated config, live environment and outer50min spawn', () => { expect(pageSettingsBrowserWiring(source)).toBe(true); });
  it.each([
    ['commented admission', "    'audit:diy-page-settings-browser',", "    // 'audit:diy-page-settings-browser',"],
    ['detached boolean', "const diyPageSettingsBrowser = schemaMaintenance && tests.length === 1 && tests[0] === 'audit:diy-page-settings-browser';", 'const diyPageSettingsBrowser = false;'],
    ['detached umbrella', 'diyPageSettingsBrowser ||', ''],
    ['wrong dispatch config', "vitest.diy-page-settings-browser.config.ts", 'vitest.diy-navigation-browser.config.ts'],
    ['wrong environment', "TEST_DIY_PAGE_SETTINGS_BROWSER: '1'", "TEST_DIY_PAGE_SETTINGS_BROWSER_WRONG: '1'"],
    ['removed outer timeout', 'diyPageSettingsBrowser ? 50 :', ''],
  ])('rejects %s even when the original bytes remain in a comment', (_name, before, after) => {
    expect(source).toContain(before); expect(pageSettingsBrowserWiring(source.replace(before, after) + '\n// ' + before)).toBe(false);
  });
});
