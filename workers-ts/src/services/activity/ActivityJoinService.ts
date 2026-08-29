/**
 * 活动参与 Service (拼团/砍价)
 *
 * 对应原版端点:
 *   - 拼团: combination/pink/:id, pink, combination/remove
 *   - 砍价: bargain/start, bargain/user/list, bargain/user/cancel
 */
import { eq, and, desc, gt, inArray, or, sql } from "drizzle-orm";
import {
  storePink,
  storeSeckill,
  storeCombination,
  storeBargain,
  storeBargainUser,
  storeBargainUserHelp,
  storeOrder,
  user,
} from "@/models/schema";
import { withTx, type Container } from "@/lib/di";
import type { Env } from "@/env";
import { ValidateException, NotFoundException } from "@/utils/errors";
import { centsToDecimal, decimalToCents } from "@/services/order/OrderBrokerageService";
import { StoreOrderRefundService } from "@/services/order/StoreOrderRefundService";
import { PublicCatalogService } from "@/services/product/PublicCatalogService";
import { SystemConfigService } from "@/services/system/SystemConfigService";
import { createQrSvgDataUrl } from "@/services/user/MembershipScanService";
import {
  WechatMiniProgramCodeService,
  type LegacyActivityCodeType,
} from "@/services/wechat/WechatMiniProgramCodeService";

const BARGAIN_HELP_LOCK_NAMESPACE = 731_627;

export function calculateBargainHelpCutCents(input: {
  remainingCents: number;
  remainingPeople: number;
  percent: number;
}): number {
  if (!Number.isSafeInteger(input.remainingCents) || input.remainingCents <= 0) {
    throw new ValidateException("砍价剩余金额无效");
  }
  if (!Number.isSafeInteger(input.remainingPeople) || input.remainingPeople <= 0) {
    throw new ValidateException("砍价剩余人数无效");
  }
  if (input.remainingPeople === 1) return input.remainingCents;
  const percent = Math.max(10, Math.min(30, Math.trunc(input.percent)));
  const distributableCents = Math.max(0, input.remainingCents - input.remainingPeople);
  const proportionalCut = Math.floor(distributableCents * percent / 100);
  const maxCut = input.remainingCents - (input.remainingPeople - 1);
  return Math.min(Math.max(1, proportionalCut), maxCut);
}

function randomBargainPercent(): number {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return 10 + value[0] % 21;
}

export class ActivityJoinService {
  constructor(
    private readonly container: Container,
    private readonly env?: Env,
  ) {}

  private runtimeEnv(): Env {
    if (!this.env) throw new Error("活动兼容服务缺少运行环境");
    return this.env;
  }

  private async routineCode(
    type: LegacyActivityCodeType,
    id: number,
    uid: number,
  ): Promise<string> {
    try {
      return await new WechatMiniProgramCodeService(
        this.container,
        this.runtimeEnv(),
      ).createActivityDataUrl(type, id, uid) ?? "";
    } catch (error) {
      console.error(JSON.stringify({
        event: "legacy_activity_code_failed",
        type,
        id,
        error: error instanceof Error ? error.message : String(error),
      }));
      return "";
    }
  }

  async bargainConfig(): Promise<Record<string, unknown>> {
    const groups = await new PublicCatalogService(
      this.container,
      this.runtimeEnv(),
    ).groupDataMany(["routine_lovely"]);
    return groups.routine_lovely?.[2] ?? {};
  }

  async combinationBanner(): Promise<Record<string, unknown>[]> {
    const groups = await new PublicCatalogService(
      this.container,
      this.runtimeEnv(),
    ).groupDataMany(["combination_banner"]);
    return groups.combination_banner ?? [];
  }

  async activityDetailCode(
    type: 1 | 3,
    id: number,
    uid: number,
    query: { time?: string; status?: string },
  ): Promise<{ code_base: string }> {
    if (!Number.isSafeInteger(id) || id <= 0) throw new ValidateException("缺少参数");
    const exists = type === 1
      ? await this.container.db.select({ id: storeSeckill.id }).from(storeSeckill)
          .where(and(eq(storeSeckill.id, id), eq(storeSeckill.status, 1), eq(storeSeckill.isShow, 1), eq(storeSeckill.isDel, 0))).limit(1)
      : await this.container.db.select({ id: storeCombination.id }).from(storeCombination)
          .where(and(eq(storeCombination.id, id), eq(storeCombination.status, 1), eq(storeCombination.isShow, 1), eq(storeCombination.isDel, 0))).limit(1);
    if (!exists[0]) throw new NotFoundException(type === 1 ? "秒杀商品不存在" : "拼团商品不存在");

    const raw = await new SystemConfigService(this.container, this.runtimeEnv()).get("site_url");
    let url: URL;
    try {
      url = new URL(typeof raw === "string" ? raw.trim() : "");
    } catch {
      throw new ValidateException("站点地址 site_url 未正确配置");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new ValidateException("站点地址 site_url 必须使用 HTTP 或 HTTPS");
    }
    url.pathname = `${url.pathname.replace(/\/$/, "")}/pages/activity/goods_details/index`;
    url.hash = "";
    url.search = new URLSearchParams({
      type: String(type),
      id: String(id),
      spid: String(uid),
      ...(type === 1 && query.time ? { time: query.time.slice(0, 64) } : {}),
      ...(type === 1 && query.status ? { status: query.status.slice(0, 32) } : {}),
    }).toString();
    return { code_base: createQrSvgDataUrl(url.toString()) };
  }

  async activityRoutineCode(
    type: 1 | 3,
    id: number,
    uid: number,
  ): Promise<{ code: string }> {
    if (!Number.isSafeInteger(id) || id <= 0) throw new ValidateException("缺少参数");
    const exists = type === 1
      ? await this.container.db.select({ id: storeSeckill.id }).from(storeSeckill)
          .where(and(eq(storeSeckill.id, id), eq(storeSeckill.status, 1), eq(storeSeckill.isShow, 1), eq(storeSeckill.isDel, 0))).limit(1)
      : await this.container.db.select({ id: storeCombination.id }).from(storeCombination)
          .where(and(eq(storeCombination.id, id), eq(storeCombination.status, 1), eq(storeCombination.isShow, 1), eq(storeCombination.isDel, 0))).limit(1);
    if (!exists[0]) throw new NotFoundException(type === 1 ? "秒杀商品不存在" : "拼团商品不存在");
    return { code: await this.routineCode(type, id, uid) };
  }

  // ═══ 拼团 ═════════════════════════════════════════════════

  /** 拼团详情含进行中的团 (combination/pink/:id) */
  async pinkInfo(uid: number, combinationId: number) {
    const combo = await this.container.db
      .select()
      .from(storeCombination)
      .where(
        and(
          eq(storeCombination.id, combinationId),
          eq(storeCombination.status, 1),
          eq(storeCombination.isShow, 1),
          eq(storeCombination.isDel, 0),
          sql`(${storeCombination.startTime} IS NULL OR ${storeCombination.startTime} <= NOW())`,
          sql`(${storeCombination.stopTime} IS NULL OR ${storeCombination.stopTime} >= NOW())`,
        ),
      )
      .limit(1);
    if (!combo[0]) throw new NotFoundException("拼团活动不存在");

    // 进行中的团
    const pinks = await this.container.db
      .select()
      .from(storePink)
      .where(
        and(
          eq(storePink.combinationId, combinationId),
          eq(storePink.kId, 0),
          eq(storePink.status, 1),
          eq(storePink.isRefund, 0),
          sql`(${storePink.stopTime} IS NULL OR ${storePink.stopTime} > NOW())`,
        ),
      )
      .orderBy(sql`${storePink.addTime} DESC`)
      .limit(5);

    const pinkList = await Promise.all(
      pinks.map(async (pink) => {
        const currentPeople = pink.memberCount > 0
          ? pink.memberCount
          : Number(
              (
                await this.container.db
                  .select({ count: sql<number>`COUNT(*)::int` })
                  .from(storePink)
                  .where(
                    and(
                      or(eq(storePink.id, pink.id), eq(storePink.kId, pink.id)),
                      eq(storePink.isRefund, 0),
                    ),
                  )
              )[0]?.count ?? 1,
            );
        return { ...pink, requiredPeople: pink.people, people: currentPeople };
      }),
    );
    const myPink = await this.container.db
      .select()
      .from(storePink)
      .where(
        and(
          eq(storePink.combinationId, combinationId),
          eq(storePink.uid, uid),
          eq(storePink.isRefund, 0),
        ),
      )
      .orderBy(sql`${storePink.addTime} DESC`)
      .limit(1);

    return {
      combination: combo[0],
      pinkList,
      people: combo[0].people,
      price: combo[0].price,
      otPrice: combo[0].otPrice,
      // 是否已参与
      myPink: myPink[0] ?? null,
    };
  }

  /** PHP GET /pink: completed/all participant count and up to three avatars. */
  async pinkStats(type = 1): Promise<{ pink_count: number; avatars: string[] }> {
    const conditions = [eq(storePink.isRefund, 0), gt(storePink.uid, 0)];
    if (type === 1) conditions.push(eq(storePink.status, 2));
    const [countRows, participantRows] = await Promise.all([
      this.container.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(storePink)
        .where(and(...conditions)),
      this.container.db
        .select({ uid: storePink.uid })
        .from(storePink)
        .where(and(...conditions))
        .orderBy(desc(storePink.addTime), desc(storePink.id))
        .limit(20),
    ]);
    const uids = [...new Set(participantRows.map((row) => row.uid))].slice(0, 3);
    if (!uids.length) return { pink_count: Number(countRows[0]?.count ?? 0), avatars: [] };
    const users = await this.container.db
      .select({ uid: user.uid, avatar: user.avatar })
      .from(user)
      .where(inArray(user.uid, uids));
    const avatarsByUid = new Map(users.map((item) => [item.uid, item.avatar]));
    return {
      pink_count: Number(countRows[0]?.count ?? 0),
      avatars: uids.map((uid) => avatarsByUid.get(uid) ?? "").filter(Boolean),
    };
  }

  async combinationPoster(uid: number, pinkId: number) {
    if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(pinkId) || pinkId <= 0) {
      throw new ValidateException("参数错误");
    }
    const pinkRows = await this.container.db
      .select()
      .from(storePink)
      .where(eq(storePink.id, pinkId))
      .limit(1);
    const pink = pinkRows[0];
    if (!pink) throw new NotFoundException("拼团记录不存在");
    const rootId = pink.kId > 0 ? pink.kId : pink.id;
    const [combinationRows, memberRows, ownMembershipRows] = await Promise.all([
      this.container.db
        .select({
          title: storeCombination.storeName,
          image: storeCombination.image,
          otPrice: storeCombination.otPrice,
        })
        .from(storeCombination)
        .where(and(
          eq(storeCombination.id, pink.combinationId),
          eq(storeCombination.isDel, 0),
        ))
        .limit(1),
      this.container.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(storePink)
        .where(and(
          or(eq(storePink.id, rootId), eq(storePink.kId, rootId)),
          eq(storePink.isRefund, 0),
        )),
      this.container.db
        .select({ id: storePink.id })
        .from(storePink)
        .where(and(
          or(eq(storePink.id, rootId), eq(storePink.kId, rootId)),
          eq(storePink.uid, uid),
          eq(storePink.isRefund, 0),
        ))
        .limit(1),
    ]);
    const combination = combinationRows[0];
    if (!combination) throw new NotFoundException("拼团商品不存在");
    if (!ownMembershipRows[0]) throw new NotFoundException("拼团记录不存在");
    const memberCount = Number(memberRows[0]?.count ?? 0);
    return {
      title: combination.title,
      url: await this.routineCode(31, pinkId, uid),
      image: combination.image,
      price: pink.price,
      label: `${pink.people}人团`,
      msg: `划线价￥${combination.otPrice} 还差${Math.max(0, pink.people - memberCount)}人拼团成功`,
    };
  }

  /** 取消开团 (combination/remove) */
  async removePink(
    uid: number,
    pinkId: number,
    combinationId: number,
  ): Promise<{ completed: boolean; status: string }> {
    const pink = await this.container.db
      .select()
      .from(storePink)
      .where(
        and(
          eq(storePink.id, pinkId),
          eq(storePink.uid, uid),
          eq(storePink.combinationId, combinationId),
          eq(storePink.kId, 0),
          eq(storePink.status, 1),
          eq(storePink.isRefund, 0),
          sql`(${storePink.stopTime} IS NULL OR ${storePink.stopTime} > NOW())`,
        ),
      )
      .limit(1);
    if (!pink[0]) throw new NotFoundException("未查到可取消的拼团记录");
    if (!this.env) throw new Error("取消拼团缺少运行环境");

    const [activeMembers, pendingOrders] = await Promise.all([
      this.container.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(storePink)
        .where(and(eq(storePink.kId, pinkId), eq(storePink.isRefund, 0))),
      this.container.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(storeOrder)
        .where(
          and(
            eq(storeOrder.type, 3),
            eq(storeOrder.pinkId, pinkId),
            eq(storeOrder.paid, 0),
            eq(storeOrder.status, 0),
            eq(storeOrder.isDel, 0),
          ),
        ),
    ]);
    if (Number(activeMembers[0]?.count ?? 0) === 0 && Number(pendingOrders[0]?.count ?? 0) > 0) {
      throw new ValidateException("该团仍有待支付参团订单，暂不能取消");
    }
    const order = await this.container.storeOrderDao.get(Number(pink[0].orderIdKey));
    if (!order || order.uid !== uid || !order.paid) throw new ValidateException("拼团订单不存在或未支付");
    const refundService = new StoreOrderRefundService(this.container, this.env);
    const existing = await this.container.storeOrderRefundDao.getByOrderId(order.id);
    let refund = existing.find(
      (item) => [0, 1, 2, 4, 5].includes(item.refundType) && !item.isCancel && !item.isDel,
    );
    if (!refund) {
      const created = await refundService.applyRefund({
        uid,
        orderId: order.orderId,
        refundReason: "用户手动取消拼团",
        refundExplain: "用户手动取消未成团的拼团订单",
        applyType: 1,
      });
      refund = (await this.container.storeOrderRefundDao.get(created.refundId)) ?? undefined;
    }
    if (!refund) throw new Error("拼团退款记录创建失败");
    return refundService.agreeRefund(refund.id);
  }

  // ═══ 砍价 ═════════════════════════════════════════════════

  /** 发起砍价 (bargain/start) */
  async startBargain(uid: number, bargainId: number): Promise<{ id: number }> {
    if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(bargainId) || bargainId <= 0) {
      throw new ValidateException("砍价参数错误");
    }
    return withTx(this.container, async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`bargain-start:${uid}:${bargainId}`}, 0))`,
      );
      const bargains = await tx
        .select()
        .from(storeBargain)
        .where(
          and(
            eq(storeBargain.id, bargainId),
            eq(storeBargain.status, 1),
            eq(storeBargain.isDel, 0),
            sql`(${storeBargain.startTime} IS NULL OR ${storeBargain.startTime} <= NOW())`,
            sql`(${storeBargain.stopTime} IS NULL OR ${storeBargain.stopTime} >= NOW())`,
          ),
        )
        .limit(1)
        .for("key share");
      const bargain = bargains[0];
      if (!bargain) throw new NotFoundException("砍价活动不存在");

      const existing = await tx
        .select({ id: storeBargainUser.id })
        .from(storeBargainUser)
        .where(
          and(
            eq(storeBargainUser.uid, uid),
            eq(storeBargainUser.bargainId, bargainId),
            eq(storeBargainUser.status, 1),
            eq(storeBargainUser.isDel, 0),
          ),
        )
        .orderBy(desc(storeBargainUser.id))
        .limit(1);
      if (existing[0]) return { id: existing[0].id };

      const rows = await tx
        .insert(storeBargainUser)
        .values({
          uid,
          bargainId,
          bargainPriceMin: bargain.minPrice,
          bargainPrice: bargain.price,
          price: "0.00",
          status: 1,
          addTime: Math.floor(Date.now() / 1000),
        })
        .returning({ id: storeBargainUser.id });
      if (!rows[0]) throw new Error("砍价参与记录创建失败");
      return rows[0];
    });
  }

  async bargainStartUser(bargainId: number, ownerUid: number) {
    if (!Number.isSafeInteger(bargainId) || bargainId <= 0 || !Number.isSafeInteger(ownerUid) || ownerUid <= 0) {
      throw new ValidateException("参数错误");
    }
    const rows = await this.container.db
      .select({ nickname: user.nickname, avatar: user.avatar })
      .from(storeBargainUser)
      .innerJoin(user, and(
        eq(user.uid, storeBargainUser.uid),
        eq(user.status, 1),
        eq(user.isDel, 0),
      ))
      .where(and(
        eq(storeBargainUser.bargainId, bargainId),
        eq(storeBargainUser.uid, ownerUid),
        eq(storeBargainUser.isDel, 0),
      ))
      .orderBy(desc(storeBargainUser.id))
      .limit(1);
    if (!rows[0]) throw new NotFoundException("用户砍价信息未查到");
    return rows[0];
  }

  async bargainShare(bargainId: number) {
    if (!Number.isSafeInteger(bargainId) || bargainId <= 0) throw new ValidateException("参数错误");
    return withTx(this.container, async (tx) => {
      const updated = await tx
        .update(storeBargain)
        .set({ share: sql`${storeBargain.share} + 1` })
        .where(and(eq(storeBargain.id, bargainId), eq(storeBargain.isDel, 0)))
        .returning({ id: storeBargain.id });
      if (!updated[0]) throw new NotFoundException("砍价活动不存在");
      const [bargainTotals, userTotals, payTotals] = await Promise.all([
        tx.select({
          look: sql<string>`COALESCE(SUM(${storeBargain.look}), 0)::text`,
          share: sql<string>`COALESCE(SUM(${storeBargain.share}), 0)::text`,
        }).from(storeBargain),
        tx.select({ count: sql<number>`COUNT(*)::int` }).from(storeBargainUserHelp),
        tx.select({ count: sql<number>`COUNT(*)::int` }).from(storeOrder).where(and(
          eq(storeOrder.activityId, bargainId),
          eq(storeOrder.type, 2),
          eq(storeOrder.isDel, 0),
          eq(storeOrder.isSystemDel, 0),
        )),
      ]);
      return {
        lookCount: Number(bargainTotals[0]?.look ?? 0),
        userCount: Number(userTotals[0]?.count ?? 0),
        payCount: Number(payTotals[0]?.count ?? 0),
        shareCount: Number(bargainTotals[0]?.share ?? 0),
      };
    });
  }

  async bargainPoster(uid: number, bargainId: number) {
    if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(bargainId) || bargainId <= 0) {
      throw new ValidateException("参数错误");
    }
    const [bargains, participations] = await Promise.all([
      this.container.db.select({
        title: storeBargain.title,
        image: storeBargain.image,
        price: storeBargain.price,
        minimum: storeBargain.minPrice,
        quota: storeBargain.quota,
      }).from(storeBargain).where(and(
        eq(storeBargain.id, bargainId),
        eq(storeBargain.isDel, 0),
      )).limit(1),
      this.container.db.select({
        price: storeBargainUser.price,
        minimum: storeBargainUser.bargainPriceMin,
      }).from(storeBargainUser).where(and(
        eq(storeBargainUser.bargainId, bargainId),
        eq(storeBargainUser.uid, uid),
        eq(storeBargainUser.isDel, 0),
      )).orderBy(desc(storeBargainUser.id)).limit(1),
    ]);
    const bargain = bargains[0];
    if (!bargain) throw new NotFoundException("砍价信息没有查到");
    if (bargain.quota <= 0) throw new ValidateException("砍价已结束");
    const participation = participations[0];
    if (!participation) throw new NotFoundException("用户砍价信息未查到");
    const currentCents = Math.max(0, decimalToCents(bargain.price) - decimalToCents(participation.price));
    const remainingCents = Math.max(0, currentCents - decimalToCents(participation.minimum));
    return {
      url: await this.routineCode(2, bargainId, uid),
      title: bargain.title,
      image: bargain.image,
      price: centsToDecimal(currentCents),
      label: "已砍至",
      msg: `还差${centsToDecimal(remainingCents)}元即可砍价成功`,
    };
  }

  /** 帮砍：每个参与记录串行处理，保留帮助明细并执行人数/次数限制。 */
  async helpBargain(uid: number, bargainUserId: number): Promise<{ price: string }> {
    if (!Number.isSafeInteger(uid) || uid <= 0) throw new ValidateException("用户ID错误");
    if (!Number.isSafeInteger(bargainUserId) || bargainUserId <= 0) {
      throw new ValidateException("砍价记录ID错误");
    }
    const user = await this.container.userDao.findForAuth(uid);
    if (!user) throw new NotFoundException("用户不存在");

    return withTx(this.container, async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${BARGAIN_HELP_LOCK_NAMESPACE}, ${bargainUserId})`,
      );
      const records = await tx
        .select()
        .from(storeBargainUser)
        .where(and(eq(storeBargainUser.id, bargainUserId), eq(storeBargainUser.isDel, 0)))
        .limit(1)
        .for("update");
      const record = records[0];
      if (!record) throw new NotFoundException("砍价记录不存在");
      if (record.status !== 1) throw new ValidateException("砍价已结束");

      const bargainRows = await tx
        .select()
        .from(storeBargain)
        .where(eq(storeBargain.id, record.bargainId))
        .limit(1)
        .for("key share");
      const bargain = bargainRows[0];
      const nowMs = Date.now();
      if (
        !bargain || bargain.status !== 1 || bargain.isDel !== 0
        || (bargain.startTime && bargain.startTime.getTime() > nowMs)
        || (bargain.stopTime && bargain.stopTime.getTime() < nowMs)
      ) {
        throw new ValidateException("砍价活动已结束");
      }

      const priorHelp = await tx
        .select({ id: storeBargainUserHelp.id })
        .from(storeBargainUserHelp)
        .where(and(
          eq(storeBargainUserHelp.uid, uid),
          eq(storeBargainUserHelp.bargainUserId, bargainUserId),
        ))
        .limit(1);
      if (priorHelp[0]) throw new ValidateException("您已经帮该用户砍过价");

      const isOwner = record.uid === uid;
      if (!isOwner) {
        const friendHelpRows = await tx
          .select({ count: sql<number>`COUNT(*)::int` })
          .from(storeBargainUserHelp)
          .where(and(
            eq(storeBargainUserHelp.uid, uid),
            eq(storeBargainUserHelp.bargainId, record.bargainId),
            eq(storeBargainUserHelp.type, 0),
          ));
        if ((friendHelpRows[0]?.count ?? 0) >= Math.max(0, bargain.bargainNum)) {
          throw new ValidateException("您不能再帮砍此件商品");
        }
      }

      const completedRows = await tx
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(storeBargainUserHelp)
        .where(eq(storeBargainUserHelp.bargainUserId, bargainUserId));
      const completedPeople = completedRows[0]?.count ?? 0;
      const peopleLimit = Math.max(1, bargain.people);
      if (completedPeople >= peopleLimit) throw new ValidateException("砍价帮助人数已满");

      const participationOriginalCents = decimalToCents(record.bargainPrice);
      const activityOriginalCents = decimalToCents(bargain.price);
      // 早期 Worker 曾把 bargain_price 原地减小；活动原价可将这类行恢复为 PHP 快照语义。
      const originalCents = Math.max(participationOriginalCents, activityOriginalCents);
      const minimumCents = decimalToCents(record.bargainPriceMin);
      const alreadyCutCents = decimalToCents(record.price);
      const maximumCutCents = Math.max(0, originalCents - minimumCents);
      if (alreadyCutCents > maximumCutCents) throw new ValidateException("砍价金额数据异常");
      const remainingCents = maximumCutCents - alreadyCutCents;
      if (remainingCents <= 0) throw new ValidateException("已砍到最低价");
      const cutCents = calculateBargainHelpCutCents({
        remainingCents,
        remainingPeople: peopleLimit - completedPeople,
        percent: randomBargainPercent(),
      });
      const newAlreadyCutCents = alreadyCutCents + cutCents;
      const now = Math.floor(nowMs / 1000);

      await tx.insert(storeBargainUserHelp).values({
        uid,
        bargainId: record.bargainId,
        bargainUserId,
        price: centsToDecimal(cutCents),
        addTime: now,
        type: isOwner ? 1 : 0,
      });
      await tx
        .update(storeBargainUser)
        .set({
          bargainPrice: centsToDecimal(originalCents),
          price: centsToDecimal(newAlreadyCutCents),
          status: newAlreadyCutCents >= maximumCutCents ? 3 : 1,
        })
        .where(eq(storeBargainUser.id, bargainUserId));
      return { price: centsToDecimal(cutCents) };
    });
  }

  async resolveBargainUserId(bargainId: number, ownerUid: number): Promise<number> {
    if (!Number.isSafeInteger(bargainId) || bargainId <= 0 || !Number.isSafeInteger(ownerUid) || ownerUid <= 0) {
      throw new ValidateException("砍价参数错误");
    }
    const rows = await this.container.db
      .select({ id: storeBargainUser.id })
      .from(storeBargainUser)
      .where(and(
        eq(storeBargainUser.bargainId, bargainId),
        eq(storeBargainUser.uid, ownerUid),
        eq(storeBargainUser.isDel, 0),
      ))
      .orderBy(desc(storeBargainUser.id))
      .limit(1);
    if (!rows[0]) throw new NotFoundException("砍价记录不存在");
    return rows[0].id;
  }

  async bargainHelpPrice(uid: number, bargainUserId: number) {
    const rows = await this.container.db
      .select({
        price: storeBargainUserHelp.price,
        bargainPrice: storeBargainUser.bargainPrice,
        bargainPriceMin: storeBargainUser.bargainPriceMin,
        totalCut: storeBargainUser.price,
      })
      .from(storeBargainUser)
      .leftJoin(storeBargainUserHelp, and(
        eq(storeBargainUserHelp.bargainUserId, storeBargainUser.id),
        eq(storeBargainUserHelp.uid, uid),
      ))
      .where(and(eq(storeBargainUser.id, bargainUserId), eq(storeBargainUser.isDel, 0)))
      .orderBy(desc(storeBargainUserHelp.id))
      .limit(1);
    if (!rows[0]) throw new NotFoundException("砍价记录不存在");
    const currentCents = decimalToCents(rows[0].bargainPrice) - decimalToCents(rows[0].totalCut);
    return {
      price: rows[0].price ?? "0.00",
      status: currentCents <= decimalToCents(rows[0].bargainPriceMin),
    };
  }

  async bargainHelpCount(uid: number, bargainUserId: number) {
    const records = await this.container.db
      .select()
      .from(storeBargainUser)
      .where(and(eq(storeBargainUser.id, bargainUserId), eq(storeBargainUser.isDel, 0)))
      .limit(1);
    const record = records[0];
    if (!record) throw new NotFoundException("砍价记录不存在");
    const [countRows, ownHelpRows] = await Promise.all([
      this.container.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(storeBargainUserHelp)
        .where(eq(storeBargainUserHelp.bargainUserId, bargainUserId)),
      this.container.db
        .select({ id: storeBargainUserHelp.id })
        .from(storeBargainUserHelp)
        .where(and(
          eq(storeBargainUserHelp.bargainUserId, bargainUserId),
          eq(storeBargainUserHelp.uid, uid),
        ))
        .limit(1),
    ]);
    const originalCents = decimalToCents(record.bargainPrice);
    const minimumCents = decimalToCents(record.bargainPriceMin);
    const alreadyCents = decimalToCents(record.price);
    const capacityCents = Math.max(0, originalCents - minimumCents);
    const remainingCents = Math.max(0, capacityCents - alreadyCents);
    const percentage = capacityCents > 0
      ? Math.min(100, Math.floor(alreadyCents * 100 / capacityCents))
      : 100;
    return {
      userBargainStatus: !ownHelpRows[0],
      count: countRows[0]?.count ?? 0,
      price: centsToDecimal(remainingCents),
      status: record.status,
      alreadyPrice: centsToDecimal(alreadyCents),
      pricePercent: Math.max(10, percentage),
    };
  }

  async bargainHelpList(bargainUserId: number, page = 1, limit = 20) {
    const safePage = Number.isSafeInteger(page) && page > 0 ? page : 1;
    const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
    return this.container.db
      .select({
        id: storeBargainUserHelp.id,
        uid: storeBargainUserHelp.uid,
        bargain_id: storeBargainUserHelp.bargainId,
        bargain_user_id: storeBargainUserHelp.bargainUserId,
        price: storeBargainUserHelp.price,
        add_time: storeBargainUserHelp.addTime,
        type: storeBargainUserHelp.type,
        nickname: user.nickname,
        avatar: user.avatar,
      })
      .from(storeBargainUserHelp)
      .leftJoin(user, eq(user.uid, storeBargainUserHelp.uid))
      .where(eq(storeBargainUserHelp.bargainUserId, bargainUserId))
      .orderBy(desc(storeBargainUserHelp.id))
      .limit(safeLimit)
      .offset((safePage - 1) * safeLimit);
  }

  /** 我的砍价列表 (bargain/user/list) */
  async myBargains(uid: number, page = 1, limit = 20) {
    const safePage = Number.isSafeInteger(page) && page > 0 ? Math.min(page, 10_000) : 1;
    const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
    const rows = await this.container.db
      .select({
        id: storeBargainUser.id,
        uid: storeBargainUser.uid,
        bargain_id: storeBargainUser.bargainId,
        bargain_price_min: storeBargainUser.bargainPriceMin,
        bargain_price: storeBargainUser.bargainPrice,
        price: storeBargainUser.price,
        status: storeBargainUser.status,
        add_time: sql<string>`to_char(to_timestamp(${storeBargainUser.addTime}) AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS')`,
        title: storeBargain.title,
        image: storeBargain.image,
        datatime: sql<string>`CASE WHEN ${storeBargain.stopTime} IS NULL THEN '' ELSE to_char(${storeBargain.stopTime}, 'YYYY-MM-DD HH24:MI:SS') END`,
        stopTime: storeBargain.stopTime,
      })
      .from(storeBargainUser)
      .leftJoin(storeBargain, eq(storeBargain.id, storeBargainUser.bargainId))
      .where(and(eq(storeBargainUser.uid, uid), eq(storeBargainUser.isDel, 0)))
      .orderBy(desc(storeBargainUser.addTime), desc(storeBargainUser.id))
      .limit(safeLimit)
      .offset((safePage - 1) * safeLimit);
    const now = Date.now();
    return rows.map(({ stopTime, ...row }) => {
      const residueCents = Math.max(0, decimalToCents(row.bargain_price) - decimalToCents(row.price));
      const effectiveStatus = row.status === 1 && stopTime && stopTime.getTime() < now ? 2 : row.status;
      return {
        ...row,
        status: effectiveStatus,
        residue_price: centsToDecimal(residueCents),
        pay_status: residueCents <= decimalToCents(row.bargain_price_min) && effectiveStatus !== 3,
      };
    });
  }

  /** 取消砍价 (bargain/user/cancel) */
  async cancelBargain(uid: number, input: { id?: number; bargainId?: number }): Promise<void> {
    const id = Number(input.id ?? 0);
    const bargainId = Number(input.bargainId ?? 0);
    if ((!Number.isSafeInteger(id) || id < 0) || (!Number.isSafeInteger(bargainId) || bargainId < 0) || (!id && !bargainId)) {
      throw new ValidateException("参数错误");
    }
    const updated = await this.container.db
      .update(storeBargainUser)
      .set({ isDel: 1, status: 2 })
      .where(and(
        eq(storeBargainUser.uid, uid),
        eq(storeBargainUser.isDel, 0),
        eq(storeBargainUser.status, 1),
        id ? eq(storeBargainUser.id, id) : eq(storeBargainUser.bargainId, bargainId),
      ))
      .returning({ id: storeBargainUser.id });
    if (!updated[0]) throw new ValidateException("状态错误");
  }
}
