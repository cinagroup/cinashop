import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

interface ApiCall {
  method: HttpMethod;
  path: string;
  source: string;
  line: number;
  registered: boolean;
  matchedRoute: string | null;
  matchedHandler: string | null;
  availability: "executable" | "controlled_unavailable" | "unregistered";
}

interface RegisteredRoute {
  method: HttpMethod;
  path: string;
  line: number;
  handler: string;
  availability: "executable" | "controlled_unavailable";
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workerRoot = resolve(scriptDir, "..");
const repositoryRoot = resolve(workerRoot, "..");
const adminRoot = join(repositoryRoot, "view", "admin-ts");
const backendFile = join(workerRoot, "src", "routes", "adminapi.ts");
const outputFile = join(workerRoot, "audit", "admin-frontend-api-contracts.json");
const methodNames = new Set(["get", "post", "put", "delete", "patch"]);

function normalizedRelative(root: string, file: string): string {
  return relative(root, file).replace(/\\/g, "/");
}

function sha256(file: string): string {
  const canonicalText = readFileSync(file, "utf8").replace(/\r\n?/g, "\n");
  return createHash("sha256").update(canonicalText).digest("hex");
}

function listFiles(root: string, extensions: ReadonlySet<string>): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const file = join(directory, entry);
      if (statSync(file).isDirectory()) visit(file);
      else if (extensions.has(extname(file).toLowerCase())) files.push(file);
    }
  };
  visit(root);
  return files.sort();
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function expressionPaths(
  expression: ts.Expression | undefined,
  variables = new Map<string, ts.Expression>(),
  literalValues = new Map<string, string[]>(),
  seen = new Set<string>(),
): string[] {
  if (!expression) return [];
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return [expression.text];
  }
  if (ts.isTemplateExpression(expression)) {
    let results = [expression.head.text];
    for (const span of expression.templateSpans) {
      const variants = expressionPaths(span.expression, variables, literalValues, seen);
      const replacements = variants.length ? variants : [":param"];
      results = results.flatMap((prefix) =>
        replacements.map((replacement) => `${prefix}${replacement}${span.literal.text}`)
      );
    }
    return unique(results);
  }
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = expressionPaths(expression.left, variables, literalValues, seen);
    const right = expressionPaths(expression.right, variables, literalValues, seen);
    const leftVariants = left.length ? left : [":param"];
    const rightVariants = right.length ? right : [":param"];
    return unique(leftVariants.flatMap((prefix) => rightVariants.map((suffix) => `${prefix}${suffix}`)));
  }
  if (ts.isConditionalExpression(expression)) {
    return unique([
      ...expressionPaths(expression.whenTrue, variables, literalValues, seen),
      ...expressionPaths(expression.whenFalse, variables, literalValues, seen),
    ]);
  }
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    return expressionPaths(expression.expression, variables, literalValues, seen);
  }
  if (ts.isIdentifier(expression)) {
    const declaredValues = literalValues.get(expression.text);
    if (declaredValues?.length) return declaredValues;
    if (seen.has(expression.text)) return [];
    const initializer = variables.get(expression.text);
    if (!initializer) return [];
    const nextSeen = new Set(seen);
    nextSeen.add(expression.text);
    return expressionPaths(initializer, variables, literalValues, nextSeen);
  }

  const objectLiteral = (candidate: ts.Expression): ts.ObjectLiteralExpression | null => {
    let current = candidate;
    while (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current)
    ) current = current.expression;
    if (ts.isObjectLiteralExpression(current)) return current;
    if (ts.isIdentifier(current)) {
      const initializer = variables.get(current.text);
      return initializer ? objectLiteral(initializer) : null;
    }
    return null;
  };

  if (ts.isElementAccessExpression(expression) || ts.isPropertyAccessExpression(expression)) {
    const literal = objectLiteral(expression.expression);
    if (!literal) return [];
    const requested = ts.isPropertyAccessExpression(expression)
      ? expression.name.text
      : ts.isStringLiteral(expression.argumentExpression)
        ? expression.argumentExpression.text
        : null;
    const values: string[] = [];
    for (const property of literal.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
        ? property.name.text
        : null;
      if (requested !== null && name !== requested) continue;
      values.push(...expressionPaths(property.initializer, variables, literalValues, seen));
    }
    return unique(values);
  }
  return [];
}

function normalizePath(path: string): string {
  const withoutQuery = path.split("?", 1)[0];
  return `/${withoutQuery}`.replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/";
}

function sourceUnits(file: string): Array<{ source: ts.SourceFile; lineOffset: number }> {
  const text = readFileSync(file, "utf8");
  if (!file.endsWith(".vue")) {
    return [{
      source: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
      lineOffset: 0,
    }];
  }
  const units: Array<{ source: ts.SourceFile; lineOffset: number }> = [];
  const matcher = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of text.matchAll(matcher)) {
    const before = text.slice(0, match.index ?? 0);
    const lineOffset = before.split("\n").length - 1;
    units.push({
      source: ts.createSourceFile(file, match[1], ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
      lineOffset,
    });
  }
  return units;
}

function collectApiCalls(files: string[]): { calls: Omit<ApiCall, "registered" | "matchedRoute" | "matchedHandler" | "availability">[]; unresolved: Array<{ method: HttpMethod; source: string; line: number }> } {
  const calls: Omit<ApiCall, "registered" | "matchedRoute" | "matchedHandler" | "availability">[] = [];
  const unresolved: Array<{ method: HttpMethod; source: string; line: number }> = [];
  for (const file of files) {
    for (const unit of sourceUnits(file)) {
      const variables = new Map<string, ts.Expression>();
      const literalValues = new Map<string, string[]>();
      const typeValues = (node: ts.TypeNode | undefined): string[] => {
        if (!node) return [];
        if (ts.isUnionTypeNode(node)) return unique(node.types.flatMap(typeValues));
        if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) return [node.literal.text];
        return [];
      };
      const collectVariables = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
          variables.set(node.name.text, node.initializer);
        }
        if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
          const values = typeValues(node.type);
          if (values.length) literalValues.set(node.name.text, values);
        }
        ts.forEachChild(node, collectVariables);
      };
      collectVariables(unit.source);
      const visit = (node: ts.Node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === "request" &&
          methodNames.has(node.expression.name.text)
        ) {
          const position = unit.source.getLineAndCharacterOfPosition(node.getStart(unit.source));
          const line = unit.lineOffset + position.line + 1;
          const method = node.expression.name.text.toUpperCase() as HttpMethod;
          const paths = expressionPaths(node.arguments[0], variables, literalValues);
          if (!paths.length) unresolved.push({ method, source: normalizedRelative(repositoryRoot, file), line });
          else {
            for (const path of paths) {
              calls.push({
                method,
                path: normalizePath(path),
                source: normalizedRelative(repositoryRoot, file),
                line,
              });
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(unit.source);
    }
  }
  return { calls, unresolved };
}

function collectRegisteredRoutes(): RegisteredRoute[] {
  const text = readFileSync(backendFile, "utf8");
  const source = ts.createSourceFile(backendFile, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const routes: RegisteredRoute[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "adminapiRoutes" &&
      methodNames.has(node.expression.name.text)
    ) {
      const paths = expressionPaths(node.arguments[0]);
      for (const path of paths) {
        const handler = node.arguments.at(-1)?.getText(source) ?? "";
        routes.push({
          method: node.expression.name.text.toUpperCase() as HttpMethod,
          path: normalizePath(path),
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          handler,
          availability: /Unavailable/.test(handler) ? "controlled_unavailable" : "executable",
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return routes;
}

function segments(path: string): string[] {
  return normalizePath(path).split("/").filter(Boolean);
}

function routeMatches(callPath: string, registeredPath: string): boolean {
  const call = segments(callPath);
  const route = segments(registeredPath);
  if (call.length !== route.length) return false;
  return call.every((segment, index) => {
    const candidate = route[index];
    if (candidate.startsWith(":")) return true;
    if (segment.startsWith(":")) return false;
    return segment === candidate;
  });
}

export function buildAdminFrontendApiAuditReport() {
  const frontendFiles = [
    ...listFiles(join(adminRoot, "src", "api"), new Set([".ts"])),
    ...listFiles(join(adminRoot, "src", "pages"), new Set([".vue"])),
  ];
  const collected = collectApiCalls(frontendFiles);
  const registeredRoutes = collectRegisteredRoutes();
  const calls: ApiCall[] = collected.calls.map((call) => {
    const match = registeredRoutes.find(
      (route) => route.method === call.method && routeMatches(call.path, route.path),
    );
    return {
      ...call,
      registered: Boolean(match),
      matchedRoute: match?.path ?? null,
      matchedHandler: match?.handler ?? null,
      availability: match?.availability ?? "unregistered",
    };
  });
  const sourceFiles = [...new Set(calls.map((call) => join(repositoryRoot, call.source)))].sort();
  const report = {
    version: 2,
    methodology: {
      scope: "Static request.get/post/put/delete/patch calls in Admin api modules and page scripts.",
      dynamicSegments: "Resolvable conditionals and local URL maps expand to path variants; remaining runtime values normalize to :param by path segment.",
      limitation: "Runtime-computed URLs that cannot be reduced to a path are reported separately.",
    },
    backend: {
      file: normalizedRelative(repositoryRoot, backendFile),
      sha256: sha256(backendFile),
      registeredRoutes,
    },
    frontendSources: sourceFiles.map((file) => ({
      file: normalizedRelative(repositoryRoot, file),
      sha256: sha256(file),
    })),
    counts: {
      callSites: new Set(calls.map((call) => `${call.source}:${call.line}:${call.method}`)).size + collected.unresolved.length,
      pathVariants: calls.length,
      registered: calls.filter((call) => call.registered).length,
      executable: calls.filter((call) => call.availability === "executable").length,
      controlledUnavailable: calls.filter((call) => call.availability === "controlled_unavailable").length,
      unregistered: calls.filter((call) => !call.registered).length,
      unresolved: collected.unresolved.length,
    },
    unregistered: calls.filter((call) => !call.registered),
    controlledUnavailable: calls.filter((call) => call.availability === "controlled_unavailable"),
    unresolved: collected.unresolved,
    calls,
  };

  return report;
}

function runCli() {
  const report = buildAdminFrontendApiAuditReport();
  if (process.argv.includes("--write")) {
    mkdirSync(dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, `${JSON.stringify(report, null, 2)}\n`);
  }
  const printable = process.argv.includes("--summary")
    ? {
      counts: report.counts,
      unregistered: report.unregistered,
      controlledUnavailable: report.controlledUnavailable,
      unresolved: report.unresolved,
    }
    : report;
  console.log(JSON.stringify(printable, null, process.argv.includes("--compact") ? 0 : 2));
  if (process.argv.includes("--strict") && (report.counts.unregistered || report.counts.unresolved)) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli();
