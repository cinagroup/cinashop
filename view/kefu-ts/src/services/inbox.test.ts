import { describe, expect, it } from "vitest";
import { createInboxGuard, parseInboxPage, parseInboxMessage } from "./inbox";
const row = { id: 2, title: "提醒", content: "正文", mark: "kefu_send_extract_application", look: 0, add_time: 1 };
describe("staff inbox response and lifecycle", () => {
  it("validates recipient-facing fields and excludes internal metadata", () => {
    expect(parseInboxMessage({ ...row, userId: 999, eventKey: "private" })).toEqual(row);
    expect(() => parseInboxMessage({ ...row, look: "0" })).toThrow();
    expect(() => parseInboxPage({ list: [row], unread_count: -1, next_cursor: null })).toThrow();
    expect(() => parseInboxPage({ list: [row, row], unread_count: 1, next_cursor: 2 })).toThrow();
    expect(() => parseInboxPage({ list: [row], unread_count: 1, next_cursor: 1 })).toThrow();
  });
  it("suppresses old-user results and stale failures after an invalidation", async () => {
    const guard = createInboxGuard(), values: string[] = [];
    let resolve!: (value: string) => void;
    const pending = guard.run(() => new Promise<string>((done) => { resolve = done; }), (value) => values.push(value), () => values.push("failure"));
    guard.invalidate(); resolve("old user"); await pending; expect(values).toEqual([]);
    await guard.run(async () => "new user", (value) => values.push(value), () => values.push("failure"));
    expect(values).toEqual(["new user"]);
  });
  it("allows only the latest response and ignores work after disposal", async () => {
    const guard = createInboxGuard(), values: string[] = [];
    let reject!: () => void;
    const pending = guard.run(() => new Promise<string>((_, fail) => { reject = () => fail(new Error()); }), (value) => values.push(value), () => values.push("stale failure"));
    await guard.run(async () => "current", (value) => values.push(value), () => values.push("failure"));
    reject(); await pending; expect(values).toEqual(["current"]);
    guard.dispose(); await guard.run(async () => "disposed", (value) => values.push(value), () => values.push("failure"));
    expect(values).toEqual(["current"]);
  });
});
