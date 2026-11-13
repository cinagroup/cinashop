import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { mount } from "hono/mount";

// Bounded library regressions for GHSA-h7mg-cq63-vhpq and GHSA-4m76-xfj5-7975.
// Existing application auth suites separately exercise our real route modules.
const auth: MiddlewareHandler = async (c, next) => {
  if (c.req.header("Authorization") !== "Bearer local-fixture") return c.text("unauthorized", 401);
  await next();
};
const headers = { Authorization: "Bearer local-fixture" };

describe("Hono patched wildcard and mount middleware coverage", () => {
  it("applies an explicit default parameter pattern to the equivalent route", async () => {
    const app = new Hono();
    app.use("/api/:tenant{[^/]+}/admin/*", auth);
    app.get("/api/:tenant/admin/:id", c => c.text("protected"));
    expect((await app.request("/api/local/admin/42")).status).toBe(401);
    const allowed = await app.request("/api/local/admin/42", { headers });
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toBe("protected");
  });

  it("applies slash-wildcard middleware to an overlapping wildcard route", async () => {
    const app = new Hono();
    app.use("/admin/*", auth);
    app.get("/admin*", c => c.text("protected"));
    expect((await app.request("/admin/secret")).status).toBe(401);
    expect((await app.request("/admin/secret", { headers })).status).toBe(200);
  });

  it.each(["%0A", "%0D", "%E2%80%A8", "%E2%80%A9"])("runs wildcard auth before not-found for encoded line terminator %s", async encoded => {
    const app = new Hono();
    app.use("/*", auth);
    app.get("/ordinary", c => c.text("ordinary"));
    app.notFound(c => c.text("private diagnostic", 404));
    expect((await app.request(`/unknown/${encoded}`)).status).toBe(401);
    const allowed = await app.request(`/unknown/${encoded}`, { headers });
    expect(allowed.status).toBe(404);
    expect(await allowed.text()).toBe("private diagnostic");
  });

  it("removes a dynamic mount prefix by its matched segments", async () => {
    const inner = new Hono();
    inner.get("/admin/secret", c => c.text("protected"));
    const app = new Hono();
    app.use("/api/:tenant/admin/*", auth);
    app.all("/api/:tenant/*", mount(inner.fetch));
    expect((await app.request("/api/a/xxxxx/admin/secret")).status).toBe(404);
    expect((await app.request("/api/a/admin/secret")).status).toBe(401);
    const allowed = await app.request("/api/a/admin/secret", { headers });
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toBe("protected");
  });

  it("rejects mount forwarding that would reinterpret encoded backslash parents", async () => {
    const inner = new Hono();
    inner.get("/admin/secret", c => c.text("protected"));
    const app = new Hono();
    app.use("/app/admin/*", auth);
    app.mount("/app", inner.fetch);
    expect((await app.request("/app/public%5C..%5Cadmin/secret")).status).toBe(404);
    expect((await app.request("/app/admin/secret")).status).toBe(401);
    expect((await app.request("/app/admin/secret", { headers })).status).toBe(200);
  });
});
