-- Preserve PHP coupon ownership semantics while keeping the Worker coupon-type
-- snapshot separate. The legacy type value is an acquisition source such as
-- get or send, not the numeric coupon type stored by the Worker.
ALTER TABLE "store_coupon_user"
  ADD COLUMN IF NOT EXISTS "receive_source" VARCHAR(32) DEFAULT 'send' NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_fail" SMALLINT DEFAULT 0 NOT NULL;

CREATE INDEX IF NOT EXISTS "scu_uid_issue"
  ON "store_coupon_user" ("uid", "issue_coupon_id");
