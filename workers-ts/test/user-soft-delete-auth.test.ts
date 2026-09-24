import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Env } from "@/env";
import type { Container } from "@/lib/di";
import { UserDao } from "@/dao/user/UserDao";
import { user } from "@/models/schema/user";
import { LoginService } from "@/services/user/LoginService";
import { md5 } from "@/utils/jwt";
import { financePostgres } from "./helpers/financePostgres";

describe("soft-deleted users cannot authenticate", () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>;
  let dao: UserDao;
  let login: LoginService;

  beforeAll(async () => {
    fixture = await financePostgres([user]);
    dao = new UserDao(fixture.db);
    login = new LoginService({ db: fixture.db, userDao: dao } as Container, {
      APP_KEY: "soft-delete-auth-fixture-key",
    } as Env);
    await fixture.db.insert(user).values([
      { uid: 11, account: "13800138011", phone: "13800138011", pwd: md5("secret-11") },
      { uid: 12, account: "13800138012", phone: "13800138012", pwd: md5("secret-12") },
      { uid: 13, account: "13800138013", phone: "13800138013", pwd: md5("secret-13") },
      { uid: 14, account: "social-account-14", phone: "", pwd: md5("secret-14") },
    ]);
  }, 60_000);

  afterAll(async () => { await fixture?.close(); });

  it("revokes a prior identity when PHP-style soft deletion only sets delete_time", async () => {
    expect(await dao.findForAuth(11)).toMatchObject({ uid: 11 });
    await dao.softDelete(11);
    const [stored] = await fixture.db.select({ isDel: user.isDel, deleteTime: user.deleteTime })
      .from(user).where(eq(user.uid, 11));
    expect(stored?.isDel).toBe(0);
    expect(stored?.deleteTime).toBeInstanceOf(Date);
    expect(await dao.findForAuth(11)).toBeNull();
    expect(await dao.findForLogin("13800138011")).toBeNull();
    await expect(login.loginByVerifiedUid(11)).rejects.toThrow("登录身份不存在或已失效");
    await expect(login.loginByPassword("13800138011", "secret-11", 0, "127.0.0.1"))
      .rejects.toThrow("账号或密码错误");
  });

  it("also rejects the separate is_del marker and leaves live users available", async () => {
    await fixture.db.update(user).set({ isDel: 1 }).where(eq(user.uid, 12));
    expect(await dao.findForAuth(12)).toBeNull();
    expect(await dao.findForLogin("13800138012")).toBeNull();
    expect(await dao.findForAuth(13)).toMatchObject({ uid: 13 });
    expect(await dao.findForLogin("13800138013")).toMatchObject({ uid: 13 });
  });

  it("blocks password and phone writes to deleted users while allowing reclaimed numbers", async () => {
    await expect(login.resetPassword("13800138011", "new-password"))
      .rejects.toThrow("用户不存在");
    await expect(login.updatePhone(11, "13800138019"))
      .rejects.toThrow("用户不存在");
    await expect(login.bindPhone(11, "13800138019"))
      .rejects.toThrow("用户不存在");
    await login.updatePhone(13, "13800138011");
    await login.bindPhone(14, "13800138012");
    const rows = await fixture.db.select({ uid: user.uid, phone: user.phone, pwd: user.pwd })
      .from(user).where(eq(user.uid, 11));
    expect(rows[0]).toMatchObject({ uid: 11, phone: "13800138011", pwd: md5("secret-11") });
    expect((await dao.findForAuth(13))?.phone).toBe("13800138011");
    expect((await dao.findForAuth(14))?.phone).toBe("13800138012");
  });
});
