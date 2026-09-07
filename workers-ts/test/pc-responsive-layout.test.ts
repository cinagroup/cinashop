import { readFileSync } from "node:fs";
import { parse, type AtRule, type Root } from "postcss";
import { describe, expect, it } from "vitest";
import { pcFixtureResponse, pcGalleryImages } from "./helpers/pcProductDetailFixture";

const read = (path: string) => readFileSync(`../view/pc-ts/src/${path}`, "utf8");
const layout = read("layouts/DefaultLayout.vue");
const detail = read("pages/goods/GoodsDetail.vue");
const css = (source: string) => parse(source.match(/<style[^>]*>([\s\S]*?)<\/style>/)![1]);
function declaration(root: Root, selector: string, property: string, media?: string) {
  const values: string[] = [];
  root.walkRules(selector, (rule) => {
    const parent = rule.parent;
    const condition = parent?.type === "atrule" ? (parent as AtRule).params : undefined;
    if (condition === media) rule.walkDecls(property, (node) => { values.push(node.value); });
  });
  return values.at(-1);
}

// Structural regression gates, not a substitute for rendered breakpoint QA.
describe("FE-002D PC responsive navigation and detail", () => {
  it("keeps one accessible search form and all existing navigation destinations", () => {
    expect(layout.match(/role="search"/g)).toHaveLength(1);
    expect(layout).toContain('@submit.prevent="doSearch"');
    expect(layout).toContain('<el-button native-type="submit">搜索</el-button>');
    expect(layout).not.toContain('@keyup.enter="doSearch"');
    expect(layout).toContain('aria-label="返回商城首页"');
    const nav = layout.match(/<nav\b[^>]*>([\s\S]*?)<\/nav>/)![1];
    expect([...nav.matchAll(/to="([^"]+)"/g)].map((match) => match[1])).toEqual([
      "/", "/category", "/goods", "/seckill", "/bargain", "/combination", "/community", "/service",
    ]);
  });

  it("reflows the header at medium and narrow widths without hiding search or navigation", () => {
    const root = css(layout);
    expect(declaration(root, ".header-inner", "grid-template-areas"))
      .toBe('"logo nav search account"');
    expect(declaration(root, ".header-inner", "grid-template-areas", "(max-width: 1100px)"))
      .toBe('"logo search account" "nav nav nav"');
    expect(declaration(root, ".header-inner", "grid-template-areas", "(max-width: 600px)"))
      .toBe('"logo account" "search search" "nav nav"');
    expect(declaration(root, ".nav", "flex-wrap")).toBe("wrap");
    expect(declaration(root, ".search-input", "width")).toBe("100%");
    root.walkRules((rule) => {
      if (/\.(?:nav|search-form|search-input)(?:\b|,)/.test(rule.selector)) {
        rule.walkDecls((node) => {
          expect(`${node.prop}:${node.value}`).not.toMatch(/^(?:display:none|visibility:hidden)$/);
        });
      }
    });
  });

  it("keeps the gallery square and the detail in a single column below 900px", () => {
    const root = css(detail);
    expect(detail).toContain('<el-carousel height="100%" class="product-carousel">');
    expect(declaration(root, ".product-carousel", "height")).toBe("100%");
    expect(declaration(root, ".gallery", "width", "(max-width: 900px)")).toBe("100%");
    expect(declaration(root, ".gallery", "height", "(max-width: 900px)")).toBe("auto");
    expect(declaration(root, ".gallery", "aspect-ratio", "(max-width: 900px)")).toBe("1");
    expect(declaration(root, ".detail-main", "flex-direction", "(max-width: 900px)")).toBe("column");
    expect(declaration(root, ".info", "min-width")).toBe("0");
    expect(declaration(root, ".actions", "grid-template-columns", "(max-width: 600px)"))
      .toBe("repeat(2, minmax(0, 1fr))");
    expect(detail).toContain('width="min(680px, calc(100vw - 32px))"');
  });

  it("allows long search text and grid columns to shrink instead of hiding page overflow", () => {
    const app = css(read("App.vue")), search = css(read("pages/goods/GoodsSearch.vue"));
    expect(declaration(search, ".title", "overflow-wrap")).toBe("anywhere");
    expect(declaration(search, ".goods-bottom", "flex-wrap")).toBe("wrap");
    expect(declaration(app, ".goods-grid", "grid-template-columns", "(max-width: 768px)"))
      .toBe("repeat(2, minmax(0, 1fr))");
    for (const root of [css(layout), css(detail), search, app]) {
      root.walkDecls("overflow-x", (node) => { expect(node.value).not.toMatch(/hidden|clip/); });
    }
  });

  it("uses only isolated GET fixtures with explicit nonempty, empty and unavailable states", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      expect(pcFixtureResponse(method, "/api/products").status).toBe(405);
    }
    for (const path of ["/api/login", "/api/cart/add", "/api/product/detail/999", "/adminapi/products"]) {
      expect(pcFixtureResponse("GET", path).status).toBe(404);
    }
    expect(pcFixtureResponse("GET", "/api/products?keyword=测试")).toMatchObject({ status: 200, data: { count: 3 } });
    expect(pcFixtureResponse("GET", "/api/products?keyword=无结果")).toMatchObject({ status: 200, data: { list: [], count: 0 } });
    expect(pcFixtureResponse("GET", "/api/product/detail/71")).toMatchObject({ data: { isPresaleProduct: 1 } });
    expect(pcFixtureResponse("GET", "/api/pc/get_appid")).toMatchObject({ data: { appid: "" } });
  });

  it("keeps empty source images separate from clearly labelled local carousel fixtures", () => {
    expect(pcFixtureResponse("GET", "/api/product/detail/70")).toMatchObject({ data: { sliderImage: [] } });
    expect(pcFixtureResponse("GET", "/api/product/detail/72")).toMatchObject({ data: { sliderImage: pcGalleryImages } });
    expect(pcGalleryImages).toHaveLength(2);
    for (const image of pcGalleryImages) {
      expect(image).toMatch(/^data:image\/svg\+xml,/);
      expect(decodeURIComponent(image)).toContain("LOCAL TEST");
    }
  });
});
