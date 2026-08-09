/**
 * 活动参与 Service (拼团/砍价)
 *
 * 对应原版端点:
 *   - 拼团: combination/pink/:id, pink, combination/remove
 *   - 砍价: bargain/start, bargain/user/list, bargain/user/cancel
 */
import { eq, and, sql } from "drizzle-orm";
import {
  storePink,
  storeCombination,
  storeBargain,
  storeBargainUser,
} from "@/models/schema";
import type { Container } from "@/lib/di";
import { ValidateException, NotFoundException } from "@/utils/errors";

export class ActivityJoinService {
  constructor(private readonly container: Container) {}

  // ═══ 拼团 ═════════════════════════════════════════════════

  /** 拼团详情含进行中的团 (combination/pink/:id) */
  async pinkInfo(uid: number, combinationId: number) {
    const combo = await this.container.db
      .select()
      .from(storeCombination)
      .where(eq(storeCombination.id, combinationId))
      .limit(1);
    if (!combo[0]) throw new NotFoundException("拼团活动不存在");

    // 进行中的团
    const pinks = await this.container.db
      .select()
      .from(storePink)
      .where(
        and(eq(storePink.combinationId, combinationId), eq(storePink.status, 1)),
      )
      .orderBy(sql`${storePink.addTime} DESC`)
      .limit(5);

    return {
      combination: combo[0],
      pinkList: pinks,
      people: combo[0].people,
      price: combo[0].price,
      otPrice: combo[0].otPrice,
      // 是否已参与
      myPink: pinks.find((p) => p.uid === uid) ?? null,
    };
  }

  /** 参与拼团 (pink, 支持开团/参团) */
  async joinPink(
    uid: number,
    params: {
      combinationId: number;
      productId: number;
      orderId: string;
      /** 参团的团 ID (0/缺省 = 开团) */
      kId?: number;
    },
  ): Promise<{ pinkId: number; isLeader: boolean; people: number }> {
    const combo = await this.container.db
      .select()
      .from(storeCombination)
      .where(eq(storeCombination.id, params.combinationId))
      .limit(1);
    if (!combo[0]) throw new NotFoundException("拼团活动不存在");
    if (combo[0].status !== 1) throw new ValidateException("拼团活动已结束");

    const now = Math.floor(Date.now() / 1000);
    const kId = params.kId ?? 0;

    if (kId > 0) {
      // 参团: 校验目标团状态, 人数 +1, 满员成团
      const pink = await this.container.db
        .select()
        .from(storePink)
        .where(and(eq(storePink.id, kId), eq(storePink.status, 1)))
        .limit(1);
      if (!pink[0]) throw new ValidateException("该团已结束, 请重新开团");
      if (pink[0].combinationId !== params.combinationId) {
        throw new ValidateException("拼团信息不匹配");
      }
      const people = pink[0].people + 1;
      const full = people >= combo[0].people;
      await this.container.db
        .update(storePink)
        .set({ people, status: full ? 2 : 1 })
        .where(eq(storePink.id, kId));
      return { pinkId: kId, isLeader: false, people };
    }

    // 开团 (kId=0)
    const row = await this.container.db
      .insert(storePink)
      .values({
        uid,
        orderId: params.orderId,
        orderIdKey: params.orderId,
        combinationId: params.combinationId,
        productId: params.productId,
        kId: 0,
        people: 1,
        status: 1,
        addTime: now,
      })
      .returning();
    return { pinkId: row[0].id, isLeader: true, people: 1 };
  }

  /** 取消开团 (combination/remove) */
  async removePink(uid: number, pinkId: number): Promise<void> {
    const pink = await this.container.db
      .select()
      .from(storePink)
      .where(and(eq(storePink.id, pinkId), eq(storePink.uid, uid)))
      .limit(1);
    if (!pink[0]) throw new NotFoundException("拼团记录不存在");
    await this.container.db
      .update(storePink)
      .set({ status: 3 }) // 失败
      .where(eq(storePink.id, pinkId));
  }

  // ═══ 砍价 ═════════════════════════════════════════════════

  /** 发起砍价 (bargain/start) */
  async startBargain(uid: number, bargainId: number): Promise<{ id: number }> {
    const bargain = await this.container.db
      .select()
      .from(storeBargain)
      .where(eq(storeBargain.id, bargainId))
      .limit(1);
    if (!bargain[0]) throw new NotFoundException("砍价活动不存在");

    // 已参与则返回原记录
    const existing = await this.container.db
      .select()
      .from(storeBargainUser)
      .where(
        and(
          eq(storeBargainUser.uid, uid),
          eq(storeBargainUser.bargainId, bargainId),
          eq(storeBargainUser.status, 1),
        ),
      )
      .limit(1);
    if (existing[0]) return { id: existing[0].id };

    const row = await this.container.db
      .insert(storeBargainUser)
      .values({
        uid,
        bargainId,
        bargainPriceMin: bargain[0].minPrice,
        bargainPrice: bargain[0].price,
        price: "0.00",
        status: 1,
        addTime: Math.floor(Date.now() / 1000),
      })
      .returning();
    return { id: row[0].id };
  }

  /** 帮砍 (bargain/help, 简化: 每次砍掉当前价与最低价差额的 10%) */
  async helpBargain(uid: number, bargainUserId: number): Promise<{ price: string }> {
    // 校验用户存在 (帮砍者必须是有效用户)
    const user = await this.container.userDao.findForAuth(uid);
    if (!user) throw new NotFoundException("用户不存在");
    const record = await this.container.db
      .select()
      .from(storeBargainUser)
      .where(eq(storeBargainUser.id, bargainUserId))
      .limit(1);
    if (!record[0]) throw new NotFoundException("砍价记录不存在");

    const current = Number(record[0].bargainPrice);
    const min = Number(record[0].bargainPriceMin);
    if (current <= min) {
      throw new ValidateException("已砍到最低价");
    }

    // 每次砍掉差额的 10%, 最少 0.01
    const cut = Math.max(0.01, Math.round((current - min) * 0.1 * 100) / 100);
    const newPrice = Math.max(min, Math.round((current - cut) * 100) / 100);

    await this.container.db
      .update(storeBargainUser)
      .set({
        bargainPrice: newPrice.toFixed(2),
        price: (Number(record[0].price) + cut).toFixed(2),
        status: newPrice <= min ? 3 : 1,
      })
      .where(eq(storeBargainUser.id, bargainUserId));

    return { price: cut.toFixed(2) };
  }

  /** 我的砍价列表 (bargain/user/list) */
  async myBargains(uid: number) {
    return this.container.db
      .select()
      .from(storeBargainUser)
      .where(and(eq(storeBargainUser.uid, uid), eq(storeBargainUser.isDel, 0)))
      .orderBy(sql`${storeBargainUser.addTime} DESC`)
      .limit(20);
  }

  /** 取消砍价 (bargain/user/cancel) */
  async cancelBargain(uid: number, id: number): Promise<void> {
    await this.container.db
      .update(storeBargainUser)
      .set({ isDel: 1, status: 2 })
      .where(and(eq(storeBargainUser.id, id), eq(storeBargainUser.uid, uid)));
  }
}
