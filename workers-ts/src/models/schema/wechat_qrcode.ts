import {
  index,
  integer,
  pgTable,
  serial,
  smallint,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

/** Generic official-account QR ticket cache used by legacy reply and channel codes. */
export const qrcode = pgTable(
  "qrcode",
  {
    id: serial("id").primaryKey(),
    thirdType: varchar("third_type", { length: 32 }).default("").notNull(),
    thirdId: integer("third_id").default(0).notNull(),
    ticket: varchar("ticket", { length: 255 }).default("").notNull(),
    expireSeconds: integer("expire_seconds").default(0).notNull(),
    status: smallint("status").default(1).notNull(),
    /** The PHP install schema declares this epoch value as varchar(255). */
    addTime: varchar("add_time", { length: 255 }).default("0").notNull(),
    url: varchar("url", { length: 255 }).default("").notNull(),
    qrcodeUrl: varchar("qrcode_url", { length: 255 }).default("").notNull(),
    scan: integer("scan").default(0).notNull(),
    type: smallint("type").default(0).notNull(),
  },
  (table) => [
    uniqueIndex("qrcode_third_type_third_id_uq").on(table.thirdType, table.thirdId),
    index("qrcode_status_type").on(table.status, table.type, table.id),
  ],
);

/** Official-account channel codes. Reply payloads remain source-shaped JSON text. */
export const wechatQrcode = pgTable(
  "wechat_qrcode",
  {
    id: serial("id").primaryKey(),
    uid: integer("uid").default(0).notNull(),
    name: varchar("name", { length: 255 }).default("").notNull(),
    image: varchar("image", { length: 500 }).default("").notNull(),
    cateId: integer("cate_id").default(0).notNull(),
    labelId: varchar("label_id", { length: 32 }).default("").notNull(),
    type: varchar("type", { length: 32 }).default("").notNull(),
    content: text("content"),
    data: text("data"),
    follow: integer("follow").default(0).notNull(),
    scan: integer("scan").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
    continueTime: integer("continue_time").default(0).notNull(),
    endTime: integer("end_time").default(0).notNull(),
    status: smallint("status").default(1).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
  },
  (table) => [
    index("wechat_qrcode_cate_active").on(table.cateId, table.isDel, table.id),
    index("wechat_qrcode_status_end_time").on(table.status, table.endTime, table.id),
    index("wechat_qrcode_uid").on(table.uid, table.id),
  ],
);

/** Source-shaped channel-code categories. */
export const wechatQrcodeCate = pgTable(
  "wechat_qrcode_cate",
  {
    id: serial("id").primaryKey(),
    cateName: varchar("cate_name", { length: 255 }).default("").notNull(),
    addTime: integer("add_time").default(0).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
  },
  (table) => [index("wechat_qrcode_cate_is_del").on(table.isDel, table.id)],
);

/** Historical channel-code scans. Duplicate users and events remain importable. */
export const wechatQrcodeRecord = pgTable(
  "wechat_qrcode_record",
  {
    id: serial("id").primaryKey(),
    qid: integer("qid").default(0).notNull(),
    uid: integer("uid").default(0).notNull(),
    isFollow: smallint("is_follow").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (table) => [
    index("wechat_qrcode_record_qid_time").on(table.qid, table.addTime, table.id),
    index("wechat_qrcode_record_qid_uid").on(table.qid, table.uid, table.id),
    index("wechat_qrcode_record_qid_follow_time").on(
      table.qid,
      table.isFollow,
      table.addTime,
      table.id,
    ),
  ],
);
