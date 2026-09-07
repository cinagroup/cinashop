import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createPcCheckoutQuoteFixture } from "./helpers/pcCheckoutQuoteFixture";
import { orderCreate } from "../src/controllers/api/v1/OrderController";
import { StoreOrderCreateService } from "../src/services/order/StoreOrderCreateService";
import { StoreOrderPayService } from "../src/services/order/StoreOrderPayService";
import { OrderFormRejectedException } from "../src/services/order/OrderSystemFormService";
import { ValidateException } from "../src/utils/errors";
import { systemForm, systemFormData, systemAttachment, storeProduct, storeOrderCartInfo, storeOrderStatus, printDocument } from "../src/models/schema";

const template = [{ id: "email", name: "texts", titleConfig: { value: "联系邮箱" }, titleShow: { val: "1" }, valConfig: { tabVal: 3 }, value: "" }];

describe("PC form rejection through actual order controller and disposable SQL transaction", () => {
  let fixture: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  let sequence = 0;
  beforeAll(async () => {
    fixture = await createPcCheckoutQuoteFixture([systemForm, systemFormData, systemAttachment, storeOrderCartInfo, storeOrderStatus, printDocument]);
    await fixture.db.update(storeProduct).set({ systemFormId: 77 }).where(eq(storeProduct.id, 70));
    await fixture.db.insert(systemForm).values({ id: 77, name: "本地表单", value: JSON.stringify(template), status: 1 });
    fixture.app.post("/api/order/create/:key", orderCreate);
  }, 30000);
  beforeEach(() => {
    // Only replace the external Sequence DO. Pricing, validation, transaction and SQL remain real.
    vi.spyOn(StoreOrderCreateService.prototype, "createOrder").mockImplementation((params) =>
      StoreOrderCreateService.createWithRuntime(fixture.container, {
        CONFIG_KV: fixture.env.CONFIG_KV, nextOrderId: async () => `local_form_${++sequence}`,
      }, params));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fixture.db.update(systemForm).set({ value: JSON.stringify(template), status: 1 }).where(eq(systemForm.id, 77));
  });
  afterAll(async () => { await fixture?.close(); });
  async function create(customForm: unknown, key = "form_key", extra: Record<string, unknown> = {}) {
    const response = await fixture.app.request(`/api/order/create/${key}`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-fixture-user": "11" },
      body: JSON.stringify({ cartIds: [1], addressId: 11, useIntegral: true, customForm, ...extra }),
    }, fixture.env);
    return response.json() as Promise<{ status: number; msg: string; data: Record<string, unknown> | null }>;
  }
  it("rolls back first-order eligibility and leaves stock/cart/points/orders unchanged on a bad form", async () => {
    const before = await fixture.snapshot();
    expect(before.users[0].isFirstOrder).toBe(0);
    const response = await create([{ ...template[0], value: "invalid-email" }]);
    expect(response).toMatchObject({ status: 400, msg: "请填写正确的联系邮箱", data: { errorCode: "ORDER_FORM_REJECTED", orderKey: "form_key" } });
    expect(sequence).toBe(1); // Actual creation crossed the quote path into the transaction.
    expect(await fixture.snapshot()).toEqual(before);
    expect(await fixture.db.select().from(systemFormData)).toEqual([]);
    expect(await fixture.db.select().from(storeOrderCartInfo)).toEqual([]);
  });
  it("marks a disabled server template as a definitive rejection without committing any order", async () => {
    await fixture.db.update(systemForm).set({ status: 0 }).where(eq(systemForm.id, 77));
    const before = await fixture.snapshot();
    expect(await create([{ ...template[0], value: "qa@example.test" }], "disabled_form")).toMatchObject({
      status: 400, data: { errorCode: "ORDER_FORM_REJECTED", orderKey: "disabled_form" },
    });
    expect(await fixture.snapshot()).toEqual(before);
  });
  it("rejects an attachment that the order owner does not own, despite valid client prevalidation", async () => {
    const images = [{ id: "image", name: "uploadPicture", titleShow: { val: true }, value: ["/api/assets/42"] }];
    await fixture.db.update(systemForm).set({ value: JSON.stringify(images) }).where(eq(systemForm.id, 77));
    const before = await fixture.snapshot();
    expect(await create(images, "foreign_attachment")).toMatchObject({
      status: 400, msg: "自定义表单包含无权使用的图片", data: { errorCode: "ORDER_FORM_REJECTED", orderKey: "foreign_attachment" },
    });
    expect(await fixture.snapshot()).toEqual(before);
  });
  it("does not grant correction for ordinary business, SQL/transport, or post-create payment failures", async () => {
    const createSpy = vi.mocked(StoreOrderCreateService.prototype.createOrder);
    createSpy.mockRejectedValueOnce(new ValidateException("库存不足"));
    expect((await create(template)).data).toBeNull();
    createSpy.mockRejectedValueOnce(new Error("simulated transport failure"));
    expect((await create(template)).data).toBeNull();
    createSpy.mockResolvedValueOnce({ orderId: "synthetic_created_order", key: "created_key" });
    const payment = vi.spyOn(StoreOrderPayService.prototype, "pay").mockRejectedValueOnce(new OrderFormRejectedException("post-create synthetic error"));
    const response = await create(template, "created_key", { payType: "yue" });
    expect(payment).toHaveBeenCalledOnce();
    expect(response).toMatchObject({ status: 400, data: null });
    expect((await fixture.snapshot()).orders).toEqual([]); // This case stubs creation/payment; no provider request.
  });
  it("corrects the rejected form using the same key and creates one immutable, idempotent local order", async () => {
    const response = await create([{ ...template[0], value: "qa@example.test", titleConfig: { value: "伪造" } }]);
    expect(response.status, response.msg).toBe(200);
    const after = await fixture.snapshot();
    expect(after.orders).toHaveLength(1);
    expect(after.orders[0]).toMatchObject({ unique: "form_key", payPrice: "18.70", paid: 0 });
    expect(after.users[0]).toMatchObject({ isFirstOrder: 1, integral: 50 });
    expect(after.products[0].stock).toBe(6);
    expect(after.skus[0].stock).toBe(6);
    expect(after.bills).toHaveLength(1);
    expect(after.orders[0].customForm).not.toBeNull();
    expect(JSON.parse(after.orders[0].customForm ?? "null")[0]).toMatchObject({ titleConfig: { value: "联系邮箱" }, value: "qa@example.test" });
    expect(await fixture.db.select().from(systemFormData)).toHaveLength(1);
    expect(await fixture.db.select().from(storeOrderCartInfo)).toHaveLength(1);
    const retry = await create([{ ...template[0], value: "invalid-after-commit" }]);
    expect(retry.data).toEqual(response.data);
    expect(await fixture.snapshot()).toEqual(after);
  });
});
