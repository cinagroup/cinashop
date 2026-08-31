/**
 * API v1 路由
 *
 * 对应 PHP route/api.php 的部分。
 * 命名与 PHP 路由保持一致, 方便前端无感切换。
 */
import { Hono } from "hono";
import { authMiddleware } from "@/middleware/auth";
import * as LoginController from "@/controllers/api/v1/LoginController";
import * as AppleAuthController from "@/controllers/api/v1/AppleAuthController";
import * as PublicController from "@/controllers/api/v1/PublicController";
import * as ProductController from "@/controllers/api/v1/ProductController";
import * as OrderController from "@/controllers/api/v1/OrderController";
import * as StoreOrderWriteoff from "@/controllers/api/v1/StoreOrderWriteoffController";
import * as StoreMobileDelivery from "@/controllers/api/v1/StoreMobileDeliveryController";
import * as StoreMobileOrder from "@/controllers/api/v1/StoreMobileOrderController";
import * as PayController from "@/controllers/api/v1/PayController";
import * as UserActivityController from "@/controllers/api/v1/UserActivityController";
import * as UserFinanceController from "@/controllers/api/v1/UserFinanceController";
import * as UserLevelController from "@/controllers/api/v1/UserLevelController";
import * as UserProfileController from "@/controllers/api/v1/UserProfileController";
import * as CommunityController from "@/controllers/api/v1/CommunityController";
import * as ActivityJoinController from "@/controllers/api/v1/ActivityJoinController";
import * as AdminLotteryController from "@/controllers/api/v1/AdminLotteryController";
import * as AdminWechatContentController from "@/controllers/api/v1/AdminWechatContentController";
import * as AdminWechatQrcodeController from "@/controllers/api/v1/AdminWechatQrcodeController";
import * as AdminLegacyRuntimeController from "@/controllers/api/v1/AdminLegacyRuntimeController";
import * as WechatLiveController from "@/controllers/api/v1/WechatLiveController";
import * as UserMessageController from "@/controllers/api/v1/UserMessageController";
import * as WechatController from "@/controllers/api/v1/WechatController";
import * as EnterpriseWechatController from "@/controllers/api/v1/EnterpriseWechatController";
import * as ReplyController from "@/controllers/api/v1/ReplyController";
import * as AdminController from "@/controllers/api/v1/AdminController";
import * as AdminCrud from "@/controllers/api/v1/AdminCrudController";
import * as AdminStore from "@/controllers/api/v1/AdminStoreController";
import * as AdminSupplierFinance from "@/controllers/api/v1/AdminSupplierFinanceController";
import * as AdminOrderOutbox from "@/controllers/api/v1/AdminOrderOutboxController";
import * as AdminNotification from "@/controllers/api/v1/AdminNotificationController";
import * as AdminDivision from "@/controllers/api/v1/AdminDivisionController";
import * as AdminCapitalFlow from "@/controllers/api/v1/AdminCapitalFlowController";
import * as DivisionController from "@/controllers/api/v1/DivisionController";
import * as AgentLevelController from "@/controllers/api/v1/AgentLevelController";
import * as ProductExperienceController from "@/controllers/api/v1/ProductExperienceController";
import * as CustomerServiceCatalogController from "@/controllers/api/v1/CustomerServiceCatalogController";
import * as PromoterApplicationController from "@/controllers/api/v1/PromoterApplicationController";
import * as SupplierApplicationController from "@/controllers/api/v1/SupplierApplicationController";
import * as UserBehaviorController from "@/controllers/api/v1/UserBehaviorController";
import * as NewcomerController from "@/controllers/api/v1/NewcomerController";
import * as ShortVideoController from "@/controllers/api/v1/ShortVideoController";
import * as DiyHomeController from "@/controllers/api/v1/DiyHomeController";
import * as PublicArticleController from "@/controllers/api/v1/PublicArticleController";
import * as MemberCardController from "@/controllers/api/v1/MemberCardController";
import * as PcCompatibilityController from "@/controllers/api/v1/PcCompatibilityController";
import * as PrintDocumentController from "@/controllers/system/PrintDocumentController";
import * as PrintJobController from "@/controllers/system/PrintJobController";
import * as WaybillJobController from "@/controllers/system/WaybillJobController";
import * as AttachmentController from "@/controllers/system/AttachmentController";
import { adminAuthMiddleware } from "@/middleware/admin-auth";
import { operationsAuthMiddleware } from "@/middleware/operations-auth";
import { stationOpenMiddleware } from "@/middleware/station-open";
import type { AppVariables, Env } from "@/env";

export const v1Routes = new Hono<{
  Bindings: Env;
  Variables: AppVariables & { container: import("@/lib/di").Container };
}>();

// ─── 登录类 (无需 auth) ───────────────────────────────────────
v1Routes.post("/login", LoginController.login);
v1Routes.post("/login/mobile", LoginController.mobile);
v1Routes.post("/verify_code", LoginController.verifyCode);
v1Routes.get("/verify_code", LoginController.legacyVerifyCode);
v1Routes.post("/verify_code/complete", LoginController.completeVerifyCode);
v1Routes.get("/verify_code/status", LoginController.verifyCodeStatus);
v1Routes.get("/turnstile/challenge", LoginController.turnstileChallenge);
v1Routes.get("/ajcaptcha", LoginController.ajcaptchaUnavailable);
v1Routes.post("/ajcheck", LoginController.ajcaptchaUnavailable);
v1Routes.get("/sms_captcha", LoginController.smsCaptchaUnavailable);
v1Routes.post("/register/verify", LoginController.requestCode);
v1Routes.post("/register", LoginController.register);
v1Routes.post("/register/reset", LoginController.reset);
v1Routes.post("/binding", LoginController.bindPendingSocialIdentity);
v1Routes.post("/apple_login/challenge", AppleAuthController.challenge);
v1Routes.post("/apple_login", AppleAuthController.login);
v1Routes.post("/user/change_password", authMiddleware({ force: true }), LoginController.changePassword);
v1Routes.post("/user/updatePhone", authMiddleware({ force: true }), LoginController.updatePhone);
v1Routes.post("/user/binding", authMiddleware({ force: true }), LoginController.bindPhone);

// ─── 旧 PC 商城登录面 ─────────────────────────────────────
v1Routes.get("/pc/key", PcCompatibilityController.key);
v1Routes.post("/pc/key", PcCompatibilityController.key);
v1Routes.get("/pc/scan/:key", PcCompatibilityController.scan);
v1Routes.get("/pc/get_appid", PcCompatibilityController.getAppid);
v1Routes.post("/pc/oauth_state", PcCompatibilityController.oauthState);
v1Routes.get("/pc/wechat_auth", PcCompatibilityController.wechatAuth);

// ─── 无需授权接口 ─────────────────────────────────────────────
v1Routes.get("/site_config", PublicController.getSiteConfig);
v1Routes.get("/get_copyright", PublicController.getCopyright);
v1Routes.get("/search/hot_keyword", PublicController.hotKeywords);
v1Routes.get("/search/keyword", PublicController.searchWords);
v1Routes.get("/user_agreement/:type", PublicController.getUserAgreement);
v1Routes.get("/agreement/:type", PublicController.getUserAgreement);
v1Routes.get("/get_open_adv", PublicController.getOpenAdv);
v1Routes.get("/navigation", PublicController.navigation);
v1Routes.get("/navigation/:template_name", PublicController.navigation);
v1Routes.get("/user/service/get_adv", authMiddleware({ force: false }), PublicController.getKfAdv);
v1Routes.get("/kefu/tourist/adv", PublicController.getKfAdv);
v1Routes.get("/assets/:id", AttachmentController.asset);

// ─── 旧 UniApp DIY 首页组件 ─────────────────────────────────
// StationOpen must run before optional auth, matching the outer PHP route group.
v1Routes.get("/diy/get_diy/:id?", stationOpenMiddleware(), DiyHomeController.getDiy);
v1Routes.get("/diy/diy_version/:id?", stationOpenMiddleware(), DiyHomeController.diyVersion);
v1Routes.get(
  "/diy/user_info",
  stationOpenMiddleware(),
  authMiddleware({ force: false }),
  DiyHomeController.userInfo,
);
v1Routes.get(
  "/diy/video_list",
  stationOpenMiddleware(),
  authMiddleware({ force: false }),
  DiyHomeController.videoList,
);
v1Routes.get(
  "/diy/newcomer_list",
  stationOpenMiddleware(),
  authMiddleware({ force: false }),
  DiyHomeController.newcomerList,
);
v1Routes.get(
  "/diy/product_rank",
  stationOpenMiddleware(),
  authMiddleware({ force: false }),
  DiyHomeController.productRank,
);
v1Routes.get(
  "/diy/sign",
  stationOpenMiddleware(),
  authMiddleware({ force: false }),
  DiyHomeController.sign,
);
v1Routes.get(
  "/diy/get_suspended",
  stationOpenMiddleware(),
  authMiddleware({ force: false }),
  DiyHomeController.suspended,
);

// ─── 旧 UniApp 公共文章 ─────────────────────────────────────
// All seven PHP routes live in the same StationOpen + optional-auth group.
v1Routes.get(
  "/article/category/list",
  stationOpenMiddleware(),
  authMiddleware({ force: false }),
  PublicArticleController.categoryList,
);
v1Routes.get(
  "/article/list/:cid",
  stationOpenMiddleware(),
  authMiddleware({ force: false }),
  PublicArticleController.articleList,
);
v1Routes.get(
  "/article/like/:id",
  stationOpenMiddleware(),
  authMiddleware({ force: false }),
  PublicArticleController.articleLike,
);
v1Routes.get(
  "/article/details/:id",
  stationOpenMiddleware(),
  authMiddleware({ force: false }),
  PublicArticleController.articleDetails,
);
v1Routes.get(
  "/article/hot/list",
  stationOpenMiddleware(),
  authMiddleware({ force: false }),
  PublicArticleController.hotList,
);
v1Routes.get(
  "/article/new/list",
  stationOpenMiddleware(),
  authMiddleware({ force: false }),
  PublicArticleController.newList,
);
v1Routes.get(
  "/article/banner/list",
  stationOpenMiddleware(),
  authMiddleware({ force: false }),
  PublicArticleController.bannerList,
);

// ─── 旧 PC 商城公共/可选登录面 ────────────────────────────────
v1Routes.get("/pc/get_pay_vip_code", authMiddleware({ force: false }), PcCompatibilityController.getPayVipCode);
v1Routes.get("/pc/get_product_phone_buy", authMiddleware({ force: false }), PcCompatibilityController.getProductPhoneBuy);
v1Routes.get("/pc/get_banner", authMiddleware({ force: false }), PcCompatibilityController.getBanner);
v1Routes.get("/pc/get_category_product", authMiddleware({ force: false }), PcCompatibilityController.getCategoryProduct);
v1Routes.get("/pc/get_products", authMiddleware({ force: false }), PcCompatibilityController.getProducts);
v1Routes.get("/pc/get_product_code/:product_id", authMiddleware({ force: false }), PcCompatibilityController.getProductCode);
v1Routes.get("/pc/get_city/:pid", authMiddleware({ force: false }), PcCompatibilityController.getCity);
v1Routes.get("/pc/check_order_status/:order_id/:end_time", authMiddleware({ force: false }), PcCompatibilityController.checkOrderStatus);
v1Routes.get("/pc/get_company_info", authMiddleware({ force: false }), PcCompatibilityController.getCompanyInfo);
v1Routes.get("/pc/get_recommend/:type", authMiddleware({ force: false }), PcCompatibilityController.getRecommend);
v1Routes.get("/pc/get_wechat_qrcode", authMiddleware({ force: false }), PcCompatibilityController.getWechatQrcode);
v1Routes.get("/pc/get_good_product", authMiddleware({ force: false }), PcCompatibilityController.getGoodProduct);

// ─── 商品域 (可选登录, 对应 PHP AuthTokenMiddleware force=false) ──
// 无需登录浏览, 带 token 时返回收藏状态等
v1Routes.get("/index", authMiddleware({ force: false }), PublicController.index);
v1Routes.get("/subscribe", authMiddleware({ force: false }), PublicController.subscribe);
v1Routes.get("/menu/user", authMiddleware({ force: false }), PublicController.menuUser);
v1Routes.get("/menu/date", authMiddleware({ force: false }), PublicController.menuUserData);
v1Routes.get("/user/activity", authMiddleware({ force: false }), UserProfileController.activity);
v1Routes.get("/category", authMiddleware({ force: false }), ProductController.category);
v1Routes.get("/category_version", ProductController.categoryVersion);
v1Routes.get("/level_category", ProductController.levelCategory);
v1Routes.get("/products", authMiddleware({ force: false }), ProductController.lst);
v1Routes.get("/presale/list", authMiddleware({ force: false }), ProductController.presaleList);
v1Routes.get("/search/recommend/:type", authMiddleware({ force: false }), ProductController.searchRecommend);
v1Routes.get("/search/filter", authMiddleware({ force: false }), ProductController.searchFilter);
v1Routes.get("/brand", authMiddleware({ force: false }), ProductController.brand);
v1Routes.get("/product/rank/category", authMiddleware({ force: false }), ProductController.rankCategory);
v1Routes.get("/product/rank/:type", authMiddleware({ force: false }), ProductController.rankList);
v1Routes.get("/product/detail/recommend/:id", authMiddleware({ force: false }), ProductController.detailRecommend);
v1Routes.get("/product/detail/activity/:id", authMiddleware({ force: false }), ProductController.detailActivity);
v1Routes.get("/product/detail_content/:id", authMiddleware({ force: false }), ProductController.detailContent);
v1Routes.get("/groom/list/:type", authMiddleware({ force: false }), ProductController.groomList);
v1Routes.get("/product/hot", authMiddleware({ force: false }), ProductController.productHot);
v1Routes.get("/product/detail/:id/:type", authMiddleware({ force: false }), ProductController.detail);
v1Routes.get("/product/detail/:id", authMiddleware({ force: false }), ProductController.detail);
v1Routes.get(
  "/newcomer/product_list",
  authMiddleware({ force: false }),
  NewcomerController.productList,
);
v1Routes.get(
  "/marketing/newcomer/product_list",
  authMiddleware({ force: false }),
  NewcomerController.productList,
);
v1Routes.get(
  "/newcomer/product_detail/:id",
  authMiddleware({ force: false }),
  NewcomerController.productDetail,
);
v1Routes.get(
  "/marketing/newcomer/product_detail/:id",
  authMiddleware({ force: false }),
  NewcomerController.productDetail,
);
v1Routes.get(
  "/store_discounts/list/:product_id",
  authMiddleware({ force: false }),
  UserActivityController.discountList,
);

// ─── 需授权接口 ────────────────────────────────────────────────
v1Routes.get("/pc/get_cart_list", authMiddleware({ force: true }), PcCompatibilityController.getCartList);
v1Routes.get("/pc/get_balance_record/:type", authMiddleware({ force: true }), PcCompatibilityController.getBalanceRecord);
v1Routes.get("/pc/get_order_list", authMiddleware({ force: true }), PcCompatibilityController.getOrderList);
v1Routes.get("/pc/get_collect_list", authMiddleware({ force: true }), PcCompatibilityController.getCollectList);
v1Routes.post("/pc/order/refund/cart_info", authMiddleware({ force: true }), PcCompatibilityController.refundCartInfoList);
v1Routes.get("/pc/order/refund/list", authMiddleware({ force: true }), PcCompatibilityController.refundList);

v1Routes.get("/logout", authMiddleware({ force: true }), LoginController.logout);
v1Routes.get("/user/code", authMiddleware({ force: true }), UserProfileController.inspectLoginCode);
v1Routes.post("/user/code", authMiddleware({ force: true }), UserProfileController.approveLoginCode);
v1Routes.get("/newcomer/info", authMiddleware({ force: true }), NewcomerController.info);
v1Routes.get("/newcomer/gift", authMiddleware({ force: true }), NewcomerController.gift);
v1Routes.get("/marketing/newcomer/info", authMiddleware({ force: true }), NewcomerController.info);
v1Routes.get("/marketing/newcomer/gift", authMiddleware({ force: true }), NewcomerController.gift);

// ─── 短视频 (PHP activity/Video 兼容面) ─────────────────────
v1Routes.get("/marketing/short_video", authMiddleware({ force: false }), ShortVideoController.list);
v1Routes.get("/marketing/short_video/info/:id", authMiddleware({ force: false }), ShortVideoController.info);
v1Routes.get("/marketing/short_video/comment/:id", authMiddleware({ force: false }), ShortVideoController.comments);
v1Routes.get("/marketing/short_video/product/:id", authMiddleware({ force: false }), ShortVideoController.products);
v1Routes.post("/marketing/short_video/comment/:id/:pid", authMiddleware({ force: true }), ShortVideoController.saveComment);
v1Routes.get("/marketing/short_video/comment_reply/:pid", authMiddleware({ force: true }), ShortVideoController.commentReplies);
v1Routes.delete("/marketing/short_video/comment/:id", authMiddleware({ force: true }), ShortVideoController.deleteComment);
v1Routes.get("/marketing/short_video/comment/:type/:id", authMiddleware({ force: true }), ShortVideoController.commentRelation);
v1Routes.get("/marketing/short_video/:type/:id", authMiddleware({ force: true }), ShortVideoController.videoRelation);
v1Routes.get(
  "/user/member/card/index",
  authMiddleware({ force: true }),
  MemberCardController.index,
);
v1Routes.post(
  "/user/member/card/draw",
  authMiddleware({ force: true }),
  MemberCardController.draw,
);
v1Routes.post(
  "/user/member/card/create",
  authMiddleware({ force: true }),
  MemberCardController.createOrder,
);
v1Routes.post(
  "/user/member/card/pay",
  authMiddleware({ force: true }),
  MemberCardController.payOrder,
);
v1Routes.get(
  "/user/member/coupons/list",
  authMiddleware({ force: true }),
  MemberCardController.memberCouponList,
);
v1Routes.get(
  "/user/member/overdue/time",
  authMiddleware({ force: true }),
  MemberCardController.overdueTime,
);
v1Routes.get(
  "/user/search_list",
  authMiddleware({ force: true }),
  UserBehaviorController.searchList,
);
// Keep the PHP GET alias for existing clients and provide POST for new clients.
v1Routes.get(
  "/user/clean_search",
  authMiddleware({ force: true }),
  UserBehaviorController.cleanSearch,
);
v1Routes.post(
  "/user/clean_search",
  authMiddleware({ force: true }),
  UserBehaviorController.cleanSearch,
);
v1Routes.post(
  "/user/set_visit",
  authMiddleware({ force: true }),
  UserBehaviorController.setVisit,
);
v1Routes.get("/agent/level_list", authMiddleware({ force: true }), AgentLevelController.levelList);
v1Routes.get(
  "/agent/level_task_list",
  authMiddleware({ force: true }),
  AgentLevelController.levelTaskList,
);

// ─── 购物车 (M3) ───────────────────────────────────────────────
v1Routes.post("/cart/add", authMiddleware({ force: true }), OrderController.cartAdd);
v1Routes.get("/cart/list", authMiddleware({ force: true }), OrderController.cartList);
v1Routes.post("/cart/num", authMiddleware({ force: true }), OrderController.cartNum);
v1Routes.post("/cart/del", authMiddleware({ force: true }), OrderController.cartDel);
v1Routes.get("/cart/count", authMiddleware({ force: true }), OrderController.cartCount);
v1Routes.post(
  "/order/first_order_quote",
  authMiddleware({ force: true }),
  OrderController.orderFirstOrderQuote,
);
v1Routes.get("/store/list", stationOpenMiddleware(), StoreOrderWriteoff.publicPickupStores);
v1Routes.get("/store/category", stationOpenMiddleware(), ProductController.category);
v1Routes.get(
  "/store/delivery/info",
  stationOpenMiddleware(),
  authMiddleware({ force: true }),
  StoreMobileDelivery.info,
);
v1Routes.get(
  "/store/delivery/statistics",
  stationOpenMiddleware(),
  authMiddleware({ force: true }),
  StoreMobileDelivery.statistics,
);
v1Routes.get(
  "/store/delivery/data",
  stationOpenMiddleware(),
  authMiddleware({ force: true }),
  StoreMobileDelivery.data,
);
v1Routes.get(
  "/store/delivery/order",
  stationOpenMiddleware(),
  authMiddleware({ force: true }),
  StoreMobileDelivery.orderList,
);
v1Routes.get(
  "/store/delivery/list",
  stationOpenMiddleware(),
  authMiddleware({ force: true }),
  StoreMobileDelivery.deliveryList,
);
v1Routes.get(
  "/store/refund/detail/:id",
  stationOpenMiddleware(),
  authMiddleware({ force: true }),
  StoreMobileOrder.refundDetail,
);
v1Routes.get(
  "/store/order/detail/:id",
  stationOpenMiddleware(),
  authMiddleware({ force: true }),
  StoreMobileOrder.orderDetail,
);
v1Routes.get(
  "/store/order/writeoff_info/:type",
  stationOpenMiddleware(),
  authMiddleware({ force: true }),
  StoreMobileOrder.writeoffInfo,
);
v1Routes.post(
  "/store/order/cart_info",
  stationOpenMiddleware(),
  authMiddleware({ force: true }),
  StoreMobileOrder.cartInfo,
);
v1Routes.get(
  "/store/order/delivery_info/:orderId",
  stationOpenMiddleware(),
  authMiddleware({ force: true }),
  StoreMobileOrder.deliveryInfo,
);
v1Routes.put(
  "/store/order/split_delivery/:id",
  stationOpenMiddleware(),
  authMiddleware({ force: true }),
  StoreMobileOrder.splitDelivery,
);
v1Routes.get(
  "/store/operator/profile",
  authMiddleware({ force: true }),
  StoreOrderWriteoff.operatorProfile,
);
v1Routes.post(
  "/store/order/writeoff_info",
  authMiddleware({ force: true }),
  StoreOrderWriteoff.staffInfo,
);
v1Routes.post(
  "/store/order/writeoff",
  authMiddleware({ force: true }),
  StoreOrderWriteoff.staffExecute,
);
v1Routes.post(
  "/delivery/order/writeoff_info",
  authMiddleware({ force: true }),
  StoreOrderWriteoff.deliveryInfo,
);
v1Routes.post(
  "/delivery/order/writeoff",
  authMiddleware({ force: true }),
  StoreOrderWriteoff.deliveryExecute,
);

// ─── 订单 (M3) ─────────────────────────────────────────────────
v1Routes.post("/order/create/:key", authMiddleware({ force: true }), OrderController.orderCreate);
v1Routes.post("/order/check_shipping", authMiddleware({ force: true }), OrderController.orderCheckShipping);
v1Routes.post("/order/confirm", authMiddleware({ force: true }), OrderController.orderConfirm);
v1Routes.post("/order/computed/:key", authMiddleware({ force: true }), OrderController.orderComputed);
v1Routes.get("/order/data", authMiddleware({ force: true }), OrderController.orderData);
v1Routes.post("/order/prize/:orderId", authMiddleware({ force: true }), OrderController.orderPrize);
v1Routes.get("/order/write/records/:id", authMiddleware({ force: true }), OrderController.orderWriteoffRecords);
v1Routes.post("/order/product", authMiddleware({ force: true }), OrderController.orderProduct);
v1Routes.get("/order/pay_cashier", authMiddleware({ force: true }), OrderController.orderPayCashier);
v1Routes.get("/order/system_form/:id", authMiddleware({ force: true }), OrderController.orderSystemForm);
v1Routes.get("/order/list", authMiddleware({ force: true }), OrderController.orderList);
v1Routes.get("/order/detail/:uni", authMiddleware({ force: true }), OrderController.orderDetail);
v1Routes.get(
  "/delivery_order/detail/:id",
  authMiddleware({ force: true }),
  OrderController.deliveryOrderDetail,
);
v1Routes.get("/order/invoice_list", authMiddleware({ force: true }), OrderController.orderInvoiceList);
v1Routes.get("/order/invoice_detail/:uni", authMiddleware({ force: true }), OrderController.orderInvoiceDetail);
v1Routes.post("/order/make_up_invoice", authMiddleware({ force: true }), OrderController.orderMakeUpInvoice);
// 订单操作 (补全)
v1Routes.post("/order/take", authMiddleware({ force: true }), OrderController.orderTake);
v1Routes.post("/order/cancel", authMiddleware({ force: true }), OrderController.orderCancel);
v1Routes.post("/order/del", authMiddleware({ force: true }), OrderController.orderDel);
v1Routes.post("/order/again", authMiddleware({ force: true }), OrderController.orderAgain);

// ─── 支付 (M4+M6) ──────────────────────────────────────────────
v1Routes.get("/order/cashier/:orderId", authMiddleware({ force: true }), PayController.orderCashier);
v1Routes.get(
  "/order/cashier/:orderId/:type",
  authMiddleware({ force: true }),
  PayController.orderCashier,
);
v1Routes.get("/payment/readiness", authMiddleware({ force: true }), PayController.paymentReadiness);
v1Routes.post("/order/pay", authMiddleware({ force: true }), PayController.orderPay);
v1Routes.post("/recharge/pay", authMiddleware({ force: true }), PayController.rechargePay);
// 支付回调 (无需 auth, 第三方调用)
// M6: 微信回调直连验签; 其他类型仍走 PHP 转发
v1Routes.all("/pay/notify/wechat", WechatController.wechatPayNotify);
v1Routes.post("/pay/notify/wechat/refund", WechatController.wechatRefundNotify);
v1Routes.post("/pay/notify/alipay", PayController.alipayNotify);
v1Routes.get("/ali_pay", PayController.aliPay);
// 微信 JSAPI 下单
v1Routes.post("/order/wechat_pay", authMiddleware({ force: true }), WechatController.wechatPayOrder);

// ─── 售后退款 (M4) ─────────────────────────────────────────────
v1Routes.post("/order/refund/apply/:id", authMiddleware({ force: true }), PayController.refundApply);
v1Routes.post("/order/refund/cancel/:uni", authMiddleware({ force: true }), PayController.refundCancel);
v1Routes.get("/order/refund/list", authMiddleware({ force: true }), PayController.refundList);
v1Routes.get("/order/refund/detail/:uni", authMiddleware({ force: true }), PayController.refundDetail);
v1Routes.get("/order/refund/reason", authMiddleware({ force: true }), OrderController.orderRefundReason);
v1Routes.get("/order/refund/cart_info/:id", authMiddleware({ force: true }), OrderController.orderRefundCartInfo);
v1Routes.post("/order/refund/cart_info", authMiddleware({ force: true }), OrderController.orderRefundCartInfoList);
v1Routes.post("/order/refund/verify", authMiddleware({ force: true }), PayController.refundVerify);
v1Routes.post("/order/refund/express", authMiddleware({ force: true }), PayController.refundExpress);
v1Routes.post("/order/refund/again/:id", authMiddleware({ force: true }), PayController.refundAgain);
v1Routes.get("/order/refund/del/:uni", authMiddleware({ force: true }), PayController.refundDelete);

// ─── 用户中心: 地址 (M5) ───────────────────────────────────────
v1Routes.get("/address/list", authMiddleware({ force: true }), UserActivityController.addressList);
v1Routes.get("/address/detail/:id", authMiddleware({ force: true }), UserActivityController.addressDetail);
v1Routes.get("/address/default", authMiddleware({ force: true }), UserActivityController.addressDefault);
v1Routes.post("/address/default/set", authMiddleware({ force: true }), UserActivityController.addressDefaultSet);
v1Routes.post("/address/edit", authMiddleware({ force: true }), UserActivityController.addressEdit);
v1Routes.post("/address/del", authMiddleware({ force: true }), UserActivityController.addressDel);

// ─── 用户中心: 收藏 (M5) ───────────────────────────────────────
v1Routes.post("/collect/add", authMiddleware({ force: true }), UserActivityController.collectAdd);
v1Routes.post("/collect/del", authMiddleware({ force: true }), UserActivityController.collectDel);
v1Routes.post("/collect/all", authMiddleware({ force: true }), UserActivityController.collectAll);
v1Routes.get("/collect/user", authMiddleware({ force: true }), UserActivityController.collectList);
v1Routes.get(
  "/user/visit_list",
  authMiddleware({ force: true }),
  ProductExperienceController.userVisitList,
);
v1Routes.delete(
  "/user/visit",
  authMiddleware({ force: true }),
  ProductExperienceController.userVisitDelete,
);

// ─── 用户中心: 签到 (M5) ───────────────────────────────────────
v1Routes.post("/sign/integral", authMiddleware({ force: true }), UserActivityController.signDo);
v1Routes.get("/sign/status", authMiddleware({ force: true }), UserActivityController.signStatus);
v1Routes.get("/sign/config", authMiddleware({ force: true }), UserActivityController.signConfig);
v1Routes.get("/sign/list", authMiddleware({ force: true }), UserActivityController.signList);
v1Routes.get("/sign/month", authMiddleware({ force: true }), UserActivityController.signMonth);
v1Routes.post("/sign/user", authMiddleware({ force: true }), UserActivityController.signUser);
v1Routes.get("/sign/remind/:status", authMiddleware({ force: true }), UserActivityController.signRemind);
v1Routes.get("/sign/calendar", authMiddleware({ force: true }), UserActivityController.signCalendar);

// ─── 分销/佣金/提现 (补全) ─────────────────────────────────────
v1Routes.post("/user/spread", authMiddleware({ force: true }), UserFinanceController.bindSpread);
v1Routes.get(
  "/user/promoter/apply/info",
  authMiddleware({ force: true }),
  PromoterApplicationController.applyInfo,
);
v1Routes.post(
  "/user/promoter/apply/:id",
  authMiddleware({ force: true }),
  PromoterApplicationController.applyPromoter,
);
v1Routes.get("/user/apply/record", authMiddleware({ force: true }), SupplierApplicationController.userList);
v1Routes.get("/user/apply/:id", authMiddleware({ force: true }), SupplierApplicationController.userDetail);
v1Routes.post("/user/apply/supplier/code", authMiddleware({ force: true }), SupplierApplicationController.requestCode);
v1Routes.post("/user/apply/supplier/:id", authMiddleware({ force: true }), SupplierApplicationController.submit);
v1Routes.post("/user/apply/activate/:id", authMiddleware({ force: true }), SupplierApplicationController.activate);
v1Routes.post("/upload/image", authMiddleware({ force: true }), AttachmentController.userUploadImage);
v1Routes.post("/assets/upload/image", authMiddleware({ force: true }), AttachmentController.userUploadImage);
v1Routes.get("/commission", authMiddleware({ force: true }), UserFinanceController.commission);
v1Routes.post("/spread/people", authMiddleware({ force: true }), UserFinanceController.spreadPeople);
v1Routes.get("/spread/commission/:type", authMiddleware({ force: true }), UserFinanceController.commissionList);
v1Routes.post("/extract/cash", authMiddleware({ force: true }), UserFinanceController.extractCash);
v1Routes.get("/user/extract/list", authMiddleware({ force: true }), UserFinanceController.extractList);
// 事业部代理申请与代理商员工关系。删除接口改用 DELETE/POST，拒绝沿用 PHP 的状态变更 GET。
v1Routes.get("/division/agent/apply/info", authMiddleware({ force: true }), DivisionController.applyInfo);
v1Routes.post("/division/agent/apply/:id", authMiddleware({ force: true }), DivisionController.applyAgent);
v1Routes.get("/division/agent/staff_list", authMiddleware({ force: true }), DivisionController.staffList);
v1Routes.post("/division/agent/staff_percent", authMiddleware({ force: true }), DivisionController.staffPercent);
v1Routes.delete("/division/agent/staff/:uid", authMiddleware({ force: true }), DivisionController.delStaff);
v1Routes.post("/division/agent/del_staff/:uid", authMiddleware({ force: true }), DivisionController.delStaff);
v1Routes.get("/division/agent/spread/code", authMiddleware({ force: true }), DivisionController.agentSpreadCode);
v1Routes.get("/division/agent/spread/code/image/:uid", DivisionController.agentSpreadCodeImage);
v1Routes.post("/division/agent/spread", authMiddleware({ force: true }), DivisionController.agentSpread);

// ─── 会员等级 (补全) ───────────────────────────────────────────
v1Routes.get("/user/level/grade", authMiddleware({ force: false }), UserLevelController.levelGrade);
v1Routes.get("/user/level/info", authMiddleware({ force: true }), UserLevelController.levelInfo);
v1Routes.get("/user/level/detection", authMiddleware({ force: true }), UserLevelController.levelDetection);
v1Routes.get("/user/level/activate_info", authMiddleware({ force: true }), UserLevelController.levelActivateInfo);
v1Routes.post("/user/level/activate", authMiddleware({ force: true }), UserLevelController.levelActivate);
v1Routes.get("/user/level/expList", authMiddleware({ force: true }), UserLevelController.levelExpList);

// ─── 社区 (补全) ───────────────────────────────────────────────
v1Routes.get("/community/config", CommunityController.communityConfig);
v1Routes.get("/community/topic", authMiddleware({ force: false }), CommunityController.communityTopic);
v1Routes.get("/community/list", authMiddleware({ force: false }), CommunityController.communityList);
v1Routes.get("/community/detail/:id", authMiddleware({ force: false }), CommunityController.communityDetail);
v1Routes.get("/community/product_list", authMiddleware({ force: false }), CommunityController.communityProductList);
v1Routes.get("/community/topic_count/:id", authMiddleware({ force: false }), CommunityController.communityTopicCount);
v1Routes.post("/community/like/:id", authMiddleware({ force: true }), CommunityController.communityLike);
v1Routes.post("/community_save", authMiddleware({ force: true }), CommunityController.communitySave);
v1Routes.get("/community/comment/list", authMiddleware({ force: false }), CommunityController.communityCommentList);
v1Routes.post("/community/comment/save", authMiddleware({ force: true }), CommunityController.communityCommentSave);
v1Routes.delete("/community_delete/:id", authMiddleware({ force: true }), CommunityController.communityDelete);
// PHP 路由保留 community 组内动作名；新前端仍可继续使用上面的短别名。
v1Routes.post("/community/community_like/:id", authMiddleware({ force: true }), CommunityController.communityLike);
v1Routes.post("/community/community_save", authMiddleware({ force: true }), CommunityController.communitySave);
v1Routes.post("/community/community_update/:id", authMiddleware({ force: true }), CommunityController.communityUpdate);
v1Routes.get("/community/like_list", authMiddleware({ force: true }), CommunityController.communityLikeList);
v1Routes.get("/community/elegant_list", authMiddleware({ force: true }), CommunityController.communityElegantList);
v1Routes.get("/community/share/:id", authMiddleware({ force: true }), CommunityController.communityShare);
v1Routes.post("/community/comment_like/:id", authMiddleware({ force: true }), CommunityController.communityCommentLike);
v1Routes.delete("/community/comment_delete/:id", authMiddleware({ force: true }), CommunityController.communityCommentDelete);
v1Routes.delete("/community/community_delete/:id", authMiddleware({ force: true }), CommunityController.communityDelete);
v1Routes.put("/community/browse/:id", authMiddleware({ force: false }), CommunityController.communityBrowse);
v1Routes.get(
  "/community/user_info/:authorUid",
  authMiddleware({ force: true }),
  CommunityController.communityUserInfo,
);
v1Routes.post(
  "/community/update_desc",
  authMiddleware({ force: true }),
  CommunityController.communityUpdateDesc,
);
v1Routes.post(
  "/community/set_interest/:authorUid",
  authMiddleware({ force: true }),
  CommunityController.communitySetInterest,
);
v1Routes.get(
  "/community/follow_list/:type",
  authMiddleware({ force: true }),
  CommunityController.communityFollowList,
);
v1Routes.get(
  "/community/user_friend",
  authMiddleware({ force: true }),
  CommunityController.communityUserFriend,
);
v1Routes.get(
  "/community/recommend_list",
  authMiddleware({ force: true }),
  CommunityController.communityRecommendList,
);
v1Routes.get(
  "/community/follow",
  authMiddleware({ force: true }),
  CommunityController.communityFollow,
);

// ─── 充值 (补全) ───────────────────────────────────────────────
v1Routes.post("/recharge/recharge", authMiddleware({ force: true }), UserMessageController.rechargeCreate);
v1Routes.get("/recharge/index", authMiddleware({ force: true }), UserMessageController.rechargeIndex);

// ─── 站内信 (补全) ─────────────────────────────────────────────
v1Routes.get("/user", authMiddleware({ force: true }), UserProfileController.personalHome);
v1Routes.get("/userinfo", authMiddleware({ force: true }), UserProfileController.userInfo);
v1Routes.get("/user/rand_code", authMiddleware({ force: true }), UserProfileController.randCode);
v1Routes.post("/user/share", authMiddleware({ force: true }), UserProfileController.userShare);
v1Routes.get("/user/share/words", authMiddleware({ force: true }), UserProfileController.shareWords);
v1Routes.get("/user/routine_code", authMiddleware({ force: true }), UserProfileController.routineCode);
v1Routes.get("/user/spread_info", authMiddleware({ force: true }), UserProfileController.spreadInfo);
v1Routes.get("/user/info", authMiddleware({ force: true }), UserMessageController.userInfo);
v1Routes.post("/user/edit", authMiddleware({ force: true }), UserMessageController.userEdit);
v1Routes.get("/service/chat_history", authMiddleware({ force: true }), UserMessageController.serviceChatHistory);
v1Routes.post("/service/send", authMiddleware({ force: true }), UserMessageController.serviceSend);
v1Routes.get("/user/service/list", authMiddleware({ force: false }), UserMessageController.customerServiceList);
v1Routes.get("/user/service/record", authMiddleware({ force: true }), UserMessageController.customerServiceRecord);
v1Routes.get(
  "/user/record",
  authMiddleware({ force: true }),
  UserMessageController.customerServiceConversationList,
);
v1Routes.post(
  "/user/service/feedback",
  authMiddleware({ force: true }),
  CustomerServiceCatalogController.submitFeedback,
);
v1Routes.get(
  "/user/service/feedback",
  authMiddleware({ force: true }),
  CustomerServiceCatalogController.feedbackInfo,
);
v1Routes.get("/user/message", authMiddleware({ force: true }), UserMessageController.messageList);
v1Routes.get("/user/message_system/list", authMiddleware({ force: true }), UserMessageController.messageList);
v1Routes.get("/user/message_system/detail/:id", authMiddleware({ force: true }), UserMessageController.messageDetail);

// ─── 发票 (补全) ───────────────────────────────────────────────
v1Routes.get("/invoice", authMiddleware({ force: true }), UserFinanceController.invoiceList);
v1Routes.post("/invoice/save", authMiddleware({ force: true }), UserFinanceController.invoiceSave);
v1Routes.delete("/invoice/del/:id", authMiddleware({ force: true }), UserFinanceController.invoiceDel);
v1Routes.post("/invoice/set_default/:id", authMiddleware({ force: true }), UserFinanceController.invoiceSetDefault);
v1Routes.get("/invoice/get_default/:type", authMiddleware({ force: true }), UserFinanceController.invoiceGetDefault);

// ─── 优惠券 (M5) ───────────────────────────────────────────────
v1Routes.get("/coupons", authMiddleware({ force: false }), UserActivityController.couponList);
v1Routes.post("/coupon/receive", authMiddleware({ force: true }), UserActivityController.couponReceive);
v1Routes.get("/coupons/user/:types", authMiddleware({ force: true }), UserActivityController.myCoupons);

// ─── 秒杀 (M5) ─────────────────────────────────────────────────
v1Routes.get("/seckill/index", authMiddleware({ force: false }), UserActivityController.seckillIndex);
v1Routes.get("/seckill/list/:time", authMiddleware({ force: false }), UserActivityController.seckillList);
v1Routes.get("/seckill/detail_code/:id", authMiddleware({ force: false }), ActivityJoinController.seckillDetailCode);
v1Routes.get("/seckill/code/:id", authMiddleware({ force: true }), ActivityJoinController.seckillCode);
v1Routes.get("/seckill/detail/:id/:time?", authMiddleware({ force: false }), UserActivityController.seckillDetail);

// ─── 拼团 (M5) ─────────────────────────────────────────────────
v1Routes.get("/combination/list", authMiddleware({ force: false }), UserActivityController.combinationList);
v1Routes.get("/combination/banner_list", authMiddleware({ force: false }), ActivityJoinController.combinationBanner);
v1Routes.get("/combination/detail_code/:id", authMiddleware({ force: false }), ActivityJoinController.combinationDetailCode);
v1Routes.get("/combination/code/:id", authMiddleware({ force: true }), ActivityJoinController.combinationCode);
v1Routes.get("/combination/poster_info/:id", authMiddleware({ force: true }), ActivityJoinController.combinationPosterInfo);
v1Routes.get("/combination/detail/:id", authMiddleware({ force: false }), UserActivityController.combinationDetail);

// ─── 砍价 (M5) ─────────────────────────────────────────────────
v1Routes.get("/bargain/list", authMiddleware({ force: false }), UserActivityController.bargainList);
v1Routes.get("/bargain/config", authMiddleware({ force: false }), ActivityJoinController.bargainConfig);
v1Routes.get("/bargain/poster_info/:bargainId", authMiddleware({ force: true }), ActivityJoinController.bargainPosterInfo);
v1Routes.get("/bargain/detail/:id", authMiddleware({ force: false }), UserActivityController.bargainDetail);

// ─── 活动参与 (拼团/砍价, 补全) ───────────────────────────────
v1Routes.get("/combination/pink/:id", authMiddleware({ force: false }), ActivityJoinController.pinkInfo);
v1Routes.get("/pink", authMiddleware({ force: false }), ActivityJoinController.pinkStats);
v1Routes.post("/combination/remove", authMiddleware({ force: true }), ActivityJoinController.removePink);
v1Routes.post("/bargain/start", authMiddleware({ force: true }), ActivityJoinController.startBargain);
v1Routes.post("/bargain/start/user", authMiddleware({ force: true }), ActivityJoinController.bargainStartUser);
v1Routes.post("/bargain/share", authMiddleware({ force: true }), ActivityJoinController.bargainShare);
v1Routes.post("/bargain/help", authMiddleware({ force: true }), ActivityJoinController.helpBargain);
v1Routes.post("/bargain/help/price", authMiddleware({ force: true }), ActivityJoinController.bargainHelpPrice);
v1Routes.post("/bargain/help/count", authMiddleware({ force: true }), ActivityJoinController.bargainHelpCount);
v1Routes.post("/bargain/help/list", authMiddleware({ force: true }), ActivityJoinController.bargainHelpList);
v1Routes.get("/bargain/user/list", authMiddleware({ force: true }), ActivityJoinController.myBargains);
v1Routes.post("/bargain/user/cancel", authMiddleware({ force: true }), ActivityJoinController.cancelBargain);

// ─── 积分商城 (M5) ─────────────────────────────────────────────
v1Routes.get("/store_integral/list", authMiddleware({ force: false }), UserActivityController.integralList);
v1Routes.get("/store_integral/detail/:id", authMiddleware({ force: false }), UserActivityController.integralDetail);
v1Routes.post("/store_integral/exchange/:id", authMiddleware({ force: true }), UserActivityController.integralExchange);
v1Routes.get("/store_integral/order/list", authMiddleware({ force: true }), OrderController.integralOrderList);
v1Routes.get("/store_integral/order/detail/:uni", authMiddleware({ force: true }), OrderController.integralOrderDetail);
v1Routes.post("/store_integral/order/del", authMiddleware({ force: true }), OrderController.integralOrderDel);

// ─── 商品评价 (M8) ─────────────────────────────────────────────
v1Routes.get("/reply/config/:productId", authMiddleware({ force: false }), ReplyController.replyConfig);
v1Routes.get("/reply/list/:productId", authMiddleware({ force: false }), ReplyController.replyList);
v1Routes.get("/reply/comment/:id", authMiddleware({ force: false }), ReplyController.commentList);
v1Routes.get("/reply/info/:id", authMiddleware({ force: true }), ReplyController.replyInfo);
v1Routes.post("/reply/comment/:id", authMiddleware({ force: true }), ReplyController.replyComment);
v1Routes.post("/reply/submit", authMiddleware({ force: true }), ReplyController.submitReply);
v1Routes.post("/reply/praise/:id", authMiddleware({ force: true }), ReplyController.praiseComment);
v1Routes.post("/reply/un_praise/:id", authMiddleware({ force: true }), ReplyController.unpraiseComment);
v1Routes.post("/reply/unpraise/:id", authMiddleware({ force: true }), ReplyController.unpraiseReply);
// PHP 兼容端点：旧商城提交评价与点赞路由可无感切换。
v1Routes.post("/order/comment", authMiddleware({ force: true }), ReplyController.submitReply);
v1Routes.post("/reply/reply_praise/:id", authMiddleware({ force: true }), ReplyController.praiseReply);
v1Routes.post(
  "/reply/un_reply_praise/:id",
  authMiddleware({ force: true }),
  ReplyController.unpraiseReply,
);

// ─── 物流查询 (M8) ─────────────────────────────────────────────
v1Routes.get("/order/express/:orderId", authMiddleware({ force: true }), OrderController.orderExpress);
// PHP `order/express/:uni/[:type]` 兼容路由，type=refund 时按退款单查询用户退回物流。
v1Routes.get("/order/express/:orderId/:type", authMiddleware({ force: true }), OrderController.orderExpress);

// ─── 开发运维端点 (调试环境 + X-Operations-Token 双重门禁) ────
v1Routes.post("/_debug", operationsAuthMiddleware, async (c) => {
  const hasRedis = !!c.env.UPSTASH_REDIS_URL && !!c.env.UPSTASH_REDIS_TOKEN;
  const { setTokenBucket, getTokenBucket } = await import("@/utils/cache");
  const testKey = "debug_test";
  const testBucket = { uid: 999, type: "api", token: "test", exp: 60 };
  let writeOk: boolean | string = false;
  let readOk: boolean | string = false;
  let readVal = null;
  try {
    writeOk = await setTokenBucket(testKey, testBucket, c.env);
  } catch (e) {
    writeOk = `error: ${e instanceof Error ? e.message : String(e)}`;
  }
  try {
    readVal = await getTokenBucket(testKey, c.env);
    readOk = !!readVal;
  } catch (e) {
    readOk = `error: ${e instanceof Error ? e.message : String(e)}`;
  }
  return c.json({
    hasRedis,
    writeOk,
    readOk,
    readBack: !!readVal,
  });
});

// ─── 迁移 + 种子数据 (开发用, 生产删除) ─────────────────────
// 支持 ?reset=1: 先 drop activity 表再重建 (修复表结构不一致)
v1Routes.post("/_migrate", operationsAuthMiddleware, async (c) => {
  const { sql } = await import("drizzle-orm");
  if (c.req.query("reset") === "1") {
    if (c.req.header("X-Confirm-Reset") !== "reset-activity-tables") {
      return c.json({ status: 400, msg: "缺少重置确认头", data: null }, 400);
    }
    const container = c.get("container");
    const dropTables = [
      "store_combination", "store_seckill", "store_seckill_time", "store_pink",
      "store_bargain", "store_integral", "store_coupon_issue", "store_coupon_user",
      "store_order_refund", "store_order_status",
    "user_invoice", "user_money", "user_recharge", "user_brokerage", "user_extract",
    ];
    const dropped: string[] = [];
    const dropErrors: string[] = [];
    for (const t of dropTables) {
      try {
        await container.db.execute(sql.raw(`DROP TABLE IF EXISTS "${t}" CASCADE`));
        dropped.push(t);
      } catch (e) {
        dropErrors.push(`${t}: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
      }
    }
    if (dropErrors.length > 0) {
      return c.json({ ok: false, dropped, errors: dropErrors }, 500);
    }
    // 同一请求内重建 (确保用当前代码建表)
    const { MigrationService } = await import("@/services/MigrationService");
    const svc = new MigrationService(container);
    const result = await svc.runAll();
    if (result.errors.length > 0) {
      return c.json({ ok: false, dropped, migrated: result.executed, errors: result.errors }, 500);
    }
    const adminProvisioned = await provisionInitialAdmin(container, c.env);
    return c.json({ ok: true, dropped, migrated: result.executed, adminProvisioned });
  }

  const { MigrationService } = await import("@/services/MigrationService");
  const svc = new MigrationService(c.get("container"));
  const result = await svc.runAll();
  if (result.errors.length > 0) {
    return c.json({ ok: false, migrated: result.executed, errors: result.errors }, 500);
  }
  const adminProvisioned = await provisionInitialAdmin(c.get("container"), c.env);

  // 诊断: 检查关键表是否存在
  const container = c.get("container");
  // 数据库连接诊断
  const dbInfo: string[] = [];
  try {
    const raw = await container.db.execute(sql.raw("SELECT current_database() AS db, current_schema() AS sch"));
    const arr = Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? [];
    dbInfo.push(`db=${(arr[0] as { db?: string })?.db ?? "?"} schema=${(arr[0] as { sch?: string })?.sch ?? "?"}`);
  } catch (e) {
    dbInfo.push(`ERR ${e instanceof Error ? e.message.slice(0, 80) : e}`);
  }
  const tables: string[] = [];
  for (const t of [
    "user", "system_config", "store_product", "store_cart", "store_order",
    "store_order_refund", "system_admin", "store_order_status",
    "user_invoice", "user_money", "user_recharge", "user_brokerage", "user_extract",
    "store_combination", "store_seckill", "store_coupon_issue", "store_bargain",
    "store_integral", "store_seckill_time", "store_pink",
  ]) {
    try {
      // to_regclass 不接受参数化, 用字符串拼接 (t 来自白名单)
      const raw = await container.db.execute(sql.raw(`SELECT to_regclass('${t}') AS tbl`));
      const arr = Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? [];
      const exists = (arr[0] as { tbl?: string } | undefined)?.tbl ?? null;
      tables.push(`${t}: ${exists ? "OK" : "MISSING"}`);
    } catch (e) {
      tables.push(`${t}: ERR ${e instanceof Error ? e.message.slice(0, 50) : e}`);
    }
  }
  return c.json({ ok: true, ...result, adminProvisioned, dbInfo, tables });
});

v1Routes.post("/_seed", operationsAuthMiddleware, async (c) => {
  if (String(c.env.NODE_ENV) !== "development") {
    return c.json({ status: 403, msg: "种子接口仅限本地开发环境", data: null }, 403);
  }
  const container = c.get("container");
  const { sql } = await import("drizzle-orm");
  const now = Math.floor(Date.now() / 1000);

  try {
    // 测试用户幂等 (M18 修复: 不 DELETE, UPDATE 保持 uid 稳定, 避免旧订单/地址对不上)
    const { md5 } = await import("@/utils/jwt");
    const upsertUser = async (account: string, nickname: string) => {
      await container.db.execute(sql`
        UPDATE "user" SET pwd = ${md5("password")}, nickname = ${nickname}, status = 1, is_del = 0,
          now_money = 1000.00, integral = 500, last_time = ${now}
        WHERE account = ${account}
      `);
      await container.db.execute(sql`
        INSERT INTO "user" ("account", "pwd", "nickname", "phone", "now_money", "integral", "status", "add_time", "last_time")
        SELECT ${account}, ${md5("password")}, ${nickname}, ${account}, 1000.00, 500, 1, ${now}, ${now}
        WHERE NOT EXISTS (SELECT 1 FROM "user" WHERE account = ${account})
      `);
    };
    await upsertUser("13800138000", "测试用户");
    await upsertUser("13900000002", "测试买家");
    // 重置买家推广关系 → 绑定到测试用户 (可重复执行验证佣金链路)
    await container.db.execute(sql`
      UPDATE "user" SET spread_uid = (SELECT uid FROM "user" WHERE account = '13800138000' LIMIT 1),
        spread_time = ${now}
      WHERE account = '13900000002'
    `);

    // 插入测试商品
    await container.db.execute(sql`
      INSERT INTO "store_product" ("store_name", "store_info", "image", "price", "ot_price", "stock", "sales", "ficti", "is_show", "is_verify", "is_del", "spec_type", "add_time", "cate_id", "keyword")
      VALUES ('测试商品A', '这是一个测试商品', 'https://via.placeholder.com/300', 99.90, 199.00, 100, 50, 200, 1, 1, 0, 0, ${now}, '1', '测试')
      ON CONFLICT DO NOTHING
    `);
    await container.db.execute(sql`
      INSERT INTO "store_product" ("store_name", "store_info", "image", "price", "ot_price", "stock", "sales", "ficti", "is_show", "is_verify", "is_del", "spec_type", "add_time", "cate_id", "keyword", "is_vip", "vip_price")
      VALUES ('会员专享商品B', '会员价商品', 'https://via.placeholder.com/300', 299.00, 399.00, 50, 30, 100, 1, 1, 0, 0, ${now}, '1', '会员', 1, 199.00)
      ON CONFLICT DO NOTHING
    `);

    // 插入 SKU (unique='sku00001')
    await container.db.execute(sql`
      INSERT INTO "store_product_attr_value" ("product_id", "suk", "stock", "sales", "price", "ot_price", "unique", "type")
      VALUES (1, '默认', 100, 50, 99.90, 199.00, 'sku00001', 0)
      ON CONFLICT DO NOTHING
    `);
    await container.db.execute(sql`
      INSERT INTO "store_product_attr_value" ("product_id", "suk", "stock", "sales", "price", "ot_price", "vip_price", "unique", "type")
      VALUES (2, '默认', 50, 30, 299.00, 399.00, 199.00, 'sku00002', 0)
      ON CONFLICT DO NOTHING
    `);

    // 插入分类 (幂等: 先清种子分类再插, cate_name 无唯一约束)
    // 结构: 6 个一级 + 14 个二级, 显式 id 避开既有数据
    const CATE_NAMES = [
      "电子产品", "服装", "食品生鲜", "美妆个护", "家居日用", "运动户外",
      "手机通讯", "电脑办公", "影音娱乐", "男装", "女装", "童装",
      "休闲零食", "粮油调味", "水果蔬菜", "面部护肤", "彩妆香水", "洗护用品",
      "厨房用品", "收纳整理", "床上用品", "运动服饰", "健身器材", "户外装备",
    ];
    await container.db.execute(
      sql`DELETE FROM store_product_category WHERE cate_name IN (${sql.join(CATE_NAMES.map((n) => sql`${n}`), sql`,`)})`,
    );
    // 分类图标用内联 SVG data URI (不依赖外部占位图服务)
    const CATE_PIC = (color: string) =>
      "data:image/svg+xml," +
      encodeURIComponent(
        `<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><rect width='120' height='120' rx='16' fill='#${color}'/></svg>`,
      );
    // 一级分类 id: 60-65; 二级 id: 70-83 (显式指定, 避免与序列冲突)
    await container.db.execute(sql`
      INSERT INTO "store_product_category" ("id", "pid", "cate_name", "level", "is_show", "sort", "pic", "add_time") VALUES
        (60, 0, '电子产品', 0, 1, 100, ${CATE_PIC("3a7afe")}, ${now}),
        (61, 0, '服装', 0, 1, 99, ${CATE_PIC("f56c6c")}, ${now}),
        (62, 0, '食品生鲜', 0, 1, 98, ${CATE_PIC("f7ba2a")}, ${now}),
        (63, 0, '美妆个护', 0, 1, 97, ${CATE_PIC("ec7dc5")}, ${now}),
        (64, 0, '家居日用', 0, 1, 96, ${CATE_PIC("67c23a")}, ${now}),
        (65, 0, '运动户外', 0, 1, 95, ${CATE_PIC("9261dc")}, ${now})
      ON CONFLICT DO NOTHING
    `);
    await container.db.execute(sql`
      INSERT INTO "store_product_category" ("id", "pid", "cate_name", "level", "is_show", "sort", "pic", "add_time") VALUES
        (70, 60, '手机通讯', 1, 1, 100, ${CATE_PIC("3a7afe")}, ${now}),
        (71, 60, '电脑办公', 1, 1, 99, ${CATE_PIC("3a7afe")}, ${now}),
        (72, 60, '影音娱乐', 1, 1, 98, ${CATE_PIC("3a7afe")}, ${now}),
        (73, 61, '男装', 1, 1, 100, ${CATE_PIC("f56c6c")}, ${now}),
        (74, 61, '女装', 1, 1, 99, ${CATE_PIC("f56c6c")}, ${now}),
        (75, 61, '童装', 1, 1, 98, ${CATE_PIC("f56c6c")}, ${now}),
        (76, 62, '休闲零食', 1, 1, 100, ${CATE_PIC("f7ba2a")}, ${now}),
        (77, 62, '粮油调味', 1, 1, 99, ${CATE_PIC("f7ba2a")}, ${now}),
        (78, 62, '水果蔬菜', 1, 1, 98, ${CATE_PIC("f7ba2a")}, ${now}),
        (79, 63, '面部护肤', 1, 1, 100, ${CATE_PIC("ec7dc5")}, ${now}),
        (80, 63, '彩妆香水', 1, 1, 99, ${CATE_PIC("ec7dc5")}, ${now}),
        (81, 63, '洗护用品', 1, 1, 98, ${CATE_PIC("ec7dc5")}, ${now}),
        (82, 64, '厨房用品', 1, 1, 100, ${CATE_PIC("67c23a")}, ${now}),
        (83, 64, '收纳整理', 1, 1, 99, ${CATE_PIC("67c23a")}, ${now}),
        (84, 64, '床上用品', 1, 1, 98, ${CATE_PIC("67c23a")}, ${now}),
        (85, 65, '运动服饰', 1, 1, 100, ${CATE_PIC("9261dc")}, ${now}),
        (86, 65, '健身器材', 1, 1, 99, ${CATE_PIC("9261dc")}, ${now}),
        (87, 65, '户外装备', 1, 1, 98, ${CATE_PIC("9261dc")}, ${now})
      ON CONFLICT DO NOTHING
    `);
    // 分类树缓存失效 (TTL 1h, 不失效则前端拿旧树)
    try {
      const { StoreCategoryService } = await import("@/services/product/StoreCategoryService");
      await new StoreCategoryService(container, c.env).invalidate();
    } catch {
      // 忽略: 缓存 1h 后自然过期
    }

    // 纯种子表幂等: 无唯一约束, ON CONFLICT 不生效, 先清再插
    await container.db.execute(
      sql`DELETE FROM system_user_level; DELETE FROM system_message; DELETE FROM store_product_words;
          DELETE FROM system_config WHERE menu_name IS NULL OR menu_name = '' OR menu_name IN ('site_name','site_logo','site_url','record_No','site_phone','share_info','sign_in_integral','sign_in_switch','auto_receive_day','auto_evaluate_day','sign_give_point','sign_status','system_delivery_time','system_comment_time');`,
    );

    // SKU 去重 (M18: 重复 seed 产生的同 unique 多行, 保留 id 最小)
    await container.db.execute(sql`
      DELETE FROM store_product_attr_value a USING store_product_attr_value b
      WHERE a.product_id = b.product_id AND a.unique = b.unique AND a.type = b.type AND a.id > b.id
    `);
    // 商品详情缓存失效 (600s TTL, 否则前端拿到旧 SKU)
    try {
      const { cacheDelete } = await import("@/utils/cache");
      await cacheDelete("product_info_1", c.env);
      await cacheDelete("product_info_2", c.env);
    } catch {
      // 忽略
    }

    // 插入基础配置 (Web 端 site_config 读取; system_config 无 add_time 列)
    await container.db.execute(sql`
      INSERT INTO "system_config" ("menu_name", "info", "value", "is_store", "type", "input_type", "sort", "status")
      VALUES
        ('site_name', '站点名称', 'CinaShop', 0, 'input', 'input', 100, 1),
        ('site_logo', '站点Logo', 'https://cinashop-pc.pages.dev/logo.png', 0, 'image', 'image', 99, 1),
        ('site_url', '站点地址', 'https://cinashop-pc.pages.dev', 0, 'input', 'input', 98, 1),
        ('record_No', '网站备案号', '京ICP备12345678号', 0, 'input', 'input', 97, 1),
        ('site_phone', '客服电话', '400-000-0000', 0, 'input', 'input', 96, 1),
        ('share_info', '分享描述', 'CinaShop 商城系统', 0, 'textarea', 'textarea', 95, 1),
        ('sign_in_integral', '签到基础积分', '1', 0, 'number', 'number', 90, 1),
        ('sign_in_switch', '签到开关', '1', 0, 'switch', 'switch', 89, 1),
        ('auto_receive_day', '自动收货天数', '7', 0, 'number', 'number', 88, 1),
        ('auto_evaluate_day', '自动评价天数', '7', 0, 'number', 'number', 87, 1)
    `);

    // 插入会员等级
    await container.db.execute(sql`
      INSERT INTO "system_user_level" ("name", "discount", "grade", "is_show", "exp_num", "add_time")
      VALUES ('白银会员', 95, 1, 1, 100, ${now}), ('黄金会员', 88, 2, 1, 500, ${now}), ('钻石会员', 70, 3, 1, 2000, ${now})
      ON CONFLICT DO NOTHING
    `);

    // 插入搜索热词
    await container.db.execute(sql`
      INSERT INTO "store_product_words" ("name", "is_show", "is_hot", "sort", "add_time")
      VALUES ('测试商品', 1, 1, 100, ${now}), ('手机', 1, 1, 99, ${now}), ('电脑', 1, 1, 98, ${now}), ('连衣裙', 1, 1, 97, ${now})
      ON CONFLICT DO NOTHING
    `);

    // 插入站内信
    await container.db.execute(sql`
      INSERT INTO "system_message" ("title", "content", "status", "add_time")
      VALUES ('欢迎使用 CinaShop', '感谢您选择我们, 祝您购物愉快!', 1, ${now})
      ON CONFLICT DO NOTHING
    `);

    // 砍价商品 upsert (M19: 保持活动 id 稳定)
    await container.db.execute(sql`
      UPDATE "store_bargain" SET product_id = 1, image = 'https://via.placeholder.com/300',
        price = 99.90, min_price = 59.90, quota = 100, quota_show = 100, stock = 100, people = 10, status = 1, sort = 90
      WHERE store_name = '砍价商品-测试商品A'
    `);
    await container.db.execute(sql`
      INSERT INTO "store_bargain" ("product_id", "store_name", "image", "price", "min_price", "quota", "quota_show", "stock", "sales", "people", "status", "sort", "add_time")
      SELECT 1, '砍价商品-测试商品A', 'https://via.placeholder.com/300', 99.90, 59.90, 100, 100, 100, 0, 10, 1, 90, ${now}
      WHERE NOT EXISTS (SELECT 1 FROM store_bargain WHERE store_name = '砍价商品-测试商品A')
    `);

    // 拼团商品 upsert (M19: 保持活动 id 稳定)
    await container.db.execute(sql`
      UPDATE "store_combination" SET product_id = 1, image = 'https://via.placeholder.com/300',
        price = 89.90, ot_price = 99.90, people = 2, quota = 100, quota_show = 100, stock = 100, status = 1, sort = 88
      WHERE store_name = '拼团商品-测试商品A'
    `);
    await container.db.execute(sql`
      INSERT INTO "store_combination" ("product_id", "store_name", "image", "price", "ot_price", "people", "quota", "quota_show", "stock", "sales", "status", "sort", "add_time")
      SELECT 1, '拼团商品-测试商品A', 'https://via.placeholder.com/300', 89.90, 99.90, 2, 100, 100, 100, 0, 1, 88, ${now}
      WHERE NOT EXISTS (SELECT 1 FROM store_combination WHERE store_name = '拼团商品-测试商品A')
    `);

    // 秒杀时间段 + 秒杀商品 (幂等, M17 补)
    await container.db.execute(
      sql`DELETE FROM store_seckill_time WHERE id IN (1,2,3)`,
    );
    await container.db.execute(sql`
      INSERT INTO "store_seckill_time" ("id", "start_time", "end_time", "status", "add_time")
      VALUES (1, '00:00', '11:59', 1, ${now}), (2, '12:00', '17:59', 1, ${now}), (3, '18:00', '23:59', 1, ${now})
      ON CONFLICT DO NOTHING
    `);
    // 秒杀商品 upsert (M19: 不 DELETE, 保持活动 id 稳定)
    await container.db.execute(sql`
      UPDATE "store_seckill" SET product_id = 1, time_id = '1,2,3', image = 'https://via.placeholder.com/300',
        price = 49.90, ot_price = 99.90, num = 2, quota = 100, quota_show = 100, stock = 100, status = 1, sort = 92
      WHERE store_name = '秒杀商品-测试商品A'
    `);
    await container.db.execute(sql`
      INSERT INTO "store_seckill" ("product_id", "time_id", "store_name", "image", "price", "ot_price", "num", "quota", "quota_show", "stock", "sales", "status", "sort", "add_time")
      SELECT 1, '1,2,3', '秒杀商品-测试商品A', 'https://via.placeholder.com/300', 49.90, 99.90, 2, 100, 100, 100, 0, 1, 92, ${now}
      WHERE NOT EXISTS (SELECT 1 FROM store_seckill WHERE store_name = '秒杀商品-测试商品A')
    `);

    // 积分商品 upsert (M19: 保持活动 id 稳定)
    await container.db.execute(sql`
      UPDATE "store_integral" SET product_id = 1, image = 'https://via.placeholder.com/300',
        integral = 300, price = 0.00, ot_price = 39.90, quota = 100, quota_show = 100, stock = 100, num = 1, status = 1, sort = 90
      WHERE store_name = '积分商品-保温杯'
    `);
    await container.db.execute(sql`
      INSERT INTO "store_integral" ("product_id", "store_name", "image", "integral", "price", "ot_price", "quota", "quota_show", "stock", "sales", "num", "status", "sort", "add_time")
      SELECT 1, '积分商品-保温杯', 'https://via.placeholder.com/300', 300, 0.00, 39.90, 100, 100, 100, 0, 1, 1, 90, ${now}
      WHERE NOT EXISTS (SELECT 1 FROM store_integral WHERE store_name = '积分商品-保温杯')
    `);

    // 秒杀诊断: 返回表中实际行数
    const seckillDiag: Record<string, unknown> = {};
    try {
      const t = await container.db.execute(sql`SELECT COUNT(*)::int AS c FROM store_seckill_time`);
      const s = await container.db.execute(sql`SELECT COUNT(*)::int AS c FROM store_seckill`);
      const arr = (x: unknown) => (Array.isArray(x) ? x : (x as { rows?: unknown[] })?.rows ?? []);
      seckillDiag.timeCount = (arr(t)[0] as { c?: number })?.c ?? -1;
      seckillDiag.seckillCount = (arr(s)[0] as { c?: number })?.c ?? -1;
    } catch (e) {
      seckillDiag.error = e instanceof Error ? e.message.slice(0, 120) : String(e);
    }
    return c.json({ ok: true, message: "种子数据插入成功", seckillDiag });

  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

async function provisionInitialAdmin(
  container: import("@/lib/di").Container,
  env: Env,
): Promise<boolean> {
  const password = env.INITIAL_ADMIN_PASSWORD;
  if (!password) return false;
  if (password.length < 12) {
    throw new Error("INITIAL_ADMIN_PASSWORD 必须至少 12 位");
  }

  const account = env.INITIAL_ADMIN_ACCOUNT?.trim() || "admin";
  if (account.length > 32) throw new Error("INITIAL_ADMIN_ACCOUNT 不能超过 32 位");
  if (await container.systemAdminDao.findByAccount(account)) return false;

  const { hash } = await import("bcryptjs");
  await container.systemAdminDao.save({
    account,
    pwd: await hash(password, 12),
    realName: "超级管理员",
    level: 0,
    status: 1,
    addTime: Math.floor(Date.now() / 1000),
  });
  return true;
}

// ─── 微信生态 (M6) ─────────────────────────────────────────────
// 小程序登录 (无需 auth)
v1Routes.post("/wechat/mp_auth", WechatController.mpAuth);
// 公众号 OAuth (无需 auth)
v1Routes.post("/wechat/oauth_state", WechatController.wechatOauthState);
v1Routes.get("/wechat/auth", WechatController.wechatAuth);
// JS-SDK 配置 (无需 auth)
v1Routes.get("/wechat/config", WechatController.wechatConfig);
// Enterprise WeChat JS-SDK signatures (public compatibility routes, strict URL allowlist).
v1Routes.get("/work/config", EnterpriseWechatController.config);
v1Routes.get("/work/agentConfig", EnterpriseWechatController.agentConfig);
v1Routes.all("/work/serve", EnterpriseWechatController.callbackServe);
v1Routes.post("/work/context/challenge", EnterpriseWechatController.contextChallenge);
v1Routes.post("/work/context/exchange", EnterpriseWechatController.contextExchange);
v1Routes.get("/work/groupInfo", EnterpriseWechatController.groupInfo);
v1Routes.get("/work/groupMember/:id", EnterpriseWechatController.groupMember);
v1Routes.get("/work/client/info", EnterpriseWechatController.clientInfo);
v1Routes.get("/work/order/list", EnterpriseWechatController.orderList);
v1Routes.get("/work/order/info/:id", EnterpriseWechatController.orderInfo);
v1Routes.get("/work/product/cart_list", EnterpriseWechatController.productCartList);
v1Routes.get("/work/product/visit_list", EnterpriseWechatController.productVisitList);
// Source-compatible mini-program live list and replay lookup.
v1Routes.get("/wechat/live", WechatLiveController.publicRooms);
v1Routes.get("/wechat/livePlaybacks/:id", WechatLiveController.publicPlaybacks);
// 小程序手机号绑定 (需 auth)
v1Routes.post("/wechat/auth_binding_phone", authMiddleware({ force: true }), WechatController.authBindingPhone);

// ─── 后续里程碑接入 ───────────────────────────────────────────
// M7+ 完整 admin CRUD (商品管理/订单管理/用户管理/系统配置等)

// ─── 管理后台 (M7 核心: 登录 + Dashboard + WebSocket 客服) ────
// 管理员登录 (无需 auth)
v1Routes.post("/admin/login", AdminController.adminLogin);
const adminAuth = adminAuthMiddleware();
// Dashboard + 通知 (需 admin token)
v1Routes.get("/admin/home/header", adminAuth, AdminController.adminHomeHeader);
v1Routes.get("/admin/home/order", adminAuth, AdminController.adminOrderChart);
v1Routes.get("/admin/home/user", adminAuth, AdminController.adminUserChart);
v1Routes.get("/admin/home/rank", adminAuth, AdminController.adminPurchaseRanking);
v1Routes.get("/admin/new_push", adminAuth, AdminController.adminNewPush);
v1Routes.get("/admin/erp/config", adminAuth, AdminController.adminErpConfig);
v1Routes.get("/admin/system/timer/task", adminAuth, AdminLegacyRuntimeController.timerTasks);
v1Routes.get("/admin/system/timer/index", adminAuth, AdminLegacyRuntimeController.timerList);
v1Routes.get("/admin/system/timer/one/:id", adminAuth, AdminLegacyRuntimeController.timerDetail);
v1Routes.get("/admin/queue/index", adminAuth, AdminLegacyRuntimeController.queueList);
v1Routes.get(
  "/admin/queue/delivery/log/:id/:type",
  adminAuth,
  AdminLegacyRuntimeController.queueDeliveryLog,
);
v1Routes.get("/admin/live/room/list", adminAuth, WechatLiveController.adminRooms);
v1Routes.get("/admin/live/goods/list", adminAuth, WechatLiveController.adminGoods);
v1Routes.get("/admin/live/anchor/list", adminAuth, WechatLiveController.adminAnchors);
v1Routes.post("/admin/live/sync", adminAuth, WechatLiveController.adminSync);
// 客服聊天记录 (需 admin token)
v1Routes.get("/admin/service/chat", adminAuth, AdminController.chatHistory);
v1Routes.post("/admin/service/send", adminAuth, AdminController.serviceReply);
v1Routes.get("/admin/service/sessions", adminAuth, AdminController.chatSessions);
v1Routes.get("/admin/feedback", adminAuth, CustomerServiceCatalogController.adminFeedbackList);
v1Routes.get("/admin/feedback/:id", adminAuth, CustomerServiceCatalogController.adminFeedbackDetail);
v1Routes.put("/admin/feedback/:id", adminAuth, CustomerServiceCatalogController.adminFeedbackUpdate);
v1Routes.delete("/admin/feedback/:id", adminAuth, CustomerServiceCatalogController.adminFeedbackDelete);
v1Routes.get("/admin/wechat/speechcraft", adminAuth, CustomerServiceCatalogController.adminSpeechcraftList);
v1Routes.get("/admin/wechat/speechcraft/categories", adminAuth, CustomerServiceCatalogController.adminSpeechcraftCategories);
v1Routes.post("/admin/wechat/speechcraft", adminAuth, CustomerServiceCatalogController.adminSpeechcraftCreate);
v1Routes.get("/admin/wechat/speechcraft/:id", adminAuth, CustomerServiceCatalogController.adminSpeechcraftDetail);
v1Routes.put("/admin/wechat/speechcraft/:id", adminAuth, CustomerServiceCatalogController.adminSpeechcraftUpdate);
v1Routes.delete("/admin/wechat/speechcraft/:id", adminAuth, CustomerServiceCatalogController.adminSpeechcraftDelete);
v1Routes.get("/admin/wechat/reply", adminAuth, AdminWechatContentController.reservedReply);
v1Routes.get("/admin/wechat/code_reply/:id", adminAuth, AdminWechatQrcodeController.replyCodeStatus);
v1Routes.post("/admin/wechat/code_reply/:id/provision", adminAuth, AdminWechatQrcodeController.provisionReplyCode);
v1Routes.get("/admin/wechat/keyword", adminAuth, AdminWechatContentController.replyList);
v1Routes.get("/admin/wechat/keyword/:id", adminAuth, AdminWechatContentController.replyDetail);
v1Routes.post("/admin/wechat/keyword/:id", adminAuth, AdminWechatContentController.saveReply);
v1Routes.delete("/admin/wechat/keyword/:id", adminAuth, AdminWechatContentController.deleteReply);
v1Routes.put(
  "/admin/wechat/keyword/set_status/:id/:status",
  adminAuth,
  AdminWechatContentController.setReplyStatus,
);
v1Routes.get("/admin/wechat/media", adminAuth, AdminWechatContentController.mediaList);
v1Routes.get("/admin/wechat/news", adminAuth, AdminWechatContentController.newsList);
v1Routes.get("/admin/wechat/news/:id", adminAuth, AdminWechatContentController.newsDetail);
v1Routes.post("/admin/wechat/news", adminAuth, AdminWechatContentController.saveNews);
v1Routes.delete("/admin/wechat/news/:id", adminAuth, AdminWechatContentController.deleteNews);
v1Routes.get("/admin/wechat/message", adminAuth, AdminWechatContentController.messageList);
v1Routes.get("/admin/wechat/message/operate", adminAuth, AdminWechatContentController.messageTypes);
v1Routes.post("/admin/wechat/push", adminAuth, AdminWechatContentController.pushUnavailable);
v1Routes.get("/admin/wechat_qrcode/cate/list", adminAuth, AdminWechatQrcodeController.categoryList);
v1Routes.get("/admin/wechat_qrcode/cate/create/:id", adminAuth, AdminWechatQrcodeController.categoryDetail);
v1Routes.post("/admin/wechat_qrcode/cate/save", adminAuth, AdminWechatQrcodeController.saveCategory);
v1Routes.delete("/admin/wechat_qrcode/cate/del/:id", adminAuth, AdminWechatQrcodeController.deleteCategory);
v1Routes.post("/admin/wechat_qrcode/save/:id", adminAuth, AdminWechatQrcodeController.saveChannel);
v1Routes.get("/admin/wechat_qrcode/info/:id", adminAuth, AdminWechatQrcodeController.channelDetail);
v1Routes.get("/admin/wechat_qrcode/list", adminAuth, AdminWechatQrcodeController.channelList);
v1Routes.delete("/admin/wechat_qrcode/del/:id", adminAuth, AdminWechatQrcodeController.deleteChannel);
v1Routes.put("/admin/wechat_qrcode/set_status/:id/:status", adminAuth, AdminWechatQrcodeController.setChannelStatus);
v1Routes.post("/admin/wechat_qrcode/provision/:id", adminAuth, AdminWechatQrcodeController.provisionChannel);
v1Routes.get("/admin/wechat_qrcode/user_list/:qid", adminAuth, AdminWechatQrcodeController.channelUsers);
v1Routes.get("/admin/wechat_qrcode/statistic/:qid", adminAuth, AdminWechatQrcodeController.channelStatistics);

// ─── Admin CRUD (M7+, 全部需 admin token) ────────────────────

// 商品管理
v1Routes.get("/admin/product/list", adminAuth, AdminCrud.adminProductList);
v1Routes.get("/admin/product/category", adminAuth, AdminCrud.adminMobileProductCategories);
v1Routes.get("/admin/product/admin_list", adminAuth, AdminCrud.adminMobileProductList);
v1Routes.post("/admin/product/set_show", adminAuth, AdminCrud.adminMobileProductSetShow);
v1Routes.get("/admin/product/product_label", adminAuth, AdminCrud.adminMobileProductLabels);
v1Routes.get("/admin/product/get_attr/:id", adminAuth, AdminCrud.adminMobileProductAttrs);
v1Routes.post("/admin/product/update_attrs/:id", adminAuth, AdminCrud.adminMobileProductUpdateAttrs);
v1Routes.post("/admin/product/batch_process", adminAuth, AdminCrud.adminMobileProductBatchProcess);
v1Routes.get("/admin/product/detail/:id", adminAuth, AdminCrud.adminProductDetail);
v1Routes.get("/admin/product/coupons/:id", adminAuth, AdminCrud.adminProductCoupons);
v1Routes.put("/admin/product/coupons/:id", adminAuth, AdminCrud.adminProductCouponsReplace);
v1Routes.post("/admin/product/create", adminAuth, AdminCrud.adminProductCreate);
v1Routes.post("/admin/product/update/:id", adminAuth, AdminCrud.adminProductUpdate);
v1Routes.post("/admin/product/set_show/:id", adminAuth, AdminCrud.adminProductSetShow);
v1Routes.delete("/admin/product/del/:id", adminAuth, AdminCrud.adminProductDel);
v1Routes.get("/admin/product/all_ensure", adminAuth, ProductExperienceController.adminEnsureAll);
v1Routes.get("/admin/product/ensure", adminAuth, ProductExperienceController.adminEnsureList);
v1Routes.post("/admin/product/ensure", adminAuth, ProductExperienceController.adminEnsureCreate);
v1Routes.put(
  "/admin/product/ensure/set_show/:id/:is_show",
  adminAuth,
  ProductExperienceController.adminEnsureStatus,
);
v1Routes.get("/admin/product/ensure/:id", adminAuth, ProductExperienceController.adminEnsureDetail);
v1Routes.put("/admin/product/ensure/:id", adminAuth, ProductExperienceController.adminEnsureUpdate);
v1Routes.delete("/admin/product/ensure/:id", adminAuth, ProductExperienceController.adminEnsureDelete);
v1Routes.get("/admin/get_all_unit", adminAuth, AdminCrud.adminProductUnitAll);
v1Routes.get("/admin/unit", adminAuth, AdminCrud.adminProductUnitList);
v1Routes.post("/admin/unit", adminAuth, AdminCrud.adminProductUnitSave);
v1Routes.get("/admin/unit/:id", adminAuth, AdminCrud.adminProductUnitDetail);
v1Routes.put("/admin/unit/:id", adminAuth, AdminCrud.adminProductUnitSave);
v1Routes.delete("/admin/unit/:id", adminAuth, AdminCrud.adminProductUnitDelete);
v1Routes.get("/admin/product/get_rule", adminAuth, AdminCrud.adminProductRuleTemplates);
v1Routes.get("/admin/product/rule", adminAuth, AdminCrud.adminProductRuleList);
v1Routes.post("/admin/product/rule/:id", adminAuth, AdminCrud.adminProductRuleSave);
v1Routes.get("/admin/product/rule/:id", adminAuth, AdminCrud.adminProductRuleDetail);
v1Routes.delete(
  "/admin/product/rule/delete/:id",
  adminAuth,
  AdminCrud.adminProductRuleDelete,
);
v1Routes.get("/admin/all_specs", adminAuth, AdminCrud.adminProductSpecsAll);
v1Routes.get("/admin/specs", adminAuth, AdminCrud.adminProductSpecsList);
v1Routes.get("/admin/specs/:id", adminAuth, AdminCrud.adminProductSpecsDetail);
v1Routes.post("/admin/specs/:id", adminAuth, AdminCrud.adminProductSpecsSave);
v1Routes.delete("/admin/specs/:id", adminAuth, AdminCrud.adminProductSpecsDelete);

// 订单管理
v1Routes.get("/admin/order/list", adminAuth, AdminCrud.adminOrderList);
v1Routes.get("/admin/order/detail/:orderId", adminAuth, AdminCrud.adminOrderDetail);
v1Routes.post("/admin/order/remark/:orderId", adminAuth, AdminCrud.adminOrderRemark);
v1Routes.post("/admin/order/print/:id", adminAuth, PrintJobController.adminManual);
v1Routes.post("/admin/order/waybill/:id", adminAuth, WaybillJobController.adminCreate);
v1Routes.get("/admin/order/delivery/index", adminAuth, AdminStore.deliveryList);
v1Routes.get("/admin/order/delivery/create", adminAuth, AdminStore.deliveryCandidates);
v1Routes.post("/admin/order/delivery/save", adminAuth, AdminStore.deliverySave);
v1Routes.get("/admin/order/delivery/:id/edit", adminAuth, AdminStore.deliveryDetail);
v1Routes.put("/admin/order/delivery/update/:id", adminAuth, AdminStore.deliveryUpdate);
v1Routes.delete("/admin/order/delivery/del/:id", adminAuth, AdminStore.deliveryDelete);
v1Routes.put(
  "/admin/order/delivery/set_status/:id/:status",
  adminAuth,
  AdminStore.deliveryStatus,
);
v1Routes.get("/admin/order/delivery/list", adminAuth, AdminStore.deliverySelectList);
v1Routes.post("/admin/order/delivery/:orderId", adminAuth, AdminCrud.adminOrderDelivery);
v1Routes.post("/admin/order/writeoff_info", adminAuth, StoreOrderWriteoff.adminInfo);
v1Routes.post("/admin/order/writeoff", adminAuth, StoreOrderWriteoff.adminExecute);
v1Routes.get("/admin/order/outbox", adminAuth, AdminOrderOutbox.orderOutboxList);
v1Routes.post("/admin/order/outbox/:id/replay", adminAuth, AdminOrderOutbox.orderOutboxReplay);
v1Routes.get(
  "/admin/order/outbox/dead-letter",
  adminAuth,
  AdminOrderOutbox.orderQueueDeadLetterList,
);
v1Routes.post(
  "/admin/order/outbox/dead-letter/:id/replay",
  adminAuth,
  AdminOrderOutbox.orderQueueDeadLetterReplay,
);
v1Routes.post(
  "/admin/order/outbox/dead-letter/:id/resolve",
  adminAuth,
  AdminOrderOutbox.orderQueueDeadLetterResolve,
);
v1Routes.get("/admin/integral/order/list", adminAuth, AdminCrud.adminIntegralOrderList);
v1Routes.get("/admin/integral/order/chart", adminAuth, AdminCrud.adminIntegralOrderChart);
v1Routes.get("/admin/merchant/store", adminAuth, AdminStore.storeList);
v1Routes.get("/admin/merchant/store/get_header", adminAuth, AdminStore.storeHeader);
v1Routes.get("/admin/merchant/store/get_info/:id", adminAuth, AdminStore.storeDetail);
v1Routes.put(
  "/admin/merchant/store/set_show/:id/:isShow",
  adminAuth,
  AdminStore.storeVisibility,
);
v1Routes.delete("/admin/merchant/store/del/:id", adminAuth, AdminStore.storeDelete);
v1Routes.post("/admin/merchant/store/:id", adminAuth, AdminStore.storeSave);
v1Routes.get("/admin/merchant/store_list", adminAuth, AdminStore.storeOptions);
v1Routes.get("/admin/merchant/store_staff", adminAuth, AdminStore.staffList);
v1Routes.get("/admin/merchant/store_staff/create", adminAuth, AdminStore.staffForm);
v1Routes.get("/admin/merchant/store_staff/:id/edit", adminAuth, AdminStore.staffForm);
v1Routes.post("/admin/merchant/store_staff/save/:id", adminAuth, AdminStore.staffSave);
v1Routes.put(
  "/admin/merchant/store_staff/set_show/:id/:status",
  adminAuth,
  AdminStore.staffStatus,
);
v1Routes.delete("/admin/merchant/store_staff/del/:id", adminAuth, AdminStore.staffDelete);

// 用户管理
v1Routes.get("/admin/user/list", adminAuth, AdminCrud.adminUserList);
v1Routes.get("/admin/user/label/:uid", adminAuth, AdminCrud.adminMobileUserLabels);
v1Routes.get("/admin/user/coupon/grant", adminAuth, AdminCrud.adminMobileUserCouponGrant);
v1Routes.get("/admin/user/group/list", adminAuth, AdminCrud.adminMobileUserGroups);
v1Routes.get("/admin/user/level/list", adminAuth, AdminCrud.adminMobileUserLevels);
v1Routes.post("/admin/user/update_other/:uid", adminAuth, AdminCrud.adminMobileUserUpdateOther);
v1Routes.post("/admin/user/update", adminAuth, AdminCrud.adminMobileUserUpdate);
v1Routes.get("/admin/user/address/list/:uid", adminAuth, AdminCrud.adminMobileUserAddresses);
v1Routes.get(
  "/admin/user/address/default/:uid",
  adminAuth,
  AdminCrud.adminMobileUserDefaultAddress,
);
v1Routes.get("/admin/user/info/:id", adminAuth, AdminCrud.adminUserInfo);
v1Routes.post("/admin/user/update/:id", adminAuth, AdminCrud.adminUserUpdate);
v1Routes.post("/admin/user/money/:id", adminAuth, AdminCrud.adminUserMoney);
v1Routes.get("/admin/user_group/list", adminAuth, AdminCrud.adminUserGroupList);
v1Routes.post("/admin/user_group/save", adminAuth, AdminCrud.adminUserGroupSave);
v1Routes.delete("/admin/user_group/del/:id", adminAuth, AdminCrud.adminUserGroupDelete);
v1Routes.get("/admin/label/:id", adminAuth, AdminCrud.adminUserLabels);
v1Routes.post("/admin/label/:id", adminAuth, AdminCrud.adminUserLabelsSet);
v1Routes.put("/admin/save_set_group", adminAuth, AdminCrud.adminUsersSetGroup);
v1Routes.put("/admin/save_set_label", adminAuth, AdminCrud.adminUsersSetLabel);

// 退款审核
v1Routes.get("/admin/refund/list", adminAuth, AdminCrud.adminRefundList);
v1Routes.get("/admin/refund/detail/:id", adminAuth, AdminCrud.adminRefundDetail);
v1Routes.get("/admin/refund_order/list", adminAuth, AdminCrud.adminRefundOrderList);
v1Routes.get("/admin/refund_order/detail/:uni", adminAuth, AdminCrud.adminRefundOrderDetail);
v1Routes.post("/admin/refund_order/remark", adminAuth, AdminCrud.adminRefundOrderRemark);
v1Routes.post("/admin/refund/agree/:id", adminAuth, AdminCrud.adminRefundAgree);
v1Routes.post("/admin/refund/refuse/:id", adminAuth, AdminCrud.adminRefundRefuse);

// 系统配置
v1Routes.get("/admin/config/list", adminAuth, AdminCrud.adminConfigList);
v1Routes.post("/admin/config/save", adminAuth, AdminCrud.adminConfigSave);
v1Routes.get("/admin/config/:menuName", adminAuth, AdminCrud.adminConfigGet);
v1Routes.get("/admin/config_class", adminAuth, AdminCrud.adminConfigTabList);
v1Routes.get("/admin/config_class/list", adminAuth, AdminCrud.adminConfigTabList);
v1Routes.post("/admin/config_class", adminAuth, AdminCrud.adminConfigTabSave);
v1Routes.put("/admin/config_class/:id", adminAuth, AdminCrud.adminConfigTabUpdate);
v1Routes.delete("/admin/config_class/:id", adminAuth, AdminCrud.adminConfigTabDelete);
v1Routes.put(
  "/admin/config_class/set_status/:id/:status",
  adminAuth,
  AdminCrud.adminConfigTabStatus,
);
v1Routes.get("/admin/form/index", adminAuth, AdminCrud.adminSystemFormList);
v1Routes.post("/admin/form/update_name/:id", adminAuth, AdminCrud.adminSystemFormRename);
v1Routes.post("/admin/form/save/:id", adminAuth, AdminCrud.adminSystemFormSave);
v1Routes.delete("/admin/form/del/:id", adminAuth, AdminCrud.adminSystemFormDelete);
v1Routes.get("/admin/form/set_show/:id/:is_show", adminAuth, AdminCrud.adminSystemFormStatus);
v1Routes.get("/admin/form/info/:id", adminAuth, AdminCrud.adminSystemFormInfo);
v1Routes.get("/admin/form/all_system_form", adminAuth, AdminCrud.adminSystemFormAll);
v1Routes.get("/admin/form/data/:id", adminAuth, AdminCrud.adminSystemFormData);
v1Routes.get("/admin/setting/sign/rewards", adminAuth, AdminCrud.adminSignRewardList);
v1Routes.get("/admin/setting/sign/add_rewards", adminAuth, AdminCrud.adminSignRewardAdd);
v1Routes.get("/admin/setting/sign/edit_rewards/:id", adminAuth, AdminCrud.adminSignRewardEdit);
v1Routes.post("/admin/setting/sign/save_rewards/:id", adminAuth, AdminCrud.adminSignRewardSave);
v1Routes.delete("/admin/setting/sign/del_rewards/:id", adminAuth, AdminCrud.adminSignRewardDelete);
v1Routes.get("/admin/agent/level_task", adminAuth, AdminCrud.adminAgentLevelTaskList);
v1Routes.get(
  "/admin/agent/level_task/create",
  adminAuth,
  AdminCrud.adminAgentLevelTaskCreateForm,
);
v1Routes.post("/admin/agent/level_task", adminAuth, AdminCrud.adminAgentLevelTaskCreate);
v1Routes.get(
  "/admin/agent/level_task/:id/edit",
  adminAuth,
  AdminCrud.adminAgentLevelTaskEditForm,
);
v1Routes.put("/admin/agent/level_task/:id", adminAuth, AdminCrud.adminAgentLevelTaskUpdate);
v1Routes.delete("/admin/agent/level_task/:id", adminAuth, AdminCrud.adminAgentLevelTaskDelete);
v1Routes.put(
  "/admin/agent/level_task/set_status/:id/:status",
  adminAuth,
  AdminCrud.adminAgentLevelTaskStatus,
);

// ─── Admin 分类管理 (M9) ─────────────────────────────────────
v1Routes.get("/admin/category/list", adminAuth, AdminCrud.adminCategoryList);
v1Routes.post("/admin/category/save", adminAuth, AdminCrud.adminCategorySave);
v1Routes.delete("/admin/category/del/:id", adminAuth, AdminCrud.adminCategoryDel);

// ─── Admin 优惠券管理 (M9) ───────────────────────────────────
v1Routes.get("/admin/coupon/list", adminAuth, AdminCrud.adminCouponList);
v1Routes.post("/admin/coupon/save", adminAuth, AdminCrud.adminCouponSave);
v1Routes.post("/admin/coupon/status/:id", adminAuth, AdminCrud.adminCouponStatus);
v1Routes.delete("/admin/coupon/del/:id", adminAuth, AdminCrud.adminCouponDel);

// ─── Admin 数据统计 (M9) ─────────────────────────────────────
v1Routes.get("/admin/statistic/overview", adminAuth, AdminController.adminStatisticOverview);
v1Routes.get("/admin/statistic/order/get_basic", adminAuth, AdminController.adminStatisticOrderBasic);
v1Routes.get("/admin/statistic/order/get_trend", adminAuth, AdminController.adminStatisticOrderTrend);
v1Routes.get("/admin/statistic/order/get_channel", adminAuth, AdminController.adminStatisticOrderChannel);
v1Routes.get("/admin/statistic/order/get_type", adminAuth, AdminController.adminStatisticOrderType);
v1Routes.get("/admin/statistic/product/get_basic", adminAuth, AdminController.adminStatisticProductBasic);
v1Routes.get("/admin/statistic/product/get_trend", adminAuth, AdminController.adminStatisticProductTrend);
v1Routes.get("/admin/statistic/product/get_product_ranking", adminAuth, AdminController.adminStatisticProductRanking);
v1Routes.get("/admin/statistic/product/get_excel", adminAuth, AdminController.adminStatisticProductExport);
v1Routes.get("/admin/statistic/user/get_basic", adminAuth, AdminController.adminStatisticUserBasic);
v1Routes.get("/admin/statistic/user/get_trend", adminAuth, AdminController.adminStatisticUserTrend);
v1Routes.get("/admin/statistic/user/get_wechat", adminAuth, AdminController.adminStatisticUserWechat);
v1Routes.get("/admin/statistic/user/get_wechat_trend", adminAuth, AdminController.adminStatisticUserWechatTrend);
v1Routes.get("/admin/statistic/user/get_region", adminAuth, AdminController.adminStatisticUserRegion);
v1Routes.get("/admin/statistic/user/get_sex", adminAuth, AdminController.adminStatisticUserSex);
v1Routes.get("/admin/statistic/user/get_excel", adminAuth, AdminController.adminStatisticUserExport);
v1Routes.get("/admin/statistic/trade/top_trade", adminAuth, AdminController.adminStatisticTradeTop);
v1Routes.get("/admin/statistic/trade/bottom_trade", adminAuth, AdminController.adminStatisticTradeBottom);
v1Routes.get("/admin/statistic/balance/get_basic", adminAuth, AdminController.adminStatisticBalanceBasic);
v1Routes.get("/admin/statistic/balance/get_trend", adminAuth, AdminController.adminStatisticBalanceTrend);
v1Routes.get("/admin/statistic/balance/get_channel", adminAuth, AdminController.adminStatisticBalanceChannel);
v1Routes.get("/admin/statistic/balance/get_type", adminAuth, AdminController.adminStatisticBalanceType);

// ─── Admin 营销活动管理 (M10) ─────────────────────────────────
v1Routes.get("/admin/activity/seckill", adminAuth, AdminCrud.adminSeckillList);
v1Routes.get("/admin/activity/combination", adminAuth, AdminCrud.adminCombinationList);
v1Routes.get("/admin/activity/bargain", adminAuth, AdminCrud.adminBargainList);
v1Routes.get("/admin/activity/integral", adminAuth, AdminCrud.adminIntegralList);
v1Routes.post("/admin/activity/status", adminAuth, AdminCrud.adminActivityStatus);
v1Routes.get("/admin/lottery/list", adminAuth, AdminLotteryController.list);
v1Routes.get("/admin/lottery/detail/:id", adminAuth, AdminLotteryController.detail);
v1Routes.get("/admin/lottery/factor_info/:factor", adminAuth, AdminLotteryController.factorInfo);
v1Routes.post("/admin/lottery/add", adminAuth, AdminLotteryController.add);
v1Routes.put("/admin/lottery/edit/:id", adminAuth, AdminLotteryController.edit);
v1Routes.delete("/admin/lottery/del/:id", adminAuth, AdminLotteryController.remove);
v1Routes.post("/admin/lottery/set_status/:id/:status", adminAuth, AdminLotteryController.setStatus);
v1Routes.get("/admin/lottery/record/list", adminAuth, AdminLotteryController.records);
v1Routes.get("/admin/lottery/record/list/:id", adminAuth, AdminLotteryController.activityRecords);
v1Routes.get("/admin/lottery/record/detail/:id", adminAuth, AdminLotteryController.recordDetail);
v1Routes.post("/admin/lottery/record/deliver", adminAuth, AdminLotteryController.deliver);
v1Routes.post("/admin/lottery/record/deliver/:id", adminAuth, AdminLotteryController.deliver);

// ─── Admin 商品评价管理 (M11) ─────────────────────────────────
v1Routes.get("/admin/reply/list", adminAuth, AdminCrud.adminReplyList);
v1Routes.post("/admin/reply/status/:id", adminAuth, AdminCrud.adminReplyStatus);
v1Routes.delete("/admin/reply/del/:id", adminAuth, AdminCrud.adminReplyDel);

// ─── Admin 品牌管理 (M15) ────────────────────────────────────
v1Routes.get("/admin/brand/list", adminAuth, AdminCrud.adminBrandList);
v1Routes.post("/admin/brand/save", adminAuth, AdminCrud.adminBrandSave);
v1Routes.delete("/admin/brand/del/:id", adminAuth, AdminCrud.adminBrandDel);

// ─── Admin 系统管理员/角色 (M16) ─────────────────────────────
v1Routes.get("/admin/system_admin/list", adminAuth, AdminCrud.adminSystemAdminList);
v1Routes.post("/admin/system_admin/save", adminAuth, AdminCrud.adminSystemAdminSave);
v1Routes.get("/admin/system_role/list", adminAuth, AdminCrud.adminSystemRoleList);
v1Routes.post("/admin/system_role/save", adminAuth, AdminCrud.adminSystemRoleSave);
v1Routes.delete("/admin/system_role/del/:id", adminAuth, AdminCrud.adminSystemRoleDel);
v1Routes.get("/admin/system_menus/tree", adminAuth, AdminCrud.adminSystemPermissionTree);
v1Routes.get("/admin/print/list", adminAuth, PrintDocumentController.adminList);
v1Routes.get("/admin/print/form/:id", adminAuth, PrintDocumentController.adminDetail);
v1Routes.post("/admin/print/save/:id", adminAuth, PrintDocumentController.adminSave);
v1Routes.put(
  "/admin/print/set_status/:id/:status",
  adminAuth,
  PrintDocumentController.adminSetStatus,
);
v1Routes.delete("/admin/print/del/:id", adminAuth, PrintDocumentController.adminDelete);
v1Routes.get("/admin/print/content/:id", adminAuth, PrintDocumentController.adminContent);
v1Routes.post(
  "/admin/print/save_content/:id",
  adminAuth,
  PrintDocumentController.adminSaveContent,
);
v1Routes.get("/admin/print/jobs", adminAuth, PrintJobController.adminJobs);
v1Routes.get("/admin/print/jobs/:id/actions", adminAuth, PrintJobController.adminActions);
v1Routes.post("/admin/print/jobs/:id/confirm-sent", adminAuth, PrintJobController.adminConfirmSent);
v1Routes.post("/admin/print/jobs/:id/confirm-retry", adminAuth, PrintJobController.adminConfirmRetry);
v1Routes.post("/admin/print/jobs/:id/close", adminAuth, PrintJobController.adminClose);
v1Routes.get("/admin/waybill/jobs", adminAuth, WaybillJobController.adminJobs);
v1Routes.get("/admin/waybill/jobs/:id/actions", adminAuth, WaybillJobController.adminActions);
v1Routes.post("/admin/waybill/jobs/:id/apply-existing", adminAuth, WaybillJobController.adminApplyExisting);
v1Routes.post("/admin/waybill/jobs/:id/confirm-issued", adminAuth, WaybillJobController.adminConfirmIssued);
v1Routes.post("/admin/waybill/jobs/:id/confirm-retry", adminAuth, WaybillJobController.adminConfirmRetry);
v1Routes.post("/admin/waybill/jobs/:id/close", adminAuth, WaybillJobController.adminClose);
// 提现审核 (M17)
v1Routes.get("/admin/extract/list", adminAuth, AdminCrud.adminExtractList);
v1Routes.post("/admin/extract/status/:id", adminAuth, AdminCrud.adminExtractStatus);
v1Routes.get("/admin/supplier/extract/list", adminAuth, AdminSupplierFinance.supplierExtractList);
v1Routes.post("/admin/supplier/extract/verify/:id", adminAuth, AdminSupplierFinance.supplierExtractReview);
v1Routes.post("/admin/supplier/extract/save_transfer/:id", adminAuth, AdminSupplierFinance.supplierExtractTransfer);
v1Routes.post("/admin/supplier/extract/mark/:id", adminAuth, AdminSupplierFinance.supplierExtractMark);

// ─── Admin 营销详情 (M12) ─────────────────────────────────────
v1Routes.get("/admin/activity/pink/:combinationId", adminAuth, AdminCrud.adminPinkList);

// ─── Admin 营销细分 (M13) ─────────────────────────────────────
v1Routes.get("/admin/activity/bargain_users/:bargainId", adminAuth, AdminCrud.adminBargainUsers);
v1Routes.get("/admin/activity/seckill_times", adminAuth, AdminCrud.adminSeckillTimes);

// ─── 用户积分明细 (M13) ───────────────────────────────────────
v1Routes.get("/user/integral_logs", authMiddleware({ force: true }), UserFinanceController.integralLogs);
v1Routes.get("/user/balance", authMiddleware({ force: true }), UserFinanceController.balanceLogs);
v1Routes.get("/user/money_list/9", authMiddleware({ force: true }), UserFinanceController.capitalLogs);

// ─── WebSocket 客服 (M7) ───────────────────────────────────────
v1Routes.get(
  "/ws/kefu",
  authMiddleware({ force: true }),
  AdminController.wsUpgrade,
);

// 财务流水 (M18)
v1Routes.get("/admin/bill/list", adminAuth, AdminCrud.adminBillList);
v1Routes.get("/admin/flow/get_list", adminAuth, AdminCapitalFlow.list);
v1Routes.post("/admin/flow/set_mark/:id", adminAuth, AdminCapitalFlow.setMark);
// 会员等级 (M18)
v1Routes.get("/admin/level/list", adminAuth, AdminCrud.adminLevelList);
v1Routes.post("/admin/level/save", adminAuth, AdminCrud.adminLevelSave);
v1Routes.delete("/admin/level/del/:id", adminAuth, AdminCrud.adminLevelDel);

// 运费模板 + 快递公司 (M19)
v1Routes.get("/admin/shipping_template/list", adminAuth, AdminCrud.adminShippingTemplateList);
v1Routes.post("/admin/shipping_template/save", adminAuth, AdminCrud.adminShippingTemplateSave);
v1Routes.delete("/admin/shipping_template/del/:id", adminAuth, AdminCrud.adminShippingTemplateDel);
v1Routes.get("/admin/express/list", adminAuth, AdminCrud.adminExpressList);
v1Routes.post("/admin/express/save", adminAuth, AdminCrud.adminExpressSave);
v1Routes.delete("/admin/express/del/:id", adminAuth, AdminCrud.adminExpressDel);


// 营销活动创建/编辑/删除 (M20)
v1Routes.post("/admin/activity/save", adminAuth, AdminCrud.adminActivitySave);
v1Routes.delete("/admin/activity/del/:type/:id", adminAuth, AdminCrud.adminActivityDel);

// 统计趋势 + 标签 (M21)
v1Routes.get("/admin/statistic/trend", adminAuth, AdminController.adminStatisticTrend);
v1Routes.get("/admin/statistic/rank", adminAuth, AdminController.adminStatisticRank);
v1Routes.get("/admin/product_label/list", adminAuth, AdminCrud.adminProductLabelList);
v1Routes.post("/admin/product_label/save", adminAuth, AdminCrud.adminProductLabelSave);
v1Routes.delete("/admin/product_label/del/:id", adminAuth, AdminCrud.adminProductLabelDel);
v1Routes.get("/admin/user_label/list", adminAuth, AdminCrud.adminUserLabelList);
v1Routes.post("/admin/user_label/save", adminAuth, AdminCrud.adminUserLabelSave);
v1Routes.delete("/admin/user_label/del/:id", adminAuth, AdminCrud.adminUserLabelDel);

// DIY + CMS + 系统工具 (M22)
v1Routes.get("/admin/dise/list", adminAuth, AdminCrud.adminDiseList);
v1Routes.post("/admin/dise/save", adminAuth, AdminCrud.adminDiseSave);
v1Routes.delete("/admin/dise/del/:id", adminAuth, AdminCrud.adminDiseDel);
v1Routes.get("/admin/article/list", adminAuth, AdminCrud.adminArticleList);
v1Routes.post("/admin/article/save", adminAuth, AdminCrud.adminArticleSave);
v1Routes.delete("/admin/article/del/:id", adminAuth, AdminCrud.adminArticleDel);
v1Routes.get("/admin/log/list", adminAuth, AdminCrud.adminLogList);

// 分销管理 + 通知模板 + 短信配置 (M24)
v1Routes.get("/admin/spread/list", adminAuth, AdminCrud.adminSpreadList);
v1Routes.get("/admin/brokerage/list", adminAuth, AdminCrud.adminBrokerageList);
v1Routes.get("/admin/promoter/apply/list", adminAuth, PromoterApplicationController.adminList);
v1Routes.get(
  "/admin/promoter/apply/examine/:id/:uid/:status",
  adminAuth,
  PromoterApplicationController.adminExamine,
);
v1Routes.delete(
  "/admin/promoter/apply/del/:id",
  adminAuth,
  PromoterApplicationController.adminDelete,
);
v1Routes.get("/admin/supplier/applications", adminAuth, SupplierApplicationController.adminList);
v1Routes.get("/admin/supplier/applications/:id", adminAuth, SupplierApplicationController.adminDetail);
v1Routes.post("/admin/supplier/applications/:id/review", adminAuth, SupplierApplicationController.adminReview);
v1Routes.post("/admin/supplier/applications/:id/mark", adminAuth, SupplierApplicationController.adminMark);
v1Routes.delete("/admin/supplier/applications/:id", adminAuth, SupplierApplicationController.adminDelete);
v1Routes.get("/admin/assets", adminAuth, AttachmentController.adminList);
v1Routes.post("/admin/assets/upload/image", adminAuth, AttachmentController.adminUploadImage);
v1Routes.post("/admin/assets/delete", adminAuth, AttachmentController.adminDelete);
v1Routes.put("/admin/assets/:id", adminAuth, AttachmentController.adminRename);
v1Routes.get("/admin/asset-categories", adminAuth, AttachmentController.adminCategories);
v1Routes.post("/admin/asset-categories", adminAuth, AttachmentController.adminCategorySave);
v1Routes.put("/admin/asset-categories/:id", adminAuth, AttachmentController.adminCategoryUpdate);
v1Routes.delete("/admin/asset-categories/:id", adminAuth, AttachmentController.adminCategoryDelete);
v1Routes.get("/admin/agent/division/list", adminAuth, AdminDivision.divisionList);
v1Routes.get("/admin/agent/division/detail/:uid", adminAuth, AdminDivision.divisionDetail);
v1Routes.post("/admin/agent/division/save", adminAuth, AdminDivision.saveDivision);
v1Routes.post("/admin/agent/division_agent/save", adminAuth, AdminDivision.saveAgent);
v1Routes.post("/admin/agent/division_staff/save", adminAuth, AdminDivision.saveStaff);
v1Routes.delete("/admin/agent/division/del/:uid", adminAuth, AdminDivision.deleteDivisionRole);
v1Routes.put("/admin/agent/division/status/:uid/:status", adminAuth, AdminDivision.setDivisionStatus);
v1Routes.get("/admin/agent/division/order/list", adminAuth, AdminDivision.divisionOrders);
v1Routes.get("/admin/agent/division/option", adminAuth, AdminDivision.divisionOptions);
v1Routes.get("/admin/agent/division/agent_option/:divisionId", adminAuth, AdminDivision.agentOptions);
v1Routes.get("/admin/agent/division/statistics", adminAuth, AdminDivision.divisionStatistics);
v1Routes.get("/admin/agent/division/trend", adminAuth, AdminDivision.divisionTrend);
v1Routes.get("/admin/agent/division/ranking", adminAuth, AdminDivision.divisionRanking);
v1Routes.get("/admin/agent/division/apply/list", adminAuth, AdminDivision.applicationList);
v1Routes.post("/admin/agent/division/apply/examine/save", adminAuth, AdminDivision.applicationReview);
v1Routes.delete("/admin/agent/division/apply/del/:id", adminAuth, AdminDivision.applicationDelete);
v1Routes.get("/admin/notification/list", adminAuth, AdminNotification.templateList);
v1Routes.post("/admin/notification/save", adminAuth, AdminNotification.templateSave);
v1Routes.get("/admin/notification/order-config", adminAuth, AdminNotification.orderConfigList);
v1Routes.put("/admin/notification/order-config/:mark", adminAuth, AdminNotification.orderConfigSave);
v1Routes.put("/admin/notification/shipping", adminAuth, AdminNotification.shippingConfigSave);
v1Routes.get("/admin/notification/readiness", adminAuth, AdminNotification.readiness);
v1Routes.get("/admin/notification/deliveries", adminAuth, AdminNotification.deliveryList);
v1Routes.get("/admin/notification/deliveries/:id/actions", adminAuth, AdminNotification.deliveryActions);
v1Routes.post("/admin/notification/deliveries/:id/confirm-sent", adminAuth, AdminNotification.deliveryConfirmSent);
v1Routes.post("/admin/notification/deliveries/:id/confirm-retry", adminAuth, AdminNotification.deliveryConfirmRetry);
v1Routes.post("/admin/notification/deliveries/:id/close", adminAuth, AdminNotification.deliveryClose);
v1Routes.get("/admin/sms/config", adminAuth, AdminNotification.smsConfig);
v1Routes.post("/admin/sms/config", adminAuth, AdminNotification.smsConfigSave);
