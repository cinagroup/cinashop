import { Hono } from "hono";
import * as ShippingCreation from '@/controllers/product/ShippingTemplateCreationController';
import type { AppVariables, Env } from "@/env";
import { supplierAuthMiddleware } from "@/middleware/supplier-auth";
import { supplierPermissionMiddleware } from "@/middleware/supplier-permission";
import * as SupplierController from "@/controllers/supplier/SupplierController";
import * as SupplierOrderTracking from '@/controllers/supplier/SupplierOrderTrackingController';
import * as SupplierOrderDistribution from "@/controllers/supplier/SupplierOrderDistributionController";
import * as ProductShippingOptions from '@/controllers/supplier/SupplierProductShippingOptionsController';
import * as SupplierQueueController from "@/controllers/supplier/SupplierQueueController";
import * as SupplierExportController from "@/controllers/supplier/SupplierExportController";
import * as SupplierProductReplyController from "@/controllers/supplier/SupplierProductReplyController";
import * as SupplierProductDetailRead from '@/controllers/supplier/SupplierProductDetailReadController';
import * as SupplierProductCatalogController from "@/controllers/supplier/SupplierProductCatalogController";
import * as SupplierCategory from "@/controllers/supplier/SupplierProductCategoryController";
import * as SupplierBatch from "@/controllers/supplier/SupplierProductBatchController";
import * as SupplierLabels from '@/controllers/supplier/SupplierProductLabelController';
import * as SupplierProductRules from '@/controllers/supplier/SupplierProductRuleController';
import * as SupplierProductRecycle from '@/controllers/supplier/SupplierProductRecycleController';
import * as PrintDocumentController from "@/controllers/system/PrintDocumentController";
import * as PrintJobController from "@/controllers/system/PrintJobController";
import * as WaybillJobController from "@/controllers/system/WaybillJobController";
import * as SupplierVideo from '@/controllers/supplier/SupplierProductVideoController';
import * as SupplierProductCopy from '@/controllers/supplier/SupplierProductCopyController';
import * as SupplierUnpaidOrderEdit from '@/controllers/supplier/SupplierUnpaidOrderEditController';
import * as SupplierOfflinePayment from '@/controllers/supplier/SupplierOfflinePaymentController';
import * as SupplierManualRefund from '@/controllers/supplier/SupplierManualRefundController';
import * as SupplierProactiveRefund from '@/controllers/supplier/SupplierProactiveRefundController';
import * as SupplierExtractApplication from '@/controllers/supplier/SupplierExtractApplicationController';
import * as SupplierFinanceAccounts from '@/controllers/supplier/SupplierFinanceAccountsController';
import * as SupplierExtractMedia from '@/controllers/supplier/SupplierExtractMediaController';
import * as SupplierExtractApplicationMedia from '@/controllers/supplier/SupplierExtractApplicationMediaController';
import * as AttachmentController from "@/controllers/system/AttachmentController";
import * as VirtualProductInventory from "@/controllers/api/v1/VirtualProductInventoryController";

export const supplierapiRoutes = new Hono<{
  Bindings: Env;
  Variables: AppVariables;
}>();

// 旧 Supplier 前端兼容的公开端点。
supplierapiRoutes.post("/login", SupplierController.login);
supplierapiRoutes.get("/login/info", SupplierController.loginInfo);
supplierapiRoutes.post("/is_captcha", (c) =>
  c.json({ status: 200, msg: "ok", data: { is_captcha: false } }),
);

supplierapiRoutes.use('/setting/shipping_templates/*', ShippingCreation.privateResponse);
supplierapiRoutes.use('/product/product/shipping-template-options', ShippingCreation.privateResponse);
supplierapiRoutes.use('/product/product/shipping-template-options/*', ShippingCreation.privateResponse);
supplierapiRoutes.use('/product/product/get_template', ShippingCreation.privateResponse);
supplierapiRoutes.use("/product/product_label", SupplierProductCatalogController.privateResponse);
supplierapiRoutes.use('/product/all_label', SupplierLabels.privateResponse);
supplierapiRoutes.use('/product/label/*', SupplierLabels.privateResponse);
supplierapiRoutes.use("/product/brand/cascader_list", SupplierProductCatalogController.privateResponse);
supplierapiRoutes.use("/product/brand/cascader_list/*", SupplierProductCatalogController.privateResponse);
supplierapiRoutes.use("/product/category", SupplierCategory.privateResponse);
supplierapiRoutes.use("/product/category/*", SupplierCategory.privateResponse);
supplierapiRoutes.use('/product/batch_process', SupplierBatch.privateResponse);
supplierapiRoutes.use('/product/batch_process/*', SupplierBatch.privateResponse);
supplierapiRoutes.use('/product/product/batch-selection', SupplierBatch.privateResponse);
supplierapiRoutes.use('/product/product/batch-selection/*', SupplierBatch.privateResponse);
supplierapiRoutes.use('/product/product/rule', SupplierProductRules.privateResponse);
supplierapiRoutes.use('/product/product/rule/*', SupplierProductRules.privateResponse);
supplierapiRoutes.use('/product/product/get_rule', SupplierProductRules.privateResponse);
supplierapiRoutes.use('/product/product/get_rule/*', SupplierProductRules.privateResponse);
supplierapiRoutes.use('/product/product', SupplierProductRecycle.privateResponse);
supplierapiRoutes.use('/product/product/*', SupplierProductRecycle.privateResponse);
supplierapiRoutes.use('/product/type_header', SupplierProductRecycle.privateResponse);
supplierapiRoutes.use('/order/express/*', SupplierOrderTracking.privateResponse);
supplierapiRoutes.use('/order/distribution/*', SupplierOrderDistribution.privateResponse);
supplierapiRoutes.use('/order/refund', SupplierProactiveRefund.privateResponse);
supplierapiRoutes.use('/order/refund/*', SupplierProactiveRefund.privateResponse);
supplierapiRoutes.use('/order/refund_operations', SupplierProactiveRefund.privateResponse);
supplierapiRoutes.use('/order/refund_operations/*', SupplierProactiveRefund.privateResponse);
supplierapiRoutes.use('/finance/supplier_flowing_water/fund_record', SupplierController.financeBillPrivateResponse);
supplierapiRoutes.use('/finance/supplier_flowing_water/fund_record_info', SupplierController.financeBillPrivateResponse);
supplierapiRoutes.use('/export/financeRecord', SupplierController.financeBillPrivateResponse);
supplierapiRoutes.use('/finance/supplier_flowing_water/list', SupplierController.financeBillPrivateResponse);
supplierapiRoutes.use('/finance/supplier_flowing_water/type', SupplierController.financeBillPrivateResponse);
supplierapiRoutes.use('/finance/supplier_flowing_water/mark/*', SupplierController.financeBillPrivateResponse);
supplierapiRoutes.use('/finance/info', SupplierFinanceAccounts.privateResponse);
supplierapiRoutes.use('/finance/supplier_extract/:id/media', SupplierExtractMedia.privateResponse);
supplierapiRoutes.use('/finance/supplier_extract/cash', SupplierExtractApplication.privateResponse);
supplierapiRoutes.use('/finance/supplier_extract/application_operations/*', SupplierExtractApplication.privateResponse);
supplierapiRoutes.use('/finance/supplier_extract/application_operations/:operationId/media', SupplierExtractApplicationMedia.privateResponse);
supplierapiRoutes.use('/finance/supplier_extract/list', SupplierController.financeBillPrivateResponse);
supplierapiRoutes.use('/finance/supplier_extract/mark/*', SupplierController.financeBillPrivateResponse);
supplierapiRoutes.use("/*", supplierAuthMiddleware);
supplierapiRoutes.use("/*", supplierPermissionMiddleware);

supplierapiRoutes.get("/logout", SupplierController.logout);
supplierapiRoutes.get("/logo", SupplierController.logo);
supplierapiRoutes.get("/config", SupplierController.config);
supplierapiRoutes.get("/jnotice", SupplierController.notices);
supplierapiRoutes.get("/city", SupplierController.city);
supplierapiRoutes.get("/menusList", SupplierController.menusList);
supplierapiRoutes.put("/updatePwd", SupplierController.updatePassword);
supplierapiRoutes.get("/config/edit_new_build/:type", SupplierController.storeConfigForm);
supplierapiRoutes.get("/config/store/:type", SupplierController.storeConfigForm);
supplierapiRoutes.post("/config", SupplierController.saveStoreConfig);
supplierapiRoutes.get("/system/config/edit_new_build/:type", SupplierController.storeConfigForm);
supplierapiRoutes.post("/system/config", SupplierController.saveStoreConfig);
supplierapiRoutes.get("/supplier", SupplierController.profile);
supplierapiRoutes.put("/supplier", SupplierController.updateProfile);

supplierapiRoutes.get("/admin", SupplierController.supplierAdminList);
supplierapiRoutes.get("/admin/create", SupplierController.supplierAdminCreateForm);
supplierapiRoutes.get("/admin/roles", SupplierController.supplierRoleList);
supplierapiRoutes.post("/admin/roles", SupplierController.createSupplierRole);
supplierapiRoutes.put("/admin/roles/:id", SupplierController.updateSupplierRole);
supplierapiRoutes.delete("/admin/roles/:id", SupplierController.deleteSupplierRole);
supplierapiRoutes.post("/admin", SupplierController.createSupplierAdmin);
supplierapiRoutes.get("/admin/:id/edit", SupplierController.supplierAdminEditForm);
supplierapiRoutes.get("/admin/:id", SupplierController.supplierAdminDetail);
supplierapiRoutes.put("/admin/:id", SupplierController.updateSupplierAdmin);
supplierapiRoutes.delete("/admin/:id", SupplierController.deleteSupplierAdmin);
supplierapiRoutes.put("/admin/set_status/:id/:status", SupplierController.setSupplierAdminStatus);

supplierapiRoutes.get("/file/file", AttachmentController.supplierList);
supplierapiRoutes.post("/file/file/delete", AttachmentController.supplierDelete);
supplierapiRoutes.put("/file/file/do_move", AttachmentController.supplierMove);
supplierapiRoutes.put("/file/file/update/:id", AttachmentController.supplierRename);
supplierapiRoutes.post("/file/upload", AttachmentController.supplierUploadImage);
supplierapiRoutes.post("/file/upload/:upload_type", AttachmentController.supplierUploadImage);
supplierapiRoutes.get("/file/upload_type", AttachmentController.supplierUploadType);
supplierapiRoutes.post("/file/video_upload", SupplierVideo.legacyUpload);
supplierapiRoutes.post("/file/video_attachment", SupplierVideo.registerExternal);
supplierapiRoutes.put('/file/video_uploads/:uploadId', SupplierVideo.initialize);
supplierapiRoutes.get('/file/video_uploads/:uploadId', SupplierVideo.query);
supplierapiRoutes.put('/file/video_uploads/:uploadId/parts/:part', SupplierVideo.part);
supplierapiRoutes.post('/file/video_uploads/:uploadId/complete', SupplierVideo.complete);
supplierapiRoutes.post('/file/video_uploads/:uploadId/cancel', SupplierVideo.cancel);
supplierapiRoutes.get('/file/video_uploads/:uploadId/preview', SupplierVideo.preview);
supplierapiRoutes.get("/file/get/way_data", AttachmentController.supplierUploadWayData);
supplierapiRoutes.get("/file/category", AttachmentController.supplierCategories);
supplierapiRoutes.get("/file/category/create", AttachmentController.supplierCategoryCreateForm);
supplierapiRoutes.get("/file/category/create/:parentId", AttachmentController.supplierCategoryCreateForm);
supplierapiRoutes.post("/file/category", AttachmentController.supplierCategorySave);
supplierapiRoutes.get("/file/category/:id/edit", AttachmentController.supplierCategoryEditForm);
supplierapiRoutes.put("/file/category/:id", AttachmentController.supplierCategoryUpdate);
supplierapiRoutes.delete("/file/category/:id", AttachmentController.supplierCategoryDelete);

supplierapiRoutes.get("/home/dashboard", SupplierController.dashboard);
supplierapiRoutes.get("/home/header", SupplierController.homeSummary);
supplierapiRoutes.get("/home/order", SupplierController.homeOrderChart);
supplierapiRoutes.get("/home/order_channel", SupplierController.homeOrderChannel);
supplierapiRoutes.get("/home/order_type", SupplierController.homeOrderType);

// Supplier review authority is established by both the reply owner tuple and
// the joined Supplier-owned product. The legacy unscoped DELETE is retired.
supplierapiRoutes.get("/product/reply", SupplierProductReplyController.list);
supplierapiRoutes.put("/product/reply/set_reply/:id", SupplierProductReplyController.setReply);

supplierapiRoutes.get("/system/form/info/:id", SupplierController.systemFormInfo);
supplierapiRoutes.get("/system/form/all_system_form", SupplierController.systemFormAll);

// Legacy queue rows are historical evidence only. Both reads join auxiliary
// relation_id to an order owned by the authenticated Supplier; opaque payloads
// and the old GET mutation contracts are intentionally not exposed.
supplierapiRoutes.get("/queue/index", SupplierQueueController.queueList);
supplierapiRoutes.get("/queue/delivery/log/:id/:type", SupplierQueueController.deliveryLog);

// Legacy browser-side spreadsheet manifests. Every query is bounded, tenant
// scoped and formula-neutralized; no historical queue payload is exported.
supplierapiRoutes.get("/export/storeOrder", SupplierExportController.storeOrder);
supplierapiRoutes.get("/export/expressList", SupplierExportController.expressList);
supplierapiRoutes.get("/export/batchOrderDelivery/:id/:queueType/:cacheType", SupplierExportController.batchOrderDelivery);
supplierapiRoutes.get("/export/financeRecord", SupplierExportController.financeRecord);

supplierapiRoutes.get("/printing", SupplierController.legacyPrinting);
supplierapiRoutes.put("/printing", SupplierController.updateLegacyPrinting);

supplierapiRoutes.get(
  "/setting/shipping_templates/list",
  SupplierController.shippingTemplateList,
);
supplierapiRoutes.get(
  "/setting/shipping_templates/:id/edit",
  SupplierController.shippingTemplateDetail,
);
supplierapiRoutes.post(
  "/setting/shipping_templates/save/:id",
  ShippingCreation.supplierSave,
);
supplierapiRoutes.post('/setting/shipping_templates/creation-receipt', ShippingCreation.supplierReceipt);
supplierapiRoutes.delete(
  "/setting/shipping_templates/del/:id",
  SupplierController.deleteShippingTemplate,
);
supplierapiRoutes.get(
  "/setting/shipping_templates/city_list",
  SupplierController.shippingTemplateCityList,
);

// Active receipt-printer definitions. The old /printing single-row table is
// represented through the scoped config service; it is not a second runtime authority.
supplierapiRoutes.get("/print/list", PrintDocumentController.supplierList);
supplierapiRoutes.get("/print/form/:id", PrintDocumentController.supplierDetail);
supplierapiRoutes.post("/print/save/:id", PrintDocumentController.supplierSave);
supplierapiRoutes.post("/print/set_status/:id/:status", PrintDocumentController.supplierSetStatus);
supplierapiRoutes.put("/print/set_status/:id/:status", PrintDocumentController.supplierSetStatus);
supplierapiRoutes.delete("/print/del/:id", PrintDocumentController.supplierDelete);
supplierapiRoutes.get("/print/content/:id", PrintDocumentController.supplierContent);
supplierapiRoutes.post("/print/save_content/:id", PrintDocumentController.supplierSaveContent);
supplierapiRoutes.get("/print/jobs", PrintJobController.supplierJobs);
supplierapiRoutes.get("/print/jobs/:id/actions", PrintJobController.supplierActions);
supplierapiRoutes.post("/print/jobs/:id/confirm-sent", PrintJobController.supplierConfirmSent);
supplierapiRoutes.post("/print/jobs/:id/confirm-retry", PrintJobController.supplierConfirmRetry);
supplierapiRoutes.post("/print/jobs/:id/close", PrintJobController.supplierClose);
supplierapiRoutes.get("/waybill/jobs", WaybillJobController.supplierJobs);
supplierapiRoutes.get("/waybill/jobs/:id/actions", WaybillJobController.supplierActions);
supplierapiRoutes.post("/waybill/jobs/:id/apply-existing", WaybillJobController.supplierApplyExisting);
supplierapiRoutes.post("/waybill/jobs/:id/confirm-issued", WaybillJobController.supplierConfirmIssued);
supplierapiRoutes.post("/waybill/jobs/:id/confirm-retry", WaybillJobController.supplierConfirmRetry);
supplierapiRoutes.post("/waybill/jobs/:id/close", WaybillJobController.supplierClose);

supplierapiRoutes.get('/product/product/copy/:id', SupplierProductCopy.seed);
supplierapiRoutes.post('/product/product/copy/:id', SupplierProductCopy.save);
supplierapiRoutes.get('/product/product/copy_operations/:operationId', SupplierProductCopy.receipt);
supplierapiRoutes.post('/product/product/copy_operations/:operationId/resolve', SupplierProductCopy.resolve);
supplierapiRoutes.get("/product/product/list", SupplierController.productList);
supplierapiRoutes.get("/product/product", SupplierController.productList);
supplierapiRoutes.get("/product/category", SupplierCategory.list);
supplierapiRoutes.get("/product/category/tree", SupplierCategory.modernTree);
supplierapiRoutes.get("/product/category/tree/:type", SupplierCategory.tier);
supplierapiRoutes.get("/product/category/cascader_list", SupplierCategory.cascader);
supplierapiRoutes.get("/product/category/cascader_list/:type", SupplierCategory.cascader);
supplierapiRoutes.get("/product/category/create", SupplierCategory.createForm);
supplierapiRoutes.get("/product/category/:id/detail", SupplierCategory.modernDetail);
supplierapiRoutes.get("/product/get_all_unit", SupplierController.productUnits);
supplierapiRoutes.get("/product/all_ensure", SupplierController.productEnsures);
supplierapiRoutes.get("/product/all_specs", SupplierController.productSpecsAll);
supplierapiRoutes.get("/product/product_label", SupplierProductCatalogController.labels);
supplierapiRoutes.get('/product/all_label', SupplierLabels.all);
supplierapiRoutes.get('/product/label/catalog', SupplierLabels.catalog);
supplierapiRoutes.get('/product/label/form', SupplierLabels.form);
supplierapiRoutes.post('/product/label/:id', SupplierLabels.save);
supplierapiRoutes.delete('/product/label/:id', SupplierLabels.remove);
supplierapiRoutes.get("/product/brand/cascader_list", SupplierProductCatalogController.brands);
supplierapiRoutes.get("/product/brand/cascader_list/:type", SupplierProductCatalogController.brands);
supplierapiRoutes.get("/form/info/:id", SupplierController.systemFormInfo);
supplierapiRoutes.get("/form/all_system_form", SupplierController.systemFormAll);
supplierapiRoutes.get("/product/product/get_rule", SupplierController.productRuleTemplates);
// Product-view authority only; editor/read-write shipping permissions stay separate.
// Explicitly paged contract, not an incomplete alias of PHP's full get_template array.
supplierapiRoutes.get('/product/product/shipping-template-options', ProductShippingOptions.list);
supplierapiRoutes.get('/product/product/shipping-template-options/:id', ProductShippingOptions.detail);
supplierapiRoutes.get('/product/product/get_template', ProductShippingOptions.legacy);
supplierapiRoutes.get("/product/product/rule", SupplierController.productRuleList);
supplierapiRoutes.post("/product/product/rule/:id", SupplierController.productRuleSave);
supplierapiRoutes.get("/product/product/rule/:id", SupplierController.productRuleDetail);
supplierapiRoutes.delete(
  "/product/product/rule/delete/:id",
  SupplierController.productRuleDelete,
);
supplierapiRoutes.post("/product/category", SupplierCategory.create);
supplierapiRoutes.get("/product/category/:id", SupplierCategory.editForm);
supplierapiRoutes.put("/product/category/:id", SupplierCategory.update);
supplierapiRoutes.delete("/product/category/:id", SupplierCategory.remove);
supplierapiRoutes.put(
  "/product/category/set_show/:id/:is_show",
  SupplierCategory.setShow,
);
supplierapiRoutes.get("/product/product/attrs/:id", SupplierController.productDetail);
supplierapiRoutes.get("/product/product/virtual-alerts", VirtualProductInventory.supplierAlerts);
supplierapiRoutes.get("/product/product/virtual/:id", VirtualProductInventory.supplierInventory);
supplierapiRoutes.post("/product/product/virtual/:id/import", VirtualProductInventory.supplierImport);
supplierapiRoutes.post(
  "/product/product/virtual/:id/export-ticket",
  VirtualProductInventory.supplierCreateExportTicket,
);
supplierapiRoutes.post(
  "/product/product/virtual/:id/export",
  VirtualProductInventory.supplierConsumeExportTicket,
);
supplierapiRoutes.put("/product/product/saveStocks/:id", SupplierController.adjustProductStock);
supplierapiRoutes.post("/product/product/sku/retire", SupplierController.retireProductSkus);
supplierapiRoutes.post("/product/product/sku/restore", SupplierController.restoreProductSkus);
supplierapiRoutes.put("/product/product/batch_show/:is_show", SupplierController.batchSetProductShow);
supplierapiRoutes.put("/product/product/show", SupplierController.batchSetProductShow);
supplierapiRoutes.put("/product/product/product_show", SupplierController.batchProductShow);
supplierapiRoutes.put("/product/product/product_unshow", SupplierController.batchProductUnshow);
supplierapiRoutes.get('/product/product/batch-selection', SupplierBatch.selection);
supplierapiRoutes.post("/product/batch_process", SupplierBatch.apply);
supplierapiRoutes.post("/product/generate_attr/:id/:type", SupplierController.generateProductAttrs);
supplierapiRoutes.post("/product/product", SupplierController.createProduct);
supplierapiRoutes.post("/product/product/:id", SupplierController.saveProduct);
supplierapiRoutes.delete("/product/product/:id", SupplierController.recycleProduct);
supplierapiRoutes.delete('/product/product/thorough/:id', SupplierProductRecycle.thorough);
supplierapiRoutes.get('/product/type_header', SupplierProductRecycle.header);
supplierapiRoutes.put("/product/product/set_show/:id/:is_show", SupplierController.setProductShow);
supplierapiRoutes.get('/product/product/:id/view', SupplierProductDetailRead.read);
supplierapiRoutes.get("/product/product/:id", SupplierController.productDetail);

supplierapiRoutes.get("/order/list", SupplierController.orderList);
supplierapiRoutes.get('/order/edit/:id', SupplierUnpaidOrderEdit.seed);
supplierapiRoutes.put('/order/update/:id', SupplierUnpaidOrderEdit.save);
supplierapiRoutes.get('/order/refund/:id', SupplierProactiveRefund.seed);
supplierapiRoutes.put('/order/refund/:id', SupplierProactiveRefund.execute);
supplierapiRoutes.get('/order/refund_operations/:operationId', SupplierProactiveRefund.receipt);
supplierapiRoutes.post('/order/refund_operations/:operationId/resolve', SupplierProactiveRefund.resolve);
supplierapiRoutes.get('/order/edit_operations/:operationId', SupplierUnpaidOrderEdit.receipt);
supplierapiRoutes.post('/order/edit_operations/:operationId/resolve', SupplierUnpaidOrderEdit.resolve);
supplierapiRoutes.get('/order/pay_offline/:id', SupplierOfflinePayment.seed);
supplierapiRoutes.post('/order/pay_offline/:id', SupplierOfflinePayment.pay);
supplierapiRoutes.get('/order/payment_operations/:operationId', SupplierOfflinePayment.receipt);
supplierapiRoutes.post('/order/payment_operations/:operationId/resolve', SupplierOfflinePayment.resolve);
supplierapiRoutes.get("/order/distribution_info", SupplierController.pickingSheets);
supplierapiRoutes.get("/order/split_cart_info/:id", SupplierController.splitCartInfo);
supplierapiRoutes.put("/order/split_delivery/:id", SupplierController.splitDelivery);
supplierapiRoutes.get("/order/split_order/:id", SupplierController.splitOrders);
supplierapiRoutes.get("/order/info/:id", SupplierController.orderDetail);
supplierapiRoutes.post("/order/print/:id", PrintJobController.supplierManual);
supplierapiRoutes.post("/order/waybill/:id", WaybillJobController.supplierCreate);
supplierapiRoutes.put("/order/remark/:id", SupplierController.updateOrderRemark);
supplierapiRoutes.get("/order/express_list", SupplierController.expressList);
supplierapiRoutes.get('/order/express/:id', SupplierOrderTracking.read);
supplierapiRoutes.get('/order/distribution/:id', SupplierOrderDistribution.read);
supplierapiRoutes.put('/order/distribution/:id', SupplierOrderDistribution.save);
supplierapiRoutes.put("/order/delivery/:id", SupplierController.deliverOrder);
supplierapiRoutes.get("/order/status/:id", SupplierController.orderStatus);
supplierapiRoutes.put("/order/take/:id", SupplierController.confirmOrderTake);

supplierapiRoutes.get("/refund/list", SupplierController.refundList);
supplierapiRoutes.get('/refund/manual/:id', SupplierManualRefund.seed);
supplierapiRoutes.put('/refund/manual/:id', SupplierManualRefund.execute);
supplierapiRoutes.get('/refund/manual_operations/:operationId', SupplierManualRefund.receipt);
supplierapiRoutes.post('/refund/manual_operations/:operationId/resolve', SupplierManualRefund.resolve);
supplierapiRoutes.get("/refund/detail/:id", SupplierController.refundDetail);
supplierapiRoutes.get("/refund/refund/:id", SupplierController.refundForm);
supplierapiRoutes.get("/refund/reason", SupplierController.refundReasons);
supplierapiRoutes.put("/refund/remark/:id", SupplierController.updateRefundRemark);
supplierapiRoutes.put("/refund/agree/:id", SupplierController.agreeRefundReturn);
supplierapiRoutes.put("/refund/refuse/:id", SupplierController.refuseRefund);
supplierapiRoutes.put("/refund/refund/:id", SupplierController.refundOrder);

supplierapiRoutes.get("/finance/info", SupplierController.financeInfo);
supplierapiRoutes.post("/finance/info", SupplierController.updateFinanceInfo);
supplierapiRoutes.get("/finance/summary", SupplierController.financeSummary);
supplierapiRoutes.get("/finance/supplier_flowing_water/list", SupplierController.financeFlowList);
supplierapiRoutes.get("/finance/supplier_flowing_water/type", SupplierController.financeFlowTypes);
supplierapiRoutes.get('/finance/supplier_flowing_water/mark/:id', SupplierController.financeFlowMark);
supplierapiRoutes.post("/finance/supplier_flowing_water/mark/:id", SupplierController.updateFinanceFlowMark);
supplierapiRoutes.get("/finance/supplier_flowing_water/fund_record", SupplierController.financeFundRecord);
supplierapiRoutes.get("/finance/supplier_flowing_water/fund_record_info", SupplierController.financeFundRecordInfo);
supplierapiRoutes.get("/finance/supplier_extract/list", SupplierController.extractList);
supplierapiRoutes.get('/finance/supplier_extract/:id/media', SupplierExtractMedia.read);
supplierapiRoutes.get('/finance/supplier_extract/mark/:id', SupplierController.extractMark);
supplierapiRoutes.get("/finance/supplier_extract/cash", SupplierExtractApplication.seed);
supplierapiRoutes.post("/finance/supplier_extract/cash", SupplierController.applyExtract);
supplierapiRoutes.get('/finance/supplier_extract/application_operations/:operationId', SupplierExtractApplication.receipt);
supplierapiRoutes.get('/finance/supplier_extract/application_operations/:operationId/media', SupplierExtractApplicationMedia.read);
supplierapiRoutes.post('/finance/supplier_extract/application_operations/:operationId/resolve', SupplierExtractApplication.resolve);
supplierapiRoutes.post("/finance/supplier_extract/mark/:id", SupplierController.updateExtractMark);

supplierapiRoutes.all("/*", (c) =>
  c.json({ status: 501, msg: `接口 ${c.req.path} 尚未迁移到 Workers`, data: null }),
);
