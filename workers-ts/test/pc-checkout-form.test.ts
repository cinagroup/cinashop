import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { prepareOrderSystemFormSubmission as prepare, SystemFormValidationError } from "../../view/common/order-system-form";
import { prepareOrderSystemFormSubmission as serverPrepare } from "../src/services/order/OrderSystemFormService";
import { ValidateException } from "../src/utils/errors";
import { ApiResponseError, canEditRejectedOrder } from "../../view/pc-ts/src/utils/apiError";
import { SystemFormUploads } from "../../view/pc-ts/src/utils/systemFormUploads";

const field = (name = "texts", value: unknown = "", extra: Record<string, unknown> = {}) => ({
  id: "field", name, titleConfig: { value: "测试信息" }, titleShow: { val: true }, value, ...extra,
});
const choice = { wordsConfig: { list: [{ val: "甲" }, { value: "乙" }, { label: "丙" }] } };

describe("PC checkout shares the authoritative system-form rules", () => {
  it.each([
    ["texts", "  测试  ", "测试", {}], ["citys", "本地省 测试市", "本地省 测试市", {}],
    ["dates", "2026-09-07", "2026-09-07", {}], ["dateranges", ["2026-09-07", "2026-09-08"], ["2026-09-07", "2026-09-08"], {}],
    ["times", "12:30", "12:30", {}], ["timeranges", "12:30 - 13:30", "12:30 - 13:30", {}],
    ["radios", "甲", "甲", choice], ["selects", "乙", "乙", choice], ["checkboxs", ["甲", "丙"], ["甲", "丙"], choice],
    ["uploadPicture", ["/api/assets/42"], ["/api/assets/42"], { numConfig: { val: 1 } }],
  ])("normalizes %s identically in PC and Worker", (name, value, expected, extra) => {
    const template = [field(String(name), "", extra as Record<string, unknown>)];
    const submission = [{ ...template[0], value, titleShow: { val: false }, titleConfig: { value: "伪造" } }];
    const result = prepare(template, submission, 77);
    expect(serverPrepare(template, submission, 77)).toEqual(result);
    expect(JSON.parse(result.snapshotJson)[0]).toMatchObject({ titleConfig: { value: "测试信息" }, titleShow: { val: true }, value: expected });
    expect(JSON.parse(result.collectedJson)[0]).toMatchObject({ title: "测试信息", require: true, value: expected });
    expect(template[0].value).toBe("");
  });
  it.each([true, 1, "1"])("treats required flag %s as mandatory", (val) => {
    const template = [field("texts", "", { titleShow: { val } })];
    expect(() => prepare(template, template, 77)).toThrow("请填写测试信息");
    expect(() => serverPrepare(template, template, 77)).toThrow(ValidateException);
  });
  it.each([false, 0, "0", undefined])("does not make optional flag %s mandatory", (val) => {
    const template = [field("texts", "", { titleShow: { val } })];
    expect(() => prepare(template, template, 77)).not.toThrow();
  });
  it.each([
    ["texts", "bad-phone", { valConfig: { tabVal: 1 } }], ["texts", "bad-id", { valConfig: { tabVal: 2 } }],
    ["texts", "bad-email", { valConfig: { tabVal: 3 } }], ["texts", "0", { valConfig: { tabVal: 4 } }],
    ["dates", "09/07/2026", {}], ["dateranges", ["2026-09-08", "2026-09-07"], {}],
    ["times", "24:00", {}], ["timeranges", "13:30 - 12:30", {}],
    ["radios", "外部选项", choice], ["checkboxs", ["甲", "外部选项"], choice], ["selects", "外部选项", choice],
    ["uploadPicture", ["javascript:alert(1)"], {}], ["uploadPicture", ["/api/assets/1", "/api/assets/2"], { numConfig: { val: 1 } }],
  ])("rejects invalid %s values before submission", (name, value, extra) => {
    const template = [field(String(name), value, extra as Record<string, unknown>)];
    expect(() => prepare(template, template, 77)).toThrow(SystemFormValidationError);
    expect(() => serverPrepare(template, template, 77)).toThrow(ValidateException);
  });
  it("rejects incomplete, duplicate, unsupported and oversized payloads", () => {
    const template = [field(), { ...field(), id: "second" }];
    expect(() => prepare(template, [field()], 77)).toThrow("不完整");
    expect(() => prepare(template, [field(), field()], 77)).toThrow("重复");
    expect(() => prepare([field("unknown", "x")], [field("unknown", "x")], 77)).toThrow("不支持");
    expect(() => prepare([field()], [field("texts", "x".repeat(10001))], 77)).toThrow("过长");
    expect(() => prepare([field()], [field("texts", "x", { extra: "x".repeat(1000001) })], 77)).toThrow("过大");
    expect(() => prepare(Array.from({ length: 101 }, (_, id) => ({ ...field(), id })), [], 77)).toThrow("配置无效");
  });
});

describe("definitive rejection is distinct from an unknown order outcome", () => {
  const rejected = (key = "owned_key") => new ApiResponseError("表单拒绝", 400, { errorCode: "ORDER_FORM_REJECTED", orderKey: key });
  it("unlocks only an exact owned-key rejection before any uncertain attempt", () => {
    expect(canEditRejectedOrder(rejected(), "owned_key", false)).toBe(true);
    expect(canEditRejectedOrder(rejected(), "owned_key", true)).toBe(false);
    expect(canEditRejectedOrder(rejected("other_key"), "owned_key", false)).toBe(false);
    expect(canEditRejectedOrder(rejected(""), "", false)).toBe(false);
  });
  it("keeps transport, generic business, malformed and lookalike failures frozen", () => {
    for (const error of [new Error("timeout"), new ApiResponseError("failure", 400, null),
      new ApiResponseError("failure", 500, rejected().data), new ApiResponseError("failure", 400, { errorCode: "ORDER_FORM_REJECTED" }),
      { status: 400, data: rejected().data }, new ApiResponseError("failure", 400, [])]) {
      expect(canEditRejectedOrder(error, "owned_key", false)).toBe(false);
    }
  });
});

describe("form uploads own their component and lifecycle", () => {
  it("allows different fields but not overlapping uploads for the same field", () => {
    const counts: number[] = [];
    const uploads = new SystemFormUploads((indices) => counts.push(indices.length));
    const first = uploads.begin(0)!, second = uploads.begin(1)!;
    expect(uploads.begin(0)).toBeNull();
    uploads.finish(first);
    expect(uploads.current(second)).toBe(true);
    uploads.finish(first);
    uploads.finish(second);
    expect(counts).toEqual([1, 2, 1, 0]);
  });
  it("discards stale completions after unmount/reset without clearing a new upload", () => {
    const counts: number[] = [];
    const uploads = new SystemFormUploads((indices) => counts.push(indices.length));
    const old = uploads.begin(0)!;
    uploads.reset();
    const fresh = uploads.begin(0)!;
    expect(uploads.current(old)).toBe(false);
    expect(uploads.current({ ...fresh })).toBe(false);
    uploads.finish(old);
    expect(uploads.current(fresh)).toBe(true);
    expect(counts).toEqual([1, 0, 1]);
    uploads.finish(fresh);
    expect(counts).toEqual([1, 0, 1, 0]);
  });
  it("wires busy/validation/uncertainty guards into rendered checkout", () => {
    const checkout = readFileSync("../view/pc-ts/src/pages/order/Checkout.vue", "utf8");
    const fields = readFileSync("../view/pc-ts/src/components/SystemFormFields.vue", "utf8");
    expect(checkout).toContain("!formValidationError.value");
    expect(checkout).toContain("pendingUploads.value === 0");
    expect(checkout).toContain("canEditRejectedOrder(e, orderKey.value, submissionUncertain.value)");
    expect(checkout).toContain(':key="formRevision"');
    expect(fields).toContain(':disabled="disabled"');
    expect(fields).toContain("onUnmounted(() => uploads.reset())");
    expect(fields).toContain("!uploads.current(ticket)");
    expect(fields).toContain("const latest = arrayValue(props.modelValue[index].value)");
  });
});
