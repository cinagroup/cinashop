-- M6 微信用户表迁移
-- 对应 eb_wechat_user

CREATE TABLE IF NOT EXISTS "wechat_user" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "unionid" VARCHAR(30) DEFAULT '' NOT NULL,
  "openid" VARCHAR(100) DEFAULT '' NOT NULL,
  "nickname" VARCHAR(64) DEFAULT '' NOT NULL,
  "headimgurl" VARCHAR(256) DEFAULT '' NOT NULL,
  "sex" SMALLINT DEFAULT 0 NOT NULL,
  "city" VARCHAR(64) DEFAULT '' NOT NULL,
  "language" VARCHAR(64) DEFAULT '' NOT NULL,
  "province" VARCHAR(64) DEFAULT '' NOT NULL,
  "country" VARCHAR(64) DEFAULT '' NOT NULL,
  "remark" VARCHAR(256) DEFAULT '' NOT NULL,
  "groupid" SMALLINT DEFAULT 0 NOT NULL,
  "tagid_list" VARCHAR(256) DEFAULT '' NOT NULL,
  "subscribe" SMALLINT DEFAULT 1 NOT NULL,
  "subscribe_time" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "second" INTEGER DEFAULT 0 NOT NULL,
  "user_type" VARCHAR(32) DEFAULT 'wechat' NOT NULL,
  "is_complete" SMALLINT DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "wu_openid_uq_idx" ON "wechat_user" ("openid");
CREATE INDEX IF NOT EXISTS "wu_unionid_idx" ON "wechat_user" ("unionid");
CREATE INDEX IF NOT EXISTS "wu_uid_idx" ON "wechat_user" ("uid");
