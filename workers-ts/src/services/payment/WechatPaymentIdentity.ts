import { and, eq } from "drizzle-orm";
import type { Container } from "@/lib/di";
import { wechatUser } from "@/models/schema";
import { ValidateException } from "@/utils/errors";

export type WechatPaymentChannel = "weixin" | "routine" | "h5" | "pc" | "app";
export type WechatTransactionType = "jsapi" | "native" | "h5" | "app";

export interface WechatPaymentIdentity {
  channel: WechatPaymentChannel;
  type: WechatTransactionType;
  openid?: string;
  payerClientIp?: string;
}

export function normalizeWechatPaymentChannel(value: unknown): WechatPaymentChannel {
  const channel = typeof value === "string" ? value.trim().toLowerCase() : "";
  switch (channel) {
    case "weixin":
    case "wechat":
      return "weixin";
    case "routine":
      return "routine";
    case "weixinh5":
    case "h5":
      return "h5";
    case "pc":
      return "pc";
    case "app":
      return "app";
    default:
      throw new ValidateException("不支持当前微信支付渠道");
  }
}

/** Resolve payer identity only from the authenticated user's stored binding. */
export async function resolveWechatPaymentIdentity(
  container: Container,
  uid: number,
  from: unknown,
  payerClientIp?: string,
): Promise<WechatPaymentIdentity> {
  const channel = normalizeWechatPaymentChannel(from);
  if (channel === "h5") {
    return { channel, type: "h5", ...(payerClientIp ? { payerClientIp } : {}) };
  }
  if (channel === "pc") return { channel, type: "native" };
  if (channel === "app") return { channel, type: "app" };

  const userType = channel === "routine" ? "routine" : "wechat";
  const rows = await container.db
    .select({ openid: wechatUser.openid })
    .from(wechatUser)
    .where(and(
      eq(wechatUser.uid, uid),
      eq(wechatUser.userType, userType),
      eq(wechatUser.isDel, 0),
    ))
    .limit(2);
  if (rows.length !== 1 || !rows[0].openid) {
    throw new ValidateException("当前账号缺少唯一的微信身份绑定");
  }
  return { channel, type: "jsapi", openid: rows[0].openid };
}
