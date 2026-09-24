import { readFileSync } from "node:fs";
import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { MIGRATION_TABLES } from "../scripts/data-migration/manifest";
import { systemConfigTab, systemForm, systemFormData } from "../src/models/schema";
import { requiredAdminPermission } from "../src/services/admin/AdminPermissionService";
import {
  buildConfigTabTree,
  handleSystemFormDefinition,
  normalizeSystemFormDefinition,
  parseSystemFormDefinition,
} from "../src/services/system/SystemMetadataService";
import {
  prepareOrderSystemFormSubmission,
  readOrderSystemFormSnapshot,
} from "../src/services/order/OrderSystemFormService";
import { parseOrderSystemFormTemplate } from '../../view/common/order-system-form';

describe("system form and configuration-tab migration", () => {
  it.each([['2026-09-23', ''], ['', '2026-09-23']])('rejects a half-filled date range %s / %s on the shared server validator', (start, end) => {
    const template = [{ id: 'range', name: 'dateranges', value: [], titleShow: { val: false } }];
    expect(() => prepareOrderSystemFormSubmission(template, [{ id: 'range', value: [start, end] }], 77)).toThrow('完整范围');
    expect(() => prepareOrderSystemFormSubmission(template, [{ id: 'range', value: [] }], 77)).not.toThrow();
    expect(() => prepareOrderSystemFormSubmission(template, [{ id: 'range', value: ['2026-09-23','2026-09-24'] }], 77)).not.toThrow();
  });
  it("preserves all three source contracts without merging their semantics", () => {
    expect(getTableName(systemConfigTab)).toBe("system_config_tab");
    expect(Object.keys(getTableColumns(systemConfigTab))).toEqual([
      "id", "isStore", "pid", "title", "engTitle", "status", "info", "icon", "type", "sort",
    ]);
    expect(getTableName(systemForm)).toBe("system_form");
    expect(Object.keys(getTableColumns(systemForm))).toEqual([
      "id", "version", "name", "coverImage", "value", "defaultValue", "status", "isDel",
      "updateTime", "addTime",
    ]);
    expect(getTableName(systemFormData)).toBe("system_form_data");
    expect(Object.keys(getTableColumns(systemFormData))).toEqual([
      "id", "uid", "systemFormId", "type", "relationId", "value", "isDel", "addTime",
    ]);
  });

  it("registers deterministic migration keys and preserves weak source constraints", () => {
    for (const table of ["system_config_tab", "system_form", "system_form_data"]) {
      expect(MIGRATION_TABLES.find((entry) => entry.table === table)?.key).toEqual(["id"]);
    }
    expect(MIGRATION_TABLES.find((entry) => entry.table === "system_config_tab")?.note)
      .toContain("system_config.config_tab_id");
    expect(MIGRATION_TABLES.find((entry) => entry.table === "system_form_data")?.note)
      .toContain("VARCHAR system_form_id");
    const migration = readFileSync("migrations/0049_system_forms_and_config_tabs.sql", "utf8");
    expect(migration).not.toContain("CREATE UNIQUE INDEX");
    expect(migration).toContain('"system_form_id" VARCHAR(255)');
  });

  it("validates new form JSON while safely reading historical invalid JSON", () => {
    expect(parseSystemFormDefinition("not-json")).toEqual([]);
    const value = [{
      id: "phone",
      name: "texts",
      titleConfig: { value: "手机号" },
      tipConfig: { value: "请输入" },
      titleShow: { val: true },
      value: "",
    }];
    expect(JSON.parse(normalizeSystemFormDefinition(value))).toEqual(value);
    expect(handleSystemFormDefinition(JSON.stringify(value))).toEqual([
      {
        id: "phone",
        type: "texts",
        name: "文本框",
        title: "手机号",
        tip: "请输入",
        list: [],
        require: true,
        value: "",
      },
    ]);
    expect(() => normalizeSystemFormDefinition("not-json")).toThrow();
    expect(() => normalizeSystemFormDefinition([])).toThrow();
  });

  it("canonically validates checkout submissions and discards client metadata", () => {
    const template = [
      {
        id: "phone",
        name: "texts",
        titleConfig: { value: "手机号" },
        tipConfig: { value: "请输入" },
        titleShow: { val: true },
        valConfig: { tabVal: 1 },
        value: "",
      },
      {
        id: "color",
        name: "radios",
        titleConfig: { value: "颜色" },
        titleShow: { val: true },
        wordsConfig: { list: [{ val: "红色" }, { val: "蓝色" }] },
        value: "红色",
      },
    ];
    const prepared = prepareOrderSystemFormSubmission(template, [
      { ...template[0], titleConfig: { value: "伪造标题" }, value: "13800138000" },
      { ...template[1], wordsConfig: { list: [{ val: "伪造选项" }] }, value: "蓝色" },
    ], 9);

    expect(prepared.systemFormId).toBe(9);
    expect(prepared.attachmentIds).toEqual([]);
    expect(JSON.parse(prepared.snapshotJson)).toMatchObject([
      { id: "phone", titleConfig: { value: "手机号" }, value: "13800138000" },
      { id: "color", wordsConfig: { list: [{ val: "红色" }, { val: "蓝色" }] }, value: "蓝色" },
    ]);
    expect(JSON.parse(prepared.collectedJson)).toEqual([
      {
        id: "phone", type: "texts", name: "文本框", title: "手机号", tip: "请输入",
        list: [], require: true, value: "13800138000",
      },
      {
        id: "color", type: "radios", name: "单选框", title: "颜色", tip: "",
        list: [{ val: "红色" }, { val: "蓝色" }], require: true, value: "蓝色",
      },
    ]);
    expect(() => prepareOrderSystemFormSubmission(template, [template[0]], 9)).toThrow("不完整");
    expect(() => prepareOrderSystemFormSubmission(template, [
      { ...template[0], value: "not-a-phone" }, template[1],
    ], 9)).toThrow("正确的手机号");
    expect(() => prepareOrderSystemFormSubmission(template, [
      { ...template[0], value: "13800138000" }, { ...template[1], value: "绿色" },
    ], 9)).toThrow("无效选项");
    expect(() => prepareOrderSystemFormSubmission([{
      id: "image", name: "uploadPicture", titleConfig: { value: "凭证" }, titleShow: { val: true }, value: [],
    }], [{ id: "image", name: "uploadPicture", value: ["javascript:alert(1)"] }], 9)).toThrow("图片地址错误");
    expect(prepareOrderSystemFormSubmission([{
      id: "image", name: "uploadPicture", titleConfig: { value: "凭证" }, titleShow: { val: true }, numConfig: { val: 2 }, value: [],
    }], [{ id: "image", name: "uploadPicture", value: ["/api/assets/42"] }], 9).attachmentIds).toEqual([42]);
    expect(() => prepareOrderSystemFormSubmission([{
      id: "image", name: "uploadPicture", titleConfig: { value: "凭证" }, numConfig: { val: 1 }, value: [],
    }], [{ id: "image", name: "uploadPicture", value: ["/api/assets/42", "/api/assets/43"] }], 9))
      .toThrow("最多上传 1 张图片");
  });

  it("signs only order-owner image references when reading immutable snapshots", async () => {
    const db = {
      select: () => ({
        from: () => ({ where: async () => [{ id: 42 }] }),
      }),
    } as never;
    const attachments = {
      signReferences: async (references: string[]) => references.map((value) => `${value}?signed=1`),
    } as never;
    const snapshot = await readOrderSystemFormSnapshot(db, attachments, 7, [{
      id: "image",
      name: "uploadPicture",
      value: ["/api/assets/42", "/api/assets/99", "https://cdn.example/a.png", "javascript:alert(1)"],
    }]);
    expect(snapshot[0].value).toEqual([
      "/api/assets/42?signed=1",
      "https://cdn.example/a.png",
    ]);
  });

  it('uses the same ordered legacy object template for preview and authoritative answer validation', () => {
    const legacy = { '200': { id:'second', timestamp:200, name:'texts', value:'' },
      '100': { id:'first', timestamp:100, name:'texts', titleShow:{val:true}, value:'' } };
    const parsed = parseOrderSystemFormTemplate(JSON.stringify(legacy));
    expect(parsed.map(field=>field.id)).toEqual(['first','second']);
    const prepared=prepareOrderSystemFormSubmission(legacy,[{id:'second',value:'two'},{id:'first',value:'one'}],7);
    expect(JSON.parse(prepared.snapshotJson).map((field:{value:string})=>field.value)).toEqual(['one','two']);
    expect(legacy['100'].value).toBe('');
  });

  it('rejects ambiguous, oversized or unsupported authoritative definitions, without weakening array-only answers', () => {
    const field={id:'first',name:'texts',value:''};
    for(const template of [null,{},[],[field,field],[{...field,name:'script'}],[{...field,extra:'x'.repeat(1_000_001)}]])
      expect(()=>parseOrderSystemFormTemplate(template)).toThrow();
    expect(()=>prepareOrderSystemFormSubmission([field],{first:{...field,value:'value'}},7)).toThrow('格式错误');
  });

  it('never signs relation-id-zero pictures for a guest order', async () => {
    const db={select:()=>{throw Error('Guest UID must not query shared attachment ownership');}} as never;
    const attachments={signReferences:()=>{throw Error('Guest UID must not sign another principal image');}} as never;
    expect((await readOrderSystemFormSnapshot(db,attachments,0,[{name:'uploadPicture',value:['/api/assets/42']}]))[0].value).toEqual([]);
  });

  it("restores scoped routes and atomically collects checkout form data", () => {
    expect(buildConfigTabTree([
      { id: 2, pid: 1, title: "child" },
      { id: 1, pid: 0, title: "root" },
    ])[0].children?.[0].id).toBe(2);

    const service = readFileSync("src/services/system/SystemMetadataService.ts", "utf8");
    const order = readFileSync("src/services/order/StoreOrderCreateService.ts", "utf8");
    const integral = readFileSync("src/services/activity/ActivityService.ts", "utf8");
    const adminRoutes = readFileSync("src/routes/adminapi.ts", "utf8");
    const v1Routes = readFileSync("src/routes/v1/index.ts", "utf8");
    const supplierRoutes = readFileSync("src/routes/supplierapi.ts", "utf8");

    expect(service).toContain("pg_advisory_xact_lock");
    expect(service).toContain("leftJoin(userTable");
    expect(service).toContain("leftJoin(systemForm");
    expect(order).toContain("collectOrderSystemForm");
    expect(order).toContain("readOrderSystemFormForOrder");
    expect(order).not.toContain("当前下单链路尚未迁移");
    expect(integral).toContain("collectOrderSystemForm");
    expect(integral).not.toContain("当前直兑链路尚未迁移");
    expect(v1Routes).toContain('/order/system_form/:id');
    for (const routes of [adminRoutes, v1Routes]) {
      expect(routes).toContain("/config_class/set_status/:id/:status");
      expect(routes).toContain("/form/index");
      expect(routes).toContain("/form/save/:id");
      expect(routes).toContain("/form/data/:id");
    }
    expect(supplierRoutes).toContain('"/form/info/:id"');
    expect(supplierRoutes).toContain('"/form/all_system_form"');
    expect(requiredAdminPermission("GET", "/adminapi/config_class")).toBe("config.view");
    expect(requiredAdminPermission("POST", "/api/admin/form/save/:id")).toBe("config.manage");
  });
});
