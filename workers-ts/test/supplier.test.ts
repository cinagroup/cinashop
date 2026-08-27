import { describe, expect, it } from "vitest";
import {
  dayRangeUtc8,
  normalizeSupplierProfileInput,
  parsePagination,
} from "@/services/supplier/SupplierService";
import { normalizeSupplierDeliveryInput } from "@/services/supplier/SupplierFulfillmentService";
import { amountToCents } from "@/services/supplier/SupplierFinanceService";
import {
  normalizeSupplierExtractReviewInput,
  normalizeSupplierTransferInput,
} from "@/services/admin/AdminSupplierFinanceService";

describe("supplier migration helpers", () => {
  it("clamps pagination and never produces a negative offset", () => {
    expect(parsePagination("-2", "999")).toEqual({ page: 1, limit: 100, offset: 0 });
    expect(parsePagination("3", "25")).toEqual({ page: 3, limit: 25, offset: 50 });
    expect(parsePagination("bad", "bad")).toEqual({ page: 1, limit: 20, offset: 0 });
  });

  it("computes China/Singapore business-day boundaries in UTC", () => {
    const noonUtc = Date.UTC(2026, 7, 9, 12, 0, 0);
    const [start, end] = dayRangeUtc8(0, noonUtc);
    expect(new Date(start * 1000).toISOString()).toBe("2026-08-08T16:00:00.000Z");
    expect(new Date(end * 1000).toISOString()).toBe("2026-08-09T15:59:59.000Z");
  });

  it("normalizes profile fields and enforces a confirmed strong password", () => {
    expect(
      normalizeSupplierProfileInput({
        supplier_name: "  测试供应商  ",
        phone: "+86 13800138000",
        email: "owner@example.com",
        province: "11",
        pwd: "correct-horse-battery",
        conf_pwd: "correct-horse-battery",
      }),
    ).toMatchObject({
      supplierName: "测试供应商",
      phone: "+86 13800138000",
      email: "owner@example.com",
      province: 11,
      password: "correct-horse-battery",
    });

    expect(() =>
      normalizeSupplierProfileInput({ pwd: "short", conf_pwd: "short" }),
    ).toThrow("密码至少需要 12 位");
    expect(() =>
      normalizeSupplierProfileInput({
        pwd: "correct-horse-battery",
        conf_pwd: "different-password",
      }),
    ).toThrow("两次输入的密码不一致");
  });

  it("validates fulfillment modes without accepting incomplete shipment data", () => {
    expect(
      normalizeSupplierDeliveryInput({
        delivery_type: "express",
        delivery_name: "顺丰速运",
        delivery_code: "SF",
        delivery_id: "SF1234567890",
      }),
    ).toMatchObject({
      deliveryType: "express",
      deliveryName: "顺丰速运",
      deliveryCode: "SF",
      deliveryId: "SF1234567890",
    });
    expect(() => normalizeSupplierDeliveryInput({ delivery_type: "express" })).toThrow(
      "delivery_name不能为空",
    );
    expect(() =>
      normalizeSupplierDeliveryInput({ delivery_type: "fictitious", fictitious_content: "" }),
    ).toThrow("fictitious_content不能为空");
  });

  it("parses withdrawal amounts as integer cents and rejects excess precision", () => {
    expect(amountToCents("123.45")).toBe(12345);
    expect(amountToCents("1")).toBe(100);
    expect(() => amountToCents("1.005")).toThrow("金额格式错误");
    expect(() => amountToCents("0")).toThrow("金额必须大于 0");
  });

  it("keeps supplier withdrawal review and actual transfer as separate audited steps", () => {
    expect(normalizeSupplierExtractReviewInput({ type: 1 })).toEqual({
      approved: true,
      message: "",
    });
    expect(normalizeSupplierExtractReviewInput({ type: 0, message: "账户信息不一致" })).toEqual({
      approved: false,
      message: "账户信息不一致",
    });
    expect(() => normalizeSupplierExtractReviewInput({ type: 0 })).toThrow("请填写拒绝原因");
    expect(
      normalizeSupplierTransferInput({
        voucher_title: "招商银行转账回单",
        voucher_image: "https://cdn.example.com/voucher.png",
      }),
    ).toEqual({
      voucherTitle: "招商银行转账回单",
      voucherImage: "https://cdn.example.com/voucher.png",
    });
    expect(() => normalizeSupplierTransferInput({ voucher_title: "已转账" })).toThrow(
      "请填写转账凭证地址",
    );
  });
});
