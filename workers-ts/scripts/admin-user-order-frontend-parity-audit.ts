import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Status = "candidate" | "partial" | "missing" | "retired";
type Review = { status: Status; targetScreens: string[]; targetApis: string[]; covered: string[]; remaining: string[]; evidence: string[] };
type InventoryRoute = { source: string; line: number; path: string; title: string | null; component: string; resolvedComponent: string | null; surface: string };
const workerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Pin this review batch to its own navigation snapshot; the prior accepted
// inventory remains intact for historical acceptance capsules.
const invoiceFollowupReview = process.argv.includes("--invoice-followup");
const invoiceAdminReview = invoiceFollowupReview || process.argv.includes("--invoice-admin");
const paidMembershipReview = invoiceAdminReview || process.argv.includes("--paid-membership");
const inventoryName = invoiceFollowupReview ? "admin-frontend-inventory-invoice-followup-20260928.json"
  : invoiceAdminReview ? "admin-frontend-inventory-invoice-admin-20260928.json"
  : paidMembershipReview ? "admin-frontend-inventory-paid-membership-20260928.json" : "admin-frontend-inventory-20260928.json";
const outputName = invoiceFollowupReview ? "admin-legacy-user-order-route-parity-invoice-followup-20260928.json"
  : invoiceAdminReview ? "admin-legacy-user-order-route-parity-invoice-admin-20260928.json"
  : paidMembershipReview ? "admin-legacy-user-order-route-parity-paid-membership-20260928.json" : "admin-legacy-user-order-route-parity-20260928.json";
const inventoryFile = resolve(workerRoot, `audit/${inventoryName}`);
const outputFile = resolve(workerRoot, `audit/${outputName}`);
const oldRouterHashes: Record<string, string> = {
  "src/router/modules/user.js": "006d0e7ee1691bb696b694de425d07b28b829fbeaea90b5e248030651789ba76",
  "src/router/modules/order.js": "e081f68ac965cc276ba83471482e3658496a3f711e86716c359e965d2b19aefd",
};
// Reviewed static meta.auth snapshot; order queue has its auth declaration commented out.
const oldAuthByPath: Record<string, string> = {
  "/admin/order/list": "['admin-order-storeOrder-index']",
  "/admin/order/split_list": "['admin-order-storeOrder-index']",
  "/admin/order/offline": "['admin-order-offline']",
  "/admin/order/refund": "['admin-order-refund']",
  "/admin/order/invoice/list": "['admin-order-startOrderInvoice-index']",
  "/admin/order/queue/list": "none (commented out)",
  "/admin/user/list": "['admin-user-user-index']",
  "/admin/vipuser/level/list": "['user-user-level']",
  "/admin/user/group": "['user-user-group']",
  "/admin/user/label": "['user-user-label']",
  "/admin/user/recharge/:id": "['user-user-recharge']",
  "/admin/vipuser/grade/type": "['admin-user-member-type']",
  "/admin/vipuser/grade/card": "['admin-user-grade-card']",
  "/admin/vipuser/grade/record": "['admin-user-grade-record']",
  "/admin/vipuser/grade/right": "['admin-user-grade-right']",
  "/admin/vipuser/grade/list/:id": "['user-member_card-index']",
  "/admin/vipuser/grade/agreement": "['admin-user-grade-agreement']",
  "/admin/user/setup_user": "['user-user-setup_user']",
};
const oldBehaviorLineByPath: Record<string, number> = {
  "/admin/order/list": 10, "/admin/order/split_list": 68, "/admin/order/offline": 48,
  "/admin/order/refund": 24, "/admin/order/invoice/list": 174, "/admin/order/queue/list": 555,
  "/admin/user/list": 49, "/admin/vipuser/level/list": 237, "/admin/user/group": 96,
  "/admin/user/label": 64, "/admin/user/recharge/:id": 216,
  "/admin/vipuser/grade/type": 38, "/admin/vipuser/grade/card": 322,
  "/admin/vipuser/grade/record": 367, "/admin/vipuser/grade/right": 275,
  "/admin/vipuser/grade/list/:id": 107, "/admin/vipuser/grade/agreement": 100,
  "/admin/user/setup_user": 1585,
};
const screenFiles: Record<string, string> = {
  "/order": "view/admin-ts/src/pages/order/OrderList.vue",
  "/order/:orderId": "view/admin-ts/src/pages/order/OrderDetail.vue",
  "/order/offline": "view/admin-ts/src/pages/order/OfflineOrders.vue",
  "/refund": "view/admin-ts/src/pages/refund/RefundList.vue",
  "/operations/legacy-runtime": "view/admin-ts/src/pages/operations/LegacyRuntimeHistory.vue",
  "/user": "view/admin-ts/src/pages/user/UserList.vue",
  "/user/groups": "view/admin-ts/src/pages/user/UserGroups.vue",
  "/level": "view/admin-ts/src/pages/level/LevelList.vue",
  "/label": "view/admin-ts/src/pages/label/LabelList.vue",
  "/member": "view/admin-ts/src/pages/user/PaidMembership.vue",
  "/config/newcomer": "view/admin-ts/src/pages/config/NewcomerSettings.vue",
  "/config/level-activation": "view/admin-ts/src/pages/config/LevelActivationSettings.vue",
  "/config/paid-membership": "view/admin-ts/src/pages/config/PaidMembershipSettings.vue",
};
const screenPermissions: Record<string, string> = {
  "/order": "order.view", "/order/:orderId": "order.view", "/order/offline": "order.view",
  "/refund": "refund.view", "/operations/legacy-runtime": "legacy_runtime.view",
  "/user": "user.view", "/user/groups": "user.view", "/level": "level.view", "/label": "label.view",
  "/member": "paid_membership.view", "/config/newcomer": "config.view",
  "/config/level-activation": "config.view",
  "/config/paid-membership": "config.view",
};
const oldOrderApi = "cinashop-php/view/admin/src/api/order.js";
const oldUserApi = "cinashop-php/view/admin/src/api/user.js";
const oldSystemApi = "cinashop-php/view/admin/src/api/system.js";
const newRouter = "view/admin-ts/src/router/index.ts";
const newRoutes = "workers-ts/src/routes/adminapi.ts";
const permissions = "workers-ts/src/services/admin/AdminPermissionService.ts";
const reviews: Record<string, Review> = {};
function add(path: string, status: Status, targetScreens: string[], targetApis: string[], covered: string[], remaining: string[], evidence: string[] = []) {
  if (reviews[path]) throw new Error(`Duplicate user/order review: ${path}`);
  reviews[path] = { status, targetScreens, targetApis, covered, remaining, evidence };
}

add("/admin/order/list", "partial", ["/order", "/order/:orderId"], ["GET /adminapi/order/list", "GET /adminapi/order/detail/:id", "POST /adminapi/order/delivery/:id", "POST /adminapi/order/print/:id"], [
  "新订单页按订单号和状态分页查看当前履约单，可查主单及子单详情、打印、平台/快递/电子面单/虚拟发货与核销。",
], [
  "旧页还有多维时间、来源、门店/供应商、支付与用户筛选，以及备注、改价/改地址、线下支付、批量处理、导出、退货和删除等操作；新页未形成同等全流程，不能因主列表和若干写 API 判完成。",
], ["cinashop-php/view/admin/src/pages/order/orderList/orderlistDetails.vue", "cinashop-php/view/admin/src/pages/order/orderList/components/tableList.vue", "view/admin-ts/src/api/order.ts"]);
add("/admin/order/split_list", "partial", ["/order", "/order/:orderId"], ["GET /adminapi/order/list", "GET /adminapi/order/detail/:id"], [
  "新订单列表可用原支付单号找到当前子单，主单详情列出子单链接和状态，当前子单可逐一打开。",
], [
  "旧独立子订单表可按门店、供应商、状态和时间筛选并执行线下收款、发货、打印、备注、退款等操作；新页没有同等子单专用筛选及所有旧动作。",
], ["view/admin-ts/src/utils/orderRead.ts"]);
add("/admin/order/offline", "candidate", ["/order/offline"], ["GET /adminapi/order/scan_list", "GET /adminapi/order/offline_scan", "GET /adminapi/order/scan_detail/:id"], [
  "新页覆盖旧收银订单列表、订单号/用户/时间查询和 H5/小程序收银码，增加逐单本地收款凭据核验、状态说明和受限角色查看。",
], [
  "仍需在生产用真实旧记录、收款凭据、扫码设备和受限角色做只读/端到端验收；旧原支付标记不能直接作为到账结论。",
], ["view/admin-ts/src/api/offline.ts", "workers-ts/src/controllers/api/v1/AdminOfflineOrderController.ts"]);
add("/admin/order/refund", "partial", ["/refund"], ["GET /adminapi/refund/list", "GET /adminapi/refund/detail/:id", "POST /adminapi/refund/operations/execute/:id", "POST /adminapi/refund/operations/receipt"], [
  "新售后页可按单号/状态读取列表与详情，并通过版本化、带原请求键的操作合同处理退货、拒绝和退款，支持回执核对与恢复。",
], [
  "旧按原因/日期/申请类型筛选、ERP 分支、商品/门店/供应商范围等流程未逐项覆盖；旧 /refund/refund/:id 和 /refund/refuse/:id 明确返回 410，不能算迁移。真实支付渠道、退款回调及角色 E2E 仍待验收。",
], ["workers-ts/src/routes/admin-refund-operations.ts", "workers-ts/src/app.ts", "workers-ts/src/controllers/api/v1/AdminRefundOperationController.ts"]);
add("/admin/order/invoice/list", "missing", [], [], [], [
  "旧页有发票统计、开票状态/时间查询、个人/企业抬头详情、发票号/金额/备注录入及导出；新 Admin 无发票管理页或等价 Worker 管理合同。",
]);
add("/admin/order/queue/list", "partial", ["/operations/legacy-runtime"], ["GET /adminapi/queue/index", "GET /adminapi/queue/delivery/log/:id/:type"], [
  "新迁移历史页可按类型/状态查看旧 queue_list 任务进度和逐项结果。",
], [
  "旧组件虽然被登记为路由，实际是默认关闭的弹窗；从订单页可查看、下载、重试、停止或清除批量任务。新页只读旧记录，当前 Worker outbox/Queue 是独立权威，不能重放旧 PHP 任务。",
], ["view/admin-ts/src/api/legacyRuntime.ts", "workers-ts/src/services/system/LegacyRuntimeCatalogService.ts"]);
add("/admin/user/list", "partial", ["/user"], ["GET /adminapi/user/list", "GET /adminapi/user/info/:id", "POST /adminapi/user/update_other/:uid"], [
  "新用户页可按手机号分页查看基础用户信息、余额/积分/等级与推广摘要，打开详情并调整余额。",
], [
  "旧页可按分组、标签、性别、等级、付费会员、访问/订单/地域等维度筛选，并支持发券、标签/分组/等级批量设置、积分/时长调整、推广关系及导出；新页无这些操作入口。",
], ["view/admin-ts/src/api/order.ts"]);
add("/admin/vipuser/level/list", "partial", ["/level"], ["GET /adminapi/level/list", "POST /adminapi/level/save", "DELETE /adminapi/level/del/:id"], [
  "新等级页可列出、新增、编辑和删除等级，维护折扣、经验、颜色、说明和启用字段。",
], [
  "旧页还提供等级任务/奖励明细、筛选与独立状态切换；新 Admin 没有等级任务管理入口，需验证历史等级和消费方。",
], ["cinashop-php/view/admin/src/pages/user/level/handle/task.vue", "view/admin-ts/src/api/level.ts"]);
add("/admin/user/group", "candidate", ["/user/groups"], ["GET /adminapi/user_group/list", "POST /adminapi/user_group/save", "DELETE /adminapi/user_group/del/:id"], [
  "新用户分组页可按名称查询并分页查看分组，新增、编辑和删除分组；写操作按 user.manage 授权，已关联用户的分组由 Worker 拒绝删除。",
], [
  "旧表单名称上限20字，新页及Worker限64字，需确认运营是否接受扩展；仍需在生产用真实分组和受限角色核对名称、编辑及删除行为；用户批量分组设置属于旧用户列表流程，未因分组目录迁移而完成。",
], ["view/admin-ts/src/api/userGroups.ts", "workers-ts/src/services/user/UserSegmentationService.ts"]);
add("/admin/user/label", "partial", ["/label"], ["GET /adminapi/user_label/list", "POST /adminapi/user_label/save", "DELETE /adminapi/user_label/del/:id"], [
  "新标签页的用户 tab 可列出、新增、编辑和删除平面用户标签。",
], [
  "旧分类侧栏、分类增删改、按类筛选及企业微信标签同步不在新页；新用户标签 CRUD 不代表分类或远端同步能力。",
], ["view/admin-ts/src/pages/label/LabelList.vue"]);
add("/admin/user/recharge/:id", "missing", [], [], [], [
  "旧路由复用 system/group/list，以 gid 管理充值组合数据条目及状态；新后台没有充值金额/赠送组合数据的配置页。新人注册赠余额和用户余额调整不是充值套餐配置。",
], ["cinashop-php/view/admin/src/pages/system/group/list.vue", "view/admin-ts/src/pages/config/NewcomerSettings.vue"]);
add("/admin/vipuser/grade/type", "partial", ["/member"], ["GET /adminapi/member/ship", "POST /adminapi/member_ship/save/:id"], [
  "新会员套餐 tab 可新建、编辑、启停免费/周期/永久套餐，维护价格、期限、排序和推荐标记。",
], [
  "旧页可删除普通套餐；新页没有删除入口（虽有 Worker 删除 API），且真实商户支付、历史套餐与前台消费仍需验收。",
], ["view/admin-ts/src/api/membership.ts"]);
add("/admin/vipuser/grade/card", "partial", ["/member"], ["GET /adminapi/member_batch/index", "POST /adminapi/member_batch/save/:id", "POST /adminapi/member_batch/set_value/:id", "GET /adminapi/member_scan"], [
  "新卡批次 tab 可分页、制卡、编辑、冻结/启用、查看卡片与二维码，并在新建时一次性下载卡密 CSV。",
], [
  "旧页可按批次名称搜索并导出历史卡密；新页不回显或导出历史密码，这是有意的安全收口。生产旧批次、计数漂移和二维码渠道仍需核验。",
], ["view/admin-ts/src/api/membership.ts", "workers-ts/src/controllers/api/v1/AdminPaidMembershipController.ts"]);
add("/admin/vipuser/grade/record", "partial", ["/member"], ["GET /adminapi/member/record"], [
  "新会员记录 tab 可按姓名/手机号/订单号和支付方式分页查看已支付记录、套餐与脱敏卡号。",
], [
  "旧会员类型、购买时间筛选及到期时间列未在新页提供；需核对历史免费/卡密记录与支付状态口径。",
], ["view/admin-ts/src/api/membership.ts"]);
add("/admin/vipuser/grade/right", "partial", ["/member"], ["GET /adminapi/member/right", "POST /adminapi/member_right/save/:id", "POST /adminapi/member/save/content/:id"], [
  "新权益 tab 可读取、增加和编辑权益名称、类型、数值、排序、状态、摘要及详细内容。",
], [
  "旧权益图标素材选择与富文本视觉编辑不在新页；当前编辑是文本输入，需验证历史图片引用和客户端呈现。",
], ["view/admin-ts/src/api/membership.ts"]);
add("/admin/vipuser/grade/list/:id", "partial", ["/member"], ["GET /adminapi/member_card/index/:card_batch_id", "POST /adminapi/member_card/set_status"], [
  "新批次卡片抽屉可按卡号/使用状态分页查看使用人、时间并冻结/启用卡。",
], [
  "旧列表可按手机号检索且直接显示卡密；新列表不提供手机号筛选，历史卡密码永久隐藏，不能按旧明文查看合同宣称等价。",
], ["view/admin-ts/src/api/membership.ts", "workers-ts/src/controllers/api/v1/AdminPaidMembershipController.ts"]);
add("/admin/vipuser/grade/agreement", "partial", ["/member"], ["GET /adminapi/member/agreement", "POST /adminapi/member_agreement/save/:id"], [
  "新协议 tab 可读取并保存标题、内容和前台启用状态。",
], [
  "旧 WangEditor 富文本所见即所得编辑器未迁移，新页是纯文本域；历史 HTML 的编辑可用性与前台安全呈现需实际核验。",
], ["view/admin-ts/src/api/membership.ts"]);
add("/admin/user/setup_user", "partial", ["/config/newcomer", "/config/level-activation"], [
  "GET /adminapi/config/user/register", "POST /adminapi/config/user/register",
  "GET /adminapi/config/level-activation", "GET /adminapi/config/level-activation/coupons", "POST /adminapi/config/level-activation",
], [
  "新人运营页覆盖登录注册方式、新人礼总开关/时效、赠送积分/余额/优惠券及首单优惠。",
  "普通等级卡激活专页承接 member_func_status、level_activate_status、level_extend_info、level_integral_status、level_give_integral、level_money_status、level_give_money、level_coupon_status、level_give_coupon 九键；member_func_status 控制普通会员功能，不能缩写成仅赠礼开关。",
  "激活资料从只读 user_extend_info 定义中选择并设置必填；已发行赠券使用独立分页选择器，保留已选历史项与诊断，发行 ID 不等于模板 ID。专用 API 使用 config.view/config.manage，不因旧用户设置菜单或 level.manage 自动授予配置权限。",
  "配置按全局 sort/id 优先级读写生效行，保留门店、重复低优先行与非九键配置；版本确认、请求幂等和提交后缓存状态属于该激活子域合同，不提供任意配置键编辑。",
  "本批原生 PostgreSQL16 已按独立 Admin/App LOGIN 验证九键保存、真实激活消费、权限、幂等、冲突、晚失败回滚与负天数赠券；前端构建及受控 API 草稿/选择测试已通过。",
], [
  "旧同屏的基础资料定义编辑、member_price_status、order_give_exp/sign_give_exp/invite_user_exp、付费会员启用与价格展示仍未由本激活九键页承接；整个用户设置页保持 partial，普通等级激活不等于 SVIP 权益。",
  "真实浏览器交互、生产配置与角色、Linux、设备、外部渠道及发布尚未验收。配置变更不追改已激活用户、历史订单或已读取旧策略的在途激活。",
], ["view/admin-ts/src/api/newcomer.ts", "workers-ts/src/controllers/api/v1/AdminNewcomerController.ts",
  "view/admin-ts/src/api/levelActivation.ts", "workers-ts/src/controllers/api/v1/AdminLevelActivationController.ts",
  "workers-ts/src/services/admin/AdminLevelActivationInput.ts", "workers-ts/src/services/admin/AdminLevelActivationService.ts",
  "workers-ts/src/services/user/UserLevelService.ts", "workers-ts/src/services/user/RegistrationLevelActivation.ts",
  "workers-ts/test/admin-level-activation-postgres.test.ts", "workers-ts/test/admin-level-activation-http.test.ts",
  "workers-ts/test/admin-level-activation-frontend.test.ts"]);

if (paidMembershipReview) {
  screenFiles["/marketing/recharge-options"] = "view/admin-ts/src/pages/marketing/RechargeOptions.vue";
  screenPermissions["/marketing/recharge-options"] = "recharge_quota.view";
  reviews["/admin/user/recharge/:id"] = {
    status: "partial",
    targetScreens: ["/marketing/recharge-options"],
    targetApis: [
      "GET /adminapi/marketing/recharge-quotas", "GET /adminapi/marketing/recharge-quotas/:id",
      "POST /adminapi/marketing/recharge-quotas", "PUT /adminapi/marketing/recharge-quotas/:id",
      "PUT /adminapi/marketing/recharge-quotas/:id/status", "DELETE /adminapi/marketing/recharge-quotas/:id",
    ],
    covered: [
      "旧充值路由复用 system/group/list；新充值档位页已承接 user_recharge_quota 组合数据的充值金额、赠送金额、排序、显隐及新增、编辑、删除，按 sort/id 倒序，并非新人赠余额或用户余额调整。",
      "专用 REST 按 user_recharge_quota 名称解析唯一动态 gid，读写分别要求 recharge_quota.view/manage；写入使用 request_id、revision 和事务审计，套餐选取与充值订单金额快照使用同一事务锁，后续改价、下架或删除不改写已有订单。",
    ],
    remaining: [
      "旧通用页提供显隐筛选和每页20条分页，新页固定读取第1页、最多100条并要求全量结果；尚无状态筛选或翻页控件，历史超过100条会拒绝展示而不是截断为全部。",
      "旧路由 :id 接受 gid 并按组字段生成动态表头和表单；新页仅管理 user_recharge_quota，不承接任意 gid 或其他组合字段。充值子域已有页面不代表整个旧通用页面完成，故保持 partial。",
      "真实充值配置与受限角色、完整 Linux CI、实际充值渠道及发布后验收仍待完成。",
    ],
    evidence: [
      "cinashop-php/view/admin/src/pages/system/group/list.vue",
      "cinashop-php/app/controller/admin/v1/system/config/SystemGroupData.php",
      "cinashop-php/app/services/system/config/SystemGroupDataServices.php",
      "cinashop-php/app/dao/system/config/SystemGroupDataDao.php",
      "cinashop-php/app/services/user/UserRechargeServices.php",
      "view/admin-ts/src/api/rechargeQuota.ts",
      "workers-ts/src/controllers/api/v1/AdminRechargeQuotaController.ts",
      "workers-ts/src/services/admin/AdminRechargeQuotaService.ts",
      "workers-ts/src/services/payment/RechargeQuotaPolicy.ts",
      "workers-ts/src/services/user/UserFinanceService.ts",
      "workers-ts/test/admin-recharge-quota.test.ts",
      "workers-ts/test/admin-recharge-quota-postgres.test.ts",
      "workers-ts/test/admin-recharge-options-frontend.test.ts",
    ],
  };
  const setup = reviews["/admin/user/setup_user"];
  setup.targetScreens.push("/config/paid-membership");
  setup.targetApis.push("GET /adminapi/config/paid-membership", "POST /adminapi/config/paid-membership");
  setup.covered.push("付费会员旧tab的启用与会员价两开关由独立配置页承接；保存仅更新两个全局胜出键，消费者仍按各自业务条件解释权限及价格。");
  setup.remaining = [
    "旧同屏的基础资料定义编辑和 order_give_exp/sign_give_exp/invite_user_exp 尚未承接；member_price_status 在旧页无启用控件且 Worker 无消费者，仍待退役判断。整个用户设置页保持 partial，付费会员开关不等于已授予 vip_price 权益。",
    "生产配置与真实角色、Linux、设备、外部渠道及发布尚未验收。配置变更不追改既有会员资格、历史订单或已产生支付义务的订单。",
  ];
  setup.evidence.push("view/admin-ts/src/api/paidMembershipConfig.ts", "workers-ts/src/controllers/api/v1/AdminPaidMembershipConfigController.ts");
}

if (invoiceAdminReview) {
  screenFiles["/order/invoice"] = "view/admin-ts/src/pages/order/InvoiceManagement.vue";
  screenPermissions["/order/invoice"] = "invoice.view";
  reviews["/admin/order/invoice/list"] = {
    status: "partial",
    targetScreens: ["/order/invoice"],
    targetApis: [
      "GET /adminapi/order/invoices", "GET /adminapi/order/invoices/:id",
      "POST /adminapi/order/invoices/:id/process",
    ],
    covered: [
      "独立发票页按申请时间、状态与订单/用户/抬头字段分页查询，展示个人及企业发票资料、票面金额和订单摘要；当前页可导出旧八列语义的公式安全 CSV。",
      "处理接口使用 invoice.view/manage 独立权限、版本和请求键，在事务内重验订单归属、支付、退款、票面净额及开票历史，并原子保存处理结果与审计。",
    ],
    remaining: [
      "旧 chart 请求具备全量状态统计合同（模板未渲染）；同一弹窗内商品、收货、优惠等完整订单信息尚未由 invoice.view 独立提供，order.view 链接不算覆盖。",
      "旧表格可对发票类型和抬头类型做当前页筛选，新页没有相应控件。",
      "旧全字段搜索还触及邮箱、地址、银行及用户昵称/手机号；当前专用查询仅覆盖列出的七类字段，不能把旧 all 搜索视为完整迁移。",
      "安装前没有创建基线的历史 0.00 申请无法证明安全金额，只读待人工核验；真实旧单、角色、税务渠道、退款并发及发布后验收仍待完成。整页保持 partial。",
    ],
    evidence: [
      "cinashop-php/view/admin/src/pages/order/invoice/index.vue",
      "cinashop-php/app/services/order/StoreOrderInvoiceServices.php",
      "view/admin-ts/src/api/invoiceManagement.ts",
      "workers-ts/src/controllers/api/v1/AdminInvoiceController.ts",
      "workers-ts/src/services/admin/AdminInvoiceService.ts",
      "workers-ts/test/admin-invoices-frontend.test.ts",
    ],
  };
}

if (invoiceFollowupReview) {
  const invoice = reviews["/admin/order/invoice/list"];
  invoice.targetApis.push("GET /adminapi/order/invoices/:id/order-info");
  invoice.covered.push(
    "invoice.view 可按申请行 ID 读取经过支付、UID、拆单根单和唯一有效申请复核的订单/收货/商品快照；不放宽通用 order.detail。旧票种与抬头过滤仅作用于当前已加载表格页，维持原页范围。",
  );
  invoice.remaining = [
    "旧 chart 全量状态统计 API 仍未重建，但旧模板未渲染该数字；当前页计数不可冒充全量统计。",
    "旧 all 搜索包括邮箱、地址、银行及用户昵称/手机号；目前服务端范围更窄，发票页仍为 partial。",
    "安装前没有创建基线的历史 0.00 申请无法证明安全金额，只读待人工核验；真实旧单、角色、税务渠道、退款并发及发布后验收仍待完成。",
  ];
  invoice.evidence.push("workers-ts/test/admin-invoice-postgres.test.ts");
  const record = reviews["/admin/vipuser/grade/record"];
  record.status = "candidate";
  record.covered = [
    "新会员记录 tab 分页显示已支付购买记录、用户/订单/套餐/金额/渠道/脱敏卡号、购买及到期时间，可按姓名、支付方式、会员类型和上海时间区间筛选。",
    "卡密和免费类型按旧 code 是否存在区分；免费支付匹配旧订单类型与赠送条件，类型选项从所有启用套餐分页获取。",
  ];
  record.remaining = [
    "历史会员记录、免费/卡密边界与受限角色仍需在生产只读核对；候选表示本地合同覆盖，不表示发布或渠道验收。",
  ];
  record.evidence.push("view/admin-ts/src/pages/user/PaidMembership.vue", "workers-ts/src/services/user/AdminPaidMembershipService.ts",
    "workers-ts/test/admin-paid-membership-record-postgres.test.ts");
}

const inventory = JSON.parse(readFileSync(inventoryFile, "utf8")) as {
  legacy: { routes: InventoryRoute[]; routeFiles: { file: string; sha256: string }[] };
  target: { routes: InventoryRoute[] };
};
const sourceNames = new Set(Object.keys(oldRouterHashes));
const legacyRoutes = inventory.legacy.routes.filter((route) => route.surface === "page" && sourceNames.has(route.source));
if (legacyRoutes.length !== 18) throw new Error(`Expected 18 user/order business pages, got ${legacyRoutes.length}`);
if (new Set(legacyRoutes.map((route) => route.path)).size !== 18) throw new Error("Duplicate user/order business path");
const bySource = Object.fromEntries([...sourceNames].map((source) => [source, legacyRoutes.filter((route) => route.source === source).length]));
if (bySource["src/router/modules/user.js"] !== 12 || bySource["src/router/modules/order.js"] !== 6) throw new Error(`Unexpected source counts: ${JSON.stringify(bySource)}`);
for (const [file, sha256] of Object.entries(oldRouterHashes)) {
  if (inventory.legacy.routeFiles.find((item) => item.file === file)?.sha256 !== sha256) throw new Error(`Legacy router snapshot changed: ${file}`);
}
const inventoryPaths = new Set(legacyRoutes.map((route) => route.path));
for (const map of [reviews, oldAuthByPath, oldBehaviorLineByPath]) for (const path of Object.keys(map)) if (!inventoryPaths.has(path)) throw new Error(`Unknown user/order review: ${path}`);
const targetPaths = new Set(inventory.target.routes.filter((route) => route.surface === "page").map((route) => route.path));
const adminRoutes = readFileSync(resolve(workerRoot, "src/routes/adminapi.ts"), "utf8");
const registeredApis = new Set([...adminRoutes.matchAll(/adminapiRoutes\.(get|post|put|delete)\(\s*["']([^"']+)["']/gu)]
  .map((match) => `${match[1].toUpperCase()} /adminapi${match[2]}`));
const appSource = readFileSync(resolve(workerRoot, "src/app.ts"), "utf8");
const refundOperationSource = readFileSync(resolve(workerRoot, "src/routes/admin-refund-operations.ts"), "utf8");
if (!appSource.includes("app.route('/adminapi/refund/operations', adminRefundOperationRoutes)")) throw new Error("Refund operation route not mounted");
for (const action of ["execute/:id", "receipt"]) {
  if (!refundOperationSource.includes(`adminRefundOperationRoutes.post('/${action}'`)) throw new Error(`Refund operation not registered: ${action}`);
  registeredApis.add(`POST /adminapi/refund/operations/${action}`);
}
function evidenceExists(file: string): boolean { return file.startsWith("cinashop-php/") || existsSync(resolve(workerRoot, "..", file)); }
function apiPermission(api: string): string {
  const [method, path] = api.split(" ");
  if (invoiceAdminReview && (path === "/adminapi/order/invoices" || path.startsWith("/adminapi/order/invoices/"))) {
    return `invoice.${method === "GET" ? "view" : "manage"}`;
  }
  if (paidMembershipReview && (path === "/adminapi/marketing/recharge-quotas" || path.startsWith("/adminapi/marketing/recharge-quotas/"))) {
    return `recharge_quota.${method === "GET" ? "view" : "manage"}`;
  }
  const domain = path.startsWith("/adminapi/order/") ? "order"
    : path.startsWith("/adminapi/refund/") ? "refund"
      : path.startsWith("/adminapi/queue/") ? "legacy_runtime"
        : path.startsWith("/adminapi/user_group/") || path.startsWith("/adminapi/user/") ? "user"
          : path.startsWith("/adminapi/user_label/") ? "label"
            : path.startsWith("/adminapi/level/") ? "level"
              : /^\/adminapi\/(member\/|member_|member)/u.test(path) ? "paid_membership"
                : path.startsWith("/adminapi/config/user/")
                  || path === "/adminapi/config/level-activation" || path === "/adminapi/config/level-activation/coupons"
                  || path === "/adminapi/config/paid-membership" ? "config" : null;
  if (!domain) throw new Error(`Unmapped user/order API permission: ${api}`);
  return `${domain}.${method === "GET" ? "view" : "manage"}`;
}
const routes = legacyRoutes.map((route) => {
  const review = reviews[route.path];
  if (!review || !route.resolvedComponent) throw new Error(`Missing semantic review or old component: ${route.path}`);
  if (!review.covered.length && !review.remaining.length) throw new Error(`Missing conclusion: ${route.path}`);
  if ((review.status === "candidate" || review.status === "partial") && (!review.targetScreens.length || !review.covered.length || !review.remaining.length)) throw new Error(`Insufficient covered review: ${route.path}`);
  if (review.status === "missing" && review.targetScreens.length) throw new Error(`Missing page claims target: ${route.path}`);
  for (const screen of review.targetScreens) if (!targetPaths.has(screen) || !screenFiles[screen]) throw new Error(`Unregistered target screen: ${route.path} -> ${screen}`);
  for (const api of review.targetApis) if (!registeredApis.has(api)) throw new Error(`Unregistered target API: ${route.path} -> ${api}`);
  const auth = oldAuthByPath[route.path], behaviorLine = oldBehaviorLineByPath[route.path];
  if (!auth || !Number.isSafeInteger(behaviorLine) || behaviorLine <= 0 || route.line <= 0) throw new Error(`Missing old provenance: ${route.path}`);
  const routerSha256 = oldRouterHashes[route.source];
  if (!routerSha256) throw new Error(`Unexpected source: ${route.path}`);
  const componentPath = `cinashop-php/view/admin/${route.resolvedComponent}`;
  const oldRouter = `cinashop-php/view/admin/${route.source}`;
  const evidence = [...new Set([oldRouter, componentPath, `${componentPath}:${behaviorLine}`,
    route.path === "/admin/user/recharge/:id" ? oldSystemApi : route.source.endsWith("order.js") ? oldOrderApi : oldUserApi,
    newRouter, newRoutes, permissions,
    ...review.targetScreens.map((screen) => screenFiles[screen]), ...review.evidence])];
  for (const file of evidence) if (!evidenceExists(file)) throw new Error(`Missing evidence file: ${route.path} -> ${file}`);
  return { legacy: { path: route.path, title: route.title, component: route.component, resolvedComponent: componentPath,
    behaviorSource: `${componentPath}:${behaviorLine}`, source: `${oldRouter}:${route.line}`, routerSha256, auth },
  ...review, targetPermissions: [...new Set([...review.targetScreens.map((screen) => screenPermissions[screen]), ...review.targetApis.map(apiPermission)])], evidence };
});
const statuses: Status[] = ["candidate", "partial", "missing", "retired"];
const counts = Object.fromEntries(statuses.map((status) => [status, routes.filter((route) => route.status === status).length]));
const report = {
  version: 1, generatedFrom: `audit/${inventoryName}`,
  methodology: {
    scope: "Only the 12 user.js and 6 order.js surface=page routes in the authoritative 274-page inventory; auxiliary components are excluded.",
    reviewBasis: "Compare each pinned old Vue component, auth and API workflow with the new Admin screen, Worker route, data contract and permission map. Old router/auth/line evidence is a static reviewed snapshot; CI reads only this repository. A shared page, API-only stub or legacy mutation route returning 410 does not establish full parity. Security improvements that remove plaintext card-password retrieval are recorded as intentional differences.",
    validationBoundary: invoiceFollowupReview
      ? "Local code and PostgreSQL evidence only. Historical invoice rows without a creation baseline, broad legacy invoice search, real-role and production invoice/tax E2E, deployment and publication remain open. FE-001D is a code-audit scope, not a feature completion claim."
      : invoiceAdminReview
      ? "Local code, PostgreSQL and synthetic browser evidence only. Historical invoice rows without a creation baseline, full invoice-scoped order detail, real-role and production invoice/tax E2E, deployment and publication remain open. FE-001D is a code-audit scope, not a feature completion claim."
      : paidMembershipReview
      ? "Code and local tests only. No production payment, refund, old card recovery, real-role browser E2E, deployment or publication is claimed. FE-001D remains open."
      : "Code-only semantic review. No production payment, refund, old card recovery, real-role browser E2E, deployment or publication is claimed. FE-001D remains open.",
  },
  summary: { legacyRoutes: routes.length, reviewed: routes.length, bySource, ...counts, unreviewed: 0 }, routes,
};
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (process.argv.includes("--write")) { mkdirSync(dirname(outputFile), { recursive: true }); writeFileSync(outputFile, serialized, "utf8"); console.log(`Wrote ${outputFile}`); }
else process.stdout.write(serialized);
