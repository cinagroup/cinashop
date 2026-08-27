/** PHP-compatible Admin order/product statistic APIs. */
import request, { getData } from "@/utils/request";

const previewMode =
  import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";

export interface StatisticSeries {
  name: string;
  data: number[];
  type: "line" | "bar";
  smooth?: "true";
  yAxisIndex?: 1;
}

export interface StatisticTrend {
  xAxis: string[];
  series: StatisticSeries[];
}

export interface OrderStatisticBasic {
  pay_price: string;
  pay_count: number;
  refund_price: string;
  refund_count: number;
  coupon_price: string;
  coupon_count: number;
}

export interface StatisticDistribution {
  bing_xdata: string[];
  bing_data: Array<{ name: string; value: number; itemStyle: { color: string } }>;
  list: Array<{ name: string; value: number; percent: number }>;
}

export interface MetricComparison {
  num: number;
  percent: number;
}

export type ProductStatisticBasic = Record<
  "browse" | "user" | "cart" | "order" | "pay" | "payPrice" | "cost" | "refundPrice" | "refund" | "payPercent",
  MetricComparison
>;

export type ProductRankingSort =
  | "visit" | "user" | "cart" | "orders" | "pay" | "price" | "profit" | "collect" | "changes";

export interface ProductRankingRow {
  product_id: number;
  store_name: string;
  image: string;
  product_price: string;
  stock: number;
  is_show: number;
  visit: number;
  user: number;
  cart: number;
  orders: number;
  pay: number;
  price: number;
  cost: number;
  profit: number;
  collect: number;
  changes: number;
  repeats: number;
}

export interface UserMetricComparison extends MetricComparison {
  last_num: number;
}

export type UserStatisticBasic = Record<
  | "people" | "browse" | "newUser" | "payPeople" | "payPercent" | "payUser"
  | "rechargePeople" | "payPrice" | "cumulativeUser" | "cumulativePayUser"
  | "cumulativeRechargePeople" | "cumulativePayPeople",
  UserMetricComparison
>;

export interface ValueSeries {
  name: string;
  value: number[];
}

export interface ValueTrend {
  xAxis: string[];
  series: ValueSeries[];
}

export interface ExportMetadata {
  header: string[];
  filekey: string[];
  export: Array<Record<string, string | number>>;
  filename: string;
}

export interface UserRegionRow {
  province: string;
  allNum: number;
  newNum: number;
  visitNum: number;
  payPrice: number;
}

export interface SexRow {
  value: number;
  name: string;
  name_key: number;
}

export interface BalanceStatisticBasic {
  now_balance: number;
  add_balance: number;
  sub_balance: number;
}

export interface TradeSeries {
  name: string;
  desc: string;
  money: number;
  type: 0 | 1;
  rate: number;
  value: number[];
}

export interface TradeBottom {
  x: string[];
  series: TradeSeries[];
  export: string;
}

export interface TradePulseSeries {
  name: string;
  now_money: number;
  last_money: number;
  rate: number;
  value: number[];
}

export interface TradeTop {
  left: { name: string; x: string[]; series: Array<{ money: number; value: number[] }> };
  right: {
    today: { x: string[]; series: TradePulseSeries[] };
    month: TradePulseSeries[];
  };
}

function previewLabels(): string[] {
  return Array.from({ length: 30 }, (_, index) => `08-${String(index + 1).padStart(2, "0")}`);
}

function previewSeries(name: string, multiplier: number, type: "line" | "bar" = "line"): StatisticSeries {
  return {
    name,
    type,
    data: previewLabels().map((_, index) => Math.round((4 + ((index * 7) % 13)) * multiplier * 100) / 100),
  };
}

const previewOrderBasic: OrderStatisticBasic = {
  pay_price: "35620.50",
  pay_count: 362,
  refund_price: "1286.00",
  refund_count: 12,
  coupon_price: "2642.50",
  coupon_count: 86,
};

const previewOrderChannel: StatisticDistribution = {
  bing_xdata: ["公众号", "小程序", "H5", "PC", "APP"],
  bing_data: [
    { name: "公众号", value: 86, itemStyle: { color: "#64a1f4" } },
    { name: "小程序", value: 148, itemStyle: { color: "#3edeb5" } },
    { name: "H5", value: 42, itemStyle: { color: "#70869f" } },
    { name: "PC", value: 61, itemStyle: { color: "#ffc653" } },
    { name: "APP", value: 25, itemStyle: { color: "#fc7d6a" } },
  ],
  list: [
    { name: "小程序", value: 148, percent: 40.88 },
    { name: "公众号", value: 86, percent: 23.76 },
    { name: "PC", value: 61, percent: 16.85 },
    { name: "H5", value: 42, percent: 11.6 },
    { name: "APP", value: 25, percent: 6.91 },
  ],
};

const previewOrderType: StatisticDistribution = {
  bing_xdata: ["普通订单", "秒杀订单", "砍价订单", "拼团订单", "积分订单", "套餐订单", "预售订单", "新人订单", "抽奖订单"],
  bing_data: [
    { name: "普通订单", value: 18640, itemStyle: { color: "#64a1f4" } },
    { name: "秒杀订单", value: 4320, itemStyle: { color: "#3edeb5" } },
    { name: "砍价订单", value: 1180, itemStyle: { color: "#70869f" } },
    { name: "拼团订单", value: 5680, itemStyle: { color: "#ffc653" } },
    { name: "积分订单", value: 320, itemStyle: { color: "#f6a623" } },
    { name: "套餐订单", value: 2760, itemStyle: { color: "#fc7d6a" } },
    { name: "预售订单", value: 1480, itemStyle: { color: "#b37feb" } },
    { name: "新人订单", value: 920, itemStyle: { color: "#ff85c0" } },
    { name: "抽奖订单", value: 320.5, itemStyle: { color: "#6dd230" } },
  ],
  list: [],
};

const previewProductBasic: ProductStatisticBasic = {
  browse: { num: 18642, percent: 17.12 },
  user: { num: 8390, percent: 12.26 },
  cart: { num: 1286, percent: 8.52 },
  order: { num: 524, percent: 6.94 },
  pay: { num: 476, percent: 9.68 },
  payPrice: { num: 35620.5, percent: 19.37 },
  cost: { num: 21840.2, percent: 14.26 },
  refundPrice: { num: 1286, percent: -5.21 },
  refund: { num: 18, percent: -10 },
  payPercent: { num: 5.67, percent: 3.84 },
};

const previewRanking: ProductRankingRow[] = Array.from({ length: 8 }, (_, index) => ({
  product_id: 101 + index,
  store_name: ["东山白玉枇杷", "阳澄湖大闸蟹礼盒", "云南高山蓝莓", "福建白茶礼盒", "新疆吊干杏", "海南金钻凤梨", "宁夏滩羊肉", "赣南脐橙"][index],
  image: "/logo.png",
  product_price: String(39.9 + index * 12),
  stock: 120 - index * 7,
  is_show: 1,
  visit: 1680 - index * 136,
  user: 820 - index * 58,
  cart: 268 - index * 17,
  orders: 186 - index * 12,
  pay: 172 - index * 11,
  price: 6862 - index * 438,
  cost: 4160 - index * 251,
  profit: Math.round((39.38 - index * 0.72) * 100) / 100,
  collect: 96 - index * 7,
  changes: Math.round((20.98 - index * 0.83) * 100) / 100,
  repeats: 0.18,
}));

const previewUserBasic: UserStatisticBasic = Object.fromEntries([
  ["people", 8390], ["browse", 18642], ["newUser", 1260], ["payPeople", 476],
  ["payPercent", 5.67], ["payUser", 218], ["rechargePeople", 164], ["payPrice", 74.83],
  ["cumulativeUser", 28560], ["cumulativePayUser", 1840],
  ["cumulativeRechargePeople", 2760], ["cumulativePayPeople", 9320],
].map(([key, value]) => [key, { num: value, last_num: Number(value) * 0.9, percent: 11.11 }])) as UserStatisticBasic;

const previewUserTrend: ValueTrend = {
  xAxis: previewLabels(),
  series: [
    { name: "新增用户数", value: previewSeries("新增用户数", 4).data },
    { name: "访客数", value: previewSeries("访客数", 32).data },
    { name: "成交用户数", value: previewSeries("成交用户数", 2).data },
    { name: "充值用户", value: previewSeries("充值用户", 0.8).data },
    { name: "激活付费用户数", value: previewSeries("激活付费用户数", 0.5).data },
  ],
};

const previewUserRegion: UserRegionRow[] = [
  ["广东", 5280, 286, 1680, 7680], ["江苏", 4380, 235, 1320, 6290],
  ["浙江", 3860, 218, 1210, 5980], ["上海", 3250, 196, 1080, 5360],
  ["北京", 2980, 182, 980, 4860], ["四川", 2260, 138, 760, 3820],
].map(([province, allNum, newNum, visitNum, payPrice]) => ({
  province: String(province), allNum: Number(allNum), newNum: Number(newNum),
  visitNum: Number(visitNum), payPrice: Number(payPrice),
}));

const previewBalanceChannel: StatisticDistribution = {
  bing_xdata: ["系统增加", "用户充值", "佣金提现", "抽奖赠送", "商品退款"],
  bing_data: [
    { name: "系统增加", value: 1200, itemStyle: { color: "#64a1f4" } },
    { name: "用户充值", value: 8680, itemStyle: { color: "#3edeb5" } },
    { name: "佣金提现", value: 820, itemStyle: { color: "#70869f" } },
    { name: "抽奖赠送", value: 360, itemStyle: { color: "#ffc653" } },
    { name: "商品退款", value: 920, itemStyle: { color: "#fc7d6a" } },
  ],
  list: [],
};

function previewDistribution(source: StatisticDistribution): StatisticDistribution {
  const total = source.bing_data.reduce((sum, item) => sum + item.value, 0);
  return {
    ...source,
    list: source.bing_data.map(({ name, value }) => ({ name, value, percent: Math.round(value / total * 10_000) / 100 }))
      .sort((left, right) => right.value - left.value),
  };
}

/** GET /adminapi/statistic/order/get_basic */
export function apiOrderStatisticBasic(time: string): Promise<OrderStatisticBasic> {
  if (previewMode) return Promise.resolve(previewOrderBasic);
  return getData(request.get("/statistic/order/get_basic", { params: { time } }));
}

/** GET /adminapi/statistic/order/get_trend */
export function apiOrderStatisticTrend(time: string): Promise<StatisticTrend> {
  if (previewMode) {
    return Promise.resolve({
      xAxis: previewLabels(),
      series: [
        previewSeries("订单金额", 86),
        previewSeries("订单量", 1),
        previewSeries("退款金额", 4),
        previewSeries("退款订单量", 0.08),
        previewSeries("用券金额", 7),
        previewSeries("用券数量", 0.25),
      ],
    });
  }
  return getData(request.get("/statistic/order/get_trend", { params: { time } }));
}

/** GET /adminapi/statistic/order/get_channel */
export function apiOrderStatisticChannel(time: string): Promise<StatisticDistribution> {
  if (previewMode) return Promise.resolve(previewOrderChannel);
  return getData(request.get("/statistic/order/get_channel", { params: { time } }));
}

/** GET /adminapi/statistic/order/get_type */
export function apiOrderStatisticType(time: string): Promise<StatisticDistribution> {
  if (previewMode) {
    const total = previewOrderType.bing_data.reduce((sum, item) => sum + item.value, 0);
    return Promise.resolve({
      ...previewOrderType,
      list: previewOrderType.bing_data
        .map(({ name, value }) => ({ name, value, percent: Math.round(value / total * 10_000) / 100 }))
        .sort((left, right) => right.value - left.value),
    });
  }
  return getData(request.get("/statistic/order/get_type", { params: { time } }));
}

/** GET /adminapi/statistic/product/get_basic */
export function apiProductStatisticBasic(data: string): Promise<ProductStatisticBasic> {
  if (previewMode) return Promise.resolve(previewProductBasic);
  return getData(request.get("/statistic/product/get_basic", { params: { data } }));
}

/** GET /adminapi/statistic/product/get_trend */
export function apiProductStatisticTrend(data: string): Promise<StatisticTrend> {
  if (previewMode) {
    return Promise.resolve({
      xAxis: previewLabels(),
      series: [
        previewSeries("商品浏览量", 84),
        previewSeries("商品访客量", 38),
        previewSeries("支付金额", 86, "bar"),
        previewSeries("退款金额", 4, "bar"),
      ],
    });
  }
  return getData(request.get("/statistic/product/get_trend", { params: { data } }));
}

/** GET /adminapi/statistic/product/get_product_ranking */
export function apiProductStatisticRanking(
  data: string,
  sort: ProductRankingSort,
  limit = 20,
): Promise<ProductRankingRow[]> {
  if (previewMode) return Promise.resolve([...previewRanking].sort((a, b) => Number(b[sort]) - Number(a[sort])).slice(0, limit));
  return getData(request.get("/statistic/product/get_product_ranking", { params: { data, sort, limit } }));
}

/** GET /adminapi/statistic/product/get_excel */
export function apiProductStatisticExport(data: string): Promise<ExportMetadata> {
  if (previewMode) return Promise.resolve({
    header: ["日期/时间", "商品浏览量", "商品访客数", "加购件数", "下单件数", "支付件数", "支付金额", "成本金额", "退款金额", "退款件数", "访客-支付转化率"],
    filekey: ["time", "browse", "user", "cart", "order", "payNum", "pay", "cost", "refund", "refundNum", "changes"],
    export: previewLabels().slice(0, 5).map((time, index) => ({ time, browse: 500 + index * 20, user: 220, cart: 36, order: 18, payNum: 16, pay: 1280, cost: 760, refund: 28, refundNum: 1, changes: 7.27 })),
    filename: "商品统计_预览",
  });
  return getData(request.get("/statistic/product/get_excel", { params: { data } }));
}

export function apiUserStatisticBasic(data: string, channel_type: string): Promise<UserStatisticBasic> {
  if (previewMode) return Promise.resolve(previewUserBasic);
  return getData(request.get("/statistic/user/get_basic", { params: { data, channel_type } }));
}

export function apiUserStatisticTrend(data: string, channel_type: string): Promise<ValueTrend> {
  if (previewMode) return Promise.resolve(previewUserTrend);
  return getData(request.get("/statistic/user/get_trend", { params: { data, channel_type } }));
}

export function apiUserStatisticWechat(data: string): Promise<Record<string, MetricComparison>> {
  if (previewMode) return Promise.resolve({
    subscribe: { num: 486, percent: 12.5 }, unSubscribe: { num: 68, percent: -4.2 },
    increaseSubscribe: { num: 418, percent: 16.8 }, cumulativeSubscribe: { num: 12860, percent: 3.9 },
    cumulativeUnSubscribe: { num: 1250, percent: 1.2 },
  });
  return getData(request.get("/statistic/user/get_wechat", { params: { data, channel_type: "wechat" } }));
}

export function apiUserStatisticWechatTrend(data: string): Promise<ValueTrend> {
  if (previewMode) return Promise.resolve({
    xAxis: previewLabels(),
    series: [
      { name: "新增关注用户", value: previewSeries("新增关注用户", 1.8).data },
      { name: "新增取关用户", value: previewSeries("新增取关用户", 0.3).data },
      { name: "累计关注用户", value: previewLabels().map((_, index) => 12000 + index * 28) },
      { name: "累计取关用户", value: previewLabels().map((_, index) => 1100 + index * 5) },
      { name: "净增用户数", value: previewSeries("净增用户数", 1.5).data },
    ],
  });
  return getData(request.get("/statistic/user/get_wechat_trend", { params: { data, channel_type: "wechat" } }));
}

export function apiUserStatisticRegion(data: string, channel_type: string, sort: string): Promise<UserRegionRow[]> {
  if (previewMode) return Promise.resolve([...previewUserRegion].sort((a, b) => Number(b[sort as keyof UserRegionRow]) - Number(a[sort as keyof UserRegionRow])));
  return getData(request.get("/statistic/user/get_region", { params: { data, channel_type, sort } }));
}

export function apiUserStatisticSex(data: string, channel_type: string): Promise<SexRow[]> {
  if (previewMode) return Promise.resolve([
    { value: 1260, name: "未知", name_key: 0 }, { value: 14280, name: "男", name_key: 1 },
    { value: 13020, name: "女", name_key: 2 },
  ]);
  return getData(request.get("/statistic/user/get_sex", { params: { data, channel_type } }));
}

export function apiUserStatisticExport(data: string, channel_type: string): Promise<ExportMetadata> {
  if (previewMode) return Promise.resolve({
    header: ["日期/时间", "访客数", "浏览量", "新增用户数", "成交用户数", "访客-支付转化率", "付费会员数", "充值用户数", "客单价"],
    filekey: ["time", "user", "browse", "new", "paid", "changes", "vip", "recharge", "payPrice"],
    export: previewLabels().slice(0, 5).map((time, index) => ({ time, user: 260 + index * 6, browse: 580, new: 42, paid: 18, changes: 6.92, vip: 8, recharge: 6, payPrice: 78.5 })),
    filename: "用户统计_预览",
  });
  return getData(request.get("/statistic/user/get_excel", { params: { data, channel_type } }));
}

export function apiTradeStatisticTop(): Promise<TradeTop> {
  if (previewMode) return Promise.resolve({
    left: { name: "当日订单金额", x: Array.from({ length: 24 }, (_, index) => `${String(index).padStart(2, "0")}时`), series: [
      { money: 3860.5, value: Array.from({ length: 24 }, (_, index) => index < 8 ? 0 : 120 + index * 7) },
      { money: 3420.2, value: Array.from({ length: 24 }, (_, index) => index < 8 ? 0 : 100 + index * 6) },
    ] },
    right: {
      today: { x: Array.from({ length: 24 }, (_, index) => String(index).padStart(2, "0")), series: [
        { name: "今日订单数", now_money: 48, last_money: 42, rate: 14.29, value: Array.from({ length: 24 }, (_, index) => index < 8 ? 0 : 2 + index % 4) },
        { name: "今日支付人数", now_money: 39, last_money: 35, rate: 11.43, value: Array.from({ length: 24 }, (_, index) => index < 8 ? 0 : 1 + index % 3) },
      ] },
      month: [
        { name: "本月订单数", now_money: 862, last_money: 798, rate: 8.02, value: [] },
        { name: "本月支付人数", now_money: 624, last_money: 588, rate: 6.12, value: [] },
      ],
    },
  });
  return getData(request.get("/statistic/trade/top_trade"));
}

export function apiTradeStatisticBottom(data: string): Promise<TradeBottom> {
  if (previewMode) {
    const names = ["营业额", "交易毛利金额", "商品支付金额", "购买会员金额", "充值金额", "线下收银金额", "支出金额", "余额支付金额", "支付佣金金额", "商品退款金额"];
    return Promise.resolve({
      x: previewLabels(),
      series: names.map((name, index) => ({ name, desc: `${name}统计口径`, money: 35620 - index * 2180, type: index < 5 || index === 6 ? 1 : 0, rate: 8.6 - index, value: previewSeries(name, Math.max(2, 86 - index * 7)).data })),
      export: "data:text/csv;charset=utf-8,%EF%BB%BF",
    });
  }
  return getData(request.get("/statistic/trade/bottom_trade", { params: { data } }));
}

export function apiBalanceStatisticBasic(): Promise<BalanceStatisticBasic> {
  if (previewMode) return Promise.resolve({ now_balance: 98620.5, add_balance: 286420.8, sub_balance: 187800.3 });
  return getData(request.get("/statistic/balance/get_basic"));
}

export function apiBalanceStatisticTrend(time: string): Promise<StatisticTrend> {
  if (previewMode) return Promise.resolve({ xAxis: previewLabels(), series: [previewSeries("余额积累", 22), previewSeries("余额消耗", 16)] });
  return getData(request.get("/statistic/balance/get_trend", { params: { time } }));
}

export function apiBalanceStatisticChannel(time: string): Promise<StatisticDistribution> {
  if (previewMode) return Promise.resolve(previewDistribution(previewBalanceChannel));
  return getData(request.get("/statistic/balance/get_channel", { params: { time } }));
}

export function apiBalanceStatisticType(time: string): Promise<StatisticDistribution> {
  if (previewMode) return Promise.resolve(previewDistribution({
    bing_xdata: ["系统减少", "充值退款", "购买商品"],
    bing_data: [
      { name: "系统减少", value: 1280, itemStyle: { color: "#64a1f4" } },
      { name: "充值退款", value: 920, itemStyle: { color: "#3edeb5" } },
      { name: "购买商品", value: 18640, itemStyle: { color: "#70869f" } },
    ],
    list: [],
  }));
  return getData(request.get("/statistic/balance/get_type", { params: { time } }));
}
