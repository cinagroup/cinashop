import { describe, expect, it } from "vitest";
import { resolveKefuAssetUrl } from "@/api/client";
import { kefuSocketPath, sessionMessagePreview, updateSessionFromMessage, upsertMessage } from "@/services/realtime";
import type { ChatMessage, SessionRecord } from "@/types/kefu";

const session = (id: number, peer: number): SessionRecord => ({
  id,
  user_id: 1001,
  to_uid: peer,
  nickname: `客户${peer}`,
  avatar: "",
  phone: "",
  is_tourist: 0,
  online: 0,
  type: 0,
  add_time: 1,
  update_time: id,
  mssage_num: 0,
  message: "old",
  message_type: 1,
});

const message = (id: number, uid = 2001, toUid = 1001): ChatMessage => ({
  id,
  uid,
  to_uid: toUid,
  msn: `message-${id}`,
  is_tourist: 0,
  add_time: id,
  type: 0,
  msn_type: 1,
});

describe("customer-service realtime reducers", () => {
  it("reconnects to the last selected customer path", () => {
    expect(kefuSocketPath(0)).toBe("/kefuapi/ws");
    expect(kefuSocketPath(2002)).toBe("/kefuapi/ws?to_uid=2002");
  });

  it("routes signed image assets through the standalone Pages proxy", () => {
    expect(resolveKefuAssetUrl("/api/assets/91?expires=1&signature=test"))
      .toBe("/kefuapi/assets/91?expires=1&signature=test");
    expect(resolveKefuAssetUrl("https://legacy.example.test/image.png"))
      .toBe("https://legacy.example.test/image.png");
  });

  it("deduplicates persisted acknowledgements and orders by database id", () => {
    const original = [message(9), message(11)];
    expect(upsertMessage(original, message(11))).toBe(original);
    expect(upsertMessage(original, message(10)).map((item) => item.id)).toEqual([9, 10, 11]);
  });

  it("updates and promotes the peer session for customer and agent messages", () => {
    const sessions = [session(2, 2002), session(1, 2001)];
    const customerUpdate = updateSessionFromMessage(sessions, message(20), 1001);
    expect(customerUpdate[0]).toMatchObject({ to_uid: 2001, message: "message-20", update_time: 20 });

    const agentUpdate = updateSessionFromMessage(customerUpdate, message(21, 1001, 2002), 1001);
    expect(agentUpdate[0]).toMatchObject({ to_uid: 2002, message: "message-21", update_time: 21 });
  });

  it("uses a safe image label instead of exposing signed URLs in session summaries", () => {
    const image = { ...message(22), msn: "/api/assets/91?expires=1&signature=test", msn_type: 3 };
    const result = updateSessionFromMessage([session(1, 2001)], image, 1001);
    expect(result[0]).toMatchObject({ message: "[图片]", message_type: 3 });
    expect(sessionMessagePreview("/api/assets/91", 3)).toBe("[图片]");
    expect(sessionMessagePreview("普通文本", 1)).toBe("普通文本");
  });

  it("does not invent a session when a pushed peer is outside the loaded page", () => {
    const sessions = [session(1, 2001)];
    expect(updateSessionFromMessage(sessions, message(30, 2009, 1001), 1001)).toBe(sessions);
  });
});
