import { Hono } from "hono";
import { authMiddleware } from "@/middleware/auth";
import * as LotteryController from "@/controllers/api/v1/LotteryController";
import * as AgentLevelController from "@/controllers/api/v1/AgentLevelController";
import * as OrderController from "@/controllers/api/v1/OrderController";
import * as ProductController from "@/controllers/api/v1/ProductController";
import * as PublicController from "@/controllers/api/v1/PublicController";
import * as ReplyController from "@/controllers/api/v1/ReplyController";
import * as UserBehaviorController from "@/controllers/api/v1/UserBehaviorController";
import * as UserActivityController from "@/controllers/api/v1/UserActivityController";
import * as UserFinanceController from "@/controllers/api/v1/UserFinanceController";
import * as UserMessageController from "@/controllers/api/v1/UserMessageController";
import * as V2UserCompatibilityController from "@/controllers/api/v1/V2UserCompatibilityController";
import * as V2PromotionCompatibilityController from "@/controllers/api/v1/V2PromotionCompatibilityController";
import type { AppVariables, Env } from "@/env";

export const v2Routes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

v2Routes.get("/lottery/info/:factor?", authMiddleware({ force: true }), LotteryController.info);
v2Routes.post("/lottery", authMiddleware({ force: true }), LotteryController.draw);
v2Routes.post("/lottery/receive", authMiddleware({ force: true }), LotteryController.receive);
v2Routes.get("/lottery/record", authMiddleware({ force: true }), LotteryController.records);

// PHP v2 public DIY/configuration and imported-address compatibility contracts.
v2Routes.get("/diy/get_diy/:name?", PublicController.getDiyV2);
v2Routes.get("/bind_status", PublicController.bindPhoneStatusV2);
v2Routes.get("/diy/get_store_status", PublicController.storeStatusV2);
v2Routes.get("/diy/color_change/:name", PublicController.colorChangeV2);
v2Routes.get("/diy/product_detail", PublicController.productDetailDiyV2);
v2Routes.get("/cityList", PublicController.cityListV2);

// PHP v2 compact homepage and official-account follow status (optional authentication).
v2Routes.get("/index", authMiddleware({ force: false }), PublicController.indexV2);
v2Routes.get("/subscribe", authMiddleware({ force: false }), PublicController.subscribeV2);

// PHP v2 coupon catalogue/popups. These endpoints are read-only; newcomer issuance stayed disabled.
v2Routes.get("/new_coupon", authMiddleware({ force: true }), UserActivityController.couponNewV2);
v2Routes.get("/get_today_coupon", authMiddleware({ force: false }), UserActivityController.couponTodayV2);
v2Routes.get("/coupons", authMiddleware({ force: false }), UserActivityController.couponListV2);

// PHP v2 promotion product, gift and authenticated order-collection compatibility contracts.
v2Routes.get("/promotions/productList/:type", V2PromotionCompatibilityController.productList);
v2Routes.get("/promotions/give_info/:id", V2PromotionCompatibilityController.giveInfo);
v2Routes.get("/promotions/collect_order/product", authMiddleware({ force: true }), V2PromotionCompatibilityController.collectOrderProduct);

// PHP v2 user/search and customer-service contracts used by the legacy UniApp.
v2Routes.get("/user/search_list", authMiddleware({ force: false }), UserBehaviorController.searchList);
v2Routes.get("/user/clean_search", authMiddleware({ force: true }), UserBehaviorController.cleanSearch);
v2Routes.get("/user/service/record", authMiddleware({ force: true }), UserMessageController.customerServiceRecord);

// PHP v2 user profile, ledger and referral contracts used by the legacy UniApp.
v2Routes.post("/user/user_update", authMiddleware({ force: true }), V2UserCompatibilityController.updateRoutineProfile);
v2Routes.get("/user/wechat", authMiddleware({ force: true }), V2UserCompatibilityController.refreshWechatProfile);
v2Routes.get("/user/money_list/:type", authMiddleware({ force: true }), V2UserCompatibilityController.moneyList);
v2Routes.get("/agent/agent_user_list/:type", authMiddleware({ force: true }), V2UserCompatibilityController.agentUserList);
v2Routes.get("/agent/agent_info", authMiddleware({ force: true }), V2UserCompatibilityController.agentInfo);

// PHP v2 invoice endpoints. The mutating GET delete is retained only for client compatibility.
v2Routes.get("/invoice", authMiddleware({ force: true }), UserFinanceController.invoiceListV2);
v2Routes.get("/invoice/detail/:id", authMiddleware({ force: true }), UserFinanceController.invoiceDetail);
v2Routes.post("/invoice/save", authMiddleware({ force: true }), UserFinanceController.invoiceSaveV2);
v2Routes.post("/invoice/set_default/:id", authMiddleware({ force: true }), UserFinanceController.invoiceSetDefault);
v2Routes.get("/invoice/get_default/:type", authMiddleware({ force: true }), UserFinanceController.invoiceGetDefaultV2);
v2Routes.get("/invoice/del/:id", authMiddleware({ force: true }), UserFinanceController.invoiceDel);
v2Routes.post("/order/make_up_invoice", authMiddleware({ force: true }), OrderController.orderMakeUpInvoice);
v2Routes.get("/order/invoice_list", authMiddleware({ force: true }), OrderController.orderInvoiceList);
v2Routes.get("/order/invoice_detail/:uni", authMiddleware({ force: true }), OrderController.orderInvoiceDetail);

v2Routes.get("/agent/level_list", authMiddleware({ force: true }), AgentLevelController.levelList);
v2Routes.get("/agent/level_task_list", authMiddleware({ force: true }), AgentLevelController.levelTaskList);
v2Routes.get("/reply/list/:id", authMiddleware({ force: false }), ReplyController.replyList);

// PHP v2 shopping-cart and SKU-selection contracts used by the old UniApp.
v2Routes.post("/reset_cart", authMiddleware({ force: true }), OrderController.cartResetV2);
v2Routes.get("/cart_list", authMiddleware({ force: true }), OrderController.cartListV2);
v2Routes.get("/get_attr/:id/:type", authMiddleware({ force: true }), ProductController.getProductAttrV2);
v2Routes.post("/set_cart_num", authMiddleware({ force: true }), OrderController.cartSetNumV2);
