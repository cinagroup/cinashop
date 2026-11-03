import ts from "typescript";

export interface SourcePosition {
  sourceName: string;
  line: number;
  column: number;
  start: number;
  end: number;
}

export interface StaticSqlLiteral extends SourcePosition {
  symbol: string;
  representation: "string-literal" | "no-substitution-template";
  sql: string;
}

export interface UnresolvedSqlSource extends SourcePosition {
  symbol?: string;
  reason: "interpolated-template" | "non-literal-sql-expression" | "mutable-sql-declaration";
  expressionRanges: Array<SourcePosition & { syntaxKind: string }>;
}

export interface MigrationSourceExtraction {
  sourceName: string;
  staticSqlLiterals: StaticSqlLiteral[];
  unresolved: UnresolvedSqlSource[];
}

// This is a declaration read port, not a TypeScript evaluator or an installer.
// Only explicitly exported *_SQL constants qualify for a literal supplement.
// SQL-looking comments, messages and arbitrary string variables are not inputs.
const sqlSymbol = /(?:^|_)SQL$/;

function withoutSqlCommentsAndValues(text: string): string {
  let output = "";
  for (let index = 0; index < text.length;) {
    if (text.startsWith("--", index)) {
      const end = text.indexOf("\n", index + 2);
      index = end < 0 ? text.length : end;
      output += " ";
    } else if (text.startsWith("/*", index)) {
      let depth = 1;
      index += 2;
      while (index < text.length && depth) {
        if (text.startsWith("/*", index)) { depth++; index += 2; }
        else if (text.startsWith("*/", index)) { depth--; index += 2; }
        else index++;
      }
      output += " ";
    } else if (text[index] === "'" || text[index] === '"') {
      const quote = text[index++];
      while (index < text.length) {
        if (text[index] === "\\") { index += 2; continue; }
        if (text[index++] === quote) {
          if (text[index] === quote) index++;
          else break;
        }
      }
      output += " identifier_or_value ";
    } else {
      output += text[index++];
    }
  }
  return output;
}

function startsSql(text: string): boolean {
  return /^\s*(?:CREATE|ALTER|DO|BEGIN|SET|LOCK|GRANT|REVOKE|COMMENT|DROP)\b/i.test(
    withoutSqlCommentsAndValues(text),
  );
}

function hasTableDdl(text: string): boolean {
  return /\b(?:CREATE|ALTER)\s+TABLE\b/i.test(withoutSqlCommentsAndValues(text));
}

export function extractStaticMigrationSql(sourceText: string, sourceName: string): MigrationSourceExtraction {
  if (!sourceName.trim()) throw new Error("Migration declaration source requires a source name");
  const file = ts.createSourceFile(sourceName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  // TypeScript's public SourceFile interface omits this parser-owned field.
  const diagnostics = (file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (diagnostics.length) {
    const first = diagnostics[0];
    const location = file.getLineAndCharacterOfPosition(first.start ?? 0);
    throw new Error(`Invalid TypeScript migration declaration source ${sourceName}:${location.line + 1}:${location.character + 1}`);
  }
  const result: MigrationSourceExtraction = { sourceName, staticSqlLiterals: [], unresolved: [] };
  const handled = new Set<ts.Node>();
  const position = (node: ts.Node): SourcePosition => {
    const start = node.getStart(file);
    const location = file.getLineAndCharacterOfPosition(start);
    return { sourceName, line: location.line + 1, column: location.character + 1, start, end: node.end };
  };
  const unresolved = (node: ts.Expression, reason: UnresolvedSqlSource["reason"], symbol?: string) => {
    if (handled.has(node)) return;
    handled.add(node);
    const expressions = ts.isTemplateExpression(node) ? node.templateSpans.map(span => span.expression) : [node];
    result.unresolved.push({ ...position(node), ...(symbol ? { symbol } : {}), reason,
      expressionRanges: expressions.map(expression => ({ ...position(expression), syntaxKind: ts.SyntaxKind[expression.kind] })),
    });
  };
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement) ||
      !statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !sqlSymbol.test(declaration.name.text)) continue;
      const symbol = declaration.name.text;
      const value = declaration.initializer;
      if (!value) {
        unresolved(declaration.name, "non-literal-sql-expression", symbol);
      } else if (!(statement.declarationList.flags & ts.NodeFlags.Const)) {
        unresolved(value, "mutable-sql-declaration", symbol);
      } else if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
        if (startsSql(value.text) && hasTableDdl(value.text)) result.staticSqlLiterals.push({
          ...position(value), symbol,
          representation: ts.isStringLiteral(value) ? "string-literal" : "no-substitution-template",
          sql: value.text,
        });
      } else {
        unresolved(value, ts.isTemplateExpression(value) ? "interpolated-template" : "non-literal-sql-expression", symbol);
      }
    }
  }
  // Also disclose DDL-bearing templates outside exported constants, including
  // migration methods. Their literal segments are never joined with blank or
  // invented interpolation values and never become a static SQL supplement.
  const visit = (node: ts.Node): void => {
    if (ts.isTemplateExpression(node)) {
      const segments = [node.head.text, ...node.templateSpans.map(span => span.literal.text)];
      if (startsSql(segments[0])) unresolved(node, "interpolated-template");
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  result.staticSqlLiterals.sort((a, b) => a.start - b.start);
  result.unresolved.sort((a, b) => a.start - b.start);
  return result;
}
