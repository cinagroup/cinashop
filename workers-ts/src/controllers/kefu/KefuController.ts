import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { extractToken } from "@/middleware/auth";
import { extractVisitorToken } from "@/middleware/visitor-auth";
import { enforceKefuLoginRateLimit } from "@/middleware/kefu-rate-limit";
import { KefuAuthService } from "@/services/kefu/KefuAuthService";
import { ScanLoginService } from "@/services/auth/ScanLoginService";
import { WechatOpenWebAuthService } from "@/services/wechat/WechatOpenWebAuthService";
import { KefuCoreService } from "@/services/kefu/KefuCoreService";
import { KefuFulfillmentService } from "@/services/kefu/KefuFulfillmentService";
import { KefuOrderManagementService } from "@/services/kefu/KefuOrderManagementService";
import { KefuOrderService } from "@/services/kefu/KefuOrderService";
import { KefuProductService } from "@/services/kefu/KefuProductService";
import { chatPrincipalName, upgradeChatSocket } from "@/services/kefu/KefuSocketGateway";
import { KefuTransferService } from "@/services/kefu/KefuTransferService";
import { KefuTouristService } from "@/services/kefu/KefuTouristService";
import { KefuVisitorSessionService } from "@/services/kefu/KefuVisitorSessionService";
import { StoreOrderCreateService } from "@/services/order/StoreOrderCreateService";
import { CustomerServiceCatalogService } from "@/services/message/CustomerServiceCatalogService";
import { ValidateException } from "@/utils/errors";
import { jsonOk } from "@/utils/json";
import { readBoundedJsonObject } from "@/utils/request-body";
import { md5 } from "@/utils/jwt";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
const MAX_KEFU_BODY_BYTES = 8 * 1024;

function core(c: C) {
  return new KefuCoreService(c.get("container"), c.env);
}

function catalog(c: C) {
  return new CustomerServiceCatalogService(c.get("container"));
}

function products(c: C) {
  return new KefuProductService(c.get("container"));
}

function tourist(c: C) {
  c.header("Cache-Control", "no-store, max-age=0");
  return new KefuTouristService(c.get("container"), c.env);
}

function orders(c: C) {
  return new KefuOrderService(c.get("container"));
}

function orderManagement(c: C) {
  return new KefuOrderManagementService(c.get("container"), c.env);
}

function fulfillment(c: C) {
  return new KefuFulfillmentService(c.get("container"), c.env);
}

function kefuId(c: C): number {
  const value = c.get("kefuId") ?? 0;
  if (!value) throw new ValidateException("客服身份无效");
  return value;
}

function kefuUid(c: C): number {
  const value = c.get("kefuUid") ?? 0;
  if (!value) throw new ValidateException("客服聊天身份无效");
  return value;
}

function personalCatalog(c: C): boolean {
  const value = c.req.query("type") ?? "0";
  if (value !== "0" && value !== "1") throw new ValidateException("话术类型错误");
  return value === "1";
}

async function body(c: C) {
  return readBoundedJsonObject(c.req.raw, MAX_KEFU_BODY_BYTES);
}

function clientIp(c: C): string {
  return (
    c.req.header("CF-Connecting-IP")
    ?? c.req.header("X-Forwarded-For")?.split(",")[0]?.trim()
    ?? c.req.header("X-Real-IP")
    ?? "0.0.0.0"
  ).slice(0, 128);
}

export async function login(c: C) {
  await enforceKefuLoginRateLimit(c);
  const result = await new KefuAuthService(c.get("container"), c.env).login(await body(c));
  return jsonOk(c, result, "登录成功");
}

export async function loginKey(c: C) {
  c.header("Cache-Control", "no-store, max-age=0");
  return jsonOk(c, await new ScanLoginService(c.get("container"), c.env)
    .create("kefu_agent", clientIp(c)));
}

export async function scanLogin(c: C) {
  c.header("Cache-Control", "no-store, max-age=0");
  return jsonOk(c, await new ScanLoginService(c.get("container"), c.env).poll(
    "kefu_agent",
    c.req.param("key"),
    c.req.header("X-Scan-Poll-Token"),
    clientIp(c),
  ));
}

export async function oauthState(c: C) {
  c.header("Cache-Control", "no-store, max-age=0");
  const result = await new WechatOpenWebAuthService(c.get("container"), c.env)
    .createOauthState("kefu_agent", clientIp(c));
  return jsonOk(c, { state: result.state, expires_in: result.expiresIn });
}

export async function wechatLogin(c: C) {
  c.header("Cache-Control", "no-store, max-age=0");
  const result = await new WechatOpenWebAuthService(c.get("container"), c.env)
    .login("kefu_agent", c.req.query("code"), c.req.query("state"), clientIp(c));
  return jsonOk(c, result, "登录成功");
}

export async function touristAdvertisement(c: C) {
  return jsonOk(c, { content: await tourist(c).advertisement() });
}

export async function touristFeedbackInfo(c: C) {
  return jsonOk(c, { feedback: await tourist(c).feedbackInfo() });
}

export async function touristSubmitFeedback(c: C) {
  await tourist(c).submitFeedback(await body(c), clientIp(c));
  return jsonOk(c, null, "保存成功");
}

export async function touristProduct(c: C) {
  return jsonOk(c, await tourist(c).productInfo(c.req.param("id")));
}

export async function touristUser(c: C) {
  c.header("Cache-Control", "no-store, max-age=0");
  return jsonOk(c, await new KefuVisitorSessionService(c.get("container"), c.env)
    .bootstrap(extractVisitorToken(c), clientIp(c)));
}

export async function touristChat(c: C) {
  c.header("Cache-Control", "no-store, max-age=0");
  const identity = c.get("visitorSession");
  if (!identity) throw new ValidateException("游客会话无效");
  return jsonOk(c, await new KefuVisitorSessionService(c.get("container"), c.env).history(
    identity,
    c.req.query("upperId") ?? c.req.query("upper_id"),
    c.req.query("limit"),
  ));
}

export async function touristOrder(c: C) {
  return jsonOk(c, await new StoreOrderCreateService(c.get("container"), c.env)
    .detail(c.get("uid"), c.req.param("order_id") ?? ""));
}

export async function touristWebsocket(c: C): Promise<Response> {
  const identity = c.get("visitorSession");
  if (!identity) throw new ValidateException("游客会话无效");
  return upgradeChatSocket(c, {
    role: 3,
    principalUid: identity.visitorUid,
    toUid: identity.kefuUid,
    isTourist: 1,
  });
}

export async function config(c: C) {
  return jsonOk(c, await core(c).clientConfig());
}

export function copyright(c: C) {
  return jsonOk(c, {
    copyrightContext: "",
    copyrightImage: "",
    is_copyright: false,
  });
}

export async function logout(c: C) {
  const token = extractToken(c);
  if (!token) throw new ValidateException("客服登录状态无效");
  const tokenKey = md5(token);
  await new KefuAuthService(c.get("container"), c.env).logout(token, kefuId(c));
  await c.env.CHAT_ROOM
    .getByName(chatPrincipalName(2, kefuUid(c)))
    .disconnectToken(tokenKey);
  return jsonOk(c, null, "退出成功");
}

export async function websocket(c: C): Promise<Response> {
  return upgradeChatSocket(c, {
    role: 2,
    principalUid: kefuUid(c),
    toUid: c.req.query("to_uid"),
    isTourist: c.req.query("is_tourist"),
  });
}

export async function erpConfig(c: C) {
  return jsonOk(c, await core(c).erpConfig());
}

export async function serviceInfo(c: C) {
  const info = c.get("kefuInfo");
  if (!info) throw new ValidateException("客服身份无效");
  return jsonOk(c, await core(c).currentInfo(info));
}

export async function serviceList(c: C) {
  return jsonOk(c, await core(c).availableServices(kefuUid(c), c.req.query()));
}

export async function serviceChat(c: C) {
  return jsonOk(c, await core(c).chatHistory(
    kefuUid(c),
    c.req.query("uid"),
    c.req.query("upperId") ?? c.req.query("upper_id"),
    c.req.query("is_tourist"),
    c.req.query("limit"),
  ));
}

export async function transfer(c: C) {
  const payload = await body(c);
  const input: Record<string, unknown> = {
    ...payload,
    uid: payload.uid ?? c.req.query("uid"),
    kefuToUid: payload.kefuToUid ?? payload.kefu_to_uid ?? c.req.query("kefuToUid") ?? c.req.query("kefu_to_uid"),
    is_tourist: payload.is_tourist ?? payload.isTourist ?? c.req.query("is_tourist"),
    request_key: payload.request_key ?? payload.requestKey ?? c.req.header("Idempotency-Key"),
  };
  const result = await new KefuTransferService(c.get("container")).transfer(
    kefuId(c),
    kefuUid(c),
    input,
  );

  if (!result.idempotent && result.recored) {
    const deliveries = await Promise.allSettled([
      c.env.CHAT_ROOM.getByName(chatPrincipalName(2, result.from_uid)).deliverTransfer({
        type: "transfer_out",
        data: {
          request_key: result.request_key,
          uid: result.uid,
          toUid: result.to_uid,
          is_tourist: result.is_tourist,
          nickname: result.targetInfo.nickname,
          avatar: result.targetInfo.avatar,
        },
      }),
      c.env.CHAT_ROOM.getByName(chatPrincipalName(2, result.to_uid)).deliverTransfer({
        type: "transfer",
        data: {
          request_key: result.request_key,
          recored: result.recored,
          kefuInfo: result.kefuInfo,
          is_tourist: result.is_tourist,
        },
      }),
      c.env.CHAT_ROOM.getByName(chatPrincipalName(result.is_tourist ? 3 : 1, result.uid)).deliverTransfer({
        type: "to_transfer",
        data: {
          request_key: result.request_key,
          toUid: result.to_uid,
          is_tourist: result.is_tourist,
          nickname: result.targetInfo.nickname,
          avatar: result.targetInfo.avatar,
          online: result.targetInfo.online,
        },
      }),
    ]);
    const failed = deliveries.filter((item) => item.status === "rejected").length;
    if (failed) {
      console.error(JSON.stringify({
        event: "kefu_transfer_delivery_failed",
        requestKey: result.request_key,
        failed,
      }));
    }
  }
  return jsonOk(c, result, "转接成功");
}

export async function sessionList(c: C) {
  return jsonOk(c, await core(c).sessionList(kefuUid(c), c.req.query()));
}

export async function userInfo(c: C) {
  return jsonOk(c, await core(c).userInfo(kefuUid(c), c.req.param("uid")));
}

export async function userLabels(c: C) {
  return jsonOk(c, await core(c).userLabels(kefuUid(c), c.req.param("uid")));
}

export async function setUserLabels(c: C) {
  await core(c).setUserLabels(kefuUid(c), c.req.param("uid"), await body(c));
  return jsonOk(c, null, "设置成功");
}

export async function userGroups(c: C) {
  return jsonOk(c, await core(c).userGroups());
}

export async function setUserGroup(c: C) {
  await core(c).setUserGroup(kefuUid(c), c.req.param("uid"), c.req.param("id"));
  return jsonOk(c, null, "设置成功");
}

export async function purchasedProducts(c: C) {
  return jsonOk(c, await products(c).purchasedProducts(
    kefuUid(c),
    c.req.param("uid"),
    c.req.query(),
  ));
}

export async function visitedProducts(c: C) {
  return jsonOk(c, await products(c).visitedProducts(
    kefuUid(c),
    c.req.param("uid"),
    c.req.query(),
  ));
}

export async function hotProducts(c: C) {
  return jsonOk(c, await products(c).hotProducts(
    kefuUid(c),
    c.req.param("uid"),
    c.req.query(),
  ));
}

export async function productInfo(c: C) {
  return jsonOk(c, await products(c).productInfo(c.req.param("id")));
}

export async function customerOrders(c: C) {
  return jsonOk(c, await orders(c).customerOrders(
    kefuUid(c),
    c.req.param("uid"),
    c.req.query(),
  ));
}

export async function orderInfo(c: C) {
  return jsonOk(c, await orders(c).orderInfo(kefuUid(c), c.req.param("id")));
}

export async function refundDetail(c: C) {
  return jsonOk(c, await orders(c).refundDetail(kefuUid(c), c.req.param("id")));
}

export async function refundList(c: C) {
  return jsonOk(c, await orders(c).refundList(kefuUid(c), c.req.query()));
}

export async function orderEditForm(c: C) {
  return jsonOk(c, await orderManagement(c).editForm(kefuUid(c), c.req.param("id")));
}

export async function updateOrder(c: C) {
  return jsonOk(c, await orderManagement(c).updateOrder(
    kefuUid(c),
    c.req.param("id"),
    await body(c),
  ), "修改成功");
}

export async function updateOrderRemark(c: C) {
  return jsonOk(c, await orderManagement(c).updateRemark(kefuUid(c), await body(c)), "备注成功");
}

export async function updateRefundRemark(c: C) {
  return jsonOk(c, await orderManagement(c).updateRefundRemark(
    kefuUid(c),
    c.req.param("id"),
    await body(c),
  ), "备注成功");
}

export async function orderRefundForm(c: C) {
  return jsonOk(c, await orderManagement(c).orderRefundForm(kefuUid(c), c.req.param("id")));
}

export async function refundForm(c: C) {
  return jsonOk(c, await orderManagement(c).refundForm(kefuUid(c), c.req.param("id")));
}

export async function agreeRefundReturn(c: C) {
  return jsonOk(
    c,
    await orderManagement(c).agreeReturn(kefuUid(c), c.req.param("id")),
    "已同意退货",
  );
}

export async function refundOrder(c: C) {
  const result = await orderManagement(c).refundOrder(
    kefuUid(c),
    c.req.param("id"),
    await body(c),
  );
  return jsonOk(c, result, result.completed ? "退款成功" : "退款已受理，等待渠道确认");
}

export async function expressList(c: C) {
  return jsonOk(c, await fulfillment(c).expressList(c.req.query()));
}

export async function deliveryAgents(c: C) {
  return jsonOk(c, await fulfillment(c).deliveryAgents(c.req.query()));
}

export async function deliveryConfig(c: C) {
  return jsonOk(c, await fulfillment(c).deliveryConfig());
}

export async function waybillTemplates(c: C) {
  return jsonOk(c, await fulfillment(c).waybillTemplates(c.req.query()));
}

export async function deliverOrder(c: C) {
  return jsonOk(c, await fulfillment(c).deliver(
    kefuUid(c),
    c.req.param("id"),
    await body(c),
  ), "发货成功");
}

export async function splitCartInfo(c: C) {
  return jsonOk(c, await fulfillment(c).splitCartInfo(kefuUid(c), c.req.param("id")));
}

export async function splitDelivery(c: C) {
  return jsonOk(c, await fulfillment(c).splitDelivery(
    kefuUid(c),
    c.req.param("id"),
    await body(c),
  ), "拆单发货成功");
}

export async function verifyOrder(c: C) {
  return jsonOk(c, await fulfillment(c).writeoffById(
    kefuId(c),
    kefuUid(c),
    c.req.param("id"),
  ), "核销成功");
}

export async function writeoffCartInfo(c: C) {
  return jsonOk(c, await fulfillment(c).writeoffCartInfo(
    kefuId(c),
    kefuUid(c),
    c.req.query("oid"),
  ));
}

export async function writeoffByPublicId(c: C) {
  return jsonOk(c, await fulfillment(c).writeoffByPublicId(
    kefuId(c),
    kefuUid(c),
    c.req.param("order_id"),
    await body(c),
  ), "核销成功");
}

export async function speechcraftList(c: C) {
  const ownerId = personalCatalog(c) ? kefuId(c) : 0;
  const result = await catalog(c).speechcraftList(ownerId, c.req.query());
  return jsonOk(c, result.list);
}

export async function speechcraftCategories(c: C) {
  const ownerId = personalCatalog(c) ? kefuId(c) : 0;
  return jsonOk(c, await catalog(c).speechcraftCategories(ownerId));
}

export async function createCategory(c: C) {
  return jsonOk(
    c,
    await catalog(c).saveSpeechcraftCategory(kefuId(c), 0, await body(c)),
    "添加成功",
  );
}

export async function updateCategory(c: C) {
  return jsonOk(
    c,
    await catalog(c).saveSpeechcraftCategory(
      kefuId(c),
      Number(c.req.param("id")),
      await body(c),
    ),
    "分类修改成功",
  );
}

export async function deleteCategory(c: C) {
  await catalog(c).deleteSpeechcraftCategory(kefuId(c), Number(c.req.param("id")));
  return jsonOk(c, null, "删除成功");
}

export async function createSpeechcraft(c: C) {
  return jsonOk(
    c,
    await catalog(c).saveSpeechcraft(kefuId(c), 0, await body(c)),
    "添加话术成功",
  );
}

export async function updateSpeechcraft(c: C) {
  return jsonOk(
    c,
    await catalog(c).saveSpeechcraft(
      kefuId(c),
      Number(c.req.param("id")),
      await body(c),
    ),
    "修改成功",
  );
}

export async function deleteSpeechcraft(c: C) {
  await catalog(c).deleteSpeechcraft(kefuId(c), Number(c.req.param("id")));
  return jsonOk(c, null, "删除成功");
}
