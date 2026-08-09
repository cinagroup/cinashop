/**
 * 商品评价 Service
 *
 * 对应原版 app/services/product/product/StoreProductReplyServices.php (简化)
 *   - reply_config: 评价统计 (好评率/总数)
 *   - reply_list: 商品评价列表 (含评论数)
 *   - 用户提交评价 (订单完成后)
 */
import { eq, sql } from "drizzle-orm";
import { storeProductReply } from "@/models/schema";
import type { Container } from "@/lib/di";
import { ValidateException } from "@/utils/errors";

export class ReplyService {
  constructor(private readonly container: Container) {}

  /** 评价配置/统计 (GET /reply/config/:productId) */
  async replyConfig(productId: number) {
    const stats = await this.container.replyDao.stats(productId);
    return stats;
  }

  /** 商品评价列表 (GET /reply/list/:productId) */
  async replyList(productId: number, page = 1, limit = 10) {
    const list = await this.container.replyDao.listByProduct(productId, page, limit);
    return list.map((item) => ({
      ...item,
      pics: this.parsePics(item.pics),
    }));
  }

  /** 用户提交评价 (POST /reply/submit, 订单完成后评价) */
  async submitReply(
    uid: number,
    params: {
      unique: string;
      comment: string;
      productScore: number;
      serviceScore: number;
      logisticsScore: number;
      pics?: string[];
    },
  ): Promise<{ id: number }> {
    const c = this.container;
    if (!params.unique) throw new ValidateException("缺少订单商品标识");
    if (!params.comment?.trim()) throw new ValidateException("评价内容不能为空");

    // 查订单商品快照
    const cartInfo = await c.storeOrderCartInfoDao.getByUnique(params.unique);
    if (!cartInfo) throw new ValidateException("订单商品不存在");

    // 查用户昵称/头像
    const user = await c.userDao.findForAuth(uid);
    if (!user) throw new ValidateException("用户不存在");

    // 幂等: 同 unique 已评价则拒绝
    const existing = await c.db
      .select()
      .from(storeProductReply)
      .where(eq(storeProductReply.unique, params.unique))
      .limit(1);
    if (existing[0]) throw new ValidateException("该商品已评价");

    const now = Math.floor(Date.now() / 1000);
    const row = await c.db
      .insert(storeProductReply)
      .values({
        productId: cartInfo.productId,
        oid: cartInfo.id,
        unique: params.unique,
        uid,
        nickname: user.nickname || "用户",
        avatar: user.avatar || "",
        comment: params.comment.trim(),
        sku: this.extractSku(cartInfo.cartInfo),
        productScore: Math.min(5, Math.max(1, params.productScore || 5)),
        serviceScore: Math.min(5, Math.max(1, params.serviceScore || 5)),
        logisticsScore: Math.min(5, Math.max(1, params.logisticsScore || 5)),
        pics: params.pics ? JSON.stringify(params.pics) : "[]",
        isReply: 0,
        merchantReply: "",
        merchantReplyTime: 0,
        praise: 0,
        status: 1,
        top: 0,
        isDel: 0,
        addTime: now,
      })
      .returning({ id: storeProductReply.id });

    return { id: row[0].id };
  }

  /** 评价点赞 (POST /reply/praise/:id) */
  async praise(_uid: number, replyId: number): Promise<{ praise: number }> {
    const c = this.container;
    await c.db
      .update(storeProductReply)
      .set({ praise: sql`praise + 1` })
      .where(eq(storeProductReply.id, replyId));
    const rows = await c.db
      .select({ praise: storeProductReply.praise })
      .from(storeProductReply)
      .where(eq(storeProductReply.id, replyId))
      .limit(1);
    return { praise: rows[0]?.praise ?? 0 };
  }

  private parsePics(pics: string | null): string[] {
    if (!pics) return [];
    try {
      const arr = JSON.parse(pics);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  /** 从 cartInfo JSON 快照提取商品规格名 */
  private extractSku(cartInfo: unknown): string {
    if (typeof cartInfo !== "string") return "";
    try {
      const info = JSON.parse(cartInfo);
      return info?.product?.attrInfo?.suk ?? info?.attrInfo?.suk ?? "";
    } catch {
      return "";
    }
  }
}
