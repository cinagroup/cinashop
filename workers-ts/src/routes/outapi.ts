import { Hono } from "hono";
import type { AppVariables, Env } from "@/env";
import { outAuthMiddleware } from "@/middleware/out-auth";
import * as OutApiController from "@/controllers/out/OutApiController";

export const outapiRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

outapiRoutes.post("/get_token", OutApiController.getToken);
outapiRoutes.post("/refresh_token", OutApiController.refreshToken);

outapiRoutes.post(
  "/category",
  outAuthMiddleware("POST", "/category"),
  OutApiController.categoryCreate,
);
outapiRoutes.put(
  "/category/set_show/:id/:is_show",
  outAuthMiddleware("PUT", "/category/set_show/{id}/{is_show}"),
  OutApiController.categorySetShow,
);
outapiRoutes.put(
  "/category/:id",
  outAuthMiddleware("PUT", "/category/{id}"),
  OutApiController.categoryUpdate,
);
outapiRoutes.delete(
  "/category/:id",
  outAuthMiddleware("DELETE", "/category/{id}"),
  OutApiController.categoryDelete,
);
outapiRoutes.get(
  "/category/list",
  outAuthMiddleware("GET", "/category/list"),
  OutApiController.categoryList,
);
outapiRoutes.get(
  "/category/:id",
  outAuthMiddleware("GET", "/category/{id}"),
  OutApiController.categoryInfo,
);
outapiRoutes.get(
  "/product/list",
  outAuthMiddleware("GET", "/product/list"),
  OutApiController.productList,
);
outapiRoutes.post(
  "/product",
  outAuthMiddleware("POST", "/product"),
  OutApiController.productCreate,
);
outapiRoutes.put(
  "/product/stock/upload",
  outAuthMiddleware("PUT", "/product/stock/upload"),
  OutApiController.productStockUpload,
);
outapiRoutes.put(
  "/product/set_show/:id/:is_show",
  outAuthMiddleware("PUT", "/product/set_show/{id}/{is_show}"),
  OutApiController.productSetShow,
);
outapiRoutes.put(
  "/product/:id",
  outAuthMiddleware("PUT", "/product/{id}"),
  OutApiController.productUpdate,
);
outapiRoutes.get(
  "/product/:id",
  outAuthMiddleware("GET", "/product/{id}"),
  OutApiController.productInfo,
);
outapiRoutes.get(
  "/order/list",
  outAuthMiddleware("GET", "/order/list"),
  OutApiController.orderList,
);
outapiRoutes.get(
  "/order/express_list",
  outAuthMiddleware("GET", "/order/express_list"),
  OutApiController.expressList,
);
outapiRoutes.get(
  "/order/split_cart_info/:order_id",
  outAuthMiddleware("GET", "/order/split_cart_info/{order_id}"),
  OutApiController.splitCartInfo,
);
outapiRoutes.put(
  "/order/delivery/:order_id",
  outAuthMiddleware("PUT", "/order/delivery/{order_id}"),
  OutApiController.orderDelivery,
);
outapiRoutes.put(
  "/order/distribution/:order_id",
  outAuthMiddleware("PUT", "/order/distribution/{order_id}"),
  OutApiController.orderDistribution,
);
outapiRoutes.put(
  "/order/invoice/:order_id",
  outAuthMiddleware("PUT", "/order/invoice/{order_id}"),
  OutApiController.orderInvoice,
);
outapiRoutes.put(
  "/order/invoice_status/:order_id",
  outAuthMiddleware("PUT", "/order/invoice_status/{order_id}"),
  OutApiController.orderInvoiceStatus,
);
outapiRoutes.put(
  "/order/remark/:order_id",
  outAuthMiddleware("PUT", "/order/remark/{order_id}"),
  OutApiController.orderRemark,
);
outapiRoutes.put(
  "/order/receive/:order_id",
  outAuthMiddleware("PUT", "/order/receive/{order_id}"),
  OutApiController.orderReceive,
);
outapiRoutes.put(
  "/order/split_delivery/:order_id",
  outAuthMiddleware("PUT", "/order/split_delivery/{order_id}"),
  OutApiController.orderSplitDelivery,
);
outapiRoutes.get(
  "/order/:order_id",
  outAuthMiddleware("GET", "/order/{order_id}"),
  OutApiController.orderInfo,
);
outapiRoutes.get(
  "/refund/list",
  outAuthMiddleware("GET", "/refund/list"),
  OutApiController.refundList,
);
outapiRoutes.put(
  "/refund/remark/:order_id",
  outAuthMiddleware("PUT", "/refund/remark/{order_id}"),
  OutApiController.refundRemark,
);
outapiRoutes.put(
  "/refund/agree/:order_id",
  outAuthMiddleware("PUT", "/refund/agree/{order_id}"),
  OutApiController.refundAgree,
);
outapiRoutes.put(
  "/refund/refuse/:order_id",
  outAuthMiddleware("PUT", "/refund/refuse/{order_id}"),
  OutApiController.refundRefuse,
);
outapiRoutes.put(
  "/refund/:order_id",
  outAuthMiddleware("PUT", "/refund/{order_id}"),
  OutApiController.refundPrice,
);
outapiRoutes.get(
  "/refund/:order_id",
  outAuthMiddleware("GET", "/refund/{order_id}"),
  OutApiController.refundInfo,
);
outapiRoutes.get(
  "/coupon/list",
  outAuthMiddleware("GET", "/coupon/list"),
  OutApiController.couponList,
);
outapiRoutes.get(
  "/user_level/list",
  outAuthMiddleware("GET", "/user_level/list"),
  OutApiController.userLevelList,
);
outapiRoutes.get(
  "/user/list",
  outAuthMiddleware("GET", "/user/list"),
  OutApiController.userList,
);
outapiRoutes.get(
  "/user/info/:uid",
  outAuthMiddleware("GET", "/user/info/{uid}"),
  OutApiController.userInfo,
);

outapiRoutes.all("/*", (c) => c.json({
  status: 501,
  msg: `接口 ${c.req.path} 尚未安全迁移到 Workers`,
  data: { runtime_status: "not_migrated" },
}, 501));
