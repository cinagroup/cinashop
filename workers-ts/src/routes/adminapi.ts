/**
 * Admin 前端兼容路由 (VUE_APP_API_URL 指向 Workers)
 *
 * PHP 原版: baseURL = {origin}/adminapi, 请求路径 = /order/list 等
 * Workers:   已有 /api/admin/order/list 等接口
 *
 * 这个文件把 /adminapi/<module>/<action> 映射到现有的 admin 处理函数,
 * 让 Vue2 前端零改动即可对接。
 *
 * 映射表 (已实现的 admin 端点):
 *   POST /adminapi/login              → adminLogin
 *   GET  /adminapi/home/header        → 首页四项统计卡片
 *   GET  /adminapi/home/order         → 订单金额/数量周期图
 *   GET  /adminapi/home/user          → 30 天新增用户与消费分层
 *   GET  /adminapi/home/rank          → PHP 兼容空排行
 *   GET  /adminapi/product/list       → adminProductList
 *   GET  /adminapi/product/detail/:id → adminProductDetail
 *   POST /adminapi/product/add        → adminProductCreate
 *   POST /adminapi/product/set_show/:id → adminProductSetShow
 *   GET  /adminapi/order/list         → adminOrderList
 *   GET  /adminapi/order/detail/:id   → adminOrderDetail
 *   POST /adminapi/order/remark/:id   → adminOrderRemark
 *   GET  /adminapi/user/list          → adminUserList
 *   GET  /adminapi/user/info/:id      → adminUserInfo
 *   GET  /adminapi/setting/config/:menuName → adminConfigGet
 *
 * 未实现端点返回 501, 前端会提示"接口未迁移"。
 */
import { Hono } from "hono";
import { adminAuthMiddleware } from "@/middleware/admin-auth";
import * as AdminController from "@/controllers/api/v1/AdminController";
import * as AdminCrud from "@/controllers/api/v1/AdminCrudController";
import * as AdminSupplierFinance from "@/controllers/api/v1/AdminSupplierFinanceController";
import * as AdminOrderOutbox from "@/controllers/api/v1/AdminOrderOutboxController";
import * as AdminPaymentReconciliation from "@/controllers/api/v1/AdminPaymentReconciliationController";
import * as AdminNotification from "@/controllers/api/v1/AdminNotificationController";
import * as AdminDivision from "@/controllers/api/v1/AdminDivisionController";
import * as AdminCapitalFlow from "@/controllers/api/v1/AdminCapitalFlowController";
import * as AdminStore from "@/controllers/api/v1/AdminStoreController";
import * as StoreOrderWriteoff from "@/controllers/api/v1/StoreOrderWriteoffController";
import * as ProductExperienceController from "@/controllers/api/v1/ProductExperienceController";
import * as AdminProductWords from "@/controllers/api/v1/AdminProductWordsController";
import * as CustomerServiceCatalogController from "@/controllers/api/v1/CustomerServiceCatalogController";
import * as PromoterApplicationController from "@/controllers/api/v1/PromoterApplicationController";
import * as SupplierApplicationController from "@/controllers/api/v1/SupplierApplicationController";
import * as PageNavigationController from "@/controllers/api/v1/PageNavigationController";
import * as AdminLotteryController from "@/controllers/api/v1/AdminLotteryController";
import * as AdminWechatContentController from "@/controllers/api/v1/AdminWechatContentController";
import * as AdminWechatQrcodeController from "@/controllers/api/v1/AdminWechatQrcodeController";
import * as AdminLegacyRuntimeController from "@/controllers/api/v1/AdminLegacyRuntimeController";
import * as WechatLiveController from "@/controllers/api/v1/WechatLiveController";
import * as AdminOutApiController from "@/controllers/api/v1/AdminOutApiController";
import * as AdminEnterpriseWechat from "@/controllers/api/v1/AdminEnterpriseWechatController";
import * as AdminWechatMemberCard from "@/controllers/api/v1/AdminWechatMemberCardController";
import * as AdminPaidMembership from "@/controllers/api/v1/AdminPaidMembershipController";
import * as AdminNewcomer from "@/controllers/api/v1/AdminNewcomerController";
import * as AdminDiscountPackage from "@/controllers/api/v1/AdminDiscountPackageController";
import * as AdminLegacyContent from "@/controllers/api/v1/AdminLegacyContentController";
import * as AdminCommunity from "@/controllers/api/v1/AdminCommunityController";
import * as AdminArticle from "@/controllers/api/v1/AdminArticleController";
import * as VirtualProductInventory from "@/controllers/api/v1/VirtualProductInventoryController";
import * as PrintDocumentController from "@/controllers/system/PrintDocumentController";
import * as PrintJobController from "@/controllers/system/PrintJobController";
import * as WaybillJobController from "@/controllers/system/WaybillJobController";
import * as AttachmentController from "@/controllers/system/AttachmentController";
import type { AppVariables, Env } from "@/env";

export const adminapiRoutes = new Hono<{
  Bindings: Env;
  Variables: AppVariables;
}>();

const adminAuth = adminAuthMiddleware();

// ─── 登录 (无 auth) ─────────────────────────────────────────
adminapiRoutes.post("/login", AdminController.adminLogin);
// 是否启用滑块验证码 (返回 false 则前端跳过滑块直接登录)
adminapiRoutes.post("/is_captcha", (c) =>
  c.json({ status: 200, msg: "ok", data: { is_captcha: false } }),
);

// ─── Dashboard (admin auth) ─────────────────────────────────
adminapiRoutes.get("/home/header", adminAuth, AdminController.adminHomeHeader);
adminapiRoutes.get("/home/order", adminAuth, AdminController.adminOrderChart);
adminapiRoutes.get("/home/user", adminAuth, AdminController.adminUserChart);
adminapiRoutes.get("/home/rank", adminAuth, AdminController.adminPurchaseRanking);
adminapiRoutes.get("/new_push", adminAuth, AdminController.adminNewPush);

// Legacy queue/timer tables are intentionally read-only. Their PHP executors
// depended on Redis/ThinkPHP Jobs and are not Cloudflare runtime authorities.
adminapiRoutes.get("/system/timer/task", adminAuth, AdminLegacyRuntimeController.timerTasks);
adminapiRoutes.get("/system/timer/index", adminAuth, AdminLegacyRuntimeController.timerList);
adminapiRoutes.get("/system/timer/one/:id", adminAuth, AdminLegacyRuntimeController.timerDetail);
adminapiRoutes.get("/queue/index", adminAuth, AdminLegacyRuntimeController.queueList);
adminapiRoutes.get(
  "/queue/delivery/log/:id/:type",
  adminAuth,
  AdminLegacyRuntimeController.queueDeliveryLog,
);

// Mini-program live catalogs are readable; remote status synchronization only
// performs WeChat GET/status reads and is dispatched through Cloudflare Queue.
adminapiRoutes.get("/live/room/list", adminAuth, WechatLiveController.adminRooms);
adminapiRoutes.get("/live/goods/list", adminAuth, WechatLiveController.adminGoods);
adminapiRoutes.get("/live/anchor/list", adminAuth, WechatLiveController.adminAnchors);
adminapiRoutes.post("/live/sync", adminAuth, WechatLiveController.adminSync);
adminapiRoutes.get("/live/room/syncRoom", adminAuth, WechatLiveController.adminSync);
adminapiRoutes.get("/live/goods/syncGoods", adminAuth, WechatLiveController.adminSync);

// Third-party API accounts use hashed secrets only. The legacy interface
// documentation remains read-only and arbitrary outbound push tests stay disabled.
adminapiRoutes.get("/system_out/index", adminAuth, AdminOutApiController.accountList);
adminapiRoutes.get("/system_out/info/:id", adminAuth, AdminOutApiController.accountInfo);
adminapiRoutes.post("/system_out/save", adminAuth, AdminOutApiController.accountCreate);
adminapiRoutes.post("/system_out/update/:id", adminAuth, AdminOutApiController.accountUpdate);
adminapiRoutes.put(
  "/system_out/set_status/:id/:status",
  adminAuth,
  AdminOutApiController.accountStatus,
);
adminapiRoutes.delete("/system_out/delete/:id", adminAuth, AdminOutApiController.accountDelete);
adminapiRoutes.put("/system_out/set_up/:id", adminAuth, AdminOutApiController.pushUnavailable);
adminapiRoutes.post("/system_out/text_out_url", adminAuth, AdminOutApiController.pushUnavailable);
adminapiRoutes.get("/system_out/interface/list", adminAuth, AdminOutApiController.interfaceList);
adminapiRoutes.get("/system_out/interface/info/:id", adminAuth, AdminOutApiController.interfaceInfo);
adminapiRoutes.get("/system_out/audit", adminAuth, AdminOutApiController.auditList);
adminapiRoutes.post(
  "/system_out/interface/save/:id",
  adminAuth,
  AdminOutApiController.interfaceWriteUnavailable,
);
adminapiRoutes.put(
  "/system_out/interface/edit_name",
  adminAuth,
  AdminOutApiController.interfaceWriteUnavailable,
);
adminapiRoutes.delete(
  "/system_out/interface/del/:id",
  adminAuth,
  AdminOutApiController.interfaceWriteUnavailable,
);

// Enterprise WeChat source-compatible read catalog. These endpoints only read
// imported PostgreSQL history; remote sync/send/tag/contact-way writes remain 501.
adminapiRoutes.get("/work/summary", adminAuth, AdminEnterpriseWechat.summary);
adminapiRoutes.get("/work/tree", adminAuth, AdminEnterpriseWechat.departments);
adminapiRoutes.get("/work/member", adminAuth, AdminEnterpriseWechat.members);
adminapiRoutes.get("/work/client", adminAuth, AdminEnterpriseWechat.clients);
adminapiRoutes.get("/work/group_chat", adminAuth, AdminEnterpriseWechat.groups);
adminapiRoutes.get("/work/group_chat/member/:id", adminAuth, AdminEnterpriseWechat.groupMembers);
adminapiRoutes.get("/work/channel_code", adminAuth, AdminEnterpriseWechat.channels);
adminapiRoutes.get("/work/group_chat_auth", adminAuth, AdminEnterpriseWechat.groupAuths);
adminapiRoutes.get("/work/label", adminAuth, AdminEnterpriseWechat.labels);
adminapiRoutes.get("/work/group_template", adminAuth, AdminEnterpriseWechat.templates);
adminapiRoutes.get("/work/moment", adminAuth, AdminEnterpriseWechat.moments);
adminapiRoutes.get("/work/welcome", adminAuth, AdminEnterpriseWechat.welcomes);
adminapiRoutes.get("/work/contact_action", adminAuth, AdminEnterpriseWechat.contactActions);
adminapiRoutes.post("/work/contact_action/:id/decision", adminAuth, AdminEnterpriseWechat.decideContactAction);

adminapiRoutes.get("/work/client/synch", adminAuth, AdminEnterpriseWechat.remoteWriteUnavailable);
adminapiRoutes.post("/work/synchMember", adminAuth, AdminEnterpriseWechat.remoteWriteUnavailable);
adminapiRoutes.post("/work/client/batchLabel", adminAuth, AdminEnterpriseWechat.remoteWriteUnavailable);
adminapiRoutes.put("/work/client/:id", adminAuth, AdminEnterpriseWechat.remoteWriteUnavailable);
adminapiRoutes.post("/work/group_chat/synch", adminAuth, AdminEnterpriseWechat.remoteWriteUnavailable);
adminapiRoutes.post("/work/channel_code", adminAuth, AdminEnterpriseWechat.remoteWriteUnavailable);
adminapiRoutes.put("/work/channel_code/:id", adminAuth, AdminEnterpriseWechat.remoteWriteUnavailable);
adminapiRoutes.delete("/work/channel_code/:id", adminAuth, AdminEnterpriseWechat.remoteWriteUnavailable);
adminapiRoutes.post("/work/group_chat_auth", adminAuth, AdminEnterpriseWechat.remoteWriteUnavailable);
adminapiRoutes.put("/work/group_chat_auth/:id", adminAuth, AdminEnterpriseWechat.remoteWriteUnavailable);
adminapiRoutes.delete("/work/group_chat_auth/:id", adminAuth, AdminEnterpriseWechat.remoteWriteUnavailable);
adminapiRoutes.post("/work/group_template", adminAuth, AdminEnterpriseWechat.remoteWriteUnavailable);
adminapiRoutes.put("/work/group_template/:id", adminAuth, AdminEnterpriseWechat.remoteWriteUnavailable);
adminapiRoutes.delete("/work/group_template/:id", adminAuth, AdminEnterpriseWechat.remoteWriteUnavailable);
adminapiRoutes.post("/work/moment", adminAuth, AdminEnterpriseWechat.remoteWriteUnavailable);
adminapiRoutes.delete("/work/moment/:id", adminAuth, AdminEnterpriseWechat.remoteWriteUnavailable);
adminapiRoutes.post("/work/welcome", adminAuth, AdminEnterpriseWechat.remoteWriteUnavailable);
adminapiRoutes.put("/work/welcome/:id", adminAuth, AdminEnterpriseWechat.remoteWriteUnavailable);
adminapiRoutes.delete("/work/welcome/:id", adminAuth, AdminEnterpriseWechat.remoteWriteUnavailable);

// Platform-owned receipt printers (supplier_id = 0).
adminapiRoutes.get("/print/list", adminAuth, PrintDocumentController.adminList);
adminapiRoutes.get("/print/form/:id", adminAuth, PrintDocumentController.adminDetail);
adminapiRoutes.post("/print/save/:id", adminAuth, PrintDocumentController.adminSave);
adminapiRoutes.put("/print/set_status/:id/:status", adminAuth, PrintDocumentController.adminSetStatus);
adminapiRoutes.delete("/print/del/:id", adminAuth, PrintDocumentController.adminDelete);
adminapiRoutes.get("/print/content/:id", adminAuth, PrintDocumentController.adminContent);
adminapiRoutes.post("/print/save_content/:id", adminAuth, PrintDocumentController.adminSaveContent);
adminapiRoutes.get("/print/jobs", adminAuth, PrintJobController.adminJobs);
adminapiRoutes.get("/print/jobs/:id/actions", adminAuth, PrintJobController.adminActions);
adminapiRoutes.post("/print/jobs/:id/confirm-sent", adminAuth, PrintJobController.adminConfirmSent);
adminapiRoutes.post("/print/jobs/:id/confirm-retry", adminAuth, PrintJobController.adminConfirmRetry);
adminapiRoutes.post("/print/jobs/:id/close", adminAuth, PrintJobController.adminClose);
adminapiRoutes.get("/waybill/jobs", adminAuth, WaybillJobController.adminJobs);
adminapiRoutes.get("/waybill/jobs/:id/actions", adminAuth, WaybillJobController.adminActions);
adminapiRoutes.post("/waybill/jobs/:id/apply-existing", adminAuth, WaybillJobController.adminApplyExisting);
adminapiRoutes.post("/waybill/jobs/:id/confirm-issued", adminAuth, WaybillJobController.adminConfirmIssued);
adminapiRoutes.post("/waybill/jobs/:id/confirm-retry", adminAuth, WaybillJobController.adminConfirmRetry);
adminapiRoutes.post("/waybill/jobs/:id/close", adminAuth, WaybillJobController.adminClose);

// ─── 商品管理 ───────────────────────────────────────────────
adminapiRoutes.get("/product/list", adminAuth, AdminCrud.adminProductList);
adminapiRoutes.get("/product/editor/options", adminAuth, AdminCrud.adminProductEditorOptions);
adminapiRoutes.get("/product/detail/:id", adminAuth, AdminCrud.adminProductDetail);
adminapiRoutes.get("/product/virtual-alerts", adminAuth, VirtualProductInventory.adminAlerts);
adminapiRoutes.get("/product/virtual/:id", adminAuth, VirtualProductInventory.adminInventory);
adminapiRoutes.post("/product/virtual/:id/import", adminAuth, VirtualProductInventory.adminImport);
adminapiRoutes.post(
  "/product/virtual/:id/export-ticket",
  adminAuth,
  VirtualProductInventory.adminCreateExportTicket,
);
adminapiRoutes.post(
  "/product/virtual/:id/export",
  adminAuth,
  VirtualProductInventory.adminConsumeExportTicket,
);
adminapiRoutes.get("/product/coupons/:id", adminAuth, AdminCrud.adminProductCoupons);
adminapiRoutes.put("/product/coupons/:id", adminAuth, AdminCrud.adminProductCouponsReplace);
adminapiRoutes.post("/product/add", adminAuth, AdminCrud.adminProductCreate);
adminapiRoutes.post("/product/edit/:id", adminAuth, AdminCrud.adminProductUpdate);
adminapiRoutes.post("/product/sku/retire", adminAuth, AdminCrud.adminProductSkuRetire);
adminapiRoutes.post("/product/sku/restore", adminAuth, AdminCrud.adminProductSkuRestore);
adminapiRoutes.post("/product/set_show", adminAuth, AdminCrud.adminMobileProductSetShow);
adminapiRoutes.post("/product/set_show/:id", adminAuth, AdminCrud.adminProductSetShow);
adminapiRoutes.post("/product/batch_process", adminAuth, AdminCrud.adminMobileProductBatchProcess);
adminapiRoutes.delete("/product/del/:id", adminAuth, AdminCrud.adminProductDel);
adminapiRoutes.get("/product/cache", adminAuth, AdminLegacyContent.getProductDraft);
adminapiRoutes.post("/product/cache", adminAuth, AdminLegacyContent.saveProductDraft);
adminapiRoutes.delete("/product/cache", adminAuth, AdminLegacyContent.deleteProductDraft);
adminapiRoutes.get("/product/all_ensure", adminAuth, ProductExperienceController.adminEnsureAll);
adminapiRoutes.get("/product/ensure", adminAuth, ProductExperienceController.adminEnsureList);
adminapiRoutes.post("/product/ensure", adminAuth, ProductExperienceController.adminEnsureCreate);
adminapiRoutes.put(
  "/product/ensure/set_show/:id/:is_show",
  adminAuth,
  ProductExperienceController.adminEnsureStatus,
);

// Source-compatible attachment center backed by the private ASSETS_BUCKET R2 binding.
adminapiRoutes.get("/file/file", adminAuth, AttachmentController.adminList);
adminapiRoutes.post("/file/file/delete", adminAuth, AttachmentController.adminDelete);
adminapiRoutes.put("/file/file/do_move", adminAuth, AttachmentController.adminMove);
adminapiRoutes.put("/file/file/update/:id", adminAuth, AttachmentController.adminRename);
adminapiRoutes.post("/file/upload", adminAuth, AttachmentController.adminUploadImage);
adminapiRoutes.post("/file/upload/:upload_type", adminAuth, AttachmentController.adminUploadImage);
adminapiRoutes.get("/file/upload_type", adminAuth, AttachmentController.uploadType);
adminapiRoutes.get("/file/category", adminAuth, AttachmentController.adminCategories);
adminapiRoutes.get("/file/category/create/:parentId", adminAuth, AttachmentController.adminCategoryCreateForm);
adminapiRoutes.post("/file/category", adminAuth, AttachmentController.adminCategorySave);
adminapiRoutes.get("/file/category/:id/edit", adminAuth, AttachmentController.adminCategoryEditForm);
adminapiRoutes.put("/file/category/:id", adminAuth, AttachmentController.adminCategoryUpdate);
adminapiRoutes.delete("/file/category/:id", adminAuth, AttachmentController.adminCategoryDelete);
adminapiRoutes.get("/config/storage", adminAuth, AttachmentController.adminStorage);
adminapiRoutes.get("/config/storage/config", adminAuth, AttachmentController.adminStorageConfig);
adminapiRoutes.get("/product/ensure/:id", adminAuth, ProductExperienceController.adminEnsureDetail);
adminapiRoutes.put("/product/ensure/:id", adminAuth, ProductExperienceController.adminEnsureUpdate);
adminapiRoutes.delete("/product/ensure/:id", adminAuth, ProductExperienceController.adminEnsureDelete);
adminapiRoutes.get("/get_all_unit", adminAuth, AdminCrud.adminProductUnitAll);
adminapiRoutes.get("/unit", adminAuth, AdminCrud.adminProductUnitList);
adminapiRoutes.post("/unit", adminAuth, AdminCrud.adminProductUnitSave);
adminapiRoutes.get("/unit/:id", adminAuth, AdminCrud.adminProductUnitDetail);
adminapiRoutes.put("/unit/:id", adminAuth, AdminCrud.adminProductUnitSave);
adminapiRoutes.delete("/unit/:id", adminAuth, AdminCrud.adminProductUnitDelete);
adminapiRoutes.get("/product/get_rule", adminAuth, AdminCrud.adminProductRuleTemplates);
adminapiRoutes.get("/product/rule", adminAuth, AdminCrud.adminProductRuleList);
adminapiRoutes.post("/product/rule/:id", adminAuth, AdminCrud.adminProductRuleSave);
adminapiRoutes.get("/product/rule/:id", adminAuth, AdminCrud.adminProductRuleDetail);
adminapiRoutes.delete(
  "/product/rule/delete/:id",
  adminAuth,
  AdminCrud.adminProductRuleDelete,
);
adminapiRoutes.get("/all_specs", adminAuth, AdminCrud.adminProductSpecsAll);
adminapiRoutes.get("/specs", adminAuth, AdminCrud.adminProductSpecsList);
adminapiRoutes.get("/specs/:id", adminAuth, AdminCrud.adminProductSpecsDetail);
adminapiRoutes.post("/specs/:id", adminAuth, AdminCrud.adminProductSpecsSave);
adminapiRoutes.delete("/specs/:id", adminAuth, AdminCrud.adminProductSpecsDelete);
adminapiRoutes.get("/product/words", adminAuth, AdminProductWords.list);
adminapiRoutes.get("/product/words/get_all", adminAuth, AdminProductWords.all);
adminapiRoutes.get("/product/words/:id", adminAuth, AdminProductWords.detail);
adminapiRoutes.post("/product/words/:id", adminAuth, AdminProductWords.save);
adminapiRoutes.put(
  "/product/words/set_show/:id/:is_show",
  adminAuth,
  AdminProductWords.setShow,
);
adminapiRoutes.delete("/product/words/:id", adminAuth, AdminProductWords.remove);

// ─── 订单管理 ───────────────────────────────────────────────
adminapiRoutes.get("/order/list", adminAuth, AdminCrud.adminOrderList);
adminapiRoutes.get("/order/detail/:id", adminAuth, AdminCrud.adminOrderDetail);
adminapiRoutes.post("/order/remark/:id", adminAuth, AdminCrud.adminOrderRemark);
adminapiRoutes.post("/order/print/:id", adminAuth, PrintJobController.adminManual);
adminapiRoutes.post("/order/waybill/:id", adminAuth, WaybillJobController.adminCreate);
adminapiRoutes.get("/order/delivery/index", adminAuth, AdminStore.deliveryList);
adminapiRoutes.get("/order/delivery/create", adminAuth, AdminStore.deliveryCandidates);
adminapiRoutes.post("/order/delivery/save", adminAuth, AdminStore.deliverySave);
adminapiRoutes.get("/order/delivery/:id/edit", adminAuth, AdminStore.deliveryDetail);
adminapiRoutes.put("/order/delivery/update/:id", adminAuth, AdminStore.deliveryUpdate);
adminapiRoutes.delete("/order/delivery/del/:id", adminAuth, AdminStore.deliveryDelete);
adminapiRoutes.put(
  "/order/delivery/set_status/:id/:status",
  adminAuth,
  AdminStore.deliveryStatus,
);
adminapiRoutes.get("/order/delivery/list", adminAuth, AdminStore.deliverySelectList);
adminapiRoutes.post("/order/delivery/:id", adminAuth, AdminCrud.adminOrderDelivery);
adminapiRoutes.post("/order/writeoff_info", adminAuth, StoreOrderWriteoff.adminInfo);
adminapiRoutes.post("/order/writeoff", adminAuth, StoreOrderWriteoff.adminExecute);
adminapiRoutes.get("/order/outbox", adminAuth, AdminOrderOutbox.orderOutboxList);
adminapiRoutes.post("/order/outbox/:id/replay", adminAuth, AdminOrderOutbox.orderOutboxReplay);
adminapiRoutes.get(
  "/order/payment-reconciliation",
  adminAuth,
  AdminPaymentReconciliation.list,
);
adminapiRoutes.post(
  "/order/payment-reconciliation/:id/decision",
  adminAuth,
  AdminPaymentReconciliation.decide,
);
adminapiRoutes.get(
  "/order/outbox/dead-letter",
  adminAuth,
  AdminOrderOutbox.orderQueueDeadLetterList,
);
adminapiRoutes.post(
  "/order/outbox/dead-letter/:id/replay",
  adminAuth,
  AdminOrderOutbox.orderQueueDeadLetterReplay,
);
adminapiRoutes.post(
  "/order/outbox/dead-letter/:id/resolve",
  adminAuth,
  AdminOrderOutbox.orderQueueDeadLetterResolve,
);
adminapiRoutes.get("/integral/order/list", adminAuth, AdminCrud.adminIntegralOrderList);
adminapiRoutes.get("/integral/order/chart", adminAuth, AdminCrud.adminIntegralOrderChart);
adminapiRoutes.get("/merchant/store", adminAuth, AdminStore.storeList);
adminapiRoutes.get("/merchant/store/get_header", adminAuth, AdminStore.storeHeader);
adminapiRoutes.get("/merchant/store/get_info/:id", adminAuth, AdminStore.storeDetail);
adminapiRoutes.put(
  "/merchant/store/set_show/:id/:isShow",
  adminAuth,
  AdminStore.storeVisibility,
);
adminapiRoutes.delete("/merchant/store/del/:id", adminAuth, AdminStore.storeDelete);
adminapiRoutes.post("/merchant/store/:id", adminAuth, AdminStore.storeSave);
adminapiRoutes.get("/merchant/store_list", adminAuth, AdminStore.storeOptions);
adminapiRoutes.get("/merchant/store_staff", adminAuth, AdminStore.staffList);
adminapiRoutes.get("/merchant/store_staff/create", adminAuth, AdminStore.staffForm);
adminapiRoutes.get("/merchant/store_staff/:id/edit", adminAuth, AdminStore.staffForm);
adminapiRoutes.post("/merchant/store_staff/save/:id", adminAuth, AdminStore.staffSave);
adminapiRoutes.put(
  "/merchant/store_staff/set_show/:id/:status",
  adminAuth,
  AdminStore.staffStatus,
);
adminapiRoutes.delete("/merchant/store_staff/del/:id", adminAuth, AdminStore.staffDelete);

// ─── 用户管理 ───────────────────────────────────────────────
adminapiRoutes.get("/user/list", adminAuth, AdminCrud.adminUserList);
adminapiRoutes.get("/user/info/:id", adminAuth, AdminCrud.adminUserInfo);
adminapiRoutes.post("/user/set_user_grade/:id", adminAuth, AdminCrud.adminUserUpdate);
adminapiRoutes.post("/user/set_other/:uid", adminAuth, AdminCrud.adminMobileUserUpdateOther);
adminapiRoutes.post("/user/update_other/:uid", adminAuth, AdminCrud.adminMobileUserUpdateOther);

// ─── 付费会员运营 ───────────────────────────────────────────
// 新批次的卡密只在 save 响应中返回一次；后续列表不回显密码。
adminapiRoutes.get("/member_batch/index", adminAuth, AdminPaidMembership.batches);
adminapiRoutes.post("/member_batch/save/:id", adminAuth, AdminPaidMembership.saveBatch);
adminapiRoutes.get("/member_batch/set_value/:id", adminAuth, AdminPaidMembership.setBatchValue);
adminapiRoutes.post("/member_batch/set_value/:id", adminAuth, AdminPaidMembership.setBatchValue);
adminapiRoutes.get(
  "/member_card/index/:card_batch_id",
  adminAuth,
  AdminPaidMembership.cards,
);
adminapiRoutes.get("/member_card/set_status", adminAuth, AdminPaidMembership.setCardStatus);
adminapiRoutes.post("/member_card/set_status", adminAuth, AdminPaidMembership.setCardStatus);
adminapiRoutes.get("/member/ship", adminAuth, AdminPaidMembership.plans);
adminapiRoutes.post("/member_ship/save/:id", adminAuth, AdminPaidMembership.savePlan);
adminapiRoutes.delete("/member_ship/delete/:id", adminAuth, AdminPaidMembership.deletePlan);
adminapiRoutes.get(
  "/member_ship/set_ship_status",
  adminAuth,
  AdminPaidMembership.setPlanStatus,
);
adminapiRoutes.post(
  "/member_ship/set_ship_status",
  adminAuth,
  AdminPaidMembership.setPlanStatus,
);
adminapiRoutes.get("/member/ship_select", adminAuth, AdminPaidMembership.planSelect);
adminapiRoutes.get("/member/record", adminAuth, AdminPaidMembership.records);
adminapiRoutes.get("/member/right", adminAuth, AdminPaidMembership.rights);
adminapiRoutes.post("/member_right/save/:id", adminAuth, AdminPaidMembership.saveRight);
adminapiRoutes.post(
  "/member/save/content/:id",
  adminAuth,
  AdminPaidMembership.saveRightContent,
);
adminapiRoutes.get("/member/agreement", adminAuth, AdminPaidMembership.membershipAgreement);
adminapiRoutes.post(
  "/member_agreement/save/:id",
  adminAuth,
  AdminPaidMembership.saveAgreement,
);
adminapiRoutes.get("/member_scan", adminAuth, AdminPaidMembership.memberScan);
adminapiRoutes.get("/user_group/list", adminAuth, AdminCrud.adminUserGroupList);
adminapiRoutes.post("/user_group/save", adminAuth, AdminCrud.adminUserGroupSave);
adminapiRoutes.delete("/user_group/del/:id", adminAuth, AdminCrud.adminUserGroupDelete);
adminapiRoutes.get("/label/:id", adminAuth, AdminCrud.adminUserLabels);
adminapiRoutes.post("/label/:id", adminAuth, AdminCrud.adminUserLabelsSet);
adminapiRoutes.put("/save_set_group", adminAuth, AdminCrud.adminUsersSetGroup);
adminapiRoutes.put("/save_set_label", adminAuth, AdminCrud.adminUsersSetLabel);

// ─── 退款审核 ───────────────────────────────────────────────
adminapiRoutes.get("/refund/list", adminAuth, AdminCrud.adminRefundList);
adminapiRoutes.get("/refund/detail/:id", adminAuth, AdminCrud.adminRefundDetail);
adminapiRoutes.post("/refund/refund/:id", adminAuth, AdminCrud.adminRefundAgree);
adminapiRoutes.post("/refund/refuse/:id", adminAuth, AdminCrud.adminRefundRefuse);

// ─── 系统配置 ───────────────────────────────────────────────
// PHP-compatible newcomer/register operations use an explicit key whitelist
// and one transaction for configuration, catalog and agreement replacement.
adminapiRoutes.get(
  "/config/user/register/products",
  adminAuth,
  AdminNewcomer.productOptions,
);
adminapiRoutes.get(
  "/config/user/register/coupons",
  adminAuth,
  AdminNewcomer.couponOptions,
);
adminapiRoutes.get("/config/user/register", adminAuth, AdminNewcomer.registerConfig);
adminapiRoutes.post("/config/user/register", adminAuth, AdminNewcomer.saveRegisterConfig);
adminapiRoutes.get("/config/runtime_content", adminAuth, AdminLegacyContent.runtimeContent);
adminapiRoutes.post("/config/runtime_content", adminAuth, AdminLegacyContent.saveRuntimeContent);
adminapiRoutes.get("/setting/get_kf_adv", adminAuth, AdminLegacyContent.getKfAdv);
adminapiRoutes.post("/setting/set_kf_adv", adminAuth, AdminLegacyContent.setKfAdv);
adminapiRoutes.get("/setting/get_user_agreement/:type", adminAuth, AdminLegacyContent.getAgreement);
adminapiRoutes.post("/setting/set_user_agreement/:type", adminAuth, AdminLegacyContent.setAgreement);
adminapiRoutes.get("/setting/config/:menuName", adminAuth, AdminCrud.adminConfigGet);
adminapiRoutes.get("/config_class", adminAuth, AdminCrud.adminConfigTabList);
adminapiRoutes.get("/config_class/list", adminAuth, AdminCrud.adminConfigTabList);
adminapiRoutes.post("/config_class", adminAuth, AdminCrud.adminConfigTabSave);
adminapiRoutes.put("/config_class/:id", adminAuth, AdminCrud.adminConfigTabUpdate);
adminapiRoutes.delete("/config_class/:id", adminAuth, AdminCrud.adminConfigTabDelete);
adminapiRoutes.put(
  "/config_class/set_status/:id/:status",
  adminAuth,
  AdminCrud.adminConfigTabStatus,
);
adminapiRoutes.get("/form/index", adminAuth, AdminCrud.adminSystemFormList);
adminapiRoutes.post("/form/update_name/:id", adminAuth, AdminCrud.adminSystemFormRename);
adminapiRoutes.post("/form/save/:id", adminAuth, AdminCrud.adminSystemFormSave);
adminapiRoutes.delete("/form/del/:id", adminAuth, AdminCrud.adminSystemFormDelete);
adminapiRoutes.get("/form/set_show/:id/:is_show", adminAuth, AdminCrud.adminSystemFormStatus);
adminapiRoutes.get("/form/info/:id", adminAuth, AdminCrud.adminSystemFormInfo);
adminapiRoutes.get("/form/all_system_form", adminAuth, AdminCrud.adminSystemFormAll);
adminapiRoutes.get("/form/data/:id", adminAuth, AdminCrud.adminSystemFormData);
adminapiRoutes.get("/setting/sign/rewards", adminAuth, AdminCrud.adminSignRewardList);
adminapiRoutes.get("/setting/sign/add_rewards", adminAuth, AdminCrud.adminSignRewardAdd);
adminapiRoutes.get("/setting/sign/edit_rewards/:id", adminAuth, AdminCrud.adminSignRewardEdit);
adminapiRoutes.post("/setting/sign/save_rewards/:id", adminAuth, AdminCrud.adminSignRewardSave);
adminapiRoutes.delete("/setting/sign/del_rewards/:id", adminAuth, AdminCrud.adminSignRewardDelete);
adminapiRoutes.get("/agent/level_task", adminAuth, AdminCrud.adminAgentLevelTaskList);
adminapiRoutes.get(
  "/agent/level_task/create",
  adminAuth,
  AdminCrud.adminAgentLevelTaskCreateForm,
);
adminapiRoutes.post("/agent/level_task", adminAuth, AdminCrud.adminAgentLevelTaskCreate);
adminapiRoutes.get(
  "/agent/level_task/:id/edit",
  adminAuth,
  AdminCrud.adminAgentLevelTaskEditForm,
);
adminapiRoutes.put("/agent/level_task/:id", adminAuth, AdminCrud.adminAgentLevelTaskUpdate);
adminapiRoutes.delete("/agent/level_task/:id", adminAuth, AdminCrud.adminAgentLevelTaskDelete);
adminapiRoutes.put(
  "/agent/level_task/set_status/:id/:status",
  adminAuth,
  AdminCrud.adminAgentLevelTaskStatus,
);

// ─── 分类管理 (M9) ──────────────────────────────────────────
adminapiRoutes.get("/category/list", adminAuth, AdminCrud.adminCategoryList);
adminapiRoutes.post("/category/save", adminAuth, AdminCrud.adminCategorySave);
adminapiRoutes.delete("/category/del/:id", adminAuth, AdminCrud.adminCategoryDel);

// ─── 优惠券管理 (M9) ────────────────────────────────────────
adminapiRoutes.get("/coupon/list", adminAuth, AdminCrud.adminCouponList);
adminapiRoutes.post("/coupon/save", adminAuth, AdminCrud.adminCouponSave);
adminapiRoutes.post("/coupon/status/:id", adminAuth, AdminCrud.adminCouponStatus);
adminapiRoutes.delete("/coupon/del/:id", adminAuth, AdminCrud.adminCouponDel);

// ─── 数据统计 (M9) ──────────────────────────────────────────
adminapiRoutes.get("/statistic/overview", adminAuth, AdminController.adminStatisticOverview);
adminapiRoutes.get("/statistic/order/get_basic", adminAuth, AdminController.adminStatisticOrderBasic);
adminapiRoutes.get("/statistic/order/get_trend", adminAuth, AdminController.adminStatisticOrderTrend);
adminapiRoutes.get("/statistic/order/get_channel", adminAuth, AdminController.adminStatisticOrderChannel);
adminapiRoutes.get("/statistic/order/get_type", adminAuth, AdminController.adminStatisticOrderType);
adminapiRoutes.get("/statistic/product/get_basic", adminAuth, AdminController.adminStatisticProductBasic);
adminapiRoutes.get("/statistic/product/get_trend", adminAuth, AdminController.adminStatisticProductTrend);
adminapiRoutes.get("/statistic/product/get_product_ranking", adminAuth, AdminController.adminStatisticProductRanking);
adminapiRoutes.get("/statistic/product/get_excel", adminAuth, AdminController.adminStatisticProductExport);
adminapiRoutes.get("/statistic/user/get_basic", adminAuth, AdminController.adminStatisticUserBasic);
adminapiRoutes.get("/statistic/user/get_trend", adminAuth, AdminController.adminStatisticUserTrend);
adminapiRoutes.get("/statistic/user/get_wechat", adminAuth, AdminController.adminStatisticUserWechat);
adminapiRoutes.get("/statistic/user/get_wechat_trend", adminAuth, AdminController.adminStatisticUserWechatTrend);
adminapiRoutes.get("/statistic/user/get_region", adminAuth, AdminController.adminStatisticUserRegion);
adminapiRoutes.get("/statistic/user/get_sex", adminAuth, AdminController.adminStatisticUserSex);
adminapiRoutes.get("/statistic/user/get_excel", adminAuth, AdminController.adminStatisticUserExport);
adminapiRoutes.get("/statistic/trade/top_trade", adminAuth, AdminController.adminStatisticTradeTop);
adminapiRoutes.get("/statistic/trade/bottom_trade", adminAuth, AdminController.adminStatisticTradeBottom);
adminapiRoutes.get("/statistic/balance/get_basic", adminAuth, AdminController.adminStatisticBalanceBasic);
adminapiRoutes.get("/statistic/balance/get_trend", adminAuth, AdminController.adminStatisticBalanceTrend);
adminapiRoutes.get("/statistic/balance/get_channel", adminAuth, AdminController.adminStatisticBalanceChannel);
adminapiRoutes.get("/statistic/balance/get_type", adminAuth, AdminController.adminStatisticBalanceType);

// ─── 营销活动管理 (M10) ─────────────────────────────────────
adminapiRoutes.get("/activity/seckill", adminAuth, AdminCrud.adminSeckillList);
adminapiRoutes.get("/activity/combination", adminAuth, AdminCrud.adminCombinationList);
adminapiRoutes.get("/activity/bargain", adminAuth, AdminCrud.adminBargainList);
adminapiRoutes.get("/activity/integral", adminAuth, AdminCrud.adminIntegralList);
adminapiRoutes.post("/activity/status", adminAuth, AdminCrud.adminActivityStatus);
// PHP-compatible discount-package administration. The legacy status mutation
// remains available on GET, but the permission resolver classifies it as manage.
adminapiRoutes.get("/discounts/products", adminAuth, AdminDiscountPackage.productOptions);
adminapiRoutes.get("/discounts/labels", adminAuth, AdminDiscountPackage.labelOptions);
adminapiRoutes.get("/discounts/list", adminAuth, AdminDiscountPackage.list);
adminapiRoutes.get("/discounts/info/:id", adminAuth, AdminDiscountPackage.detail);
adminapiRoutes.post("/discounts/save", adminAuth, AdminDiscountPackage.save);
adminapiRoutes.get(
  "/discounts/set_status/:id/:status",
  adminAuth,
  AdminDiscountPackage.setStatus,
);
adminapiRoutes.put(
  "/discounts/set_status/:id/:status",
  adminAuth,
  AdminDiscountPackage.setStatus,
);
adminapiRoutes.delete("/discounts/del/:id", adminAuth, AdminDiscountPackage.remove);
adminapiRoutes.get("/lottery/list", adminAuth, AdminLotteryController.list);
adminapiRoutes.get("/lottery/detail/:id", adminAuth, AdminLotteryController.detail);
adminapiRoutes.get("/lottery/factor_info/:factor", adminAuth, AdminLotteryController.factorInfo);
adminapiRoutes.post("/lottery/add", adminAuth, AdminLotteryController.add);
adminapiRoutes.put("/lottery/edit/:id", adminAuth, AdminLotteryController.edit);
adminapiRoutes.delete("/lottery/del/:id", adminAuth, AdminLotteryController.remove);
adminapiRoutes.post("/lottery/set_status/:id/:status", adminAuth, AdminLotteryController.setStatus);
adminapiRoutes.get("/lottery/record/list", adminAuth, AdminLotteryController.records);
adminapiRoutes.get("/lottery/record/list/:id", adminAuth, AdminLotteryController.activityRecords);
adminapiRoutes.get("/lottery/record/detail/:id", adminAuth, AdminLotteryController.recordDetail);
adminapiRoutes.post("/lottery/record/deliver", adminAuth, AdminLotteryController.deliver);
adminapiRoutes.post("/lottery/record/deliver/:id", adminAuth, AdminLotteryController.deliver);

// ─── 客服 (M10) ─────────────────────────────────────────────
adminapiRoutes.get("/service/sessions", adminAuth, AdminController.chatSessions);
adminapiRoutes.get("/service/chat", adminAuth, AdminController.chatHistory);
adminapiRoutes.get("/feedback", adminAuth, CustomerServiceCatalogController.adminFeedbackList);
adminapiRoutes.get("/feedback/:id", adminAuth, CustomerServiceCatalogController.adminFeedbackDetail);
adminapiRoutes.put("/feedback/:id", adminAuth, CustomerServiceCatalogController.adminFeedbackUpdate);
adminapiRoutes.delete("/feedback/:id", adminAuth, CustomerServiceCatalogController.adminFeedbackDelete);
adminapiRoutes.get("/wechat/speechcraft", adminAuth, CustomerServiceCatalogController.adminSpeechcraftList);
adminapiRoutes.get("/wechat/speechcraft/categories", adminAuth, CustomerServiceCatalogController.adminSpeechcraftCategories);
adminapiRoutes.post("/wechat/speechcraft", adminAuth, CustomerServiceCatalogController.adminSpeechcraftCreate);
adminapiRoutes.get("/wechat/speechcraft/:id", adminAuth, CustomerServiceCatalogController.adminSpeechcraftDetail);
adminapiRoutes.put("/wechat/speechcraft/:id", adminAuth, CustomerServiceCatalogController.adminSpeechcraftUpdate);
adminapiRoutes.delete("/wechat/speechcraft/:id", adminAuth, CustomerServiceCatalogController.adminSpeechcraftDelete);

// Official-account reply/content administration. External callback delivery,
// Bulk push stays unavailable; reply and channel QR generation run asynchronously in batch 0072.
adminapiRoutes.get("/wechat/reply", adminAuth, AdminWechatContentController.reservedReply);
adminapiRoutes.get("/wechat/code_reply/:id", adminAuth, AdminWechatQrcodeController.replyCodeStatus);
adminapiRoutes.post("/wechat/code_reply/:id/provision", adminAuth, AdminWechatQrcodeController.provisionReplyCode);
adminapiRoutes.get("/wechat/keyword", adminAuth, AdminWechatContentController.replyList);
adminapiRoutes.get("/wechat/keyword/:id", adminAuth, AdminWechatContentController.replyDetail);
adminapiRoutes.post("/wechat/keyword/:id", adminAuth, AdminWechatContentController.saveReply);
adminapiRoutes.delete("/wechat/keyword/:id", adminAuth, AdminWechatContentController.deleteReply);
adminapiRoutes.put(
  "/wechat/keyword/set_status/:id/:status",
  adminAuth,
  AdminWechatContentController.setReplyStatus,
);
adminapiRoutes.get("/wechat/media", adminAuth, AdminWechatContentController.mediaList);
adminapiRoutes.get("/wechat/news", adminAuth, AdminWechatContentController.newsList);
adminapiRoutes.get("/wechat/news/:id", adminAuth, AdminWechatContentController.newsDetail);
adminapiRoutes.post("/wechat/news", adminAuth, AdminWechatContentController.saveNews);
adminapiRoutes.delete("/wechat/news/:id", adminAuth, AdminWechatContentController.deleteNews);
adminapiRoutes.get("/wechat/message", adminAuth, AdminWechatContentController.messageList);
adminapiRoutes.get("/wechat/message/operate", adminAuth, AdminWechatContentController.messageTypes);
adminapiRoutes.post("/wechat/push", adminAuth, AdminWechatContentController.pushUnavailable);

// Official-account member-card data is an imported, masked catalog. The PHP
// save flow and /wechat/serve callback graph are intentionally not replayed.
adminapiRoutes.get("/wechat/card", adminAuth, AdminWechatMemberCard.cards);
adminapiRoutes.get("/wechat/card/summary", adminAuth, AdminWechatMemberCard.summary);
adminapiRoutes.get("/wechat/card/users", adminAuth, AdminWechatMemberCard.claims);
adminapiRoutes.post("/wechat/card", adminAuth, AdminWechatMemberCard.remoteWriteUnavailable);

adminapiRoutes.get("/wechat_qrcode/cate/list", adminAuth, AdminWechatQrcodeController.categoryList);
adminapiRoutes.get("/wechat_qrcode/cate/create/:id", adminAuth, AdminWechatQrcodeController.categoryDetail);
adminapiRoutes.post("/wechat_qrcode/cate/save", adminAuth, AdminWechatQrcodeController.saveCategory);
adminapiRoutes.delete("/wechat_qrcode/cate/del/:id", adminAuth, AdminWechatQrcodeController.deleteCategory);
adminapiRoutes.post("/wechat_qrcode/save/:id", adminAuth, AdminWechatQrcodeController.saveChannel);
adminapiRoutes.get("/wechat_qrcode/info/:id", adminAuth, AdminWechatQrcodeController.channelDetail);
adminapiRoutes.get("/wechat_qrcode/list", adminAuth, AdminWechatQrcodeController.channelList);
adminapiRoutes.delete("/wechat_qrcode/del/:id", adminAuth, AdminWechatQrcodeController.deleteChannel);
adminapiRoutes.put("/wechat_qrcode/set_status/:id/:status", adminAuth, AdminWechatQrcodeController.setChannelStatus);
adminapiRoutes.post("/wechat_qrcode/provision/:id", adminAuth, AdminWechatQrcodeController.provisionChannel);
adminapiRoutes.get("/wechat_qrcode/user_list/:qid", adminAuth, AdminWechatQrcodeController.channelUsers);
adminapiRoutes.get("/wechat_qrcode/statistic/:qid", adminAuth, AdminWechatQrcodeController.channelStatistics);

// ─── 商品评价管理 (M11) ─────────────────────────────────────
adminapiRoutes.get("/reply/list", adminAuth, AdminCrud.adminReplyList);
adminapiRoutes.post("/reply/status/:id", adminAuth, AdminCrud.adminReplyStatus);
adminapiRoutes.delete("/reply/del/:id", adminAuth, AdminCrud.adminReplyDel);
adminapiRoutes.get("/activity/pink/:combinationId", adminAuth, AdminCrud.adminPinkList);

// ─── 营销细分 (M13) ─────────────────────────────────────────
adminapiRoutes.get("/activity/bargain_users/:bargainId", adminAuth, AdminCrud.adminBargainUsers);
adminapiRoutes.get("/activity/seckill_times", adminAuth, AdminCrud.adminSeckillTimes);

// 客服回复 (M14)
adminapiRoutes.post("/service/send", adminAuth, AdminController.serviceReply);

// ─── 品牌管理 (M15) ─────────────────────────────────────────
adminapiRoutes.get("/brand/list", adminAuth, AdminCrud.adminBrandList);
adminapiRoutes.post("/brand/save", adminAuth, AdminCrud.adminBrandSave);
adminapiRoutes.delete("/brand/del/:id", adminAuth, AdminCrud.adminBrandDel);

// ─── 系统管理员/角色 (M16) ──────────────────────────────────
adminapiRoutes.get("/system_admin/list", adminAuth, AdminCrud.adminSystemAdminList);
adminapiRoutes.post("/system_admin/save", adminAuth, AdminCrud.adminSystemAdminSave);
adminapiRoutes.get("/system_role/list", adminAuth, AdminCrud.adminSystemRoleList);
adminapiRoutes.post("/system_role/save", adminAuth, AdminCrud.adminSystemRoleSave);
adminapiRoutes.delete("/system_role/del/:id", adminAuth, AdminCrud.adminSystemRoleDel);
adminapiRoutes.get("/system_menus/tree", adminAuth, AdminCrud.adminSystemPermissionTree);

// ─── 提现审核 (M17) ─────────────────────────────────────────
adminapiRoutes.get("/extract/list", adminAuth, AdminCrud.adminExtractList);
adminapiRoutes.post("/extract/status/:id", adminAuth, AdminCrud.adminExtractStatus);

// ─── 供应商提现审核/转账 ────────────────────────────────────
adminapiRoutes.get("/supplier/extract/list", adminAuth, AdminSupplierFinance.supplierExtractList);
adminapiRoutes.post("/supplier/extract/verify/:id", adminAuth, AdminSupplierFinance.supplierExtractReview);
adminapiRoutes.post("/supplier/extract/save_transfer/:id", adminAuth, AdminSupplierFinance.supplierExtractTransfer);
adminapiRoutes.post("/supplier/extract/mark/:id", adminAuth, AdminSupplierFinance.supplierExtractMark);

// ─── 财务流水 (M18) ─────────────────────────────────────────
adminapiRoutes.get("/bill/list", adminAuth, AdminCrud.adminBillList);
adminapiRoutes.get("/flow/get_list", adminAuth, AdminCapitalFlow.list);
adminapiRoutes.post("/flow/set_mark/:id", adminAuth, AdminCapitalFlow.setMark);

// ─── 会员等级 (M18) ─────────────────────────────────────────
adminapiRoutes.get("/level/list", adminAuth, AdminCrud.adminLevelList);
adminapiRoutes.post("/level/save", adminAuth, AdminCrud.adminLevelSave);
adminapiRoutes.delete("/level/del/:id", adminAuth, AdminCrud.adminLevelDel);

// ─── 运费模板 + 快递公司 (M19) ─────────────────────────────
adminapiRoutes.get("/shipping_template/list", adminAuth, AdminCrud.adminShippingTemplateList);
adminapiRoutes.post("/shipping_template/save", adminAuth, AdminCrud.adminShippingTemplateSave);
adminapiRoutes.delete("/shipping_template/del/:id", adminAuth, AdminCrud.adminShippingTemplateDel);
adminapiRoutes.get("/express/list", adminAuth, AdminCrud.adminExpressList);
adminapiRoutes.post("/express/save", adminAuth, AdminCrud.adminExpressSave);
adminapiRoutes.delete("/express/del/:id", adminAuth, AdminCrud.adminExpressDel);

// ─── 营销活动创建/编辑/删除 (M20) ─────────────────────────
adminapiRoutes.post("/activity/save", adminAuth, AdminCrud.adminActivitySave);
adminapiRoutes.delete("/activity/del/:type/:id", adminAuth, AdminCrud.adminActivityDel);

// ─── 统计趋势 + 标签 (M21) ─────────────────────────────────
adminapiRoutes.get("/statistic/trend", adminAuth, AdminController.adminStatisticTrend);
adminapiRoutes.get("/statistic/rank", adminAuth, AdminController.adminStatisticRank);
adminapiRoutes.get("/product_label/list", adminAuth, AdminCrud.adminProductLabelList);
adminapiRoutes.post("/product_label/save", adminAuth, AdminCrud.adminProductLabelSave);
adminapiRoutes.delete("/product_label/del/:id", adminAuth, AdminCrud.adminProductLabelDel);
adminapiRoutes.get("/user_label/list", adminAuth, AdminCrud.adminUserLabelList);
adminapiRoutes.post("/user_label/save", adminAuth, AdminCrud.adminUserLabelSave);
adminapiRoutes.delete("/user_label/del/:id", adminAuth, AdminCrud.adminUserLabelDel);

// ─── DIY + CMS + 系统工具 (M22) ──────────────────────────────
adminapiRoutes.get("/dise/list", adminAuth, AdminCrud.adminDiseList);
adminapiRoutes.post("/dise/save", adminAuth, AdminCrud.adminDiseSave);
adminapiRoutes.delete("/dise/del/:id", adminAuth, AdminCrud.adminDiseDel);
adminapiRoutes.get("/diy/get_page_category", adminAuth, PageNavigationController.getPageCategory);
adminapiRoutes.get("/diy/get_page_link/:cate_id", adminAuth, PageNavigationController.getPageLinks);
adminapiRoutes.post("/diy/save_link/:cate_id", adminAuth, PageNavigationController.savePageLink);
adminapiRoutes.delete("/diy/del_link/:id", adminAuth, PageNavigationController.deletePageLink);
adminapiRoutes.get("/diy/get_url", adminAuth, AdminLegacyContent.getUniAppUrls);
adminapiRoutes.get("/diy/open_adv/info", adminAuth, AdminLegacyContent.getOpenAdv);
adminapiRoutes.post("/diy/open_adv/add", adminAuth, AdminLegacyContent.setOpenAdv);
adminapiRoutes.get("/article/list", adminAuth, AdminArticle.list);
adminapiRoutes.get("/article/detail/:id", adminAuth, AdminArticle.detail);
adminapiRoutes.post("/article/save", adminAuth, AdminArticle.save);
adminapiRoutes.delete("/article/del/:id", adminAuth, AdminArticle.remove);
adminapiRoutes.get("/article/category", adminAuth, AdminArticle.categoryList);
adminapiRoutes.post("/article/category", adminAuth, AdminArticle.createCategory);
adminapiRoutes.put("/article/category/:id", adminAuth, AdminArticle.updateCategory);
adminapiRoutes.put("/article/category/:id/status", adminAuth, AdminArticle.categoryStatus);
adminapiRoutes.delete("/article/category/:id", adminAuth, AdminArticle.removeCategory);
adminapiRoutes.get("/article/product-options", adminAuth, AdminArticle.productOptions);
adminapiRoutes.get("/article/attachment-options", adminAuth, AdminArticle.attachmentOptions);
adminapiRoutes.get("/article/attachment-categories", adminAuth, AdminArticle.attachmentCategories);
adminapiRoutes.get("/log/list", adminAuth, AdminCrud.adminLogList);

// ─── 分销管理 + 通知模板 + 短信配置 (M24) ─────────────────
adminapiRoutes.get("/spread/list", adminAuth, AdminCrud.adminSpreadList);
adminapiRoutes.get("/brokerage/list", adminAuth, AdminCrud.adminBrokerageList);
adminapiRoutes.get("/promoter/apply/list", adminAuth, PromoterApplicationController.adminList);
adminapiRoutes.get(
  "/promoter/apply/examine/:id/:uid/:status",
  adminAuth,
  PromoterApplicationController.adminExamine,
);
adminapiRoutes.delete(
  "/promoter/apply/del/:id",
  adminAuth,
  PromoterApplicationController.adminDelete,
);
// Supplier onboarding keeps the PHP route contract but closes the legacy IDOR
// and replaces predictable default passwords with user-driven SMS activation.
adminapiRoutes.get("/supplier/apply/list", adminAuth, SupplierApplicationController.adminList);
adminapiRoutes.get("/supplier/apply/info/:id", adminAuth, SupplierApplicationController.adminDetail);
adminapiRoutes.get("/supplier/apply/verify/form/:id", adminAuth, SupplierApplicationController.adminReviewForm);
adminapiRoutes.post("/supplier/apply/verify/:id", adminAuth, SupplierApplicationController.adminReview);
adminapiRoutes.get("/supplier/apply/mark/form/:id", adminAuth, SupplierApplicationController.adminMarkForm);
adminapiRoutes.post("/supplier/apply/mark/:id", adminAuth, SupplierApplicationController.adminMark);
adminapiRoutes.delete("/supplier/apply/del/:id", adminAuth, SupplierApplicationController.adminDelete);
// 事业部/代理商/员工层级管理与报表
adminapiRoutes.get("/agent/division/list", adminAuth, AdminDivision.divisionList);
adminapiRoutes.get("/agent/division/down_list", adminAuth, AdminDivision.divisionList);
adminapiRoutes.get("/agent/division/detail/:uid", adminAuth, AdminDivision.divisionDetail);
adminapiRoutes.post("/agent/division/save", adminAuth, AdminDivision.saveDivision);
adminapiRoutes.post("/agent/division_agent/save", adminAuth, AdminDivision.saveAgent);
adminapiRoutes.post("/agent/division_staff/save", adminAuth, AdminDivision.saveStaff);
adminapiRoutes.delete("/agent/division/del/:uid", adminAuth, AdminDivision.deleteDivisionRole);
adminapiRoutes.put("/agent/division/status/:uid/:status", adminAuth, AdminDivision.setDivisionStatus);
adminapiRoutes.get("/agent/division/order/list", adminAuth, AdminDivision.divisionOrders);
adminapiRoutes.get("/agent/division/option", adminAuth, AdminDivision.divisionOptions);
adminapiRoutes.get("/agent/division/agent_option/:divisionId", adminAuth, AdminDivision.agentOptions);
adminapiRoutes.get("/agent/division/statistics", adminAuth, AdminDivision.divisionStatistics);
adminapiRoutes.get("/agent/division/trend", adminAuth, AdminDivision.divisionTrend);
adminapiRoutes.get("/agent/division/ranking", adminAuth, AdminDivision.divisionRanking);
adminapiRoutes.get("/agent/division/apply/list", adminAuth, AdminDivision.applicationList);
adminapiRoutes.post("/agent/division/apply/examine/save", adminAuth, AdminDivision.applicationReview);
adminapiRoutes.delete("/agent/division/apply/del/:id", adminAuth, AdminDivision.applicationDelete);
adminapiRoutes.get("/notification/list", adminAuth, AdminNotification.templateList);
adminapiRoutes.post("/notification/save", adminAuth, AdminNotification.templateSave);
adminapiRoutes.get("/notification/order-config", adminAuth, AdminNotification.orderConfigList);
adminapiRoutes.put("/notification/order-config/:mark", adminAuth, AdminNotification.orderConfigSave);
adminapiRoutes.put("/notification/shipping", adminAuth, AdminNotification.shippingConfigSave);
adminapiRoutes.get("/notification/readiness", adminAuth, AdminNotification.readiness);
adminapiRoutes.get("/notification/deliveries", adminAuth, AdminNotification.deliveryList);
adminapiRoutes.get("/notification/deliveries/:id/actions", adminAuth, AdminNotification.deliveryActions);
adminapiRoutes.post("/notification/deliveries/:id/confirm-sent", adminAuth, AdminNotification.deliveryConfirmSent);
adminapiRoutes.post("/notification/deliveries/:id/confirm-retry", adminAuth, AdminNotification.deliveryConfirmRetry);
adminapiRoutes.post("/notification/deliveries/:id/close", adminAuth, AdminNotification.deliveryClose);
adminapiRoutes.get("/sms/config", adminAuth, AdminNotification.smsConfig);
adminapiRoutes.post("/sms/config", adminAuth, AdminNotification.smsConfigSave);

// ─── 社区内容、话题与评论运营 ───────────────────────────────
adminapiRoutes.get("/community/settings", adminAuth, AdminCommunity.communitySettings);
adminapiRoutes.post("/community/settings", adminAuth, AdminCommunity.saveCommunitySettings);
adminapiRoutes.get("/community/all_topic", adminAuth, AdminCommunity.allTopics);
adminapiRoutes.get("/community/topic/list", adminAuth, AdminCommunity.topicList);
adminapiRoutes.get("/community/topic/save_form/:id", adminAuth, AdminCommunity.topicForm);
adminapiRoutes.post("/community/topic/save/:id", adminAuth, AdminCommunity.topicSave);
// PHP kept these two mutations on GET; permission resolution explicitly maps
// them to community.manage so a view-only operator cannot change state.
adminapiRoutes.get("/community/topic/set_status/:id/:status", adminAuth, AdminCommunity.topicStatus);
adminapiRoutes.get("/community/topic/set_hot/:id/:hot", adminAuth, AdminCommunity.topicRecommend);
adminapiRoutes.delete("/community/topic/del/:id", adminAuth, AdminCommunity.topicDelete);

adminapiRoutes.get("/community/community/header", adminAuth, AdminCommunity.postHeader);
adminapiRoutes.get("/community/community/list", adminAuth, AdminCommunity.postList);
adminapiRoutes.get("/community/community/info/:id", adminAuth, AdminCommunity.postInfo);
adminapiRoutes.post("/community/community/save/:id", adminAuth, AdminCommunity.postSave);
adminapiRoutes.post("/community/community/set_status/:id/:status", adminAuth, AdminCommunity.postStatus);
adminapiRoutes.get("/community/community/star/form/:id", adminAuth, AdminCommunity.postStarForm);
adminapiRoutes.post("/community/community/star/:id", adminAuth, AdminCommunity.postStar);
adminapiRoutes.post(
  "/community/community/set_recommend/:id/:recommend",
  adminAuth,
  AdminCommunity.postRecommend,
);
adminapiRoutes.get("/community/community/verify/form/:id", adminAuth, AdminCommunity.postVerifyForm);
adminapiRoutes.get("/community/community/take_down/form/:id", adminAuth, AdminCommunity.postTakeDownForm);
adminapiRoutes.post("/community/community/set_verify/:id", adminAuth, AdminCommunity.postVerify);
adminapiRoutes.delete("/community/community/del/:id", adminAuth, AdminCommunity.postDelete);

adminapiRoutes.get("/community/comment/list", adminAuth, AdminCommunity.commentList);
adminapiRoutes.get("/community/comment/reply/:id", adminAuth, AdminCommunity.commentReplies);
adminapiRoutes.get("/community/comment/reply/form/:id", adminAuth, AdminCommunity.commentReplyForm);
adminapiRoutes.post("/community/comment/reply/:id", adminAuth, AdminCommunity.commentReply);
adminapiRoutes.delete("/community/comment/del/:id", adminAuth, AdminCommunity.commentDelete);
adminapiRoutes.get("/community/comment/verify/form/:id", adminAuth, AdminCommunity.commentVerifyForm);
adminapiRoutes.get("/community/comment/take_down/form/:id", adminAuth, AdminCommunity.commentTakeDownForm);
adminapiRoutes.put("/community/comment/set_status/:id/:status", adminAuth, AdminCommunity.commentStatus);
adminapiRoutes.post("/community/comment/set_verify/:id", adminAuth, AdminCommunity.commentVerify);
adminapiRoutes.get("/community/comment/fictitious/:id", adminAuth, AdminCommunity.fictitiousCommentForm);
adminapiRoutes.post(
  "/community/comment/save_fictitious",
  adminAuth,
  AdminCommunity.saveFictitiousComment,
);

// ─── 未实现端点兜底 (必须最后注册, 否则吞掉后续路由) ─────────
adminapiRoutes.all("/*", (c) =>
  c.json({ status: 501, msg: `接口 ${c.req.path} 尚未迁移到 Workers`, data: null }),
);
