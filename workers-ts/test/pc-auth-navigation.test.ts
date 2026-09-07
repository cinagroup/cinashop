import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { safeLoginRedirect, expiredLoginDestination, requiresPcAuth } from "../../view/pc-ts/src/utils/authNavigation";

const origin = "https://shop.example.test";
describe("PC login return paths preserve intent without leaving the shop", () => {
  it("preserves checkout, SKU, encoded queries and hash", () => {
    const path = "/checkout?mode=buy&cartIds=2&type=0&label=%E6%B5%8B%E8%AF%95#details";
    expect(safeLoginRedirect(path, origin)).toBe(path);
    const redirect = expiredLoginDestination({ origin, pathname: "/checkout", search: path.slice(path.indexOf("?"), path.indexOf("#")), hash: "#details" });
    expect(new URL(redirect!, origin).searchParams.get("redirect")).toBe(path);
    expect(safeLoginRedirect("/goods/70?sku=actual_sku&qty=2#buy", origin)).toBe("/goods/70?sku=actual_sku&qty=2#buy");
  });
  it("rejects external/protocol-relative/backslash/control-character returns and login loops", () => {
    for (const value of ["https://evil.example", "//evil.example", "/\\evil.example", "/\nevil.example", "javascript:alert(1)",
      "/login?redirect=/checkout", "/LOGIN/", "/%6cogin", "/%5cevil.example", "/%2f%2fevil.example", "/%0aevil.example", "/bad%", undefined, ["/checkout"]]) {
      expect(safeLoginRedirect(value, origin)).toBe("/");
    }
    expect(expiredLoginDestination({ origin, pathname: "/login", search: "?redirect=%2Fcheckout", hash: "" })).toBeNull();
  });
  it("protects refund and tracking as well as checkout/order/user routes with segment boundaries", () => {
    for (const path of ["/cart", "/checkout", "/order", "/order/123", "/user/phone", "/refund/123", "/express", "/USER"]) {
      expect(requiresPcAuth(path), path).toBe(true);
    }
    for (const path of ["/", "/goods/70", "/service", "/login", "/orderly", "/userland", "/cartoon"]) {
      expect(requiresPcAuth(path), path).toBe(false);
    }
  });
  it("keeps both logout entry points from reporting or navigating for an obsolete session", () => {
    for (const file of ["layouts/DefaultLayout.vue", "pages/user/UserCenter.vue"]) {
      const source = readFileSync(new NodeURL(`../../view/pc-ts/src/${file}`, import.meta.url), "utf8");
      expect(source, file).toContain("const { serverRevoked, clearedCurrentSession } = await authStore.logout();");
      expect(source, file).toMatch(/if \(!clearedCurrentSession\) return;\s*if \(serverRevoked\) ElMessage\.success/);
      expect(source, file).toContain("else ElMessage.warning(");
    }
  });
});
