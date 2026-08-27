/**
 * Admin 认证 + Dashboard API
 */
import request, { getData } from "@/utils/request";
import type {
  AdminLoginResult,
  DashboardCycle,
  DashboardData,
  DashboardOrderChart,
  DashboardUserChart,
} from "@/types/admin";

const previewMode =
  import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";

function previewOrderChart(cycle: DashboardCycle): DashboardOrderChart {
  const labels = cycle === "week"
    ? ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
    : cycle === "year"
      ? Array.from({ length: 12 }, (_, index) => String(index + 1))
      : cycle === "month"
        ? Array.from({ length: 31 }, (_, index) => String(index + 1))
        : Array.from({ length: 30 }, (_, index) => `${String(index + 1).padStart(2, "0")}日`);
  const currentCount = labels.map((_, index) => 8 + ((index * 7) % 13));
  const currentPrice = currentCount.map((count, index) => count * (86 + (index % 4) * 9));
  const previousCount = currentCount.map((count, index) => Math.max(1, count - 2 - (index % 3)));
  const previousPrice = previousCount.map((count, index) => count * (80 + (index % 4) * 8));
  const comparisonMode = cycle !== "thirtyday";
  const legend = comparisonMode
    ? ["上期金额", "本期金额", "上期订单数", "本期订单数"]
    : ["订单金额", "订单数"];
  return {
    yAxis: {
      maxnum: Math.max(...currentCount, ...previousCount),
      maxprice: Math.max(...currentPrice, ...previousPrice),
    },
    legend,
    xAxis: labels,
    series: comparisonMode
      ? [
          { name: legend[0], type: "bar", data: previousPrice },
          { name: legend[1], type: "bar", data: currentPrice },
          { name: legend[2], type: "line", data: previousCount, yAxisIndex: 1 },
          { name: legend[3], type: "line", data: currentCount, yAxisIndex: 1 },
        ]
      : [
          { name: legend[0], type: "bar", data: currentPrice },
          { name: legend[1], type: "line", data: currentCount, yAxisIndex: 1 },
        ],
    pre_cycle: { count: { data: 318 }, price: { data: 29_840 } },
    cycle: {
      count: { data: 362, percent: 13.84, is_plus: 1 },
      price: { data: 35_620, percent: 19.37, is_plus: 1 },
    },
  };
}

/** 管理员登录 (POST /adminapi/login) */
export function apiAdminLogin(account: string, pwd: string): Promise<AdminLoginResult> {
  return getData(request.post<AdminLoginResult>("/login", { account, pwd }));
}

/** Dashboard 统计 (GET /adminapi/home/header) */
export function apiDashboard(): Promise<DashboardData> {
  if (previewMode) {
    return Promise.resolve({
      info: [
        { title: "销售额", today: "2687.20", yesterday: "2148.80", today_ratio: 25.06, total: "38642.50元", total_name: "本月销售额", date: "今日" },
        { title: "用户访问量", today: 1286, yesterday: 1098, today_ratio: 17.12, total: "18642Pv", total_name: "本月访问量", date: "今日" },
        { title: "订单量", today: 19, yesterday: 16, today_ratio: 18.75, total: "362单", total_name: "本月订单量", date: "今日" },
        { title: "新增用户", today: 8, yesterday: 6, today_ratio: 33.33, total: "126人", total_name: "本月新增用户", date: "今日" },
      ],
    });
  }
  return getData(request.get<DashboardData>("/home/header"));
}

/** 首页订单图表 (GET /adminapi/home/order) */
export function apiDashboardOrder(cycle: DashboardCycle): Promise<DashboardOrderChart> {
  if (previewMode) return Promise.resolve(previewOrderChart(cycle));
  return getData(request.get<DashboardOrderChart>("/home/order", { params: { cycle } }));
}

/** 首页用户图表 (GET /adminapi/home/user) */
export function apiDashboardUser(): Promise<DashboardUserChart> {
  if (previewMode) {
    const series = Array.from({ length: 30 }, (_, index) => 2 + ((index * 5) % 9));
    return Promise.resolve({
      legend: ["用户数"],
      yAxis: { maxnum: Math.max(...series) },
      xAxis: Array.from({ length: 30 }, (_, index) => `${String(index + 1).padStart(2, "0")}日`),
      series,
      bing_xdata: ["未消费用户", "消费一次用户", "留存客户", "回流客户"],
      bing_data: [
        { name: "未消费用户", value: 82, itemStyle: { color: "#5cadff" } },
        { name: "消费一次用户", value: 31, itemStyle: { color: "#b37feb" } },
        { name: "留存客户", value: 19, itemStyle: { color: "#19be6b" } },
        { name: "回流客户", value: 7, itemStyle: { color: "#ff9900" } },
      ],
    });
  }
  return getData(request.get<DashboardUserChart>("/home/user"));
}

/** 管理员消息通知 (GET /adminapi/new_push) */
export function apiNewPush(): Promise<{
  ordernum: number;
  inventory: number;
  commentnum: number;
  reflectnum: number;
  msgcount: number;
}> {
  if (previewMode) {
    return Promise.resolve({ ordernum: 6, inventory: 2, commentnum: 3, reflectnum: 1, msgcount: 4 });
  }
  return getData(request.get("/new_push"));
}
