import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..'), script = resolve(root, 'scripts/run-local-finance-postgres.mjs');
const source = readFileSync(script, 'utf8');
function admission(args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe(''); return result.stderr;
}
function variable(file: ts.SourceFile, name: string): ts.Expression | undefined {
  let value: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) value = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(file); return value;
}
function wired(text: string) {
  const file = ts.createSourceFile(script, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const mode = variable(file, 'diyNavigationBrowser'), umbrella = variable(file, 'productPurchaseAdmissionBrowser'), command = variable(file, 'commandArgs');
  if (!mode || !umbrella || !command) return false;
  const environment: Record<string, unknown> = { schemaMaintenance: true, tests: ['audit:diy-navigation-browser'] };
  if (runInNewContext(mode.getText(file), environment) !== true) return false;
  if (runInNewContext(mode.getText(file), { ...environment, tests: ['audit:diy-navigation-browser-extra'] }) !== false) return false;
  const context: Record<string, unknown> = {};
  function identifiers(node: ts.Node) { if (ts.isIdentifier(node)) context[node.text] = false; ts.forEachChild(node, identifiers); }
  identifiers(umbrella); identifiers(command); context.diyNavigationBrowser = true;
  if (runInNewContext(umbrella.getText(file), context) !== true) return false;
  const args = runInNewContext(command.getText(file), context) as string[];
  if (JSON.stringify(args) !== JSON.stringify(['node_modules/vitest/vitest.mjs','run','--config','vitest.diy-navigation-browser.config.ts','--maxWorkers=1'])) return false;
  let flag = false, allowed = false;
  function visit(node: ts.Node) {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Set'
      && node.arguments?.some(arg => ts.isArrayLiteralExpression(arg) && arg.elements.some(value => ts.isStringLiteral(value) && value.text === 'audit:diy-navigation-browser'))) allowed = true;
    if (ts.isSpreadAssignment(node)) {
      let expression = node.expression; while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
      if (ts.isConditionalExpression(expression) && ts.isIdentifier(expression.condition) && expression.condition.text === 'diyNavigationBrowser'
        && ts.isObjectLiteralExpression(expression.whenTrue) && expression.whenTrue.properties.some(property => ts.isPropertyAssignment(property)
          && property.name.getText(file) === 'TEST_DIY_NAVIGATION_BROWSER' && ts.isStringLiteral(property.initializer) && property.initializer.text === '1')) flag = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(file); return allowed && flag;
}

function withoutNavigationUmbrellaOperand(text: string): string {
  const file = ts.createSourceFile(script, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), umbrella = variable(file, 'productPurchaseAdmissionBrowser');
  if (!umbrella) throw Error('Missing actual Browser umbrella');
  let removed = 0;
  const transformed = ts.transform(file, [context => root => {
    function edit(node: ts.Node): ts.VisitResult<ts.Node> {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
        if (ts.isIdentifier(node.left) && node.left.text === 'diyNavigationBrowser') { removed++; return ts.visitNode(node.right, edit); }
        if (ts.isIdentifier(node.right) && node.right.text === 'diyNavigationBrowser') { removed++; return ts.visitNode(node.left, edit); }
      }
      return ts.visitEachChild(node, edit, context);
    }
    function visit(node: ts.Node): ts.VisitResult<ts.Node> { return node === umbrella ? edit(node) : ts.visitEachChild(node, visit, context); }
    return ts.visitNode(root, visit) as ts.SourceFile;
  }]);
  try {
    if (removed !== 1) throw Error('Expected exactly one executable navigation umbrella operand');
    return ts.createPrinter().printFile(transformed.transformed[0]) + '\n// ' + umbrella.getText(file);
  } finally { transformed.dispose(); }
}

describe('owned DIY navigation runner exact admission', () => {
  it('admits only the exact hidden Browser mode through its owned runner up to trusted-bin lookup', () => {
    const error = admission(['--schema-maintenance','unused-bin','audit:diy-navigation-browser']);
    expect(error).toContain('ENOENT'); expect(error).not.toContain('TEST_BROWSER_PACKAGE_JSON'); expect(error).not.toContain('Schema maintenance accepts only');
  });
  it('admits the exact new native file alongside the unchanged complete carousel file before trusted-bin lookup', () => {
    expect(admission(['--schema-maintenance','unused-bin','test/diy-navigation-postgres.test.ts','test/diy-carousel-postgres.test.ts'])).toContain('ENOENT');
  });
  it.each(['audit:diy-navigation-browser-extra','audit:diy-navigation-browser.other'])('rejects suffixed navigation mode %s before native work', mode => {
    expect(admission(['--schema-maintenance','unused-bin',mode])).not.toContain('ENOENT');
  });
  it('rejects navigation Browser without explicit owned schema-maintenance mode', () => {
    expect(admission(['unused-bin','audit:diy-navigation-browser'])).not.toContain('ENOENT');
  });
  it('rejects Browser mode mixed with another mode instead of broadening an umbrella', () => {
    expect(admission(['--schema-maintenance','unused-bin','audit:diy-navigation-browser','audit:diy-carousel-browser'])).not.toContain('ENOENT');
  });
  it('rejects arbitrary verbose/case modifiers for the interactive Browser mode', () => {
    expect(admission(['--schema-maintenance','--verbose-tests','unused-bin','audit:diy-navigation-browser'])).toContain('Verbose reporting applies only');
    expect(admission(['--schema-maintenance','--case','x','unused-bin','audit:diy-navigation-browser'])).toContain('Literal cases apply only');
  });
  it('follows executable literal guard, umbrella, dedicated Vitest command, allowSet and environment binding', () => { expect(wired(source)).toBe(true); });
  it('rejects an AST-disconnected navigation umbrella regardless of preceding family operands or retained commentary', () => {
    const changed = withoutNavigationUmbrellaOperand(source); expect(changed).not.toBe(source); expect(wired(changed)).toBe(false);
  });
  it.each([
    ["    'audit:diy-navigation-browser',", '    // audit:diy-navigation-browser'],
    ["vitest.diy-navigation-browser.config.ts", 'vitest.diy-carousel-browser.config.ts'],
    ["TEST_DIY_NAVIGATION_BROWSER: '1'", "TEST_DIY_NAVIGATION_BROWSER: '0'"],
  ])('rejects a lost runtime navigation link even with its old string in a comment (%s)', (before, after) => {
    expect(source).toContain(before); expect(wired(source.replace(before, after) + '\n// ' + before)).toBe(false);
  });
});
