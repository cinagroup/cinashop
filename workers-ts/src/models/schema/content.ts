import { index, integer, pgTable, serial, smallint, text, uniqueIndex, varchar } from "drizzle-orm/pg-core";

export const systemArticle = pgTable(
  "system_article",
  {
    id: serial("id").primaryKey(),
    cid: integer("cid").default(0).notNull(),
    title: varchar("title", { length: 255 }).default("").notNull(),
    author: varchar("author", { length: 255 }).default("").notNull(),
    content: text("content").default(""),
    synopsis: varchar("synopsis", { length: 500 }).default("").notNull(),
    status: smallint("status").default(1).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
    imageInput: varchar("image_input", { length: 255 }).default("").notNull(),
    shareTitle: varchar("share_title", { length: 255 }).default("").notNull(),
    shareSynopsis: varchar("share_synopsis", { length: 255 }).default("").notNull(),
    visit: integer("visit").default(0).notNull(),
    likes: integer("likes").default(0).notNull(),
    sort: integer("sort").default(0).notNull(),
    url: varchar("url", { length: 255 }).default("").notNull(),
    hide: smallint("hide").default(0).notNull(),
    adminId: integer("admin_id").default(0).notNull(),
    merId: integer("mer_id").default(0).notNull(),
    productId: integer("product_id").default(0).notNull(),
    isHot: smallint("is_hot").default(0).notNull(),
    isBanner: smallint("is_banner").default(0).notNull(),
  },
  (t) => [index("sa_visible_sort").on(t.status, t.isDel, t.hide, t.sort)],
);

export const articleCategory = pgTable(
  "article_category",
  {
    id: serial("id").primaryKey(),
    pid: integer("pid").default(0).notNull(),
    title: varchar("title", { length: 255 }).default("").notNull(),
    intr: varchar("intr", { length: 255 }).default("").notNull(),
    image: varchar("image", { length: 255 }).default("").notNull(),
    status: smallint("status").default(1).notNull(),
    sort: integer("sort").default(0).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
    hidden: smallint("hidden").default(0).notNull(),
  },
  (t) => [index("ac_visible_sort").on(t.status, t.isDel, t.hidden, t.sort)],
);

/** Original PHP article body table, retained for lossless import and fallback reads. */
export const articleContent = pgTable("article_content", {
  nid: integer("nid").primaryKey(),
  content: text("content"),
});

/** Legacy DIY pages, renamed by the TypeScript admin UI. */
export const systemDise = pgTable(
  "system_dise",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 255 }).default("").notNull(),
    title: varchar("title", { length: 255 }).default("").notNull(),
    content: text("content").default(""),
    value: text("value").default(""),
    type: smallint("type").default(0).notNull(),
    status: smallint("status").default(1).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
    templateName: varchar("template_name", { length: 255 }).default("").notNull(),
    version: varchar("version", { length: 255 }).default("").notNull(),
    coverImage: varchar("cover_image", { length: 255 }).default("").notNull(),
    defaultValue: text("default_value"),
    isDiy: smallint("is_diy").default(0).notNull(),
    isShow: smallint("is_show").default(0).notNull(),
    isBgColor: smallint("is_bg_color").default(0).notNull(),
    isBgPic: smallint("is_bg_pic").default(0).notNull(),
    colorPicker: varchar("color_picker", { length: 50 }).default("").notNull(),
    bgPic: varchar("bg_pic", { length: 256 }).default("").notNull(),
    bgTabVal: smallint("bg_tab_val").default(0).notNull(),
    orderStatus: smallint("order_status").default(0).notNull(),
    myBannerStatus: smallint("my_banner_status").default(1).notNull(),
    menuStatus: smallint("menu_status").default(1).notNull(),
    serviceStatus: smallint("service_status").default(1).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
  },
  (t) => [
    index("sd_template_type").on(t.templateName, t.type),
    index("sd_status_type").on(t.status, t.type),
  ],
);

export const agreement = pgTable(
  "agreement",
  {
    id: serial("id").primaryKey(),
    type: smallint("type").default(0).notNull(),
    title: varchar("title", { length: 200 }).default("").notNull(),
    content: text("content"),
    sort: integer("sort").default(0).notNull(),
    status: smallint("status").default(1).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    uniqueIndex("agreement_type").on(t.type),
    index("agreement_visible").on(t.status, t.sort),
  ],
);
