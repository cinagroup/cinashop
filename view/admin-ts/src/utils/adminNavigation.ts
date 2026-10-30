/** Existing routes and menu gates, presented with PHP-style groups. */
export interface AdminNavigationItem {
  path: string;
  permissionPath: string;
  icon: string;
  label: string;
}
export interface AdminNavigationSection {
  id: string;
  label: string;
  icon: string;
  items: readonly AdminNavigationItem[];
}
export const ADMIN_NAVIGATION_SHORTCUTS: readonly AdminNavigationItem[] = [
  {"path": "/dashboard", "permissionPath": "/dashboard", "icon": "Odometer", "label": "控制台"},
  {"path": "/statistic", "permissionPath": "/statistic", "icon": "TrendCharts", "label": "统计报表"},
];

export const ADMIN_NAVIGATION_SECTIONS: readonly AdminNavigationSection[] = [
  { id: "nav:catalog", label: "商品管理", icon: "Goods", items: [
    {"path": "/product", "permissionPath": "/product", "icon": "Goods", "label": "商品管理"},
    {"path": "/category", "permissionPath": "/category", "icon": "Folder", "label": "商品分类"},
    {"path": "/brand", "permissionPath": "/brand", "icon": "Collection", "label": "品牌管理"},
    {"path": "/label", "permissionPath": "/label", "icon": "PriceTag", "label": "标签管理"},
    {"path": "/label/products", "permissionPath": "/label", "icon": "PriceTag", "label": "商品标签管理"},
    {"path": "/product/units", "permissionPath": "/product", "icon": "Goods", "label": "商品单位"},
    {"path": "/product/ensures", "permissionPath": "/product", "icon": "Goods", "label": "保障服务"},
    {"path": "/product/rules", "permissionPath": "/product", "icon": "Goods", "label": "SKU 规格模板"},
    {"path": "/product/parameters", "permissionPath": "/product", "icon": "Goods", "label": "商品参数模板"},
    {"path": "/product/hotwords", "permissionPath": "/product", "icon": "Goods", "label": "搜索热词"},
  ] },
  { id: "nav:orders", label: "订单与配送", icon: "Tickets", items: [
    {"path": "/order", "permissionPath": "/order", "icon": "Tickets", "label": "订单管理"},
    {"path": "/order/offline", "permissionPath": "/order", "icon": "CreditCard", "label": "线下消费"},
    {"path": "/order/invoice", "permissionPath": "/order/invoice", "icon": "Tickets", "label": "发票管理"},
    {"path": "/refund", "permissionPath": "/refund", "icon": "RefreshLeft", "label": "退款审核"},
    {"path": "/shipping", "permissionPath": "/shipping", "icon": "Van", "label": "运费模板"},
    {"path": "/express", "permissionPath": "/express", "icon": "Box", "label": "快递公司"},
    {"path": "/setting/shipping", "permissionPath": "/setting/shipping", "icon": "Tickets", "label": "发货设置"},
    {"path": "/setting/city-delivery-settings", "permissionPath": "/setting/city-delivery-settings", "icon": "Tickets", "label": "同城配送设置"},
    {"path": "/setting/city-delivery-records", "permissionPath": "/setting/city-delivery-records", "icon": "Tickets", "label": "同城配送记录"},
    {"path": "/setting/waybill", "permissionPath": "/setting/waybill", "icon": "Tickets", "label": "电子面单"},
    {"path": "/order/delivery-people", "permissionPath": "/order", "icon": "User", "label": "平台配送员"},
  ] },
  { id: "nav:users", label: "用户与会员", icon: "User", items: [
    {"path": "/user", "permissionPath": "/user", "icon": "User", "label": "用户管理"},
    {"path": "/user/groups", "permissionPath": "/user", "icon": "User", "label": "商城用户分组"},
    {"path": "/member", "permissionPath": "/member", "icon": "Key", "label": "付费会员"},
    {"path": "/config/level-activation", "permissionPath": "/config", "icon": "Present", "label": "普通等级卡激活"},
    {"path": "/config/paid-membership", "permissionPath": "/config", "icon": "Setting", "label": "付费会员功能设置"},
    {"path": "/level", "permissionPath": "/level", "icon": "Medal", "label": "会员等级"},
  ] },
  { id: "nav:marketing", label: "营销与积分", icon: "Present", items: [
    {"path": "/config/newcomer", "permissionPath": "/config", "icon": "Present", "label": "新人运营"},
    {"path": "/coupon", "permissionPath": "/coupon", "icon": "Ticket", "label": "优惠券管理"},
    {"path": "/marketing/coupon-records", "permissionPath": "/marketing/coupon-records", "icon": "Ticket", "label": "用户领取记录"},
    {"path": "/marketing/coupon-templates", "permissionPath": "/marketing/coupon-templates", "icon": "Ticket", "label": "优惠券模板"},
    {"path": "/activity", "permissionPath": "/activity", "icon": "Present", "label": "营销活动"},
    {"path": "/activity/seckill-statistics", "permissionPath": "/activity/seckill-statistics", "icon": "Present", "label": "秒杀统计"},
    {"path": "/activity/seckill-times", "permissionPath": "/activity/seckill-times", "icon": "Present", "label": "秒杀时段"},
    {"path": "/activity/seckill-activities", "permissionPath": "/activity/seckill-activities", "icon": "Present", "label": "秒杀父活动"},
    {"path": "/activity/combinations", "permissionPath": "/activity/combinations", "icon": "Present", "label": "拼团商品"},
    {"path": "/activity/combination-groups", "permissionPath": "/activity/combination-groups", "icon": "Present", "label": "全局拼团记录"},
    {"path": "/activity/combination-statistics", "permissionPath": "/activity/combination-statistics", "icon": "Present", "label": "拼团统计"},
    {"path": "/marketing/lottery", "permissionPath": "/marketing/lottery", "icon": "Trophy", "label": "抽奖活动"},
    {"path": "/marketing/lottery-records", "permissionPath": "/marketing/lottery-records", "icon": "Trophy", "label": "抽奖记录"},
    {"path": "/marketing/activity-frame", "permissionPath": "/marketing/activity-frame", "icon": "Present", "label": "活动边框"},
    {"path": "/marketing/activity-background", "permissionPath": "/marketing/activity-background", "icon": "Present", "label": "活动背景"},
    {"path": "/marketing/time-discounts", "permissionPath": "/marketing/time-discounts", "icon": "Present", "label": "限时折扣"},
    {"path": "/marketing/full-discounts", "permissionPath": "/marketing/full-discounts", "icon": "Present", "label": "满减满折"},
    {"path": "/marketing/nth-discounts", "permissionPath": "/marketing/nth-discounts", "icon": "Present", "label": "第N件N折"},
    {"path": "/marketing/full-gifts", "permissionPath": "/marketing/full-gifts", "icon": "Present", "label": "满送活动"},
    {"path": "/marketing/live", "permissionPath": "/marketing/live", "icon": "VideoCamera", "label": "小程序直播"},
    {"path": "/marketing/user-point", "permissionPath": "/marketing/user-point", "icon": "Tickets", "label": "积分日志"},
    {"path": "/marketing/point-statistic", "permissionPath": "/marketing/point-statistic", "icon": "DataLine", "label": "积分统计"},
    {"path": "/marketing/recharge-options", "permissionPath": "/marketing/recharge-options", "icon": "Wallet", "label": "充值金额档位"},
    {"path": "/marketing/integral-categories", "permissionPath": "/marketing/integral-categories", "icon": "Folder", "label": "积分分类"},
    {"path": "/activity/integral-batch", "permissionPath": "/activity/integral-batch", "icon": "Present", "label": "批量添加积分商品"},
    {"path": "/marketing/sign-rewards", "permissionPath": "/config", "icon": "Present", "label": "签到奖励"},
    {"path": "/marketing/sign-day-config", "permissionPath": "/marketing/sign-day-config", "icon": "Present", "label": "签到天数组"},
    {"path": "/activity/bargain-records", "permissionPath": "/activity/bargain-records", "icon": "Present", "label": "砍价运营记录"},
    {"path": "/activity/bargain-statistics", "permissionPath": "/activity/bargain-statistics", "icon": "Present", "label": "砍价统计"},
  ] },
  { id: "nav:content", label: "内容与装修", icon: "Brush", items: [
    {"path": "/community", "permissionPath": "/community", "icon": "ChatLineRound", "label": "社区运营"},
    {"path": "/assets", "permissionPath": "/assets", "icon": "Picture", "label": "素材中心"},
    {"path": "/content/article", "permissionPath": "/content/article", "icon": "Document", "label": "CMS 文章"},
    {"path": "/content/wechat-card", "permissionPath": "/content/wechat-card", "icon": "CreditCard", "label": "公众号会员卡"},
    {"path": "/content/wechat", "permissionPath": "/content/wechat", "icon": "ChatLineRound", "label": "公众号内容"},
    {"path": "/content/wechat-qrcode", "permissionPath": "/content/wechat-qrcode", "icon": "Connection", "label": "渠道二维码"},
    {"path": "/content/dise", "permissionPath": "/content/dise", "icon": "Brush", "label": "DIY 装修"},
    {"path": "/setting/pc-banner", "permissionPath": "/setting/pc-banner", "icon": "Monitor", "label": "PC首页轮播"},
    {"path": "/setting/operational-groups", "permissionPath": "/setting/operational-groups", "icon": "Picture", "label": "运营图片配置"},
    {"path": "/setting/product-category-style", "permissionPath": "/setting/product-category-style", "icon": "Tickets", "label": "商品分类页面"},
    {"path": "/setting/product-detail-design", "permissionPath": "/setting/product-detail-design", "icon": "Tickets", "label": "商品详情设计"},
    {"path": "/setting/user-center-design", "permissionPath": "/setting/user-center-design", "icon": "Tickets", "label": "个人中心设计"},
    {"path": "/setting/theme-style", "permissionPath": "/setting/theme-style", "icon": "Tickets", "label": "主题风格"},
    {"path": "/setting/fab", "permissionPath": "/setting/fab", "icon": "Tickets", "label": "悬浮按钮"},
    {"path": "/content/wechat-open", "permissionPath": "/content/wechat-open", "icon": "Setting", "label": "微信开放平台"},
    {"path": "/content/wechat-app", "permissionPath": "/content/wechat-app", "icon": "Setting", "label": "原生App微信配置"},
    {"path": "/content/wechat-base", "permissionPath": "/content/wechat-base", "icon": "Setting", "label": "公众号基础设置"},
    {"path": "/content/wechat-menu", "permissionPath": "/content/wechat-menu", "icon": "ChatLineRound", "label": "公众号自定义菜单"},
  ] },
  { id: "nav:service", label: "客服与评价", icon: "ChatDotRound", items: [
    {"path": "/kefu", "permissionPath": "/kefu", "icon": "ChatDotRound", "label": "客服会话"},
    {"path": "/kefu/feedback", "permissionPath": "/kefu/feedback", "icon": "ChatDotRound", "label": "客服反馈"},
    {"path": "/kefu/speechcraft", "permissionPath": "/kefu/speechcraft", "icon": "ChatDotRound", "label": "客服话术"},
    {"path": "/reply", "permissionPath": "/reply", "icon": "Star", "label": "商品评价"},
  ] },
  { id: "nav:finance", label: "财务管理", icon: "Wallet", items: [
    {"path": "/finance/extract", "permissionPath": "/finance/extract", "icon": "Wallet", "label": "提现审核"},
    {"path": "/finance/recharges", "permissionPath": "/finance/recharges", "icon": "Wallet", "label": "充值订单"},
    {"path": "/finance/commissions", "permissionPath": "/finance/commissions", "icon": "Wallet", "label": "佣金记录"},
    {"path": "/finance/supplier-extract", "permissionPath": "/finance/supplier-extract", "icon": "WalletFilled", "label": "供应商提现"},
    {"path": "/finance/bill", "permissionPath": "/finance/bill", "icon": "Tickets", "label": "财务流水"},
    {"path": "/finance/capital-flow", "permissionPath": "/finance/capital-flow", "icon": "Wallet", "label": "平台资金流水"},
  ] },
  { id: "nav:supplier", label: "供应商管理", icon: "Shop", items: [
    {"path": "/supplier/applications", "permissionPath": "/supplier/applications", "icon": "Shop", "label": "供应商入驻"},
    {"path": "/supplier/directory", "permissionPath": "/supplier/directory", "icon": "Shop", "label": "供应商目录"},
    {"path": "/supplier/menu-rules", "permissionPath": "/supplier/menu-rules", "icon": "Key", "label": "供应商菜单规则"},
    {"path": "/supplier/bills", "permissionPath": "/supplier/bills", "icon": "Tickets", "label": "供应商账单"},
    {"path": "/supplier/capital-flow", "permissionPath": "/supplier/capital-flow", "icon": "CreditCard", "label": "供应商资金流水"},
    {"path": "/supplier/order-statistics", "permissionPath": "/supplier/order-statistics", "icon": "TrendCharts", "label": "供应商订单统计"},
  ] },
  { id: "nav:operations", label: "门店与分销", icon: "Connection", items: [
    {"path": "/operations/store", "permissionPath": "/operations/store", "icon": "Shop", "label": "门店与配送"},
    {"path": "/operations/writeoff-orders", "permissionPath": "/operations/writeoff-orders", "icon": "Shop", "label": "核销订单"},
    {"path": "/agent", "permissionPath": "/agent", "icon": "Share", "label": "分销管理"},
    {"path": "/agent/promoter-applications", "permissionPath": "/agent/promoter-applications", "icon": "Share", "label": "分销员申请审核"},
    {"path": "/agent/agreement", "permissionPath": "/agent/agreement", "icon": "Share", "label": "分销说明"},
    {"path": "/division", "permissionPath": "/division", "icon": "Connection", "label": "事业部管理"},
    {"path": "/division/statistics", "permissionPath": "/division/statistics", "icon": "DataAnalysis", "label": "事业部统计"},
    {"path": "/setting/distributor-levels", "permissionPath": "/setting/distributor-levels", "icon": "Tickets", "label": "分销等级"},
    {"path": "/setting/distributor-levels/tasks", "permissionPath": "/setting/distributor-levels/tasks", "icon": "Tickets", "label": "分销等级任务"},
  ] },
  { id: "nav:system", label: "系统与运维", icon: "Setting", items: [
    {"path": "/operations/outbox", "permissionPath": "/operations/outbox", "icon": "Operation", "label": "任务运维"},
    {"path": "/operations/legacy-runtime", "permissionPath": "/operations/legacy-runtime", "icon": "Clock", "label": "迁移运行历史"},
    {"path": "/operations/work", "permissionPath": "/operations/work", "icon": "Connection", "label": "企业微信"},
    {"path": "/config/runtime-content", "permissionPath": "/config", "icon": "Monitor", "label": "客户端内容"},
    {"path": "/config", "permissionPath": "/config", "icon": "Setting", "label": "系统配置"},
    {"path": "/system/out", "permissionPath": "/system/out", "icon": "Key", "label": "对外接口"},
    {"path": "/system", "permissionPath": "/system", "icon": "UserFilled", "label": "系统管理"},
    {"path": "/system/legacy-staff", "permissionPath": "/system/legacy-staff", "icon": "UserFilled", "label": "下级管理员"},
    {"path": "/system/legacy-roles", "permissionPath": "/system/legacy-roles", "icon": "UserFilled", "label": "下级角色"},
    {"path": "/system/log", "permissionPath": "/system/log", "icon": "Tickets", "label": "操作日志"},
    {"path": "/setting/notification", "permissionPath": "/setting/notification", "icon": "Bell", "label": "通知配置"},
    {"path": "/setting/print", "permissionPath": "/setting/print", "icon": "Printer", "label": "小票打印"},
    {"path": "/config/classes", "permissionPath": "/config", "icon": "Setting", "label": "配置分类"},
    {"path": "/system/menu-rules", "permissionPath": "/system/menu-rules", "icon": "Setting", "label": "平台权限规则"},
    {"path": "/config/pc", "permissionPath": "/config/pc", "icon": "Setting", "label": "PC基础配置"},
    {"path": "/system/frontend-log", "permissionPath": "/system/frontend-log", "icon": "Document", "label": "本浏览器日志"},
  ] },
];

export function visibleAdminNavigation(canMenu: (path: string) => boolean) {
  return {
    shortcuts: ADMIN_NAVIGATION_SHORTCUTS.filter(item => canMenu(item.permissionPath)),
    sections: ADMIN_NAVIGATION_SECTIONS.map(section => ({
      ...section,
      items: section.items.filter(item => canMenu(item.permissionPath)),
    })).filter(section => section.items.length > 0),
  };
}
export function activeAdminSection(activePath: string, sections: readonly AdminNavigationSection[]): string[] {
  const section = sections.find(group => group.items.some(item => item.path === activePath));
  return section ? [section.id] : [];
}
export function exactAdminMenuPath(path: string): string | undefined {
  return [...ADMIN_NAVIGATION_SHORTCUTS, ...ADMIN_NAVIGATION_SECTIONS.flatMap(group => group.items)]
    .find(item => item.path === path)?.path;
}
