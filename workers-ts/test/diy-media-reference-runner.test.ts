import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
const root = resolve(import.meta.dirname, '..'), script = resolve(root, 'scripts/run-local-finance-postgres.mjs');
const target = 'test/diy-media-reference-postgres.test.ts';
function admission(file: string) {
  const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', file], { cwd: root, encoding: 'utf8', timeout: 10000 });
  expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe(''); return result.stderr;
}
function literal(text: string) {
  const file = ts.createSourceFile(script, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS); let admitted = false;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'allowed' && node.initializer
      && ts.isNewExpression(node.initializer) && ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === 'Set'
      && node.initializer.arguments?.some(value => ts.isArrayLiteralExpression(value) && value.elements.some(element => ts.isStringLiteral(element) && element.text === target))) admitted = true;
    ts.forEachChild(node, visit);
  }
  visit(file); return admitted;
}
describe('owned media-reference native runner exact admission', () => {
  it('admits only its exact native file up to trusted-bin lookup', () => { expect(admission(target)).toContain('ENOENT'); });
  it.each([target + '.extra', 'test/diy-media-reference-extra-postgres.test.ts', 'test/../' + target])('rejects nonliteral %s before any native command work', file => { expect(admission(file)).not.toContain('ENOENT'); });
  it('requires actual allowed Set membership and rejects a name retained only in comments', () => {
    const source = readFileSync(script, 'utf8'), entry = "    '" + target + "',";
    expect(literal(source)).toBe(true); expect(source).toContain(entry);
    expect(literal(source.replace(entry, '    // ' + entry.trim()))).toBe(false);
  });
});

// Follow executable nodes from the admitted literal to the child process.
// A detached string/import/comment never satisfies this Browser contract.
function mediaReferenceBrowserWiring(text: string): boolean {
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
  const mode = variable('diyMediaReferenceBrowser'), allow = variable('allowed'), umbrella = variable('productPurchaseAdmissionBrowser'), command = variable('commandArgs'), child = variable('testRun');
  if (!mode || !allow || !umbrella || !command || !child) return false;
  const guards = terms(mode, ts.SyntaxKind.AmpersandAmpersandToken);
  if (guards.length !== 3 || !identifier(guards[0], 'schemaMaintenance') || !equal(guards[1], node => {
    node = unwrap(node); return ts.isPropertyAccessExpression(node) && identifier(node.expression, 'tests') && node.name.text === 'length';
  }, node => number(node, 1)) || !equal(guards[2], node => {
    node = unwrap(node); return ts.isElementAccessExpression(node) && identifier(node.expression, 'tests') && !!node.argumentExpression && number(node.argumentExpression, 0);
  }, node => string(node, 'audit:diy-media-reference-browser'))) return false;
  const allowed = unwrap(allow);
  if (!ts.isNewExpression(allowed) || !identifier(allowed.expression, 'Set') || allowed.arguments?.length !== 1
    || !ts.isArrayLiteralExpression(allowed.arguments[0]) || !allowed.arguments[0].elements.some(node => ts.isStringLiteral(node) && node.text === 'audit:diy-media-reference-browser')) return false;
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
  if (!terms(umbrella, ts.SyntaxKind.BarBarToken).some(node => identifier(node, 'diyMediaReferenceBrowser'))) return false;
  const branch = (input: ts.Expression): ts.Expression | undefined => {
    const node = unwrap(input); if (!ts.isConditionalExpression(node)) return undefined;
    return identifier(node.condition, 'diyMediaReferenceBrowser') ? node.whenTrue : branch(node.whenFalse);
  };
  const dispatched = branch(command), wanted = ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.diy-media-reference-browser.config.ts', '--maxWorkers=1'];
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
  const duration = branch(multiplied.left); if (!duration || !number(duration, 40)) return false;
  const environment = unwrap(env);
  if (!ts.isConditionalExpression(environment) || !identifier(environment.condition, 'unitGate') || !ts.isObjectLiteralExpression(environment.whenFalse)) return false;
  return environment.whenFalse.properties.some(node => {
    if (!ts.isSpreadAssignment(node)) return false; const value = unwrap(node.expression);
    return ts.isConditionalExpression(value) && identifier(value.condition, 'diyMediaReferenceBrowser') && ts.isObjectLiteralExpression(value.whenTrue)
      && !!property(value.whenTrue, 'TEST_DIY_MEDIA_REFERENCE_BROWSER') && string(property(value.whenTrue, 'TEST_DIY_MEDIA_REFERENCE_BROWSER')!, '1')
      && ts.isObjectLiteralExpression(value.whenFalse) && value.whenFalse.properties.length === 0;
  });
}


const browserTarget = 'audit:diy-media-reference-browser';
function browserAdmission(args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', timeout: 10000 });
  expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe(''); return result.stderr;
}
describe('owned media-reference Browser exact process admission', () => {
  it('admits the single maintenance literal up to trusted-bin lookup', () => {
    expect(browserAdmission(['--schema-maintenance', 'unused-bin', browserTarget])).toContain('ENOENT');
  });
  it.each([
    ['non-maintenance', ['unused-bin', browserTarget], 'Only explicit unit test paths'],
    ['mixed native path', ['--schema-maintenance', 'unused-bin', browserTarget, target], 'Only explicit unit test paths'],
    ['mixed Browser mode', ['--schema-maintenance', 'unused-bin', browserTarget, 'audit:diy-page-settings-browser'], 'Only explicit unit test paths'],
    ['suffix literal', ['--schema-maintenance', 'unused-bin', browserTarget + '-extra'], 'Only explicit unit test paths'],
    ['verbose mode', ['--schema-maintenance', '--verbose-tests', 'unused-bin', browserTarget], 'Verbose reporting applies only to explicit native test files'],
    ['case mode', ['--schema-maintenance', '--case', 'owned-case', 'unused-bin', browserTarget], 'Literal cases apply only to explicit test files'],
  ])('rejects %s before any native command work', (_name, args, message) => {
    const stderr = browserAdmission(args as string[]); expect(stderr).toContain(message); expect(stderr).not.toContain('ENOENT');
  });
});
describe('owned media-reference Browser executable AST chain', () => {
  const source = readFileSync(script, 'utf8');
  it('connects exact maintenance admission through its own umbrella, dedicated config, env flag and outer40min child', () => {
    expect(mediaReferenceBrowserWiring(source)).toBe(true);
  });
  it.each([
    ['commented admission', "    'audit:diy-media-reference-browser',", "    // 'audit:diy-media-reference-browser',"],
    ['detached boolean', "const diyMediaReferenceBrowser = schemaMaintenance && tests.length === 1 && tests[0] === 'audit:diy-media-reference-browser';", 'const diyMediaReferenceBrowser = false;'],
    ['missing single-token bound', "const diyMediaReferenceBrowser = schemaMaintenance && tests.length === 1 && tests[0] === 'audit:diy-media-reference-browser';", "const diyMediaReferenceBrowser = schemaMaintenance && tests[0] === 'audit:diy-media-reference-browser';"],
    ['detached umbrella', 'diyMediaReferenceBrowser ||', ''],
    ['borrowed other Browser umbrella', 'diyMediaReferenceBrowser ||', 'diyPageSettingsBrowser ||'],
    ['wrong config', 'vitest.diy-media-reference-browser.config.ts', 'vitest.diy-page-settings-browser.config.ts'],
    ['wrong environment', "TEST_DIY_MEDIA_REFERENCE_BROWSER: '1'", "TEST_DIY_PAGE_SETTINGS_BROWSER: '1'"],
    ['removed timeout', 'diyMediaReferenceBrowser ? 40 :', ''],
  ])('rejects %s even if the original text survives as a comment', (_name, before, after) => {
    expect(source).toContain(before); expect(mediaReferenceBrowserWiring(source.replace(before, after) + '\n// ' + before)).toBe(false);
  });
});
function configWiring(source: string): boolean {
  const file = ts.createSourceFile('vitest.diy-media-reference-browser.config.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let guard = false, actualConfig = false;
  function visit(node: ts.Node) {
    if (ts.isIfStatement(node) && ts.isBinaryExpression(node.expression) && node.expression.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      const left = node.expression.left, right = node.expression.right;
      guard = ts.isBinaryExpression(left) && left.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
        && left.left.getText(file) === 'process.env.TEST_DIY_MEDIA_REFERENCE_BROWSER'
        && ts.isStringLiteral(left.right) && left.right.text === '1'
        && ts.isPrefixUnaryExpression(right) && right.operator === ts.SyntaxKind.ExclamationToken
        && right.operand.getText(file) === 'process.env.TEST_FINANCE_POSTGRES_URL'
        && ts.isThrowStatement(node.thenStatement) && !!node.thenStatement.expression;
    }
    if (ts.isExportAssignment(node) && ts.isCallExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'defineConfig') {
      const object = node.expression.arguments[0];
      if (object && ts.isObjectLiteralExpression(object)) {
        const property = (value: ts.ObjectLiteralExpression, name: string) => value.properties.find((item): item is ts.PropertyAssignment => ts.isPropertyAssignment(item) && ts.isIdentifier(item.name) && item.name.text === name)?.initializer;
        const test = property(object, 'test');
        if (test && ts.isObjectLiteralExpression(test)) {
          const include = property(test, 'include'), parallel = property(test, 'fileParallelism'), workers = property(test, 'maxWorkers'), timeout = property(test, 'testTimeout');
          actualConfig = !!include && ts.isArrayLiteralExpression(include) && include.elements.length === 1 && ts.isStringLiteral(include.elements[0]) && include.elements[0].text === 'test/browser/diy-media-reference.acceptance.ts'
            && parallel?.kind === ts.SyntaxKind.FalseKeyword && !!workers && ts.isNumericLiteral(workers) && Number(workers.text) === 1
            && !!timeout && ts.isBinaryExpression(timeout) && timeout.operatorToken.kind === ts.SyntaxKind.AsteriskToken
            && ts.isNumericLiteral(timeout.left) && Number(timeout.left.text) === 36 && ts.isNumericLiteral(timeout.right) && Number(timeout.right.text) === 60000;
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file); return guard && actualConfig;
}
describe('owned media-reference dedicated Browser config', () => {
  const config = readFileSync(resolve(root, 'vitest.diy-media-reference-browser.config.ts'), 'utf8');
  it('requires its actual owned env and PG URL before exporting the exact single-worker 36min acceptance config', () => { expect(configWiring(config)).toBe(true); });
  it.each([
    ['wrong env flag', 'TEST_DIY_MEDIA_REFERENCE_BROWSER', 'TEST_DIY_PAGE_SETTINGS_BROWSER'],
    ['missing PG guard', "||!process.env.TEST_FINANCE_POSTGRES_URL", ''],
    ['comment-only include', "include:['test/browser/diy-media-reference.acceptance.ts']", "include:[]"],
    ['parallel worker config', 'maxWorkers:1', 'maxWorkers:2'],
  ])('rejects %s with the original bytes left only in a comment', (_name, before, after) => {
    expect(config).toContain(before); expect(configWiring(config.replace(before, after) + '\n// ' + before)).toBe(false);
  });
});
