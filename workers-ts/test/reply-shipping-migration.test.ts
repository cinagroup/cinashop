import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { MIGRATION_TABLES } from "../scripts/data-migration/manifest";
import {
  shippingTemplates,
  shippingTemplatesFree,
  shippingTemplatesNoDelivery,
  shippingTemplatesRegion,
  storeProductReplyComment,
} from "../src/models/schema";

describe("reply and shipping migration parity", () => {
  it("keeps source and target meanings separate in the manifest", () => {
    expect(
      MIGRATION_TABLES.find((entry) => entry.table === "store_product_reply_comment")
        ?.columnMappings,
    ).toEqual({ create_time: "add_time" });
    expect(
      MIGRATION_TABLES.find((entry) => entry.table === "shipping_templates")?.columnMappings,
    ).toEqual({ type: "owner_type", group: "type" });
    expect(
      MIGRATION_TABLES.find((entry) => entry.table === "shipping_templates_region")
        ?.columnMappings,
    ).toEqual({
      temp_id: "template_id",
      city_id: "region_id",
      group: "billing_group",
    });
    expect(
      MIGRATION_TABLES.find((entry) => entry.table === "shipping_templates_free"),
    ).toMatchObject({ key: ["id"], phase: "activity" });
    expect(
      MIGRATION_TABLES.find((entry) => entry.table === "shipping_templates_no_delivery"),
    ).toMatchObject({ key: ["id"], phase: "activity" });
  });

  it("preserves reply thread metadata and legacy field widths in Drizzle", () => {
    const reply = getTableColumns(storeProductReplyComment);
    const shipping = getTableColumns(shippingTemplates);
    const shippingRegion = getTableColumns(shippingTemplatesRegion);
    const shippingFree = getTableColumns(shippingTemplatesFree);
    const shippingNoDelivery = getTableColumns(shippingTemplatesNoDelivery);

    expect(Object.keys(reply)).toEqual(
      expect.arrayContaining(["type", "relationId", "pid", "addTime", "updateTime"]),
    );
    expect(reply.content.getSQLType()).toBe("varchar(1000)");
    expect(Object.keys(shipping)).toEqual(
      expect.arrayContaining(["ownerType", "relationId", "type", "appoint", "noDelivery"]),
    );
    expect(shipping.name.getSQLType()).toBe("varchar(255)");
    expect(Object.keys(shippingRegion)).toEqual(
      expect.arrayContaining([
        "templateId",
        "provinceId",
        "regionId",
        "billingGroup",
        "value",
        "uniqid",
      ]),
    );
    expect(Object.keys(shippingFree)).toEqual(
      expect.arrayContaining([
        "provinceId", "tempId", "cityId", "number", "price", "billingGroup", "value", "uniqid",
      ]),
    );
    expect(Object.keys(shippingNoDelivery)).toEqual(
      expect.arrayContaining(["provinceId", "tempId", "cityId", "value", "uniqid"]),
    );
  });
});
