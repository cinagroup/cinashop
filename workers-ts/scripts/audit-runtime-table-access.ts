/** Read-only source inventory for reviewing the release GRANT contract.
 * This is evidence, never an automatically executable privilege plan: generic
 * DAOs, dynamic tables, SQL text and row-lock column needs require review. */
import { readdir, readFile } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import ts from 'typescript';
import { is, getTableName } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../src/models/schema';

const tables = new Map<string, string>();
for (const [key, table] of Object.entries(schema)) if (is(table, PgTable)) tables.set(key, getTableName(table));
const root = resolve('src');
const evidence = new Map<string, Map<string, Set<string>>>();
async function walk(directory: string): Promise<void> {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) { if (!['migrations', 'models'].includes(item.name)) await walk(path); continue; }
    if (!item.name.endsWith('.ts')) continue;
    const source = ts.createSourceFile(path, await readFile(path, 'utf8'), ts.ScriptTarget.Latest, true);
    // Resolve imported model aliases (not arbitrary identifiers with the same
    // spelling). This still is not a complete interprocedural call graph.
    const localTables = new Map(tables);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
        || !statement.moduleSpecifier.text.includes('models/schema')) continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) for (const entry of bindings.elements) {
        const table = tables.get((entry.propertyName ?? entry.name).text);
        if (table) localTables.set(entry.name.text, table);
      }
    }
    const record = (table: string, access: string) => {
      let row = evidence.get(table); if (!row) evidence.set(table, row = new Map());
      let locations = row.get(access); if (!locations) row.set(access, locations = new Set());
      locations.add(relative(root, path).replaceAll('\\','/'));
    };
    const targetTable = (node: ts.Node | undefined) => {
      const key = node && (ts.isIdentifier(node) ? node.text : ts.isPropertyAccessExpression(node) ? node.name.text : '');
      return key ? localTables.get(key) : undefined;
    };
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const operation = node.expression.name.text;
        const table = targetTable(node.arguments[0]);
        if (table && ['from','innerJoin','leftJoin','rightJoin','insert','update','delete'].includes(operation)) {
          const access = ['insert','update','delete'].includes(operation) ? operation : 'select';
          record(table,access);
        }
        if (operation === 'onConflictDoUpdate') {
          const inserts = (child: ts.Node) => {
            if (ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression)
              && child.expression.name.text === 'insert') {
              const table = targetTable(child.arguments[0]); if (table) record(table,'upsertUpdate');
            }
            ts.forEachChild(child,inserts);
          };
          inserts(node.expression.expression);
        }
        if (operation === 'for') {
          // Evidence only: joins, dynamic aliases and the `of` option still
          // require manual review before granting any lock-support column.
          const locks = (child: ts.Node) => {
            if (ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression)
              && ['from','innerJoin','leftJoin','rightJoin'].includes(child.expression.name.text)) {
              const table = targetTable(child.arguments[0]); if (table) record(table,'rowLock');
            }
            ts.forEachChild(child,locks);
          };
          locks(node.expression.expression);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}
await walk(root);
console.log(JSON.stringify({ complete: false, executable: false, tables: [...evidence].sort(([a],[b]) => a.localeCompare(b))
  .map(([table, operations]) => ({ table, operations: Object.fromEntries([...operations].map(([key, paths]) => [key, [...paths].sort()])) })) }, null, 2));
