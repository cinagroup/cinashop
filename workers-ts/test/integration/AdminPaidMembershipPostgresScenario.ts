import { sql } from "drizzle-orm";
import { createContainerFromDb, createDbFromConnectionString, withTx, type Container, type DbClient } from "../../src/lib/di";
import { AdminPaidMembershipService } from "../../src/services/user/AdminPaidMembershipService";

const MEMBERSHIP_AUDIT_DDL = `
CREATE TABLE member_card_batch (
  id SERIAL PRIMARY KEY,
  title VARCHAR(100) DEFAULT '0' NOT NULL,
  total_num INTEGER DEFAULT 0 NOT NULL,
  use_start_time INTEGER DEFAULT 7 NOT NULL,
  use_end_time INTEGER DEFAULT 0 NOT NULL,
  use_day INTEGER DEFAULT 0 NOT NULL,
  use_num INTEGER DEFAULT 0 NOT NULL,
  status SMALLINT DEFAULT 0 NOT NULL,
  sort INTEGER DEFAULT 0 NOT NULL,
  qrcode VARCHAR(255) DEFAULT '' NOT NULL,
  remark VARCHAR(512) DEFAULT '' NOT NULL,
  add_time INTEGER DEFAULT 0 NOT NULL,
  update_time INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX member_card_batch_status_sort ON member_card_batch (status, sort, id);

CREATE TABLE member_card (
  id SERIAL NOT NULL,
  card_batch_id INTEGER DEFAULT 0 NOT NULL,
  card_number VARCHAR(20) DEFAULT '' NOT NULL,
  card_password CHAR(12) DEFAULT '' NOT NULL,
  use_uid INTEGER DEFAULT 0 NOT NULL,
  use_time INTEGER DEFAULT 0 NOT NULL,
  status SMALLINT DEFAULT 0 NOT NULL,
  add_time INTEGER DEFAULT 0 NOT NULL,
  update_time INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT member_card_pk PRIMARY KEY (id, card_batch_id)
);
CREATE INDEX member_card_number_lookup ON member_card (card_number);
CREATE INDEX member_card_batch_status_use ON member_card (card_batch_id, status, use_time, id);
CREATE INDEX member_card_user_use ON member_card (use_uid, use_time, id);

CREATE TABLE member_ship (
  id SERIAL PRIMARY KEY,
  type VARCHAR(20) DEFAULT 'month' NOT NULL,
  title VARCHAR(200) DEFAULT '' NOT NULL,
  vip_day INTEGER DEFAULT 0 NOT NULL,
  price NUMERIC(12,2) DEFAULT 0.00 NOT NULL,
  pre_price NUMERIC(12,2) DEFAULT 0.00 NOT NULL,
  is_label SMALLINT DEFAULT 0 NOT NULL,
  sort INTEGER DEFAULT 0 NOT NULL,
  is_del SMALLINT DEFAULT 0 NOT NULL,
  add_time INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX member_ship_active_sort ON member_ship (is_del, sort, id);
CREATE INDEX member_ship_type ON member_ship (type, is_del);

CREATE TABLE member_right (
  id SERIAL PRIMARY KEY,
  right_type VARCHAR(100) DEFAULT '' NOT NULL,
  title VARCHAR(200) DEFAULT '' NOT NULL,
  show_title VARCHAR(255) DEFAULT '' NOT NULL,
  image VARCHAR(200) DEFAULT '' NOT NULL,
  explain VARCHAR(1024) DEFAULT '' NOT NULL,
  content TEXT,
  number INTEGER DEFAULT 1 NOT NULL,
  sort INTEGER DEFAULT 0 NOT NULL,
  status SMALLINT DEFAULT 1 NOT NULL,
  add_time INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT mr_number_ck CHECK (number >= 0)
);
CREATE INDEX mr_right_type ON member_right (right_type);

CREATE TABLE agreement (
  id SERIAL PRIMARY KEY,
  type SMALLINT DEFAULT 0 NOT NULL,
  title VARCHAR(200) DEFAULT '' NOT NULL,
  content TEXT,
  sort INTEGER DEFAULT 0 NOT NULL,
  status SMALLINT DEFAULT 1 NOT NULL,
  add_time INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT agreement_type UNIQUE (type)
);
CREATE INDEX agreement_visible ON agreement (status, sort);

CREATE TABLE "user" (
  uid SERIAL PRIMARY KEY,
  nickname VARCHAR(60) DEFAULT '' NOT NULL,
  real_name VARCHAR(25) DEFAULT '' NOT NULL,
  phone VARCHAR(15) DEFAULT '' NOT NULL
);

CREATE TABLE other_order (
  id SERIAL PRIMARY KEY,
  store_id INTEGER DEFAULT 0 NOT NULL,
  staff_id INTEGER DEFAULT 0 NOT NULL,
  uid INTEGER DEFAULT 0 NOT NULL,
  type SMALLINT DEFAULT 0 NOT NULL,
  order_id VARCHAR(32) DEFAULT '' NOT NULL,
  member_type VARCHAR(10) DEFAULT '' NOT NULL,
  code VARCHAR(20) DEFAULT '' NOT NULL,
  pay_type VARCHAR(32) DEFAULT '' NOT NULL,
  paid SMALLINT DEFAULT 0 NOT NULL,
  pay_price NUMERIC(10,2) DEFAULT 0.00 NOT NULL,
  member_price NUMERIC(10,2) DEFAULT 0.00 NOT NULL,
  pay_time INTEGER DEFAULT 0 NOT NULL,
  trade_no VARCHAR(50) DEFAULT '' NOT NULL,
  channel_type VARCHAR(10) DEFAULT '' NOT NULL,
  is_free SMALLINT DEFAULT 0 NOT NULL,
  is_permanent SMALLINT DEFAULT 0 NOT NULL,
  overdue_time INTEGER DEFAULT 0 NOT NULL,
  is_del SMALLINT DEFAULT 0 NOT NULL,
  vip_day INTEGER DEFAULT 0 NOT NULL,
  add_time INTEGER DEFAULT 0 NOT NULL,
  money NUMERIC(12,2) DEFAULT 0.00 NOT NULL,
  remarks VARCHAR(255) DEFAULT '' NOT NULL
);
CREATE INDEX other_order_order_id ON other_order (order_id);
CREATE INDEX other_order_uid_time ON other_order (uid, add_time, id);
CREATE INDEX other_order_paid_time ON other_order (paid, pay_time, id);
CREATE INDEX other_order_type_paid ON other_order (type, paid, id);

CREATE TABLE audit_public_snapshot (
  position VARCHAR(8) PRIMARY KEY,
  snapshot JSONB NOT NULL
);
CREATE TABLE audit_result (
  id SMALLINT PRIMARY KEY,
  audit_key VARCHAR(32) NOT NULL,
  result JSONB NOT NULL,
  completed_at INTEGER NOT NULL
);
`;

export interface MembershipPublicSnapshot {
  member_card_batch_count: string;
  member_card_count: string;
  member_ship_count: string;
  member_right_count: string;
  agreement_count: string;
  other_order_count: string;
  member_card_batch_sequence: string;
  member_card_sequence: string;
  member_ship_sequence: string;
  member_right_sequence: string;
  agreement_sequence: string;
  other_order_sequence: string;
}

interface MembershipAuditResult {
  batch_count: number;
  card_count: number;
  issued_secret_count: number;
  issued_card_numbers_unique: boolean;
  issued_card_format_valid: boolean;
  issued_password_format_valid: boolean;
  card_list_omits_password: boolean;
  batch_status_propagated: boolean;
  used_counter_consistent: boolean;
  used_card_joined_user: boolean;
  plan_count: number;
  free_plan_price_zeroed: boolean;
  right_count: number;
  right_content_saved: boolean;
  agreement_saved: boolean;
  record_count: number;
  record_code_masked: boolean;
}

export function assertMembershipAuditSchema(value: string): string {
  if (!/^codex_member_[a-z0-9_]{8,40}$/.test(value) || value.length > 63) {
    throw new Error("unsafe paid-membership audit schema name");
  }
  return value;
}

function assertAuditKey(value: string): string {
  if (!/^member-[a-z0-9]{10,24}$/.test(value) || value.length > 32) {
    throw new Error("invalid paid-membership audit key");
  }
  return value;
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Paid-membership audit failed: ${message}`);
}

export function createMembershipAuditContainer(connectionString: string, schemaValue: string): Container {
  return createContainerFromDb(createDbFromConnectionString(connectionString, 1, {
    searchPath: assertMembershipAuditSchema(schemaValue),
    applicationName: "cinashop_member_audit",
  }));
}

async function publicSnapshot(db: DbClient): Promise<MembershipPublicSnapshot> {
  const rows = await db.$client.unsafe<Array<{ snapshot: MembershipPublicSnapshot }>>(`
    SELECT jsonb_build_object(
      'member_card_batch_count', (SELECT count(*)::text FROM public.member_card_batch),
      'member_card_count', (SELECT count(*)::text FROM public.member_card),
      'member_ship_count', (SELECT count(*)::text FROM public.member_ship),
      'member_right_count', (SELECT count(*)::text FROM public.member_right),
      'agreement_count', (SELECT count(*)::text FROM public.agreement),
      'other_order_count', (SELECT count(*)::text FROM public.other_order),
      'member_card_batch_sequence', (SELECT last_value::text FROM public.member_card_batch_id_seq),
      'member_card_sequence', (SELECT last_value::text FROM public.member_card_id_seq),
      'member_ship_sequence', (SELECT last_value::text FROM public.member_ship_id_seq),
      'member_right_sequence', (SELECT last_value::text FROM public.member_right_id_seq),
      'agreement_sequence', (SELECT last_value::text FROM public.agreement_id_seq),
      'other_order_sequence', (SELECT last_value::text FROM public.other_order_id_seq)
    ) AS snapshot
  `);
  if (!rows[0]) throw new Error("could not capture public paid-membership snapshot");
  return rows[0].snapshot;
}

async function publicMarkerCount(db: DbClient, auditKey: string): Promise<number> {
  const rows = await db.$client.unsafe<Array<{ marker_count: number }>>(`
    SELECT (
      (SELECT count(*) FROM public.member_card_batch WHERE title = $1) +
      (SELECT count(*) FROM public.member_ship WHERE title LIKE $1 || '%') +
      (SELECT count(*) FROM public.member_right WHERE title LIKE $1 || '%') +
      (SELECT count(*) FROM public.agreement WHERE title LIKE $1 || '%') +
      (SELECT count(*) FROM public.other_order WHERE order_id = $1) +
      (SELECT count(*) FROM public."user" WHERE nickname = $1)
    )::int AS marker_count
  `, [auditKey]);
  return rows[0]?.marker_count ?? -1;
}

async function withAuditService<T>(container: Container, callback: (service: AdminPaidMembershipService, tx: DbClient) => Promise<T>): Promise<T> {
  return withTx(container, async (tx) => callback(
    new AdminPaidMembershipService(createContainerFromDb(tx)),
    tx,
  ));
}

export async function setupMembershipAudit(connectionString: string, schemaValue: string, auditKeyValue: string) {
  const schema = assertMembershipAuditSchema(schemaValue);
  const auditKey = assertAuditKey(auditKeyValue);
  const adminDb = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_member_setup",
  });
  try {
    const existing = await adminDb.$client.unsafe<Array<{ schema_exists: boolean }>>(
      "SELECT to_regnamespace($1) IS NOT NULL AS schema_exists",
      [schema],
    );
    if (existing[0]?.schema_exists) throw new Error("paid-membership audit schema already exists");
    const [before, markerCount] = await Promise.all([
      publicSnapshot(adminDb),
      publicMarkerCount(adminDb, auditKey),
    ]);
    assertCondition(markerCount === 0, "audit marker already exists in public tables");
    await adminDb.$client.unsafe(`CREATE SCHEMA "${schema}"`);
    const container = createMembershipAuditContainer(connectionString, schema);
    try {
      await withTx(container, async (tx) => {
        await tx.execute(sql.raw(MEMBERSHIP_AUDIT_DDL));
        await tx.execute(sql`
          INSERT INTO audit_public_snapshot (position, snapshot)
          VALUES ('before', ${JSON.stringify(before)}::jsonb)
        `);
      });
    } finally {
      await container.db.$client.end();
    }
    return { schema_created: true, public_marker_count: markerCount, public_before: before };
  } finally {
    await adminDb.$client.end();
  }
}

export async function runMembershipAudit(connectionString: string, schemaValue: string, auditKeyValue: string): Promise<MembershipAuditResult> {
  const schema = assertMembershipAuditSchema(schemaValue);
  const auditKey = assertAuditKey(auditKeyValue);
  const container = createMembershipAuditContainer(connectionString, schema);
  try {
    const result = await withAuditService(container, async (service, tx) => {
      const created = await service.saveBatch(0, {
        title: auditKey,
        total_num: 3,
        use_day: 30,
        status: 1,
        sort: 9,
        remark: "production Hyperdrive isolated audit",
      });
      assertCondition(created.issued_count === 3 && created.cards.length === 3, "card batch did not issue three secrets");
      const numbers = created.cards.map((card) => card.card_number);
      const issuedCardNumbersUnique = new Set(numbers).size === 3;
      const issuedCardFormatValid = numbers.every((value) => /^MC[A-Z0-9]{18}$/.test(value));
      const issuedPasswordFormatValid = created.cards.every((card) => /^[A-HJ-NP-Z2-9]{12}$/.test(card.card_password));

      const batchesBeforeUse = await service.batches({ page: 1, limit: 20, title: auditKey });
      const cardsBeforeUse = await service.cards(created.id, { page: 1, limit: 20 });
      assertCondition(cardsBeforeUse.list.length === 3, "card list count differs from issued count");
      const cardListOmitsPassword = cardsBeforeUse.list.every((card) => !("card_password" in card));

      await service.setBatchValue(created.id, { field: "status", value: 0 });
      const disabledCards = await service.cards(created.id, { page: 1, limit: 20, status: 0 });
      const batchStatusPropagated = disabledCards.list.length === 3;
      await service.setBatchValue(created.id, { field: "status", value: 1 });

      const firstCard = cardsBeforeUse.list[0];
      assertCondition(firstCard, "issued card list is empty");
      await service.setCardStatus({ card_id: firstCard.id, card_batch_id: created.id, status: 1 });

      await tx.execute(sql`
        INSERT INTO "user" (uid, nickname, real_name, phone)
        VALUES (2000000001, ${auditKey}, 'Audit User', '13800138000')
      `);
      const usedAt = Math.floor(Date.now() / 1_000);
      await tx.execute(sql`
        UPDATE member_card
        SET use_uid = 2000000001, use_time = ${usedAt}, update_time = ${usedAt}
        WHERE id = ${firstCard.id} AND card_batch_id = ${created.id}
      `);
      await tx.execute(sql`
        UPDATE member_card_batch SET use_num = 1, update_time = ${usedAt} WHERE id = ${created.id}
      `);
      const usedCards = await service.cards(created.id, { page: 1, limit: 20, is_use: 1 });
      const batchesAfterUse = await service.batches({ page: 1, limit: 20, title: auditKey });

      const paidPlan = await service.savePlan(0, {
        type: "year",
        title: `${auditKey}-year`,
        vip_day: 365,
        price: "199.00",
        pre_price: "99.00",
        is_label: 1,
        sort: 10,
      });
      await service.savePlan(0, {
        type: "free",
        title: `${auditKey}-free`,
        vip_day: 30,
        price: "88.00",
        pre_price: "188.00",
        is_label: 0,
        sort: 1,
      });
      const plans = await service.plans({ page: 1, limit: 20 });
      const freePlan = plans.list.find((plan) => plan.type === "free");

      const right = await service.saveRight(0, {
        right_type: `audit_${auditKey.replace(/-/g, "_")}`,
        title: `${auditKey}-right`,
        show_title: "Audit right",
        explain: "isolated production Hyperdrive verification",
        number: 2,
        sort: 5,
        status: 1,
      });
      await service.saveRightContent(right.id, { content: `<p>${auditKey}-content</p>` });
      const rights = await service.rights();
      const savedRight = rights.list.find((item) => item.id === right.id);

      await service.saveAgreement({
        title: `${auditKey}-agreement`,
        content: `<p>${auditKey}-agreement-content</p>`,
        status: 1,
        sort: 3,
      });
      const agreement = await service.membershipAgreement();

      await tx.execute(sql`
        INSERT INTO other_order (
          uid, type, order_id, member_type, code, pay_type, paid, pay_price,
          member_price, pay_time, channel_type, vip_day, add_time
        ) VALUES (
          2000000001, 1, ${auditKey}, ${String(paidPlan.id)}, ${numbers[0]}, 'weixin', 1,
          99.00, 99.00, ${usedAt}, 'wechat', 365, ${usedAt}
        )
      `);
      const records = await service.records({ page: 1, limit: 20, name: auditKey });
      const record = records.list[0];

      const sanitized: MembershipAuditResult = {
        batch_count: batchesBeforeUse.count,
        card_count: cardsBeforeUse.count,
        issued_secret_count: created.issued_count,
        issued_card_numbers_unique: issuedCardNumbersUnique,
        issued_card_format_valid: issuedCardFormatValid,
        issued_password_format_valid: issuedPasswordFormatValid,
        card_list_omits_password: cardListOmitsPassword,
        batch_status_propagated: batchStatusPropagated,
        used_counter_consistent: batchesAfterUse.list[0]?.counter_drift === false,
        used_card_joined_user: usedCards.list[0]?.username === "Audit User" && usedCards.list[0]?.phone === "13800138000",
        plan_count: plans.count,
        free_plan_price_zeroed: freePlan?.price === "0.00" && freePlan.pre_price === "0.00",
        right_count: rights.count,
        right_content_saved: savedRight?.content === `<p>${auditKey}-content</p>`,
        agreement_saved: agreement?.title === `${auditKey}-agreement`,
        record_count: records.count,
        record_code_masked: Boolean(record?.code_masked && record.code_masked !== numbers[0] && !record.code_masked.includes(numbers[0])),
      };
      await tx.execute(sql`
        INSERT INTO audit_result (id, audit_key, result, completed_at)
        VALUES (1, ${auditKey}, ${JSON.stringify(sanitized)}::jsonb, ${usedAt})
      `);
      return sanitized;
    });
    return result;
  } finally {
    await container.db.$client.end();
  }
}

export async function verifyMembershipAudit(connectionString: string, schemaValue: string, auditKeyValue: string) {
  const schema = assertMembershipAuditSchema(schemaValue);
  const auditKey = assertAuditKey(auditKeyValue);
  const container = createMembershipAuditContainer(connectionString, schema);
  const adminDb = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_member_verify",
  });
  try {
    const [stored, isolatedCounts, before, after, markerCount] = await Promise.all([
      withTx(container, async (tx) => tx.execute(sql`
        SELECT audit_key, result, completed_at FROM audit_result WHERE id = 1
      `) as unknown as Array<{ audit_key: string; result: MembershipAuditResult; completed_at: number }>),
      withTx(container, async (tx) => tx.execute(sql`
        SELECT
          (SELECT count(*)::int FROM member_card_batch) AS batches,
          (SELECT count(*)::int FROM member_card) AS cards,
          (SELECT count(*)::int FROM member_ship) AS plans,
          (SELECT count(*)::int FROM member_right) AS rights,
          (SELECT count(*)::int FROM agreement) AS agreements,
          (SELECT count(*)::int FROM other_order) AS records
      `) as unknown as Array<{ batches: number; cards: number; plans: number; rights: number; agreements: number; records: number }>),
      withTx(container, async (tx) => tx.execute(sql`
        SELECT snapshot FROM audit_public_snapshot WHERE position = 'before'
      `) as unknown as Array<{ snapshot: MembershipPublicSnapshot }>),
      publicSnapshot(adminDb),
      publicMarkerCount(adminDb, auditKey),
    ]);
    const result = stored[0]?.result;
    const counts = isolatedCounts[0];
    assertCondition(stored[0]?.audit_key === auditKey, "stored result belongs to another audit");
    assertCondition(result, "sanitized audit result is missing");
    assertCondition(counts?.batches === 1 && counts.cards === 3, "isolated card inventory counts are wrong");
    assertCondition(counts.plans === 2 && counts.rights === 1 && counts.agreements === 1 && counts.records === 1, "isolated membership operation counts are wrong");
    for (const [key, value] of Object.entries(result)) {
      if (typeof value === "boolean") assertCondition(value, `${key} is false`);
    }
    assertCondition(result.batch_count === 1 && result.card_count === 3 && result.issued_secret_count === 3, "batch/card summary is wrong");
    assertCondition(result.plan_count === 2 && result.right_count === 1 && result.record_count === 1, "plan/right/record summary is wrong");
    assertCondition(markerCount === 0, "audit marker leaked into public tables");
    return {
      verified: true,
      result,
      isolated_counts: counts,
      public_marker_count: markerCount,
      public_snapshot_unchanged: JSON.stringify(before[0]?.snapshot) === JSON.stringify(after),
      public_before: before[0]?.snapshot,
      public_after: after,
    };
  } finally {
    await Promise.all([container.db.$client.end(), adminDb.$client.end()]);
  }
}

export async function cleanupMembershipAudit(connectionString: string, schemaValue: string, auditKeyValue: string) {
  const schema = assertMembershipAuditSchema(schemaValue);
  const auditKey = assertAuditKey(auditKeyValue);
  const adminDb = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_member_cleanup",
  });
  try {
    const markerCount = await publicMarkerCount(adminDb, auditKey);
    await adminDb.$client.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    const removed = await adminDb.$client.unsafe<Array<{ schema_removed: boolean }>>(
      "SELECT to_regnamespace($1) IS NULL AS schema_removed",
      [schema],
    );
    assertCondition(removed[0]?.schema_removed, "isolated schema was not removed");
    assertCondition(markerCount === 0, "audit marker exists in public tables after cleanup");
    return { schema_removed: true, public_marker_count: markerCount };
  } finally {
    await adminDb.$client.end();
  }
}
