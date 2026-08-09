/**
 * 物流查询 Service
 *
 * 对应原版 app/services/other/ExpressServices.php (简化)
 *   - 从 store_order_status 取发货记录 (admin 发货时记录的快递公司+单号)
 *   - 返回模拟轨迹 (M6+ 可接入快递100 API)
 */
import type { Container } from "@/lib/di";
import { NotFoundException } from "@/utils/errors";

export class ExpressService {
  constructor(private readonly container: Container) {}

  /** 查询订单物流 (GET /order/express/:orderId) */
  async query(uid: number, orderId: string) {
    const c = this.container;
    const order = await c.storeOrderDao.findByOrderId(orderId);
    if (!order) throw new NotFoundException("订单不存在");
    if (order.uid !== uid) throw new NotFoundException("订单不属于当前用户");

    // 从订单状态日志取发货记录
    const statuses = await c.storeOrderStatusDao.selectList({ where: { oid: order.id } });
    const deliveryLog = statuses.find((s: { changeType: string; changeMessage: string }) => s.changeType === "delivery_goods");
    const expressInfo = this.parseDeliveryLog(deliveryLog?.changeMessage ?? "");

    // 未发货
    if (!expressInfo.expressNo) {
      return {
        orderId: order.orderId,
        deliveryStatus: order.status >= 1 ? "已发货" : "未发货",
        expressName: "",
        expressNo: "",
        traces: [] as TraceItem[],
      };
    }

    const traces = this.generateMockTraces(order.payTime ?? 0, expressInfo);

    return {
      orderId: order.orderId,
      deliveryStatus: order.status >= 2 ? "已签收" : "运输中",
      expressName: expressInfo.expressName,
      expressNo: expressInfo.expressNo,
      traces,
    };
  }

  /** 解析发货日志 "已发货: 顺丰速运 SF1234567890" */
  private parseDeliveryLog(msg: string): { expressName: string; expressNo: string } {
    // 格式: "已发货: {公司名} {单号}"
    const match = msg.match(/已发货:\s*(\S+)\s+(\S+)/);
    if (match) {
      return { expressName: match[1], expressNo: match[2] };
    }
    return { expressName: "", expressNo: "" };
  }

  private generateMockTraces(
    payTime: number,
    info: { expressName: string; expressNo: string },
  ): TraceItem[] {
    const now = Math.floor(Date.now() / 1000);
    const base = payTime || now;
    const elapsed = now - base;
    const traces: TraceItem[] = [];

    traces.push({
      time: this.fmt(base + 3600),
      content: `【${info.expressName}】已揽收, 运单号 ${info.expressNo}`,
      status: "揽收",
    });
    traces.push({
      time: this.fmt(base + 7200),
      content: "快件已到达【深圳转运中心】",
      status: "运输中",
    });
    traces.push({
      time: this.fmt(base + 10800),
      content: "快件已发出, 下一站【目的地城市】",
      status: "运输中",
    });
    if (elapsed > 86400) {
      traces.push({
        time: this.fmt(base + 86400),
        content: "快件已到达【目的地营业点】, 正在派送",
        status: "派送中",
      });
    }
    if (elapsed > 172800) {
      traces.push({
        time: this.fmt(base + 172800),
        content: "快件已签收, 签收人: 本人",
        status: "已签收",
      });
    }
    return traces;
  }

  private fmt(ts: number): string {
    const d = new Date(ts * 1000);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
}

interface TraceItem {
  time: string;
  content: string;
  status: string;
}
