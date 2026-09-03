import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { requiredAdminPermission } from "@/services/admin/AdminPermissionService";
import {
  handleSystemFormDefinition,
  normalizeSystemFormDefinition,
  parseSystemFormDefinition,
} from "@/services/system/SystemMetadataService";

function textComponent(id = "name") {
  return {
    id,
    timestamp: 1,
    name: "texts",
    titleConfig: { value: "联系人" },
    titleShow: { val: true },
    tipConfig: { value: "请输入" },
    valConfig: { tabVal: 1 },
    defaultValConfig: { value: "13800138000" },
    value: "",
  };
}

describe("Admin system form operations", () => {
  it("validates component type, identity, choices, defaults, and upload bounds before save", () => {
    expect(JSON.parse(normalizeSystemFormDefinition([textComponent()]))[0].name).toBe("texts");
    expect(() => normalizeSystemFormDefinition([{ ...textComponent(), name: "html" }]))
      .toThrow("不支持的组件");
    expect(() => normalizeSystemFormDefinition([textComponent("same"), textComponent("same")]))
      .toThrow("重复组件ID");
    expect(() => normalizeSystemFormDefinition([{
      ...textComponent(),
      name: "selects",
      wordsConfig: { list: [{ val: "A" }, { val: "A" }] },
    }])).toThrow("重复选项");
    expect(() => normalizeSystemFormDefinition([{ ...textComponent(), defaultValConfig: { value: "bad" } }]))
      .toThrow("默认手机号");
    expect(() => normalizeSystemFormDefinition([{
      ...textComponent(),
      name: "uploadPicture",
      numConfig: { val: 10 },
    }])).toThrow("1到9");
  });

  it("accepts the legacy timestamp-keyed object and restores its component order", () => {
    const later = { ...textComponent("later"), timestamp: 200, titleShow: { val: "0" } };
    const earlier = { ...textComponent("earlier"), timestamp: 100, titleShow: { val: "1" } };
    const legacy = JSON.stringify({ 200: later, 100: earlier });
    expect(parseSystemFormDefinition(legacy).map((item: any) => item.id)).toEqual(["earlier", "later"]);
    expect(JSON.parse(normalizeSystemFormDefinition(legacy)).map((item: any) => item.id))
      .toEqual(["earlier", "later"]);
    expect(handleSystemFormDefinition(legacy).map((item) => item.require)).toEqual([true, false]);
  });

  it("bounds Admin bodies, avoids list JSON amplification, and hardens mutations", () => {
    const controller = readFileSync("src/controllers/api/v1/AdminCrudController.ts", "utf8");
    const service = readFileSync("src/services/system/SystemMetadataService.ts", "utf8");
    const migration = readFileSync("migrations/0128_system_form_reference_indexes.sql", "utf8");
    expect(controller).toContain("readBoundedJsonObject(c.req.raw, 1_100_000)");
    expect(controller).toContain("readBoundedJsonObject(c.req.raw, 4_096)");
    expect(controller).toContain('c.header("Pragma", "no-cache")');
    expect(service).toContain("select(formListProjection())");
    expect(service).toContain("SET LOCAL lock_timeout = '2s'");
    expect(service).toContain("SET LOCAL statement_timeout = '5s'");
    expect(service).toContain("activeSystemFormReferences");
    expect(service).toContain("writeSystemFormAudit");
    expect(service).toContain("系统表单保存回读不一致");
    for (const table of ["store_product", "store_seckill", "store_combination", "store_bargain", "store_integral"]) {
      expect(migration).toContain(`ON "${table}" ("system_form_id"`);
    }
  });

  it("provides an executable editor, safe CSV export, and mutating PUT alias", () => {
    const page = readFileSync("../view/admin-ts/src/pages/config/SystemForms.vue", "utf8");
    const api = readFileSync("../view/admin-ts/src/api/systemForms.ts", "utf8");
    const routes = readFileSync("src/routes/adminapi.ts", "utf8");
    expect(page).toContain('draggable="true"');
    expect(page).toContain("超过5000条");
    expect(page).toContain("/^[=+\\-@]/");
    expect(page).not.toContain("v-html");
    expect(api).toContain("request.put(`/form/set_show/");
    expect(routes).toContain('put("/form/set_show/:id/:is_show"');
    expect(requiredAdminPermission("GET", "/adminapi/form/data/:id")).toBe("config.view");
    expect(requiredAdminPermission("PUT", "/adminapi/form/set_show/:id/:is_show")).toBe("config.manage");
  });
});
