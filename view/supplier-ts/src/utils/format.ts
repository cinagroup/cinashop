export function formatMoney(value: string | number) {
  return `¥${Number(value).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatTime(value: number) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value * 1000));
}

export function orderStatus(row: { paid: number; status: number; refund_status: number }) {
  if (row.refund_status > 0) return { label: "售后中", tone: "danger" };
  if (!row.paid) return { label: "待付款", tone: "info" };
  if (row.status === 0) return { label: "待发货", tone: "warning" };
  if (row.status === 1) return { label: "已发货", tone: "primary" };
  if (row.status === 2) return { label: "已收货", tone: "success" };
  if (row.status === 3) return { label: "已完成", tone: "success" };
  return { label: "处理中", tone: "info" };
}

export function payType(value: string) {
  const map: Record<string, string> = {
    weixin: "微信支付",
    alipay: "支付宝",
    yue: "余额支付",
    offline: "线下支付",
  };
  return map[value] ?? (value || "—");
}
