import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

type Surface = "page" | "auxiliary" | "layout" | "other";

interface RouteEntry {
  source: string;
  line: number;
  path: string;
  name: string | null;
  title: string | null;
  component: string;
  resolvedComponent: string | null;
  surface: Surface;
}

interface FrontendInventory {
  root: string;
  routeFiles: Array<{ file: string; sha256: string }>;
  pageVueFiles: string[];
  routes: RouteEntry[];
  unresolvedComponents: string[];
  unroutedPageFiles: string[];
  duplicatePaths: Array<{ path: string; count: number }>;
  duplicateComponents: Array<{ component: string; count: number }>;
  domains: Record<string, number>;
  counts: {
    pageVueFiles: number;
    routeRecords: number;
    businessPageRouteRecords: number;
    distinctRoutedPageComponents: number;
    auxiliaryRouteRecords: number;
    layoutRouteRecords: number;
    otherRouteRecords: number;
    unresolvedComponents: number;
    unroutedPageFiles: number;
  };
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workerRoot = resolve(scriptDir, "..");
const repositoryRoot = resolve(workerRoot, "..");
const legacyRoot = resolve(
  process.env.CINASHOP_PHP_ROOT ?? join(repositoryRoot, "..", "cinashop-php"),
);
const legacyAdminRoot = join(legacyRoot, "view", "admin");
const targetAdminRoot = join(repositoryRoot, "view", "admin-ts");
const outputFile = join(workerRoot, "audit", "admin-frontend-inventory.json");

function normalizedRelative(root: string, file: string): string {
  return relative(root, file).replace(/\\/g, "/");
}

function sha256(file: string): string {
  const canonicalText = readFileSync(file, "utf8").replace(/\r\n?/g, "\n");
  return createHash("sha256").update(canonicalText).digest("hex");
}

function listFiles(root: string, extension: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const file = join(directory, entry);
      if (statSync(file).isDirectory()) visit(file);
      else if (extname(file).toLowerCase() === extension) files.push(file);
    }
  };
  visit(root);
  return files.sort();
}

function property(object: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | undefined {
  return object.properties.find((candidate): candidate is ts.PropertyAssignment => {
    if (!ts.isPropertyAssignment(candidate)) return false;
    if (ts.isIdentifier(candidate.name) || ts.isStringLiteral(candidate.name)) {
      return candidate.name.text === name;
    }
    return false;
  });
}

function literal(expression: ts.Expression | undefined): string | null {
  if (!expression) return null;
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  return null;
}

function findImport(expression: ts.Expression | undefined): string | null {
  if (!expression) return null;
  let result: string | null = null;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1
    ) {
      result = literal(node.arguments[0]);
      return;
    }
    if (!result) ts.forEachChild(node, visit);
  };
  visit(expression);
  return result;
}

function routeTitle(object: ts.ObjectLiteralExpression): string | null {
  const meta = property(object, "meta")?.initializer;
  if (!meta || !ts.isObjectLiteralExpression(meta)) return null;
  return literal(property(meta, "title")?.initializer);
}

function joinRoute(parent: string, child: string | null): string {
  if (!child) return parent || "/";
  if (child.startsWith("/")) return child.replace(/\/+$/, "") || "/";
  const prefix = parent === "/" ? "" : parent.replace(/\/+$/, "");
  return `${prefix}/${child}`.replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/";
}

function resolveAliasComponent(frontendRoot: string, component: string): string | null {
  if (!component.startsWith("@/")) return null;
  const base = join(frontendRoot, "src", component.slice(2));
  const candidates = [base, `${base}.vue`, join(base, "index.vue")];
  const match = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
  return match ? normalizedRelative(frontendRoot, match) : null;
}

function classifyComponent(component: string): Surface {
  if (component.startsWith("@/pages/")) return "page";
  if (component.startsWith("@/components/")) return "auxiliary";
  if (component.startsWith("@/layouts/")) return "layout";
  return "other";
}

function sourceFile(file: string): ts.SourceFile {
  const source = readFileSync(file, "utf8");
  return ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
}

function variableInitializers(source: ts.SourceFile): Map<string, ts.Expression> {
  const variables = new Map<string, ts.Expression>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) {
        variables.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  return variables;
}

function collectRoutes(
  file: string,
  frontendRoot: string,
  initialExpressions: ts.Expression[],
): RouteEntry[] {
  const source = sourceFile(file);
  const variables = variableInitializers(source);
  const routes: RouteEntry[] = [];

  const visit = (expression: ts.Expression, parentPath: string) => {
    if (ts.isIdentifier(expression)) {
      const resolved = variables.get(expression.text);
      if (resolved) visit(resolved, parentPath);
      return;
    }
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)) {
      visit(expression.expression, parentPath);
      return;
    }
    if (ts.isArrayLiteralExpression(expression)) {
      for (const element of expression.elements) {
        if (ts.isSpreadElement(element)) visit(element.expression, parentPath);
        else visit(element, parentPath);
      }
      return;
    }
    if (!ts.isObjectLiteralExpression(expression)) return;

    const path = joinRoute(parentPath, literal(property(expression, "path")?.initializer));
    const component = findImport(property(expression, "component")?.initializer);
    if (component) {
      const position = source.getLineAndCharacterOfPosition(expression.getStart(source));
      routes.push({
        source: normalizedRelative(frontendRoot, file),
        line: position.line + 1,
        path,
        name: literal(property(expression, "name")?.initializer),
        title: routeTitle(expression),
        component,
        resolvedComponent: resolveAliasComponent(frontendRoot, component),
        surface: classifyComponent(component),
      });
    }

    const children = property(expression, "children")?.initializer;
    if (children) visit(children, path);
  };

  for (const expression of initialExpressions) visit(expression, "");
  return routes;
}

function defaultExportExpressions(file: string): ts.Expression[] {
  const source = sourceFile(file);
  return source.statements
    .filter((statement): statement is ts.ExportAssignment => ts.isExportAssignment(statement))
    .map((statement) => statement.expression);
}

function namedVariableExpression(file: string, name: string): ts.Expression[] {
  const source = sourceFile(file);
  const expression = variableInitializers(source).get(name);
  return expression ? [expression] : [];
}

function activeLegacyRouteFiles(routesFile: string): string[] {
  const source = sourceFile(routesFile);
  const files = source.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return [];
    const imported = statement.moduleSpecifier.text;
    if (!imported.startsWith("./modules/")) return [];
    return [resolve(dirname(routesFile), `${imported.slice(2)}.js`)];
  });
  return [...new Set(files)].filter(existsSync).sort();
}

function duplicates(routes: RouteEntry[], key: "path" | "component") {
  const counts = new Map<string, number>();
  for (const route of routes) counts.set(route[key], (counts.get(route[key]) ?? 0) + 1);
  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([value, count]) => ({ [key]: value, count }))
    .sort((a, b) => String(a[key]).localeCompare(String(b[key])));
}

function domainFor(path: string): string {
  const parts = path.split("/").filter(Boolean);
  const withoutAdmin = parts[0] === "admin" ? parts.slice(1) : parts;
  return withoutAdmin[0] ?? "root";
}

function buildInventory(
  frontendRoot: string,
  rootLabel: string,
  routeFiles: string[],
  routes: RouteEntry[],
): FrontendInventory {
  const pageFiles = listFiles(join(frontendRoot, "src", "pages"), ".vue").map((file) =>
    normalizedRelative(frontendRoot, file),
  );
  const routedPages = new Set(
    routes
      .filter((route) => route.surface === "page" && route.resolvedComponent)
      .map((route) => route.resolvedComponent as string),
  );
  const unresolvedComponents = [...new Set(
    routes.filter((route) => !route.resolvedComponent).map((route) => route.component),
  )].sort();
  const unroutedPageFiles = pageFiles.filter((file) => !routedPages.has(file));
  const domains: Record<string, number> = {};
  for (const route of routes.filter((entry) => entry.surface === "page")) {
    const domain = domainFor(route.path);
    domains[domain] = (domains[domain] ?? 0) + 1;
  }

  return {
    root: rootLabel,
    routeFiles: routeFiles.map((file) => ({
      file: normalizedRelative(frontendRoot, file),
      sha256: sha256(file),
    })),
    pageVueFiles: pageFiles,
    routes,
    unresolvedComponents,
    unroutedPageFiles,
    duplicatePaths: duplicates(routes, "path") as FrontendInventory["duplicatePaths"],
    duplicateComponents: duplicates(routes, "component") as FrontendInventory["duplicateComponents"],
    domains: Object.fromEntries(Object.entries(domains).sort(([a], [b]) => a.localeCompare(b))),
    counts: {
      pageVueFiles: pageFiles.length,
      routeRecords: routes.length,
      businessPageRouteRecords: routes.filter((route) => route.surface === "page").length,
      distinctRoutedPageComponents: routedPages.size,
      auxiliaryRouteRecords: routes.filter((route) => route.surface === "auxiliary").length,
      layoutRouteRecords: routes.filter((route) => route.surface === "layout").length,
      otherRouteRecords: routes.filter((route) => route.surface === "other").length,
      unresolvedComponents: unresolvedComponents.length,
      unroutedPageFiles: unroutedPageFiles.length,
    },
  };
}

function audit() {
  if (!existsSync(legacyAdminRoot)) {
    throw new Error(`Legacy Admin frontend not found: ${legacyAdminRoot}`);
  }
  if (!existsSync(targetAdminRoot)) {
    throw new Error(`Target Admin frontend not found: ${targetAdminRoot}`);
  }

  const legacyRoutesFile = join(legacyAdminRoot, "src", "router", "routes.js");
  const legacyModuleFiles = activeLegacyRouteFiles(legacyRoutesFile);
  const legacyRoutes = [
    ...collectRoutes(
      legacyRoutesFile,
      legacyAdminRoot,
      namedVariableExpression(legacyRoutesFile, "frameIn"),
    ),
    ...legacyModuleFiles.flatMap((file) =>
      collectRoutes(file, legacyAdminRoot, defaultExportExpressions(file)),
    ),
  ];

  const targetRoutesFile = join(targetAdminRoot, "src", "router", "index.ts");
  const targetRoutes = collectRoutes(
    targetRoutesFile,
    targetAdminRoot,
    namedVariableExpression(targetRoutesFile, "routes"),
  );

  const report = {
    version: 1,
    methodology: {
      scope:
        "Enabled Vue router records with lazy-loaded components; comments and unimported legacy modules are excluded.",
      businessPage:
        "A business page route is a route whose component import begins with @/pages/.",
      limitations:
        "This is a navigation inventory, not semantic feature parity. API and workflow equivalence require separate mapping.",
    },
    legacy: buildInventory(
      legacyAdminRoot,
      "cinashop-php/view/admin",
      [legacyRoutesFile, ...legacyModuleFiles],
      legacyRoutes,
    ),
    target: buildInventory(
      targetAdminRoot,
      "view/admin-ts",
      [targetRoutesFile],
      targetRoutes,
    ),
  };

  if (process.argv.includes("--write")) {
    mkdirSync(dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, `${JSON.stringify(report, null, 2)}\n`);
  }

  const printable = process.argv.includes("--summary")
    ? {
        version: report.version,
        legacy: { counts: report.legacy.counts, domains: report.legacy.domains },
        target: { counts: report.target.counts, domains: report.target.domains },
      }
    : report;
  console.log(JSON.stringify(printable, null, process.argv.includes("--compact") ? 0 : 2));
}

audit();
