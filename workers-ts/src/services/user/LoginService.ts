/**
 * 登录 Service
 *
 * 对应 PHP app/services/user/LoginServices.php::login
 *
 * 业务逻辑 (严格对齐 PHP):
 *   1. 按手机号查用户
 *   2. md5(password) 校验
 *   3. 默认密码 md5('123456') 提示修改
 *   4. status 校验是否封禁
 *   5. 创建 JWT + 存 token bucket (Upstash)
 *   6. 更新 last_time / last_ip / 分销绑定
 *   7. 返回 { token, expires_time }
 */
import { and, eq, or, sql } from "drizzle-orm";
import { withTx, type Container } from "@/lib/di";
import type { Env } from "@/env";
import { user as userTable } from "@/models/schema";
import { NotFoundException, ValidateException } from "@/utils/errors";
import { createToken, md5 } from "@/utils/jwt";
import { setTokenBucket, type TokenBucket } from "@/utils/cache";
import { UserFinanceService } from "@/services/user/UserFinanceService";
import {
  applyRegistrationGifts,
  StoreNewcomerService,
} from "@/services/activity/StoreNewcomerService";

export class LoginService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  private async findUniquePhoneUser(phone: string) {
    const rows = await this.container.db.select({
      uid: userTable.uid,
      account: userTable.account,
      phone: userTable.phone,
      pwd: userTable.pwd,
      status: userTable.status,
    }).from(userTable).where(and(
      eq(userTable.phone, phone),
      eq(userTable.isDel, 0),
    )).limit(2);
    if (rows.length > 1) {
      throw new ValidateException("手机号关联多个账号，请联系客服处理");
    }
    return rows[0] ?? null;
  }

  private async issueToken(user: { uid: number; pwd: string }) {
    const { token, exp } = await createToken(
      user.uid,
      "api",
      user.pwd,
      this.env.APP_KEY,
    );
    const bucket: TokenBucket = {
      uid: user.uid,
      type: "api",
      token,
      exp: exp - Math.floor(Date.now() / 1000) + 60,
    };
    const ok = await setTokenBucket(md5(token), bucket, this.env);
    if (!ok) throw new Error("token 保存失败");
    return { token, expires_time: exp };
  }

  /**
   * 账号密码登录 (对应 PHP LoginServices::login)
   *
   * @param account 手机号 (PHP 用 phone 查询)
   * @param password 明文密码
   * @param spreadUid 推广人 UID (可选)
   * @param ip 客户端 IP
   */
  async loginByPassword(
    account: string,
    password: string,
    spreadUid: number,
    ip: string,
  ): Promise<{ token: string; expires_time: number }> {
    // 1. 参数校验 (对应 PHP LoginValidate)
    if (!account || !password) {
      throw new ValidateException("请输入账号和密码");
    }

    // 2. 查用户 (按 phone, 与 PHP getOne(['phone'=>$account]) 一致)
    const u = await this.findUniquePhoneUser(account);
    if (!u) {
      throw new ValidateException("账号或密码错误");
    }

    // 3. md5 密码校验 (注意 PHP 是 md5((string)$password), 双层 md5 不是)
    if (u.pwd !== md5(password)) {
      throw new ValidateException("账号或密码错误");
    }

    // 4. 默认密码提示 (与 PHP 一致)
    if (u.pwd === md5("123456")) {
      throw new ValidateException("请修改您的初始密码,再尝试登录!");
    }

    // 5. 封禁校验
    if (!u.status) {
      throw new ValidateException("已被禁止,请联系管理员");
    }

    // 6. 创建 JWT (对应 PHP createToken(uid, 'api', $user->pwd))
    //    auth claim = md5(pwd), 改密后旧 token 失效
    const result = await this.issueToken(u);

    // 8. 更新登录信息并尝试永久绑定推广关系。无效邀请码不阻断登录。
    await this.container.userDao.touchLogin(u.uid, ip);
    if (spreadUid > 0 && spreadUid !== u.uid) {
      await new UserFinanceService(this.container)
        .bindSpread(u.uid, spreadUid)
        .catch((error: unknown) => {
          if (error instanceof ValidateException || error instanceof NotFoundException) return;
          throw error;
        });
    }

    // 9. TODO(M2+): event('user.login') —— 队列触发登录后置
    //    await env.ORDER_QUEUE.send({ action: 'onUserLogin', ... });

    return result;
  }

  /** 注册 (对应 PHP RegisterServices::register) */
  async register(
    account: string,
    password: string,
    spreadUid: number,
    ip = "0.0.0.0",
    userType = "h5",
  ): Promise<{ token: string; expires_time: number }> {
    const c = this.container;
    const now = Math.floor(Date.now() / 1000);
    const registration = await new StoreNewcomerService(c, this.env).registrationState();
    const row = await withTx(c, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`user-phone:${account}`}))`);
      const duplicate = await tx
        .select({ uid: userTable.uid })
        .from(userTable)
        .where(and(
          eq(userTable.isDel, 0),
          or(eq(userTable.account, account), eq(userTable.phone, account)),
        ))
        .limit(1);
      if (duplicate[0]) throw new ValidateException("该手机号已注册");
      const inserted = await tx
        .insert(userTable)
        .values({
          account,
          pwd: md5(password),
          nickname: `用户${account.slice(-4)}`,
          phone: account,
          addIp: ip.slice(0, 45),
          spreadUid: 0,
          nowMoney: "0.00",
          integral: 0,
          status: 1,
          addTime: now,
          lastTime: now,
          lastIp: ip.slice(0, 45),
          userType: userType.slice(0, 32),
          ...registration.flags,
        })
        .returning();
      const created = inserted[0];
      if (!created) throw new Error("用户创建失败");
      await applyRegistrationGifts(tx, created.uid, registration.gifts, now);
      return created;
    });
    // 注册后使用同一关系服务绑定、计数并写入 user_spread；无效邀请码不写悬空关系。
    if (spreadUid > 0 && spreadUid !== row.uid) {
      await new UserFinanceService(c)
        .bindSpread(row.uid, spreadUid)
        .catch((error: unknown) => {
          if (error instanceof ValidateException || error instanceof NotFoundException) return;
          throw error;
        });
    }

    return this.issueToken(row);
  }

  async loginByMobile(
    phone: string,
    spreadUid: number,
    ip: string,
    userType = "h5",
  ): Promise<{ token: string; expires_time: number }> {
    let current = await this.findUniquePhoneUser(phone);
    if (!current) {
      const now = Math.floor(Date.now() / 1000);
      const registration = await new StoreNewcomerService(
        this.container,
        this.env,
      ).registrationState();
      current = await withTx(this.container, async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${`user-phone:${phone}`}))`,
        );
        const existing = await tx.select({
          uid: userTable.uid,
          account: userTable.account,
          phone: userTable.phone,
          pwd: userTable.pwd,
          status: userTable.status,
        }).from(userTable).where(and(
          eq(userTable.isDel, 0),
          or(eq(userTable.account, phone), eq(userTable.phone, phone)),
        )).limit(2);
        if (existing.length > 1) {
          throw new ValidateException("手机号关联多个账号，请联系客服处理");
        }
        if (existing[0]) return existing[0];
        const inserted = await tx.insert(userTable).values({
          account: phone,
          phone,
          pwd: md5(crypto.randomUUID()),
          nickname: `用户${phone.slice(-4)}`,
          addIp: ip.slice(0, 45),
          lastIp: ip.slice(0, 45),
          addTime: now,
          lastTime: now,
          userType: userType.slice(0, 32),
          status: 1,
          spreadUid: 0,
          nowMoney: "0.00",
          integral: 0,
          ...registration.flags,
        }).returning();
        const created = inserted[0];
        if (!created) throw new Error("用户创建失败");
        await applyRegistrationGifts(tx, created.uid, registration.gifts, now);
        return created;
      });
    }
    if (!current.status) throw new ValidateException("已被禁止，请联系管理员");
    await this.container.userDao.touchLogin(current.uid, ip);
    if (spreadUid > 0 && spreadUid !== current.uid) {
      await new UserFinanceService(this.container)
        .bindSpread(current.uid, spreadUid)
        .catch((error: unknown) => {
          if (error instanceof ValidateException || error instanceof NotFoundException) return;
          throw error;
        });
    }
    return this.issueToken(current);
  }

  async resetPassword(account: string, password: string): Promise<void> {
    await withTx(this.container, async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`user-phone:${account}`}))`,
      );
      const rows = await tx.select({ uid: userTable.uid }).from(userTable)
        .where(and(
          eq(userTable.isDel, 0),
          or(eq(userTable.account, account), eq(userTable.phone, account)),
        )).for("update").limit(2);
      if (rows.length > 1) {
        throw new ValidateException("手机号关联多个账号，请联系客服处理");
      }
      if (!rows[0]) throw new ValidateException("用户不存在");
      await tx.update(userTable).set({ pwd: md5(password) })
        .where(eq(userTable.uid, rows[0].uid));
    });
  }

  async updatePhone(uid: number, phone: string): Promise<void> {
    await withTx(this.container, async (tx) => {
      const currentRows = await tx.select({
        uid: userTable.uid,
        account: userTable.account,
        phone: userTable.phone,
      }).from(userTable).where(and(
        eq(userTable.uid, uid),
        eq(userTable.isDel, 0),
      )).for("update").limit(1);
      const current = currentRows[0];
      if (!current) throw new ValidateException("用户不存在");
      if (current.phone === phone) {
        throw new ValidateException("新手机号和原手机号相同，无需修改");
      }
      const lockValues = [current.phone, phone].filter(Boolean).sort();
      for (const value of lockValues) {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${`user-phone:${value}`}))`,
        );
      }
      const duplicate = await tx.select({ uid: userTable.uid }).from(userTable)
        .where(and(
          eq(userTable.isDel, 0),
          sql`${userTable.uid} <> ${uid}`,
          or(eq(userTable.account, phone), eq(userTable.phone, phone)),
        )).limit(1);
      if (duplicate[0]) throw new ValidateException("此手机已经注册");
      await tx.update(userTable).set({
        phone,
        ...(current.account === "" || current.account === current.phone
          ? { account: phone }
          : {}),
      }).where(eq(userTable.uid, uid));
    });
  }

  async bindPhone(uid: number, phone: string): Promise<void> {
    await withTx(this.container, async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`user-phone:${phone}`}))`,
      );
      const currentRows = await tx.select({
        uid: userTable.uid,
        account: userTable.account,
        phone: userTable.phone,
      }).from(userTable).where(and(
        eq(userTable.uid, uid),
        eq(userTable.isDel, 0),
      )).for("update").limit(1);
      const current = currentRows[0];
      if (!current) throw new ValidateException("用户不存在");
      if (current.phone) throw new ValidateException("您的账号已经绑定过手机号码");
      const duplicate = await tx.select({ uid: userTable.uid }).from(userTable)
        .where(and(
          eq(userTable.isDel, 0),
          sql`${userTable.uid} <> ${uid}`,
          or(eq(userTable.account, phone), eq(userTable.phone, phone)),
        )).limit(1);
      if (duplicate[0]) throw new ValidateException("此手机已经绑定，无法多次绑定");
      await tx.update(userTable).set({
        phone,
        ...(current.account === "" ? { account: phone } : {}),
      }).where(eq(userTable.uid, uid));
    });
  }

  /** 修改密码 (对应 PHP UserServices::modifyPwd) */
  async changePassword(uid: number, oldPassword: string, newPassword: string): Promise<void> {
    const c = this.container;
    const user = await c.userDao.findForAuth(uid);
    if (!user) throw new ValidateException("用户不存在");
    if (user.pwd !== md5(oldPassword)) {
      throw new ValidateException("原密码错误");
    }
    await c.userDao.update(uid, { pwd: md5(newPassword) });
    // 旧 token 失效: auth claim = md5(pwd) 已变
  }
}
