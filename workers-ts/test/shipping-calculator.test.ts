import { describe, expect, it } from "vitest";
import {
  calculateOrderPostageCents,
  expandShippingRegionIds,
  ShippingConfigurationError,
  type ShippingItemInput,
  type ShippingRegionInput,
} from "../src/services/order/ShippingCalculator";

function templateItem(overrides: Partial<ShippingItemInput> = {}): ShippingItemInput {
  return {
    freight: 3,
    postage: "0.00",
    tempId: 10,
    quantity: 1,
    unitPrice: "10.00",
    weight: "0.00",
    volume: "0.00",
    ...overrides,
  };
}

function region(overrides: Partial<ShippingRegionInput> = {}): ShippingRegionInput {
  return {
    id: 1,
    templateId: 10,
    regionId: 0,
    regionName: "全国",
    first: "1.00",
    firstPrice: "5.00",
    continue: "1.00",
    continuePrice: "2.00",
    ...overrides,
  };
}

describe("order shipping calculator", () => {
  it("expands city_area paths from the selected city to nearest and root ancestors", () => {
    expect(expandShippingRegionIds(4, "/1/2/3/")).toEqual([4, 3, 2, 1]);
    expect(expandShippingRegionIds(4, "/1/2/4/")).toEqual([4, 2, 1]);
    expect(() => expandShippingRegionIds(4, "/1/not-a-city/")).toThrow(
      "Invalid city hierarchy path",
    );
  });

  it("matches the nearest configured ancestor before province and nationwide rows", () => {
    expect(
      calculateOrderPostageCents(
        [templateItem()],
        [{ id: 10, type: 1 }],
        [
          region({ id: 1, regionId: 0, firstPrice: "1.00" }),
          region({ id: 2, regionId: 1, firstPrice: "2.00" }),
          region({ id: 3, regionId: 3, firstPrice: "5.00" }),
        ],
        { cityId: 4, regionPath: "/1/2/3/" },
      ),
    ).toBe(500);
  });

  it("applies no-delivery rules configured on an ancestor city ID", () => {
    expect(() =>
      calculateOrderPostageCents(
        [templateItem()],
        [{ id: 10, type: 1, noDelivery: 1 }],
        [region()],
        { cityId: 4, regionPath: "/1/2/3/" },
        [],
        [{ id: 1, tempId: 10, provinceId: 1, cityId: 2, value: "" }],
      ),
    ).toThrow();
  });

  it("adds fixed postage per quantity and ignores free-shipping items", () => {
    expect(
      calculateOrderPostageCents(
        [
          templateItem({ freight: 1, quantity: 8 }),
          templateItem({ freight: 2, postage: "3.25", quantity: 2 }),
        ],
        [],
        [],
        {},
      ),
    ).toBe(650);
  });

  it("uses an exact city row before a named or nationwide fallback", () => {
    expect(
      calculateOrderPostageCents(
        [templateItem({ quantity: 3 })],
        [{ id: 10, type: 1 }],
        [
          region({ id: 1, regionId: 0, firstPrice: "1.00" }),
          region({ id: 2, regionId: 440300, regionName: "深圳市", firstPrice: "5.00" }),
          region({ id: 3, regionId: 0, regionName: "广东省", firstPrice: "9.00" }),
        ],
        { cityId: 440300, province: "广东省" },
      ),
    ).toBe(900);
  });

  it("aggregates weight/volume by template and preserves PHP max-first-price charging", () => {
    expect(
      calculateOrderPostageCents(
        [
          templateItem({ tempId: 10, quantity: 2, weight: "0.75" }),
          templateItem({ tempId: 20, quantity: 1, volume: "2.00" }),
        ],
        [
          { id: 10, type: 2 },
          { id: 20, type: 3 },
        ],
        [
          region({
            templateId: 10,
            first: "1.00",
            firstPrice: "10.00",
            continue: "0.50",
            continuePrice: "2.00",
          }),
          region({
            id: 2,
            templateId: 20,
            first: "1.00",
            firstPrice: "5.00",
            continue: "1.00",
            continuePrice: "3.00",
          }),
        ],
        {},
      ),
    ).toBe(1800);
  });

  it("uses the province-name fallback for Worker-created rows", () => {
    expect(
      calculateOrderPostageCents(
        [templateItem()],
        [{ id: 10, type: 1 }],
        [region({ regionId: 44, regionName: "广东", firstPrice: "6.00" })],
        { province: "广东省" },
      ),
    ).toBe(600);
  });

  it("waives a template charge only when both designated-free thresholds match", () => {
    const rules = [
      {
        id: 1,
        tempId: 10,
        provinceId: 44,
        cityId: 440300,
        number: "2.00",
        price: "50.00",
        value: "[44,440300]",
      },
    ];
    expect(
      calculateOrderPostageCents(
        [templateItem({ quantity: 2, unitPrice: "30.00" })],
        [{ id: 10, type: 1, appoint: 1 }],
        [region()],
        { cityId: 440300 },
        rules,
      ),
    ).toBe(0);
    expect(
      calculateOrderPostageCents(
        [templateItem({ quantity: 2, unitPrice: "20.00" })],
        [{ id: 10, type: 1, appoint: 1 }],
        [region()],
        { cityId: 440300 },
        rules,
      ),
    ).toBe(700);
  });

  it("rejects no-delivery destinations and fails closed when the city is absent", () => {
    const rules = [
      {
        id: 1,
        tempId: 10,
        provinceId: 44,
        cityId: 440300,
        value: "[44,440300]",
      },
    ];
    expect(() =>
      calculateOrderPostageCents(
        [templateItem()],
        [{ id: 10, type: 1, noDelivery: 1 }],
        [region()],
        { cityId: 440300 },
        [],
        rules,
      ),
    ).toThrow("当前地区不支持配送");
    expect(() =>
      calculateOrderPostageCents(
        [templateItem()],
        [{ id: 10, type: 1, noDelivery: 1 }],
        [region()],
        {},
        [],
        rules,
      ),
    ).toThrow("必须提供城市 ID");
  });

  it("fails closed when a template, destination rate, or continuation is invalid", () => {
    expect(() =>
      calculateOrderPostageCents([templateItem()], [], [], {}),
    ).toThrow(ShippingConfigurationError);
    expect(() =>
      calculateOrderPostageCents(
        [templateItem()],
        [{ id: 10, type: 1 }],
        [],
        { cityId: 440300 },
      ),
    ).toThrow("未配置当前地区费率");
    expect(() =>
      calculateOrderPostageCents(
        [templateItem({ quantity: 2 })],
        [{ id: 10, type: 1 }],
        [region({ continue: "0.00" })],
        {},
      ),
    ).toThrow("续计量必须大于 0");
  });
});
