import assert from "node:assert/strict";
import ts from "typescript";

/** Keep historical expressions verbatim inside the unique named class/method.
 * Comments, calls in another method and duplicated declarations cannot stand
 * in for a shifted live source anchor. This proves syntax, not SQL execution.
 */
export function assertMethodCall(source: string, className: string, methodName: string, declaration: string, count = 1) {
  const file = ts.createSourceFile("consumer.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const classes = file.statements.filter(ts.isClassDeclaration).filter(node => node.name?.text === className);
  assert.equal(classes.length, 1, `Expected one consumer class ${className}`);
  const methods = classes[0].members.filter(ts.isMethodDeclaration).filter(node => node.name.getText(file) === methodName);
  assert.equal(methods.length, 1, `Expected one consumer method ${className}.${methodName}`);
  const expected = declaration.trim().replace(/,$/, "");
  let matches = 0;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && (node.getText(file) === expected
      || expected.startsWith(".") && ts.isPropertyAccessExpression(node.expression)
      && file.text.slice(node.expression.expression.end, node.end).trim() === expected)) matches++;
    ts.forEachChild(node, visit);
  };
  visit(methods[0]);
  assert.equal(matches, count, `Exact consumer call in ${className}.${methodName}: ${expected}`);
}
