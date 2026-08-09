import { describe, it, expect } from "vitest";
import { createToken, verifyToken, md5 } from "../src/utils/jwt";

const SECRET = "crmeb_app_key";

describe("jwt", () => {
  it("createToken → verifyToken 往返一致", async () => {
    const pwdMd5 = md5("password123");
    const { token, exp } = await createToken(42, "api", pwdMd5, SECRET);

    expect(token.split(".")).toHaveLength(3);
    expect(exp).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const payload = await verifyToken(token, SECRET);
    expect(payload.id).toBe(42);
    expect(payload.type).toBe("api");
    expect(payload.auth).toBe(pwdMd5);
  });

  it("签名错误抛异常", async () => {
    const { token } = await createToken(1, "api", md5("x"), SECRET);
    await expect(verifyToken(token, "wrong_secret")).rejects.toThrow();
  });

  it("md5 与 PHP 输出一致 (md5('123456'))", () => {
    // 已知值: md5('123456') = e10adc3949ba59abbe56e057f20f883e
    expect(md5("123456")).toBe("e10adc3949ba59abbe56e057f20f883e");
    expect(md5("password")).toBe("5f4dcc3b5aa765d61d8327deb882cf99");
  });

  it("默认密码识别 (md5('123456'))", () => {
    const defaultPwd = md5("123456");
    // auth 中间件里: user.pwd !== md5('123456') 跳过 auth claim 校验
    expect(defaultPwd).toBe("e10adc3949ba59abbe56e057f20f883e");
  });
});
