import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const { parse: parseCommunitySfc } = createRequire(import.meta.url)(
  "../../view/admin-ts/node_modules/@vue/compiler-sfc",
) as typeof import("../../view/admin-ts/node_modules/@vue/compiler-sfc");

// Inspect the actual SFC -> imported composable -> imported API chain, so
// comments, type imports or an unused lookalike module cannot satisfy the gate.
function hasPeopleComposableBindings(pageSource: string, composableSource: string): boolean {
  const parsed = parseCommunitySfc(pageSource, { filename: "people.vue" });
  if (parsed.errors.length || !parsed.descriptor.scriptSetup || !parsed.descriptor.template?.ast) return false;
  const page = ts.createSourceFile("people.ts", parsed.descriptor.scriptSetup.content, ts.ScriptTarget.Latest, true);
  const composable = ts.createSourceFile("useCommunityPeople.ts", composableSource, ts.ScriptTarget.Latest, true);
  if ([page, composable].some(tree => (tree as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length)) return false;
  const runtimeImport = (tree: ts.SourceFile, modulePath: string, imported: string) => {
    const bindings = tree.statements.filter(ts.isImportDeclaration).flatMap(statement => {
      const clause = statement.importClause;
      return ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === modulePath
        && clause && !clause.isTypeOnly && clause.namedBindings && ts.isNamedImports(clause.namedBindings)
        ? clause.namedBindings.elements.filter(binding => !binding.isTypeOnly && (binding.propertyName?.text ?? binding.name.text) === imported)
        : [];
    });
    return bindings.length === 1 ? bindings[0].name.text : null;
  };
  const binding = runtimeImport(page, "@/composables/useCommunityPeople", "useCommunityPeople");
  if (!binding) return false;
  const consumed = page.statements.filter(ts.isVariableStatement).flatMap(statement => [...statement.declarationList.declarations])
    .filter(declaration => declaration.initializer && ts.isCallExpression(declaration.initializer)
      && ts.isIdentifier(declaration.initializer.expression) && declaration.initializer.expression.text === binding
      && declaration.initializer.arguments.length === 0 && ts.isObjectBindingPattern(declaration.name));
  if (consumed.length !== 1 || !ts.isObjectBindingPattern(consumed[0].name)) return false;
  const destructured = consumed[0].name;
  const required = ["tabs", "users", "changeTab", "initialize", "toggleFollow", "confirmUnfollow", "cancelUnfollow", "openAuthor"];
  if (!required.every(name => destructured.elements.some(element => ts.isIdentifier(element.name)
    && element.name.text === name && (!element.propertyName || element.propertyName.getText(page) === name)))) return false;
  const exported = (node: ts.Node) => ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
  const functions = composable.statements.filter((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement)
    && exported(statement) === true && statement.name?.text === "useCommunityPeople" && !!statement.body);
  if (functions.length !== 1) return false;
  const body = functions[0].body!;
  const returns = body.statements.filter(ts.isReturnStatement);
  if (returns.length !== 1 || !returns[0].expression || !ts.isObjectLiteralExpression(returns[0].expression)) return false;
  const returned = returns[0].expression;
  if (!returned.properties.some(property => ts.isPropertyAssignment(property) && property.name.getText(composable) === "tabs"
    && ts.isIdentifier(property.initializer) && property.initializer.text === "communityPeopleTabs")) return false;
  if (!required.filter(name => name !== "tabs").every(name => returned.properties.some(property => ts.isShorthandPropertyAssignment(property)
    && property.name.text === name))) return false;
  const tabs = composable.statements.filter(ts.isVariableStatement).filter(statement => exported(statement) === true)
    .flatMap(statement => [...statement.declarationList.declarations])
    .filter(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === "communityPeopleTabs");
  if (tabs.length !== 1 || !tabs[0].initializer || !ts.isArrayLiteralExpression(tabs[0].initializer)) return false;
  const expected = [["friend", "好友"], ["follow", "关注"], ["fans", "粉丝"], ["recommend", "推荐"]];
  if (tabs[0].initializer.elements.length !== expected.length || !tabs[0].initializer.elements.every((element, index) =>
    ts.isObjectLiteralExpression(element) && ["key", "label"].every((name, field) => element.properties.some(property =>
      ts.isPropertyAssignment(property) && property.name.getText(composable) === name
      && ts.isStringLiteral(property.initializer) && property.initializer.text === expected[index][field])))) return false;
  const calls = new Set<string>();
  const visit = (node: ts.Node) => { if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) calls.add(node.expression.text); ts.forEachChild(node, visit); };
  visit(body);
  if (!["apiCommunityFriendList", "apiCommunityFollowList", "apiCommunityRecommendations", "apiCommunitySetInterest"].every(name => {
    const imported = runtimeImport(composable, "@/api/community", name); return imported !== null && calls.has(imported);
  })) return false;
  const compact = (value: string) => value.replace(/\s+/g, "");
  const template = parsed.descriptor.template.ast;
  const elements: typeof template.children = [];
  const walk = (nodes: typeof elements) => { for (const node of nodes) if (node.type === 1) { elements.push(node); walk(node.children); } };
  walk(template.children);
  const tap = (expression: string) => elements.some(node => node.type === 1 && node.props.some(prop => prop.type === 7
    && prop.name === "on" && prop.arg?.type === 4 && prop.arg.content === "tap" && prop.exp?.type === 4 && compact(prop.exp.content) === expression));
  return elements.some(node => node.type === 1 && node.props.some(prop => prop.type === 7 && prop.name === "for"
    && prop.exp?.type === 4 && compact(prop.exp.content) === "tabintabs")
    && node.props.some(prop => prop.type === 7 && prop.name === "on" && prop.arg?.type === 4 && prop.arg.content === "tap"
      && prop.exp?.type === 4 && compact(prop.exp.content) === "changeTab(tab.key)")
    && node.children.some(child => child.type === 5 && child.content.type === 4 && compact(child.content.content) === "tab.label"))
    && ["toggleFollow(item)", "confirmUnfollow", "cancelUnfollow", "openAuthor(item)"].every(tap);
}

describe("community social graph migration", () => {
  it("keeps the physical and embedded social indexes byte-equivalent", () => {
    const migration = readFileSync("migrations/0087_community_social_graph_indexes.sql", "utf8").trim();
    const service = readFileSync("src/services/MigrationService.ts", "utf8");
    const embedded = service.match(
      /private migration_0094\(\): string \{\s*return `([\s\S]*?)`;\s*\}/,
    )?.[1]?.trim();
    expect(embedded).toBe(migration);
    expect(migration).toContain('WHERE "status" = 1 AND "is_verify" = 1 AND "is_del" = 0');
    expect(migration).toContain('WHERE "status" = 1 AND "is_del" = 0 AND "community_num" > 0');
  });

  it("restores every PHP community-user route with the original methods", () => {
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    const expected = [
      '"/community/user_info/:authorUid"',
      '"/community/update_desc"',
      '"/community/set_interest/:authorUid"',
      '"/community/follow_list/:type"',
      '"/community/user_friend"',
      '"/community/recommend_list"',
      '"/community/follow"',
      '"/community/browse/:id"',
    ];
    for (const fragment of expected) expect(routes).toContain(fragment);
    expect(routes).toContain('v1Routes.put("/community/browse/:id"');
    expect(routes).toContain('v1Routes.post(\n  "/community/set_interest/:authorUid"');
  });

  it("bounds social request bodies and never falls back to unbounded Hono JSON parsing", () => {
    const controller = readFileSync("src/controllers/api/v1/CommunityController.ts", "utf8");
    expect(controller).toContain("MAX_COMMUNITY_BODY_BYTES = 256 * 1024");
    expect(controller).toContain("stream.getReader()");
    expect(controller).not.toContain("c.req.json()");
  });

  it("uses stable user locks, idempotent edges, duplicate guards and durable browse rows", () => {
    const service = readFileSync("src/services/community/CommunitySocialService.ts", "utf8");
    expect(service).toContain("sort((a, b) => a - b)");
    expect(service).toContain("pg_advisory_xact_lock");
    expect(service).toContain("existing.length === 0");
    expect(service).toContain("existing.length > 0");
    expect(service).toContain("社区用户资料存在重复，请先处理历史数据");
    expect(service).toContain('type: COMMUNITY_BROWSE');
    expect(service).toContain("GROUP BY right_id");
    expect(service).toContain("GROUP BY left_id");
    expect(service).toContain("SELECT DISTINCT ON (cu.relation_id)");
    expect(service).toContain('FROM "user" account');
    expect(service).toContain("eq(communityUser.relationId, 0)");
    expect(service).toContain("executeRows<");
    expect(service).not.toContain("tx.$client");
  });

  it("keeps production integration writes inside guarded disposable schemas", () => {
    const scenario = readFileSync("test/integration/CommunitySocialPostgresScenario.ts", "utf8");
    const worker = readFileSync("test/integration/CommunitySocialAuditWorker.ts", "utf8");
    const config = readFileSync("test/integration/community-social-audit.wrangler.toml", "utf8");
    expect(scenario).toContain("codex_community_social_");
    expect(scenario).toContain("SET LOCAL search_path");
    expect(scenario).toContain("publicStateUnchanged");
    expect(scenario).toContain("DROP SCHEMA");
    expect(scenario).not.toMatch(/insert\(.*public\./is);
    expect(worker).toContain("AUDIT_TOKEN_SHA256");
    expect(worker).toContain("timingSafeEqual");
    expect(worker).toContain('"/cleanup-schemas"');
    expect(worker).toContain("business_rows_unchanged");
    expect(config).toContain('id = "9748c294e21c49a99579c9cef70102e0"');
  });

  it("migrates the UniApp social API and a usable four-tab relationship screen", () => {
    const api = readFileSync("../view/uniapp-ts/src/api/community.ts", "utf8");
    const page = readFileSync("../view/uniapp-ts/src/pages/discover/people.vue", "utf8");
    const manifest = readFileSync("../view/uniapp-ts/src/pages.json", "utf8");
    const composable = readFileSync("../view/uniapp-ts/src/composables/useCommunityPeople.ts", "utf8");
    expect(api).toContain("apiCommunitySetInterest");
    expect(api).toContain("apiCommunityFollowList");
    expect(api).toContain("apiCommunityRecommendations");
    expect(api).toContain("communityPreviewMode");
    expect(api).toContain("previewPeople");
    expect(hasPeopleComposableBindings(page, composable)).toBe(true);
    expect(manifest).toContain('"path": "pages/discover/people"');
  });

  it("rejects detached or fake people composable, tab and API bindings", () => {
    const page = readFileSync("../view/uniapp-ts/src/pages/discover/people.vue", "utf8");
    const composable = readFileSync("../view/uniapp-ts/src/composables/useCommunityPeople.ts", "utf8");
    for (const altered of [
      page.replace("@/composables/useCommunityPeople", "@/composables/fakePeople"),
      page.replace("import { useCommunityPeople }", "import type { useCommunityPeople }"),
      page.replace("import { useCommunityPeople }", "// import { useCommunityPeople }"),
      page.replace("= useCommunityPeople();", "= fakePeople();"),
      page.replace('v-for="tab in tabs"', 'v-for="tab in unrelatedTabs"'),
      page.replace('@tap="changeTab(tab.key)"', '@tap="fakeChangeTab(tab.key)"'),
      page.replace('@tap="toggleFollow(item)"', '@tap="fakeFollow(item)"'),
    ]) expect(hasPeopleComposableBindings(altered, composable)).toBe(false);
    for (const altered of [
      composable.replace('key: "fans", label: "粉丝"', 'key: "fans", label: "关注"'),
      composable.replace("tabs: communityPeopleTabs", "tabs: unrelatedTabs"),
      composable.replace("@/api/community", "@/api/fakeCommunity"),
      composable.replace("apiCommunitySetInterest(row.relation_id, desired)", "fakeSetInterest(row.relation_id, desired)"),
      composable.replace("apiCommunityFriendList(next, PAGE_SIZE)", "fakeFriendList(next, PAGE_SIZE)"),
    ]) expect(hasPeopleComposableBindings(page, altered)).toBe(false);
  });

  it("exposes the same social contract in the PC community surface", () => {
    const api = readFileSync("../view/pc-ts/src/api/community.ts", "utf8");
    const page = readFileSync("../view/pc-ts/src/pages/community/Community.vue", "utf8");
    for (const symbol of [
      "apiCommunityFollowHighlights",
      "apiCommunityFollowList",
      "apiCommunityFriendList",
      "apiCommunityRecommendations",
      "apiCommunitySetInterest",
    ]) expect(api).toContain(symbol);
    expect(page).toContain('type SocialTab = "friend" | "follow" | "fans" | "recommend"');
    expect(page).toContain("好友来自推广关系");
    expect(page).toContain("ElMessageBox.confirm");
    expect(page).toContain("apiCommunitySetInterest");
  });
});
