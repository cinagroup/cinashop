import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const client = readFileSync(resolve(root, "../view/uniapp-ts/src/api/diy.ts"), "utf8");
const loader = readFileSync(resolve(root, "../view/uniapp-ts/src/utils/diy.ts"), "utf8");
const renderer = readFileSync(
  resolve(root, "../view/uniapp-ts/src/components/diy/DiyHomeRenderer.vue"),
  "utf8",
);
const suspended = readFileSync(
  resolve(root, "../view/uniapp-ts/src/components/diy/DiySuspendedNavigation.vue"),
  "utf8",
);
const homepage = readFileSync(resolve(root, "../view/uniapp-ts/src/pages/index/index.vue"), "utf8");
const microPage = readFileSync(resolve(root, "../view/uniapp-ts/src/pages/diy/detail.vue"), "utf8");
const pages = readFileSync(resolve(root, "../view/uniapp-ts/src/pages.json"), "utf8");

describe("DIY-home frontend migration", () => {
  it("provides typed clients for the eight legacy contracts", () => {
    for (const route of [
      "diy/get_diy/",
      "diy/diy_version/",
      "diy/user_info",
      "diy/video_list",
      "diy/newcomer_list",
      "diy/product_rank",
      "diy/sign",
      "diy/get_suspended",
    ]) {
      expect(client).toContain(route);
    }
    expect(client).toContain("Promise<DiyPage | []>");
    expect(client).toContain("Promise<DiySuspendedConfig>");
  });

  it("normalizes only named, visible allowlisted components in timestamp order", () => {
    expect(client).toContain('"pageFoot"');
    expect(loader).toContain("ALLOWED_COMPONENTS.has(name)");
    expect(loader).toContain("isDiyEnabled(item.isHide)");
    expect(loader).toContain("componentTimestamp(left) - componentTimestamp(right)");
    expect(loader).toContain("slice(0, MAX_COMPONENTS)");
  });

  it("fails closed on malformed page, image, color, and navigation input", () => {
    expect(loader).toContain("if (!page || Array.isArray(value)) return null");
    expect(loader).toContain("/^https:\\/\\//i.test(url)");
    expect(loader).toContain("/^\\/(?!\\/)/.test(url)");
    expect(loader).toContain("return \"\";");
    expect(loader).toContain('"/pages/goods_details/index": "/pages/goods/detail"');
    expect(loader).toContain("if (!raw.startsWith(\"/pages/\")) return \"\"");
  });

  it("only emits bounded safe page background styles", () => {
    expect(loader).toContain("safeDiyColor(page.color_picker)");
    expect(loader).toContain("safeDiyImageUrl(page.bg_pic)");
    expect(loader).toContain("backgroundSize");
    expect(loader).toContain("backgroundRepeat");
  });

  it("uses version-scoped storage and never dynamically instantiates server component names", () => {
    expect(loader).toContain("apiDiyVersion(safeId)");
    expect(loader).toContain("apiDiyPage(safeId)");
    expect(loader).toContain("cinashop_diy_page_v1_");
    expect(loader).toContain("ALLOWED_COMPONENTS.has(name)");
    expect(renderer).not.toContain("<component");
    expect(renderer).not.toContain("v-html");
    expect(renderer).toContain("sanitizeArticleRichText");
  });

  it("registers reachable home, micro-page, and suspended-navigation consumers", () => {
    expect(homepage).toContain("loadDiyPage(0");
    expect(homepage).toContain("<DiyHomeRenderer");
    expect(homepage).toContain("<DiySuspendedNavigation");
    expect(microPage).toContain("loadDiyPage(pageId.value");
    expect(microPage).toContain("micro-page");
    expect(pages).toContain('"path": "pages/diy/detail"');
    expect(suspended).toContain("apiDiySuspended()");
    expect(suspended).toContain("normalizeDiyLink");
  });
});
