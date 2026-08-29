import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  adminDiseDeletionProtectionReason,
  normalizeAdminDiseJson,
  parseAdminDiseSaveInput,
} from "../src/controllers/api/v1/AdminCrudController";

describe("admin DIY safety contract", () => {
  it("accepts only explicit update fields and keeps value/content independent", () => {
    expect(parseAdminDiseSaveInput({
      id: 9,
      name: "  首页 A  ",
      title: "标题",
      value: "{ \"widgets\": [] }",
      content: "legacy markup",
      status: 1,
    })).toEqual({
      mode: "update",
      id: 9,
      name: "首页 A",
      title: "标题",
      value: '{"widgets":[]}',
      content: "legacy markup",
      status: 1,
    });

    expect(parseAdminDiseSaveInput({
      create_kind: "diy_page",
      name: "新页面",
      value: "[]",
      status: 0,
    })).toEqual({
      mode: "create",
      createKind: "diy_page",
      name: "新页面",
      title: undefined,
      value: "[]",
      content: undefined,
    });
  });

  it("rejects malformed, null, unsafe and over-coupled JSON", () => {
    expect(() => normalizeAdminDiseJson("{"))
      .toThrow("value不是有效JSON");
    expect(() => normalizeAdminDiseJson("null"))
      .toThrow("value不能为null");
    expect(() => normalizeAdminDiseJson('{"__proto__":{"polluted":true}}'))
      .toThrow("value包含不安全字段");
    expect(() => parseAdminDiseSaveInput({ id: 2, value: "[]", content: "[]" }))
      .toThrow("value与content必须独立维护");

    // Legacy type=3 rows can legitimately contain a scalar JSON value.
    expect(normalizeAdminDiseJson(" 2 ")).toBe("2");
  });

  it("rejects immutable and unknown fields instead of silently changing contracts", () => {
    for (const field of ["type", "template_name", "is_diy", "unexpected"]) {
      expect(() => parseAdminDiseSaveInput({ id: 2, name: "x", [field]: 0 }))
        .toThrow("不支持的字段");
    }
    expect(() => parseAdminDiseSaveInput({ id: 0, name: "x" })).toThrow("ID错误");
    expect(() => parseAdminDiseSaveInput({ id: 2, status: 2 })).toThrow("status只能为0或1");
    expect(() => parseAdminDiseSaveInput({ name: "x", value: "[]" }))
      .toThrow("create_kind=diy_page");
    expect(() => parseAdminDiseSaveInput({
      create_kind: "diy_page",
      name: "x",
      value: "[]",
      status: 1,
    })).toThrow("必须先以停用状态保存");
  });

  it("protects the default page, suspended config and active DIY home", () => {
    expect(adminDiseDeletionProtectionReason({
      id: 1, status: 0, type: 1, isDiy: 0, templateName: "",
    })).toBe("默认页面不能删除");
    expect(adminDiseDeletionProtectionReason({
      id: 8, status: 0, type: 3, isDiy: 0, templateName: "suspended_window",
    })).toBe("悬浮配置不能删除");
    expect(adminDiseDeletionProtectionReason({
      id: 9, status: 1, type: 1, isDiy: 1, templateName: "",
    })).toBe("启用中的首页不能删除");
    expect(adminDiseDeletionProtectionReason({
      id: 9, status: 0, type: 1, isDiy: 1, templateName: "",
    })).toBeNull();
  });

  it("keeps persistence transactional, versioned and free of the legacy dual-write", () => {
    const source = readFileSync("src/controllers/api/v1/AdminCrudController.ts", "utf8");
    const section = source.slice(
      source.indexOf("const ADMIN_DISE_MAX_BODY_BYTES"),
      source.indexOf("// CMS 内容管理"),
    );

    expect(section).toContain("withTx(container");
    expect(section.match(/\.for\("update"\)/g)).toHaveLength(2);
    expect(section).toContain("GREATEST(${systemDise.updateTime} + 1, ${now})");
    expect(section).toContain("version: newAdminDiseVersion()");
    expect(section).toContain("normalizeAdminDiseJson(existing.value)");
    expect(section).toContain("type: 1");
    expect(section).toContain("isDiy: 1");
    expect(section).toContain("status: 0");
    expect(section).not.toContain("COALESCE(NULLIF(content");
    expect(section).not.toContain("body.type");
  });

  it("renders explicit fields and never posts type=0 from the admin page", () => {
    const page = readFileSync("../view/admin-ts/src/pages/content/DiseList.vue", "utf8");
    expect(page).toContain("interface DiseRow");
    expect(page).toContain("v-model=\"form.value\"");
    expect(page).toContain("v-model=\"form.content\"");
    expect(page).toContain('create_kind: "diy_page"');
    expect(page).toContain("template_name");
    expect(page).toContain("delete_protected");
    expect(page).not.toMatch(/\bany\b/);
    expect(page).not.toContain("type: 0");
  });
});
