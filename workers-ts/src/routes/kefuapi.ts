import { Hono } from "hono";
import type { AppVariables, Env } from "@/env";
import * as KefuController from "@/controllers/kefu/KefuController";
import * as AttachmentController from "@/controllers/system/AttachmentController";
import { kefuAuthMiddleware } from "@/middleware/kefu-auth";

/** PHP-compatible dedicated customer-service security domain. */
export const kefuapiRoutes = new Hono<{
  Bindings: Env;
  Variables: AppVariables;
}>();

// Public bootstrap and login surfaces use separate, rate-limited security domains.
kefuapiRoutes.post("/login", KefuController.login);
kefuapiRoutes.get("/key", KefuController.loginKey);
kefuapiRoutes.get("/scan/:key", KefuController.scanLogin);
kefuapiRoutes.post("/oauth_state", KefuController.oauthState);
kefuapiRoutes.get("/wechat", KefuController.wechatLogin);
kefuapiRoutes.get("/config", KefuController.config);
kefuapiRoutes.get("/copyright", KefuController.copyright);
// Signed URLs cannot attach an Authorization header; signature verification is the access grant.
kefuapiRoutes.get("/assets/:id", AttachmentController.asset);

kefuapiRoutes.use("*", kefuAuthMiddleware);

kefuapiRoutes.get("/ws", KefuController.websocket);
kefuapiRoutes.post("/upload", AttachmentController.kefuUploadImage);
kefuapiRoutes.get("/erp/config", KefuController.erpConfig);

kefuapiRoutes.get("/user/record", KefuController.sessionList);
kefuapiRoutes.get("/user/info/:uid", KefuController.userInfo);
kefuapiRoutes.get("/user/label/:uid", KefuController.userLabels);
kefuapiRoutes.put("/user/label/:uid", KefuController.setUserLabels);
kefuapiRoutes.get("/user/group", KefuController.userGroups);
kefuapiRoutes.put("/user/group/:uid/:id", KefuController.setUserGroup);
kefuapiRoutes.post("/user/logout", KefuController.logout);

kefuapiRoutes.get("/product/hot/:uid", KefuController.hotProducts);
kefuapiRoutes.get("/product/visit/:uid", KefuController.visitedProducts);
kefuapiRoutes.get("/product/cart/:uid", KefuController.purchasedProducts);
kefuapiRoutes.get("/product/info/:id", KefuController.productInfo);

kefuapiRoutes.get("/order/list/:uid", KefuController.customerOrders);
kefuapiRoutes.get("/order/info/:id", KefuController.orderInfo);
kefuapiRoutes.get("/order/refund/detail/:id", KefuController.refundDetail);
kefuapiRoutes.post("/order/delivery/:id", KefuController.deliverOrder);
kefuapiRoutes.get("/order/edit/:id", KefuController.orderEditForm);
kefuapiRoutes.put("/order/update/:id", KefuController.updateOrder);
kefuapiRoutes.post("/order/remark", KefuController.updateOrderRemark);
kefuapiRoutes.get("/order/refund_form/:id", KefuController.orderRefundForm);
kefuapiRoutes.get("/order/export", KefuController.expressList);
kefuapiRoutes.get("/order/delivery_all", KefuController.deliveryAgents);
kefuapiRoutes.get("/order/delivery_info", KefuController.deliveryConfig);
kefuapiRoutes.get("/order/verific/:id", KefuController.verifyOrder);
kefuapiRoutes.get("/order/writeOff/cartInfo", KefuController.writeoffCartInfo);
kefuapiRoutes.put("/order/write_update/:order_id", KefuController.writeoffByPublicId);
kefuapiRoutes.get("/order/split_cart_info/:id", KefuController.splitCartInfo);
kefuapiRoutes.put("/order/split_delivery/:id", KefuController.splitDelivery);
kefuapiRoutes.get("/refund/list", KefuController.refundList);
kefuapiRoutes.post("/refund/remark/:id", KefuController.updateRefundRemark);
kefuapiRoutes.get("/refund/refund/:id", KefuController.refundForm);
kefuapiRoutes.put("/refund/agree/:id", KefuController.agreeRefundReturn);
kefuapiRoutes.put("/refund/refund/:id", KefuController.refundOrder);

kefuapiRoutes.get("/service/list", KefuController.serviceChat);
kefuapiRoutes.get("/service/info", KefuController.serviceInfo);
kefuapiRoutes.get("/service/transfer_list", KefuController.serviceList);
kefuapiRoutes.post("/service/transfer", KefuController.transfer);
kefuapiRoutes.get("/service/speechcraft", KefuController.speechcraftList);
kefuapiRoutes.get("/service/cate", KefuController.speechcraftCategories);
kefuapiRoutes.post("/service/cate", KefuController.createCategory);
kefuapiRoutes.put("/service/cate/:id", KefuController.updateCategory);
kefuapiRoutes.delete("/service/cate/:id", KefuController.deleteCategory);
kefuapiRoutes.post("/service/speechcraft", KefuController.createSpeechcraft);
kefuapiRoutes.put("/service/speechcraft/:id", KefuController.updateSpeechcraft);
kefuapiRoutes.delete("/service/speechcraft/:id", KefuController.deleteSpeechcraft);
