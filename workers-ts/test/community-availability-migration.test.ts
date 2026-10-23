import { reverseNavigationAuthorSource } from './helpers/diyNavigationAuthorSourceBinding';
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { communityAvailabilityRoutes } from "./helpers/communityAvailabilityRoutes";
import { reverseRouteSourceFollowup, type RouteSourceFollowup } from "./helpers/routeSourceIncrement";

const source = readFileSync("src/routes/v1/index.ts", "utf8");
const followup = JSON.parse(readFileSync("audit/community-availability-root-source-followup-20261021.json", "utf8")) as RouteSourceFollowup;
function bindings(text: string) {
  const tree = ts.createSourceFile("v1.ts", text, ts.ScriptTarget.Latest, true);
  const rows: Array<{ method: string; path: string; args: string[] }> = [];
  for (const statement of tree.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
    const call = statement.expression;
    if (!ts.isPropertyAccessExpression(call.expression) || call.expression.expression.getText(tree) !== "v1Routes"
      || !call.arguments[0] || !ts.isStringLiteral(call.arguments[0])) continue;
    const path = "/api" + call.arguments[0].text;
    if (!call.arguments.some(arg => ts.isPropertyAccessExpression(arg) && arg.expression.getText(tree) === "CommunityController")) continue;
    rows.push({ method: call.expression.name.text.toUpperCase(), path,
      args: call.arguments.slice(1).map(arg => arg.getText(tree).replace(/\s+/g, "")) });
  }
  const imports = tree.statements.filter(ts.isImportDeclaration).filter(row => !row.importClause?.isTypeOnly)
    .map(row => row.getText(tree));
  if (!imports.some(row => row.includes('from "@/middleware/community-open"') && row.includes("{ communityOpenMiddleware }"))) throw Error("Missing real community gate import");
  return rows;
}
function verify(text: string) {
  const rows = bindings(text);
  const expected = [{ method: "GET", path: "/api/community/config", args: ["CommunityController.communityConfig"] },
    ...communityAvailabilityRoutes.map(row => ({ method: row.method, path: row.path,
      args: ["stationOpenMiddleware()", "communityOpenMiddleware()", `authMiddleware({force:${row.auth === "required"}})`, "CommunityController." + row.handler] }))];
  if (JSON.stringify(rows) !== JSON.stringify(expected)) throw Error("Community gate/auth/handler inventory changed");
}
describe("PHP community availability route admission", () => {
  it("reverses only one actual import and the exact 28 gate additions to the previously pinned source", () => {
    expect(followup.edits).toHaveLength(29);
    expect(followup.edits[0]).toEqual({ kind: "import", before_source: "",
      after_source: 'import { communityOpenMiddleware } from "@/middleware/community-open";\n', after_line: 147 });
    for (const [index, route] of communityAvailabilityRoutes.entries()) {
      const edit = followup.edits[index + 1];
      expect(edit.before_source).toContain(`"${route.path.slice(4)}"`);
      expect(edit.before_source).toContain(`CommunityController.${route.handler}`);
      expect(edit.before_source.startsWith(`v1Routes.${route.method.toLowerCase()}(`)).toBe(true);
      expect(edit.after_source).toBe(edit.before_source.replace("authMiddleware(", "stationOpenMiddleware(), communityOpenMiddleware(), authMiddleware("));
    }
    expect(() => reverseRouteSourceFollowup(reverseNavigationAuthorSource('workers-ts/src/routes/v1/index.ts',source), followup)).not.toThrow();
  });
  it.each(["after_line", "before_line", "before_source", "after_source", "before_sha256"] as const)("rejects a changed %s source followup", key => {
    const changed = structuredClone(followup);
    if (key === "before_sha256") changed.before_sha256 = "0".repeat(64);
    else if (key === "before_line" || key === "after_line") changed.edits[1][key] = 1;
    else changed.edits[1][key] += " /* unrelated */";
    expect(() => reverseRouteSourceFollowup(reverseNavigationAuthorSource('workers-ts/src/routes/v1/index.ts',source), changed)).toThrow();
  });
  it("binds the two real gates in order before unchanged auth on exactly 28 actions, excluding public config", () => {
    expect(communityAvailabilityRoutes).toHaveLength(28); expect(() => verify(source)).not.toThrow();
  });
  it.each([
    ["extra unguarded action", (text: string) => text + '\nv1Routes.get("/community/forgotten", CommunityController.communityList);\n'],
    ["missing station", (text: string) => text.replace('"/community/list", stationOpenMiddleware(), ', '"/community/list", ')],
    ["missing community", (text: string) => text.replace('"/community_save", stationOpenMiddleware(), communityOpenMiddleware(), ', '"/community_save", stationOpenMiddleware(), ')],
    ["auth before gate", (text: string) => text.replace('stationOpenMiddleware(), communityOpenMiddleware(), authMiddleware({ force: false })', 'authMiddleware({ force: false }), stationOpenMiddleware(), communityOpenMiddleware()')],
    ["gate on config", (text: string) => text.replace('"/community/config", CommunityController.communityConfig', '"/community/config", communityOpenMiddleware(), CommunityController.communityConfig')],
    ["type-only import", (text: string) => text.replace('import { communityOpenMiddleware }', 'import type { communityOpenMiddleware }')],
    ["missing short deletion alias", (text: string) => text.replace('"/community_delete/:id", stationOpenMiddleware(), communityOpenMiddleware(), ', '"/community_delete/:id", ')],
  ])("rejects %s", (_label, change) => { const mutated = change(source); expect(mutated).not.toBe(source); expect(() => verify(mutated)).toThrow(); });
});
