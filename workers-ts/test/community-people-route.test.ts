import { describe, expect, it } from "vitest";
import { parseCommunityPeopleTab, resolveCommunityPageRoute } from "../../view/common/communityRoute";
import { resolveRegisteredPageRoute } from "@/services/content/FabRouteRegistry";

const path = "/pages/discover/discoverFollow/index";
describe("legacy community follow list routes", () => {
  it.each([["0", "follow"], ["1", "friend"], ["2", "fans"]])("keeps PHP type=%s as %s on both shared and actual server routes", (type, tab) => {
    expect(resolveCommunityPageRoute(path, `type=${type}`)).toBe(`/pages/discover/people?tab=${tab}`);
    expect(resolveRegisteredPageRoute(path, `type=${type}`)).toBe(`/pages/discover/people?tab=${tab}`);
    expect(parseCommunityPeopleTab({ type })).toBe(tab);
  });
  it("defaults to friends and retains every modern tab while dropping unrelated private input", () => {
    expect(resolveCommunityPageRoute(path, "")).toBe("/pages/discover/people?tab=friend");
    expect(parseCommunityPeopleTab()).toBe("friend");
    for (const tab of ["friend", "follow", "fans", "recommend"] as const) {
      expect(parseCommunityPeopleTab({ tab })).toBe(tab);
      expect(resolveCommunityPageRoute(path, `tab=${tab}&token=PRIVATE&uid=22`)).toBe(`/pages/discover/people?tab=${tab}`);
    }
    expect(resolveCommunityPageRoute(path, "type=%32")).toBe("/pages/discover/people?tab=fans");
    expect(resolveCommunityPageRoute("/pages/discover/people", "type=2")).toBeNull();
  });
  it("rejects ambiguous duplicate malformed and noncanonical list selectors", () => {
    for (const query of ["type=3", "type=-1", "type=01", "type=1.0", "type=1e0", "type=", "type=2&type=2",
      "tab=follow&tab=fans", "type=0&tab=follow", "type=0&%74ype=1", "tab=unknown", "tab=%", "type=%00", "x=" + "a".repeat(2048)]) {
      expect(resolveCommunityPageRoute(path, query), query).toBe("");
      expect(resolveRegisteredPageRoute(path, query), query).toBe("");
    }
    for (const query of [{ type: 0 }, { type: null }, { tab: [] }, { tab: "Follow" }, { type: "0", tab: "follow" }]) {
      expect(parseCommunityPeopleTab(query)).toBeNull();
    }
  });
});
