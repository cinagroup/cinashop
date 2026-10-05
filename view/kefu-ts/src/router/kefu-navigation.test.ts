import { describe, expect, it } from "vitest";
import { conversationKey, parseConversationQuery, safeKefuRedirect } from "./kefu-navigation";
describe("independent customer-service navigation", () => {
  it("requires an explicit domain and positive canonical UID", () => {
    expect(parseConversationQuery({ toUid: "9", is_tourist: "1" })).toEqual({ uid: 9, isTourist: 1 });
    expect(parseConversationQuery({ uid: "9", is_tourist: "0" })).toEqual({ uid: 9, isTourist: 0 });
    for (const value of [{ uid: "9" }, { uid: ["9"], is_tourist: "0" }, { uid: "09", is_tourist: "1" }, { uid: "0", is_tourist: "0" }, { uid: "9", is_tourist: "2" }, { uid: "2147483648", is_tourist: "0" }, { uid: "9", toUid: "9", is_tourist: "0" }]) expect(parseConversationQuery(value)).toBeNull();
    expect(conversationKey({ to_uid: 9, is_tourist: 0 })).not.toBe(conversationKey({ to_uid: 9, is_tourist: 1 }));
  });
  it("preserves only customer-service destinations on this origin", () => {
    const origin = "https://kefu.example.test";
    expect(safeKefuRedirect("/kefu/mobile_chat?toUid=9&is_tourist=1", origin)).toBe("/kefu/mobile_chat?toUid=9&is_tourist=1");
    for (const value of ["//evil.test", "https://evil.test", "/\\evil.test", "/login", "/admin", "/%2f%2fevil.test", "/workbench\n", null]) expect(safeKefuRedirect(value, origin)).toBe("/workbench");
  });
});
