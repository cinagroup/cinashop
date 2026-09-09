import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { getQueryParam, getQueryParams } from "hono/utils/url";
import { parseBody } from "hono/utils/body";
import { ssgParams, toSSG } from "hono/ssg";
import { getMore } from "../src/utils/request";

// Library-boundary regressions, not claims that SSG/dot parsing are enabled in production.
describe("Hono September 2026 patched boundaries", () => {
  it.each(["https://audit.invalid/#?role=extra", "https://audit.invalid/?ok=1#&role=extra"])("ignores fragment parameters: %s", (url) => {
    expect(getQueryParam(url, "role")).toBeUndefined();
    expect(getQueryParams(url, "role")).toBeUndefined();
    expect(getQueryParam(url)).not.toHaveProperty("role");
  });
  it("preserves encoded hashes, duplicate parameters, spaces and application casting", async () => {
    const app = new Hono();
    app.get("/", c => c.json({ values: c.req.queries("tag"), input: getMore(c, [["page", 1, "d"], ["keyword", ""]]) }));
    const response = await app.request("https://audit.invalid/?tag=a%23b&tag=c+d&page=2&keyword=%E5%95%86%E5%93%81");
    expect(await response.json()).toEqual({ values: ["a#b", "c d"], input: { page: 2, keyword: "商品" } });
    expect(getQueryParam("https://audit.invalid/?tag=normal#ignored", "tag")).toBe("normal");
  });
  const form = (body: URLSearchParams) => new Request("https://audit.invalid/", { method: "POST", body });
  it("preserves normal dot fields and repeated form values", async () => {
    expect(await parseBody(form(new URLSearchParams("profile.name=local&tag=x&tag=y")), { dot: true, all: true }))
      .toEqual({ profile: { name: "local" }, tag: ["x", "y"] });
    expect(await parseBody(form(new URLSearchParams("profile.name=local")))).toEqual({ "profile.name": "local" });
  });
  it.each([Array(34).fill("a").join("."), ".".repeat(64)])("bounds dot depth without allocating unbounded nesting (%#)", async key => {
    await expect(parseBody(form(new URLSearchParams([[key, "local"]])), { dot: true }).then(() => "accepted")).rejects.toThrow("Nesting limit exceeded");
  });
  it("bounds total nested allocations across shallow fields", async () => {
    const body = new URLSearchParams(Array.from({ length: 10_001 }, (_, i) => [`field${i}.value`, "local"]));
    await expect(parseBody(form(body), { dot: true }).then(() => "accepted")).rejects.toThrow("Nesting limit exceeded");
  });
  it.each(["../../../outside", "../../../../outside", "..\\..\\..\\outside"])("rejects SSG traversal before any filesystem sink: %s", async slug => {
    const writes: string[] = [];
    const app = new Hono();
    app.get("/page/:slug", ssgParams([{ slug }]), c => c.text("inert local fixture"));
    const result = await toSSG(app, { mkdir: async path => { writes.push(path); }, writeFile: async path => { writes.push(path); } }, { dir: "output/site", plugins: [] });
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/traversal|outside/i);
    expect(writes).toEqual([]);
  });
  it("still generates ordinary SSG output through the same in-memory filesystem adapter", async () => {
    const writes: Array<[string, string | Uint8Array]> = [];
    const app = new Hono();
    app.get("/page/:slug", ssgParams([{ slug: "local" }]), c => c.text("ordinary"));
    const result = await toSSG(app, { mkdir: async () => {}, writeFile: async (path, data) => { writes.push([path, data]); } }, { dir: "output/site", plugins: [] });
    expect(result.success).toBe(true);
    expect(writes).toEqual([["output/site/page/local.txt", "ordinary"]]);
  });
  it.each(["a/b/../../../outside", "a\\b\\..\\..\\..\\outside"])("rejects consecutive parents after nested SSG parameters: %s", async slug => {
    const writes: string[] = [];
    const app = new Hono();
    app.get("/:slug", ssgParams([{ slug }]), c => c.text("inert"));
    const result = await toSSG(app, { mkdir: async path => { writes.push(path); }, writeFile: async path => { writes.push(path); } }, { dir: "./output", plugins: [] });
    expect(result.success).toBe(false);
    expect(writes).toEqual([]);
  });
});
