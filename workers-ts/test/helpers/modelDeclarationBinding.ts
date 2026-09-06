import assert from "node:assert/strict";
import ts from "typescript";

/** Historical line numbers are provenance, not stable after unrelated imports.
 * Bind verbatim syntax to the unique named pgTable's AST, never a global match.
 */
export function assertModelDeclaration(source: string, table: string, declaration: string) {
  const file = ts.createSourceFile("model.ts", source.replace(/\r\n/g, "\n"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const tables: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)
      && ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === "pgTable"
      && node.initializer.arguments[0] && ts.isStringLiteral(node.initializer.arguments[0])
      && node.initializer.arguments[0].text === table) tables.push(node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.equal(tables.length, 1, `Expected exactly one pgTable for ${table}`);
  const expected = declaration.trim().replace(/,$/, "");
  const matches: ts.Node[] = [];
  const bind = (node: ts.Node) => {
    if ((ts.isPropertyAssignment(node) || ts.isCallExpression(node) || ts.isArrowFunction(node))
      && node.getText(file) === expected) matches.push(node);
    // Some historical anchors are a single fluent-method line, not the full field.
    // Bind the exact method-call suffix once, still inside the named table AST.
    if (expected.startsWith(".") && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && file.text.slice(node.expression.expression.end, node.end).trim() === expected) matches.push(node);
    ts.forEachChild(node, bind);
  };
  bind(tables[0]);
  assert.equal(matches.length, 1, `Missing, duplicated or changed declaration in pgTable ${table}: ${expected}`);
}
