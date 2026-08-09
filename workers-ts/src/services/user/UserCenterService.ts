/**
 * 用户中心 Service (M5)
 * 地址 + 收藏 + 签到
 *
 * 对应 PHP:
 *   - UserAddressServices (editAddress/setDefault)
 *   - UserRelationServices (productRelation 收藏)
 *   - UserSignServices (sign 签到)
 */
import { eq, sql } from "drizzle-orm";
import { user as userTable } from "@/models/schema";
import type { Container } from "@/lib/di";
import { ValidateException, NotFoundException } from "@/utils/errors";

export class UserCenterService {
  constructor(private readonly container: Container) {}

  // ─── 地址 ─────────────────────────────────────────────────

  /** 地址列表 */
  async addressList(uid: number) {
    return this.container.userAddressDao.listByUid(uid);
  }

  /** 默认地址 */
  async addressDefault(uid: number) {
    return this.container.userAddressDao.getDefault(uid);
  }

  /** 新增/编辑地址 (对应 PHP editAddress) */
  async addressSave(uid: number, params: {
    id?: number;
    realName: string;
    phone: string;
    province: string;
    city: string;
    district: string;
    detail: string;
    isDefault?: number;
  }) {
    if (!params.realName || !params.phone || !params.detail) {
      throw new ValidateException("收货人、电话、详细地址不能为空");
    }
    const c = this.container;
    if (params.id) {
      // 编辑
      const existing = await c.userAddressDao.get(params.id);
      if (!existing || existing.uid !== uid || existing.isDel) {
        throw new NotFoundException("地址不存在");
      }
      await c.userAddressDao.update(params.id, {
        realName: params.realName,
        phone: params.phone,
        province: params.province,
        city: params.city,
        district: params.district,
        detail: params.detail,
      });
      if (params.isDefault) await c.userAddressDao.setDefault(uid, params.id);
      return params.id;
    }
    // 新增
    const row = await c.userAddressDao.save({
      uid,
      realName: params.realName,
      phone: params.phone,
      province: params.province,
      city: params.city,
      district: params.district,
      detail: params.detail,
      isDefault: params.isDefault ?? 0,
      addTime: Math.floor(Date.now() / 1000),
    });
    if (params.isDefault) await c.userAddressDao.setDefault(uid, row.id);
    return row.id;
  }

  /** 删除地址 (软删) */
  async addressDel(uid: number, id: number) {
    const c = this.container;
    const addr = await c.userAddressDao.get(id);
    if (!addr || addr.uid !== uid) throw new NotFoundException("地址不存在");
    await c.userAddressDao.update(id, { isDel: 1 });
  }

  // ─── 收藏 ─────────────────────────────────────────────────

  /** 收藏商品 (对应 PHP productRelation) */
  async collectAdd(uid: number, productIds: number[]): Promise<number> {
    if (!productIds.length) throw new ValidateException("请选择商品");
    return this.container.userRelationDao.addCollect(uid, productIds);
  }

  /** 取消收藏 */
  async collectDel(uid: number, productIds: number[]): Promise<void> {
    await this.container.userRelationDao.removeCollect(uid, productIds);
  }

  /** 收藏列表 (返回商品 ID, 前端再查商品详情) */
  async collectList(uid: number): Promise<number[]> {
    return this.container.userRelationDao.getCollectIds(uid);
  }

  /** 是否收藏 */
  async isCollected(uid: number, productId: number): Promise<boolean> {
    return this.container.userRelationDao.isCollected(uid, productId);
  }

  // ─── 签到 ─────────────────────────────────────────────────

  /**
   * 签到 (对应 PHP UserSignServices::sign)
   *
   * 逻辑:
   *   1. 今日已签到 → 拒绝
   *   2. 昨日未签到 → sign_num 重置为 0
   *   3. sign_num++
   *   4. 基础积分 + 连续/累计奖励 (从 system_config 读)
   *   5. 记 sign 流水 + 加积分
   */
  async sign(uid: number): Promise<{ point: number; exp: number; continuousDays: number }> {
    const c = this.container;

    // 1. 今日已签到
    if (await c.userSignDao.isSignedToday(uid)) {
      throw new ValidateException("今日已签到");
    }

    // 2. 连续天数
    const signedYesterday = await c.userSignDao.isSignedYesterday(uid);
    const user = await c.userDao.findForAuth(uid);
    if (!user) throw new NotFoundException("用户不存在");

    let signNum = signedYesterday ? (user.signNum ?? 0) + 1 : 1;

    // 3. 基础积分 (从 system_config 读, 默认 0)
    // M5 简化: 基础积分固定 + 连续奖励递增
    let point = 1; // 基础 1 积分
    let exp = 0;
    // 连续签到奖励 (简化版: 每 7 天翻倍)
    if (signNum % 7 === 0) point += 5;

    const cumulativeDays = (await c.userSignDao.getCumulativeDays(uid)) + 1;
    void cumulativeDays; // M5 预留: 返回给前端展示累计天数

    // 4. 事务: 写 sign 记录 + 加积分 + 更新 sign_num
    const newBalance = user.integral + point;
    await c.db.transaction(async (tx) => {
      await tx.insert((await import("@/models/schema")).userSign).values({
        uid,
        title: `连续签到第${signNum}天`,
        number: point,
        balance: newBalance,
        expNum: exp,
        expBalance: Number(user.exp) + exp,
        addTime: Math.floor(Date.now() / 1000),
      });

      await tx
        .update(userTable)
        .set({
          integral: sql`integral + ${point}`,
          signNum,
        })
        .where(eq(userTable.uid, uid));
    });

    return { point, exp, continuousDays: signNum };
  }

  /** 签到状态 (今日是否签、连续天数) */
  async signStatus(uid: number): Promise<{ signedToday: boolean; continuousDays: number; cumulativeDays: number }> {
    const c = this.container;
    const user = await c.userDao.findForAuth(uid);
    return {
      signedToday: await c.userSignDao.isSignedToday(uid),
      continuousDays: user?.signNum ?? 0,
      cumulativeDays: await c.userSignDao.getCumulativeDays(uid),
    };
  }
}
