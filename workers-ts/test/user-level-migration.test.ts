import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeLevelActivationFields } from "../src/services/user/UserLevelService";

describe("PHP user-level activation migration", () => {
  it("normalizes only configured activation fields and preserves PHP profile mappings", () => {
    const result = normalizeLevelActivationFields(
      [
        { info: "姓名", value: " 审计用户 " },
        { info: "性别", value: "女" },
        { info: "生日", value: "2001-02-03" },
        { info: "忽略字段", param: "level", value: 99 },
      ],
      [
        { info: "姓名", param: "real_name", format: "text", required: 1 },
        { info: "性别", param: "sex", format: "radio", required: 0 },
        { info: "生日", param: "birthday", format: "date", required: 0 },
      ],
    );

    expect(result.fields).toMatchObject({
      realName: "审计用户",
      sex: 2,
      birthday: 981129600,
    });
    expect(result.fields).not.toHaveProperty("level");
    expect(JSON.parse(String(result.fields.levelExtendInfo))).toHaveLength(3);
  });

  it("rejects missing required, invalid identity, and oversized profile values", () => {
    expect(() => normalizeLevelActivationFields([], [
      { info: "姓名", param: "real_name", required: 1, tip: "请填写真实姓名" },
    ])).toThrow("请填写真实姓名");
    expect(() => normalizeLevelActivationFields([
      { info: "身份证", value: "not-an-id" },
    ], [
      { info: "身份证", param: "card_id", format: "id" },
    ])).toThrow("请填写正确的身份证号码");
    expect(() => normalizeLevelActivationFields([
      { info: "姓名", value: "x".repeat(26) },
    ], [
      { info: "姓名", param: "real_name", format: "text" },
    ])).toThrow("姓名内容过长");
  });

  it("registers PHP detection and activation-info routes behind mandatory auth", () => {
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    expect(routes).toContain('get("/user/level/detection", authMiddleware({ force: true })');
    expect(routes).toContain('get("/user/level/activate_info", authMiddleware({ force: true })');
  });

  it("removes arbitrary target-level escalation and uses transactional reward evidence", () => {
    const controller = readFileSync("src/controllers/api/v1/UserLevelController.ts", "utf8");
    const service = readFileSync("src/services/user/UserLevelService.ts", "utf8");
    expect(controller).not.toContain("body.levelId");
    expect(service).not.toContain("直接设置用户等级");
    expect(service).toContain('.for("update")');
    expect(service).toContain('levelStatus: 1');
    expect(service).toContain('eventKey: "level_give_integral"');
    expect(service).toContain('receiveSource: "activate_level"');
    expect(service).toContain("detectUserLevel");
  });
});
