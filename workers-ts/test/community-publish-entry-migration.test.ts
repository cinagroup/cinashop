import { readMembershipRightsHistoricalFile as readFileSync, reverseMembershipRightsRegisteredRoutes } from './helpers/membershipRightsSourceBinding';
const clientPages=reverseMembershipRightsRegisteredRoutes(currentClientRoutes);
const serverPages=reverseMembershipRightsRegisteredRoutes(currentServerRoutes);
import { reverseGrowthRecordsManifest } from './helpers/customerGrowthRecordsManifest';
import { reversePointsCentreManifest } from './helpers/customerPointsCentreManifest';
import { reverseSignCentreManifest } from './helpers/customerSignCentreManifest';

import { createRequire } from "node:module";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { REGISTERED_PAGE_ROUTES as currentClientRoutes, resolveRegisteredPageRoute as clientRoute } from "../../view/uniapp-ts/src/config/navigation";
import { REGISTERED_PAGE_ROUTES as currentServerRoutes, resolveRegisteredPageRoute as serverRoute } from "../src/services/content/FabRouteRegistry";
import { parseCommunityWorkspaceEntry, resolveCommunityLegacyPageEntry, resolveCommunityPageRoute } from "../../view/common/communityRoute";
import { communityInbound, communityQuery } from "../../view/common/communityShare";

const { parse, compileTemplate } = createRequire(import.meta.url)("../../view/admin-ts/node_modules/@vue/compiler-sfc") as typeof import("../../view/admin-ts/node_modules/@vue/compiler-sfc");
const root = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const client = (path: string) => read("view/uniapp-ts/src/" + path);
const script = (name: string, text: string) => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
function all<T extends ts.Node>(node: ts.Node, predicate: (value: ts.Node) => value is T): T[] {
  const result: T[] = [];
  const visit = (value: ts.Node) => { if (predicate(value)) result.push(value); ts.forEachChild(value, visit); };
  visit(node); return result;
}
function sfc(name: string, text = client(name)) {
  const parsed = parse(text, { filename: name }); expect(parsed.errors).toEqual([]);
  const template = parsed.descriptor.template; expect(template).toBeDefined();
  expect(compileTemplate({ source: template!.content, filename: name, id: "publish-entry-contract" }).errors).toEqual([]);
  const nodes: any[] = [];
  const visit = (value: any) => { nodes.push(value); for (const child of value.children ?? []) visit(child); };
  visit(template!.ast);
  return { nodes, script: script(name + ".ts", parsed.descriptor.scriptSetup?.content ?? parsed.descriptor.script?.content ?? "") };
}
function namedValueImport(source: ts.SourceFile, module: string, local: string): boolean {
  return source.statements.some(row => ts.isImportDeclaration(row) && ts.isStringLiteral(row.moduleSpecifier) && row.moduleSpecifier.text === module
    && row.importClause?.isTypeOnly === false && row.importClause.namedBindings && ts.isNamedImports(row.importClause.namedBindings)
    && row.importClause.namedBindings.elements.some(item => !item.isTypeOnly && item.name.text === local));
}
function defaultValueImport(source: ts.SourceFile, module: string, local: string): boolean {
  return source.statements.some(row => ts.isImportDeclaration(row) && ts.isStringLiteral(row.moduleSpecifier) && row.moduleSpecifier.text === module
    && row.importClause?.isTypeOnly === false && row.importClause.name?.text === local);
}
const called = (call: ts.CallExpression) => call.expression.getText();
const calls = (node: ts.Node, name: string) => all(node, ts.isCallExpression).filter(row => called(row) === name);
function declaration(source: ts.SourceFile, name: string) {
  return source.statements.find((row): row is ts.FunctionDeclaration => ts.isFunctionDeclaration(row) && row.name?.text === name);
}
const directive = (node: any, name: string, argument: string | undefined, expression: string) => (node.props ?? []).some((prop: any) => prop.type === 7
  && prop.name === name && (argument === undefined || prop.arg?.content === argument) && prop.exp?.content === expression);
function topicPublisherBound(text = client("components/community/CommunityDeepLinkFeed.vue")): boolean {
  const parsed = sfc("components/community/CommunityDeepLinkFeed.vue", text), open = declaration(parsed.script, "openPublish");
  if (!open || !parsed.nodes.some(node => directive(node, "on", "tap", "openPublish"))) return false;
  const topic = all(open, ts.isVariableDeclaration).find(row => ts.isIdentifier(row.name) && row.name.text === "topicId");
  if (topic?.initializer?.getText() !== "feed.selectedTopicId.value") return false;
  return calls(open, "uni.navigateTo").some(call => call.arguments.some(arg => ts.isObjectLiteralExpression(arg) && arg.properties.some(prop =>
    ts.isPropertyAssignment(prop) && prop.name.getText() === "url" && ts.isTemplateExpression(prop.initializer)
    && prop.initializer.head.text === "/pages/discover/workspace?publish=1&topic_id="
    && prop.initializer.templateSpans.length === 1 && prop.initializer.templateSpans[0].expression.getText() === "topicId"
    && prop.initializer.templateSpans[0].literal.text === "")));
}
function legacyPageBound(name: string, path: string, text = client(name)): boolean {
  const parsed = sfc(name, text);
  if (!namedValueImport(parsed.script, "@/composables/useCommunityLegacyEntry", "useCommunityLegacyEntry")
    || !defaultValueImport(parsed.script, "@/components/ThemePage.vue", "ThemePage")) return false;
  const initialized = all(parsed.script, ts.isVariableDeclaration).some(row => {
    if (!ts.isObjectBindingPattern(row.name)) return false;
    const bindings = row.name.elements.map(item => item.name.getText());
    return ["target", "error", "open"].every(key => bindings.includes(key))
      && row.initializer && ts.isCallExpression(row.initializer) && called(row.initializer) === "useCommunityLegacyEntry"
      && row.initializer.arguments.length === 1 && ts.isStringLiteral(row.initializer.arguments[0]) && row.initializer.arguments[0].text === path;
  });
  return initialized && parsed.nodes.some(node => node.tag === "ThemePage")
    && parsed.nodes.some(node => node.tag === "button" && directive(node, "on", "tap", "open") && directive(node, "if", undefined, "target"))
    && parsed.nodes.some(node => (node.props ?? []).some((prop: any) => prop.type === 6 && prop.name === "role" && prop.value?.content === "status")
      && (node.children ?? []).some((child: any) => child.type === 5 && child.content?.content.includes("error")));
}
function legacyLifecycleBound(text = client("composables/useCommunityLegacyEntry.ts")): boolean {
  const source = script("useCommunityLegacyEntry.ts", text), entry = declaration(source, "useCommunityLegacyEntry"); if (!entry) return false;
  if (!["onLoad", "onUnload"].every(name => namedValueImport(source, "@dcloudio/uni-app", name))
    || !namedValueImport(source, "@/utils/communityShare", "communityPageQuery")
    || !namedValueImport(source, "@/utils/communityEntry", "resolveCommunityLegacyPageEntry")) return false;
  const load = calls(entry, "onLoad")[0]?.arguments[0], unload = calls(entry, "onUnload")[0]?.arguments[0];
  const open = all(entry, ts.isFunctionDeclaration).find(row => row.name?.text === "open");
  if (!load || !unload || !open) return false;
  const decode = calls(load, "communityPageQuery")[0], resolveEntry = calls(load, "resolveCommunityLegacyPageEntry")[0], invoke = calls(load, "open")[0];
  const assignment = all(load, ts.isBinaryExpression).find(row => row.operatorToken.kind === ts.SyntaxKind.EqualsToken && row.left.getText() === "target.value" && row.right.getText() === "route");
  const rejected = all(load, ts.isIfStatement).some(row => row.expression.getText() === "!route" && all(row, ts.isThrowStatement).length === 1);
  const redirect = calls(open, "uni.redirectTo")[0];
  const disposed = all(unload, ts.isBinaryExpression).some(row => row.left.getText() === "disposed" && row.right.kind === ts.SyntaxKind.TrueKeyword);
  const guarded = all(open, ts.isIfStatement).some(row => row.expression.getText().includes("disposed") && row.expression.getText().includes("target.value") && all(row.thenStatement, ts.isReturnStatement).length > 0);
  const allowed = new Set(["ref", "Error", "onLoad", "onUnload", "communityPageQuery", "resolveCommunityLegacyPageEntry", "open", "uni.redirectTo"]);
  return Boolean(decode && resolveEntry && invoke && assignment && rejected && redirect && disposed && guarded
    && decode.pos < resolveEntry.pos && resolveEntry.pos < assignment.pos && assignment.pos < invoke.pos
    && all(source, ts.isCallExpression).every(call => allowed.has(called(call)))
    && source.statements.filter(ts.isImportDeclaration).every(row => ts.isStringLiteral(row.moduleSpecifier)
      && ["vue", "@dcloudio/uni-app", "@/utils/communityShare", "@/utils/communityEntry"].includes(row.moduleSpecifier.text)));
}
function workspaceParsingBound(text = client("pages/discover/index.vue")): boolean {
  const source = sfc("pages/discover/index.vue", text).script;
  if (!namedValueImport(source, "@/utils/communityEntry", "parseCommunityWorkspaceEntry")) return false;
  const load = calls(source, "onLoad")[0]?.arguments[0]; if (!load) return false;
  const decode = calls(load, "communityPageQuery")[0], validate = calls(load, "parseCommunityWorkspaceEntry")[0];
  const publisher = declaration(source, "initializePublisher");
  if (!publisher || !["editPost", "relations.seedTopic"].every(name => calls(publisher, name).length === 1)) return false;
  const later = ["communityInbound", "referrals.captureInbound", "openDetail", "author.initialize", "initializePublisher"];
  return Boolean(decode && validate && decode.pos < validate.pos && later.every(name => {
    const bound = calls(load, name); return bound.length === 1 && bound[0].pos > validate.pos;
  }));
}
function workspacePublisherBound(text = client("pages/discover/index.vue")): boolean {
  const parsed = sfc("pages/discover/index.vue", text), publish = declaration(parsed.script, "publish");
  return namedValueImport(parsed.script, "@/composables/useCommunityPublish", "useCommunityPublish")
    && all(parsed.script, ts.isVariableDeclaration).some(row => row.name.getText() === "publisher" && row.initializer
      && ts.isCallExpression(row.initializer) && called(row.initializer) === "useCommunityPublish")
    && Boolean(publish && calls(publish, "publisher.publish").length === 1)
    && ["publish", "chooseImages", "chooseVideo", "relations.openTopics", "relations.openProducts"].every(handler => parsed.nodes.some(node =>
      node.tag === "button" && directive(node, "on", "tap", handler)));
}
function canonical(raw: string) {
  const query = communityQuery(raw);
  return { entry: parseCommunityWorkspaceEntry(query), post: communityInbound("/pages/discover/workspace", query) };
}
const legacy = ["User", "Follow", "Create"] as const;
const legacyPath = (name: string) => `/pages/discover/discover${name}/index`;

describe("complete shared community publishing and registered legacy entries", () => {
  it("binds the actual topic tap to a fixed topic identity and complete workspace publisher", () => {
    expect(topicPublisherBound()).toBe(true);
    const parsed = sfc("components/community/CommunityDeepLinkFeed.vue"), open = declaration(parsed.script, "openPublish")!;
    expect(open.getText()).toContain('props.mode !== "topic"'); expect(open.getText()).toContain("feed.initialized.value");
    expect(calls(open, "uni.navigateTo")).toHaveLength(2); // login admission and admitted topic destination
  });
  it("rejects a disconnected topic button or a navigation call disconnected from the selected topic", () => {
    const original = client("components/community/CommunityDeepLinkFeed.vue");
    expect(topicPublisherBound(original.replace('@tap="openPublish"', '@tap="retryRoute"'))).toBe(false);
    expect(topicPublisherBound(original.replace("topic_id=${topicId}", "topic_id=9"))).toBe(false);
  });
  it("removes the independent topic write form and direct API save path", () => {
    const { script: source, nodes } = sfc("components/community/CommunityDeepLinkFeed.vue");
    expect(all(source, ts.isImportDeclaration).some(row => row.getText().includes("apiCommunitySave"))).toBe(false);
    expect(calls(source, "apiCommunitySave")).toEqual([]); expect(declaration(source, "submitPublish")).toBeUndefined();
    expect(nodes.some(node => node.tag === "textarea" || directive(node, "model", undefined, "publishTitle") || directive(node, "model", undefined, "publishContent"))).toBe(false);
  });
  it.each(legacy)("registers the actual raw %s page with a value-imported fixed-path bridge and retry UI", name => {
    expect(legacyPageBound(`pages/discover/discover${name}/index.vue`, legacyPath(name))).toBe(true);
  });
  it("detects type-only, uncalled and wrong-identity legacy bridge substitutions", () => {
    for (const name of legacy) {
      const file = `pages/discover/discover${name}/index.vue`, original = client(file);
      expect(legacyPageBound(file, legacyPath(name), original.replace("import { useCommunityLegacyEntry }", "import type { useCommunityLegacyEntry }"))).toBe(false);
      expect(legacyPageBound(file, legacyPath(name), original.replace("= useCommunityLegacyEntry(", "= disconnectedLegacyEntry("))).toBe(false);
      expect(legacyPageBound(file, legacyPath(name), original.replace(legacyPath(name), "/pages/discover/discoverDetails/index"))).toBe(false);
      expect(legacyPageBound(file, legacyPath(name), original.replace('@tap="open"', '@tap="() => {}"'))).toBe(false);
    }
  });
  it("parses and admits the raw identity in onLoad before redirect and disposes navigation ownership without business I/O", () => {
    expect(legacyLifecycleBound()).toBe(true);
    const source = script("legacy.ts", client("composables/useCommunityLegacyEntry.ts"));
    const exported = declaration(source, "useCommunityLegacyEntry")!;
    expect(exported.modifiers?.some(item => item.kind === ts.SyntaxKind.ExportKeyword)).toBe(true);
  });
  it("rejects a type-only lifecycle import, detached load callback or added business call", () => {
    const original = client("composables/useCommunityLegacyEntry.ts");
    expect(legacyLifecycleBound(original.replace("import { onLoad, onUnload }", "import type { onLoad, onUnload }"))).toBe(false);
    expect(legacyLifecycleBound(original.replace("onLoad(input =>", "disconnectedOnLoad(input =>"))).toBe(false);
    expect(legacyLifecycleBound(original.replace("target.value = route; open();", "target.value = route; apiCommunitySave({}); open();"))).toBe(false);
  });
  it("binds canonical workspace validation ahead of detail, profile, seed and edit I/O", () => {
    const original = client("pages/discover/index.vue"); expect(workspaceParsingBound(original)).toBe(true);
    expect(workspaceParsingBound(original.replace("import { parseCommunityWorkspaceEntry,", "import type { parseCommunityWorkspaceEntry,"))).toBe(false);
    expect(workspaceParsingBound(original.replace("entry = parseCommunityWorkspaceEntry(query);", "entry = { kind: 'feed' };"))).toBe(false);
    expect(workspaceParsingBound(original.replace("void initializePublisher(entry)", "void disconnectedPublisher(entry)"))).toBe(false);
    expect(workspaceParsingBound(original.replace("await editPost(entry.editId)", "await disconnectedEdit(entry.editId)"))).toBe(false);
    expect(workspaceParsingBound(original.replace("await relations.seedTopic(entry.topicId)", "await disconnectedSeed(entry.topicId)"))).toBe(false);
  });
  it("connects the destination's real media, topic, product and submit controls to its value-imported shared publisher", () => {
    const original = client("pages/discover/index.vue"); expect(workspacePublisherBound(original)).toBe(true);
    expect(workspacePublisherBound(original.replace("import { useCommunityPublish }", "import type { useCommunityPublish }"))).toBe(false);
    expect(workspacePublisherBound(original.replace('@tap="publish"', '@tap="openPublish"'))).toBe(false);
    expect(workspacePublisherBound(original.replace("await publisher.publish()", "await disconnectedPublisher()"))).toBe(false);
  });
  it("preserves the exact reviewed138-page baseline through only the sign/points/growth additions and synchronizes both live route allowlists", () => {
    const raw = client("pages.json"), previous = reverseSignCentreManifest(reversePointsCentreManifest(reverseGrowthRecordsManifest(raw)));
    const historical = JSON.parse(previous).pages.map((row: { path: string }) => "/" + row.path);
    const pages = JSON.parse(raw).pages.map((row: { path: string }) => "/" + row.path);
    expect(historical).toHaveLength(138); expect(new Set(historical).size).toBe(138);
    expect(pages).toHaveLength(historical.length + 3); expect(new Set(pages).size).toBe(pages.length);
    const additive = ['/pages/user/points','/pages/user/signRecords','/pages/user/growthRecords'];
    expect(pages.filter((path:string)=>!additive.includes(path))).toEqual(historical);
    expect(pages.filter((path:string)=>additive.includes(path))).toEqual(additive);
    expect([...clientPages].sort()).toEqual(pages.slice().sort()); expect([...serverPages].sort()).toEqual(pages.slice().sort());
    for (const name of legacy) expect(pages).toContain(legacyPath(name));
    expect(pages).toContain("/pages/discover/discoverDetails/index"); expect(pages).toContain("/pages/discover/workspace");
  });
  it("resolves actual frontend and server author/follow/create identities identically, retaining edit priority and dropping credentials", () => {
    const rows = [
      ["User", "", "/pages/discover/workspace?author_id=self"],
      ["User", "id=0&uid=22&token=secret", "/pages/discover/workspace?author_id=0"],
      ["User", "id=22", "/pages/discover/workspace?author_id=22"],
      ["Follow", "type=0&uid=22&token=secret", "/pages/discover/people?tab=follow"],
      ["Follow", "type=1", "/pages/discover/people?tab=friend"],
      ["Follow", "type=2", "/pages/discover/people?tab=fans"],
      ["Create", "", "/pages/discover/workspace?publish=1"],
      ["Create", "topic_id=9&uid=22&token=secret", "/pages/discover/workspace?publish=1&topic_id=9"],
      ["Create", "id=31&topic_id=9&token=secret", "/pages/discover/workspace?publish=1&edit_id=31"],
      ["Create", "id=2147483647", "/pages/discover/workspace?publish=1&edit_id=2147483647"],
    ];
    for (const [name, query, expected] of rows) for (const resolveRoute of [clientRoute, serverRoute]) {
      expect(resolveRoute(legacyPath(name), query)).toBe(expected);
      expect(resolveCommunityLegacyPageEntry(legacyPath(name), communityQuery(query))).toBe(expected);
    }
  });
  it("rejects zero, oversized, malformed, duplicate and ambiguous legacy identities on both sides", () => {
    const rows = [["User", "id=01"], ["User", "id=-1"], ["User", "id=2147483648"], ["User", "id=11&id=22"],
      ["Create", "id=0"], ["Create", "topic_id=0"], ["Create", "id=31&topic_id=no"], ["Create", "id=31&id=32"],
      ["Create", "topic_id=9&topic%5Fid=10"], ["Create", "topic_id=%ZZ"], ["Follow", "type=3"],
      ["Follow", "type=1&tab=friend"], ["Follow", "type=1&type=0"]];
    for (const [name, query] of rows) for (const resolveRoute of [clientRoute, serverRoute]) expect(resolveRoute(legacyPath(name), query)).toBe("");
  });
  it("applies the real canonical parsers to feed, author, post and full-publisher modes", () => {
    expect(canonical("")).toEqual({ entry: { kind: "feed" }, post: null });
    expect(canonical("author_id=0")).toEqual({ entry: { kind: "author", authorId: 0 }, post: null });
    expect(canonical("author_id=self")).toEqual({ entry: { kind: "author", authorId: "self" }, post: null });
    expect(canonical("publish=1&topic_id=9&uid=22&token=secret")).toEqual({ entry: { kind: "publish", editId: 0, topicId: 9 }, post: null });
    expect(canonical("publish=1&edit_id=31&topic_id=9")).toEqual({ entry: { kind: "publish", editId: 31, topicId: 0 }, post: null });
    expect(canonical("id=31&spid=0")).toEqual({ entry: { kind: "feed" }, post: { id: 31, contentType: 1, spid: 0 } });
    expect(canonical("post_id=31&post_type=2&spid=11")).toEqual({ entry: { kind: "feed" }, post: { id: 31, contentType: 2, spid: 11 } });
  });
  it("rejects invalid canonical modes and all malformed or conflicting controlling identities before I/O", () => {
    for (const query of ["publish=0", "publish=", "publish=1&author_id=self", "publish=1&id=31", "publish=1&post_id=31&post_type=1",
      "topic_id=9", "edit_id=31", "author_id=2147483648", "author_id=self&id=31", "publish=1&edit_id=0", "publish=1&topic_id=0",
      "publish=1&edit_id=31&topic_id=bad", "publish=1&edit_id=2147483648", "publish=1&topic_id=01", "publish=1&topic_id=9&topic_id=10",
      "id=0", "id=2147483648", "id=31&id=32", "post_id=31&post_type=3", "id=31&post_id=32&post_type=1"])
      expect(() => canonical(query), query).toThrow();
    expect(() => parseCommunityWorkspaceEntry({ publish: 1 })).toThrow();
    expect(() => parseCommunityWorkspaceEntry({ publish: "1", topic_id: [9] })).toThrow();
  });
  it("leaves unrelated registered query policies untouched, including their duplicate and encoding rules", () => {
    for (const query of ["id=9&id=10", "id=9&search=%ZZ", "id=9&keyword=a+b"]) {
      expect(resolveCommunityPageRoute("/pages/goods/detail", query)).toBeNull();
      expect(clientRoute("/pages/goods/detail", query)).toBe(serverRoute("/pages/goods/detail", query));
      expect(clientRoute("/pages/goods/detail", query)).not.toBe("");
    }
  });
  it("preserves the old raw detail namespace and its canonical/referral behavior", () => {
    for (const resolveRoute of [clientRoute, serverRoute]) {
      expect(resolveRoute("/pages/discover/discoverDetails/index", "id=31&spid=0")).toBe("/pages/discover/workspace?id=31");
      expect(resolveRoute("/pages/discover/discoverDetails/index", "id=31&spid=11&token=secret")).toBe("/pages/discover/workspace?id=31&spid=11");
      expect(resolveRoute("/pages/discover/discoverDetails/index", "id=31&id=32")).toBe("");
      expect(resolveRoute("/pages/discover/discoverDetails/index", "id=0")).toBe("");
    }
  });
  it("keeps the restored public get_script executable-JavaScript response and real frontend loader binding", () => {
    const routes = script("routes.ts", read("workers-ts/src/routes/v1/index.ts"));
    const route = calls(routes, "v1Routes.get").find(row => ts.isStringLiteral(row.arguments[0]) && row.arguments[0].text === "/get_script");
    expect(route?.arguments.map(row => row.getText())).toEqual(["'/get_script'", "PublicController.getScript"]);
    const controller = script("public.ts", read("workers-ts/src/controllers/api/v1/PublicController.ts")), handler = declaration(controller, "getScript")!;
    expect(calls(handler, "c.header").map(row => row.arguments.map(arg => ts.isStringLiteral(arg) ? arg.text : arg.getText())))
      .toEqual([["Cache-Control", "public, max-age=60"], ["Content-Type", "application/javascript; charset=utf-8"], ["X-Content-Type-Options", "nosniff"]]);
    expect(calls(handler, "c.body")[0]?.arguments[0].getText()).toBe("script"); expect(calls(handler, "jsonOk")).toEqual([]);
    const appDescriptor = parse(client("App.vue"), { filename: "App.vue" }); expect(appDescriptor.errors).toEqual([]);
    const app = script("App.vue.ts", appDescriptor.descriptor.scriptSetup!.content);
    expect(namedValueImport(app, "../../common/statisticsScript", "loadStatisticsScript")).toBe(true);
    expect(calls(app, "onLaunch").some(call => call.arguments.some(arg => calls(arg, "loadStatisticsScript").length === 1))).toBe(true);
    for (const name of ["admin", "supplier"]) {
      const main = script(name + ".ts", read(`view/${name}-ts/src/main.ts`));
      expect(all(main, ts.isImportDeclaration).some(row => !row.importClause?.isTypeOnly && row.getText().includes("loadStatisticsScript"))).toBe(true);
      expect(calls(main, "loadStatisticsScript")).toHaveLength(1);
    }
  });
});
