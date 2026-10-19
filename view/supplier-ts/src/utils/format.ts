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

export function orderStatus(row: { paid: number; status: number; refund_status: number; shipping_type?: number; is_del?: number }) {
  if (row.is_del === 1) return { label: '用户已删除', tone: 'info' };
  if (row.refund_status === 2) return { label: '已退款', tone: 'danger' };
  if ([1, 4].includes(row.refund_status)) return { label: "售后中", tone: "danger" };
  if (!row.paid) return { label: "待付款", tone: "info" };
  const fulfillment = [0, 1].includes(row.status) && row.shipping_type === 2 ? { label: '待核销', tone: 'warning' }
    : row.status === 0 ? { label: '待发货', tone: 'warning' }
    : row.status === 1 ? { label: '已发货', tone: 'primary' }
    : row.status === 2 ? { label: '已收货', tone: 'success' }
    : row.status === 3 ? { label: '已完成', tone: 'success' }
    : row.status === 4 ? { label: '部分发货', tone: 'warning' }
    : row.status === 5 && row.shipping_type === 2 ? { label: '部分核销', tone: 'warning' }
    : row.status === 5 && [1, 3].includes(row.shipping_type ?? 0) ? { label: '部分收货', tone: 'warning' }
    : { label: '处理中', tone: 'info' };
  // refund_status=3 is a partial refund; rejection is refund_type=3. Preserve
  // the fulfillment stage as well so a remaining shipment is still visible.
  return row.refund_status === 3 ? { label: `部分退款 · ${fulfillment.label}`, tone: 'danger' } : fulfillment;
}

export function payType(value: string) {
  const map: Record<string, string> = {
    weixin: "微信支付",
    alipay: "支付宝",
    yue: "余额支付",
    offline: "线下支付",
    integral: '积分支付',
    cash: '现金支付',
  };
  return Object.hasOwn(map, value) ? map[value] : value || "—";
}
