/**
 * Legacy WeChat mini-program live rooms, anchors, goods, and room bindings.
 *
 * Source uniqueness is intentionally preserved: live_room has the unusual
 * (id, phone) primary key and live_room_goods has no unique key at all.
 */
import {
  decimal,
  index,
  integer,
  pgTable,
  primaryKey,
  serial,
  smallint,
  varchar,
} from "drizzle-orm/pg-core";

export const liveAnchor = pgTable(
  "live_anchor",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 50 }).default("").notNull(),
    coverImg: varchar("cover_img", { length: 255 }).default("").notNull(),
    wechat: varchar("wechat", { length: 50 }).default("").notNull(),
    phone: varchar("phone", { length: 32 }).default("").notNull(),
    isShow: smallint("is_show").default(1).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (table) => [
    index("live_anchor_visible_time").on(
      table.isDel,
      table.isShow,
      table.addTime,
      table.id,
    ),
    index("live_anchor_wechat").on(table.wechat, table.id),
  ],
);

export const liveGoods = pgTable(
  "live_goods",
  {
    id: serial("id").primaryKey(),
    goodsId: integer("goods_id").default(0).notNull(),
    auditId: integer("audit_id").default(0).notNull(),
    productId: integer("product_id").default(0).notNull(),
    name: varchar("name", { length: 30 }).default("").notNull(),
    coverImg: varchar("cover_img", { length: 255 }).default("").notNull(),
    url: varchar("url", { length: 255 }).default("").notNull(),
    priceType: smallint("price_type").default(1).notNull(),
    costPrice: decimal("cost_price", { precision: 10, scale: 2 }).default("0.00").notNull(),
    price: decimal("price", { precision: 10, scale: 2 }).default("0.00").notNull(),
    price2: decimal("price2", { precision: 10, scale: 2 }).default("0.00").notNull(),
    auditStatus: smallint("audit_status").default(0).notNull(),
    thirdPartTag: smallint("third_part_tag").default(1).notNull(),
    sort: smallint("sort").default(0).notNull(),
    isShow: smallint("is_show").default(1).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (table) => [
    index("live_goods_visible_sort").on(
      table.isDel,
      table.isShow,
      table.sort,
      table.addTime,
      table.id,
    ),
    index("live_goods_audit_status").on(table.auditStatus, table.goodsId, table.id),
    index("live_goods_product").on(table.productId, table.id),
  ],
);

export const liveRoom = pgTable(
  "live_room",
  {
    id: serial("id").notNull(),
    roomId: integer("room_id").default(0).notNull(),
    name: varchar("name", { length: 32 }).default("").notNull(),
    coverImg: varchar("cover_img", { length: 255 }).default("").notNull(),
    shareImg: varchar("share_img", { length: 255 }).default("").notNull(),
    startTime: integer("start_time").default(0).notNull(),
    endTime: integer("end_time").default(0).notNull(),
    anchorName: varchar("anchor_name", { length: 50 }).default("").notNull(),
    anchorWechat: varchar("anchor_wechat", { length: 50 }).default("").notNull(),
    phone: varchar("phone", { length: 32 }).default("").notNull(),
    type: smallint("type").default(0).notNull(),
    screenType: smallint("screen_type").default(1).notNull(),
    closeLike: smallint("close_like").default(0).notNull(),
    closeGoods: smallint("close_goods").default(0).notNull(),
    closeComment: smallint("close_comment").default(0).notNull(),
    errorMsg: varchar("error_msg", { length: 255 }).default("").notNull(),
    status: smallint("status").default(0).notNull(),
    liveStatus: smallint("live_status").default(102).notNull(),
    mark: varchar("mark", { length: 512 }).default("").notNull(),
    replayStatus: smallint("replay_status").default(0).notNull(),
    sort: smallint("sort").default(0).notNull(),
    isShow: smallint("is_show").default(1).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (table) => [
    primaryKey({ name: "live_room_pk", columns: [table.id, table.phone] }),
    index("live_room_visible_sort").on(table.isDel, table.isShow, table.sort, table.id),
    index("live_room_remote_status").on(table.roomId, table.liveStatus, table.id),
    index("live_room_anchor").on(table.anchorWechat, table.id),
  ],
);

export const liveRoomGoods = pgTable(
  "live_room_goods",
  {
    liveRoomId: integer("live_room_id").default(0).notNull(),
    liveGoodsId: integer("live_goods_id").default(0).notNull(),
  },
  (table) => [
    index("live_room_goods_pair").on(table.liveRoomId, table.liveGoodsId),
    index("live_room_goods_goods_room").on(table.liveGoodsId, table.liveRoomId),
  ],
);

export type LiveAnchor = typeof liveAnchor.$inferSelect;
export type LiveGoods = typeof liveGoods.$inferSelect;
export type LiveRoom = typeof liveRoom.$inferSelect;
