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
import type { Container } from "@/lib/di";
import type { Env } from "@/env";
import { ValidateException } from "@/utils/errors";
import { createToken, md5 } from "@/utils/jwt";
import { setTokenBucket, type TokenBucket } from "@/utils/cache";

export class LoginService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

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
    _spreadUid: number, // TODO(M5): 分销绑定逻辑
    ip: string,
  ): Promise<{ token: string; expires_time: number }> {
    // 1. 参数校验 (对应 PHP LoginValidate)
    if (!account || !password) {
      throw new ValidateException("请输入账号和密码");
    }

    // 2. 查用户 (按 phone, 与 PHP getOne(['phone'=>$account]) 一致)
    const u = await this.container.userDao.findForLogin(account);
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
    const { token, exp } = await createToken(
      u.uid,
      "api",
      u.pwd, // 已经是 md5, 直接作为 auth
      this.env.APP_KEY,
    );

    // 7. 存 token bucket (对应 PHP CacheService::setTokenBucket(md5(token), ...))
    const bucket: TokenBucket = {
      uid: u.uid,
      type: "api",
      token,
      exp: exp - Math.floor(Date.now() / 1000) + 60, // 剩余秒数 + 60s 容差
    };
    const ok = await setTokenBucket(md5(token), bucket, this.env);
    if (!ok) {
      throw new Error("token 保存失败");
    }

    // 8. 更新登录信息 (last_time / last_ip)
    //    分销绑定逻辑 (spread_uid) M1 暂不实现, M5 用户域补
    await this.container.userDao.touchLogin(u.uid, ip);

    // 9. TODO(M2+): event('user.login') —— 队列触发登录后置
    //    await env.ORDER_QUEUE.send({ action: 'onUserLogin', ... });

    return { token, expires_time: exp };
  }

  /** 注册 (对应 PHP RegisterServices::register) */
  async register(
    account: string,
    password: string,
    spreadUid: number,
  ): Promise<{ token: string; expires_time: number }> {
    const c = this.container;
    const existing = await c.userDao.findForLogin(account);
    if (existing) throw new ValidateException("该手机号已注册");

    const now = Math.floor(Date.now() / 1000);
    const row = await c.userDao.save({
      account,
      pwd: md5(password),
      nickname: `用户${account.slice(-4)}`,
      phone: account,
      spreadUid: 0,
      nowMoney: "0.00",
      integral: 0,
      status: 1,
      addTime: now,
      lastTime: now,
    });
    // 注册后绑定推广人
    if (spreadUid > 0 && spreadUid !== row.uid) {
      await c.userDao.update(row.uid, { spreadUid });
    }

    // 自动登录
    const { token, exp } = await createToken(row.uid, "api", row.pwd, this.env.APP_KEY);
    const bucket: TokenBucket = {
      uid: row.uid,
      type: "api",
      token,
      exp: exp - Math.floor(Date.now() / 1000) + 60,
    };
    await setTokenBucket(md5(token), bucket, this.env).catch(() => {});
    return { token, expires_time: exp };
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
