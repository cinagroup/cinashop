import { sql } from "drizzle-orm";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  withTx,
  type Container,
  type DbClient,
} from "../../src/lib/di";
import {
  deliverPaidVirtualOrders,
  parseVirtualDeliveryInfo,
  type VirtualDeliveryOrder,
} from "../../src/services/order/VirtualProductDeliveryService";

const DDL = `
CREATE TABLE store_order (
  id INTEGER PRIMARY KEY,
  order_id VARCHAR(32) DEFAULT '0' NOT NULL,
  uid INTEGER DEFAULT 0 NOT NULL,
  paid SMALLINT DEFAULT 0 NOT NULL,
  status SMALLINT DEFAULT 0 NOT NULL,
  is_del SMALLINT DEFAULT 0 NOT NULL,
  is_system_del SMALLINT DEFAULT 0 NOT NULL,
  product_type SMALLINT DEFAULT 0 NOT NULL,
  delivery_type VARCHAR(32) DEFAULT '' NOT NULL,
  fictitious_content VARCHAR(500) DEFAULT '' NOT NULL,
  virtual_info TEXT
);
CREATE TABLE store_order_cart_info (
  id INTEGER PRIMARY KEY,
  oid INTEGER DEFAULT 0 NOT NULL,
  product_id INTEGER DEFAULT 0 NOT NULL,
  product_type SMALLINT DEFAULT 0 NOT NULL,
  sku_unique VARCHAR(255) DEFAULT '' NOT NULL,
  cart_num INTEGER DEFAULT 0 NOT NULL
);
CREATE TABLE store_product_attr_value (
  id INTEGER PRIMARY KEY,
  product_id INTEGER DEFAULT 0 NOT NULL,
  type SMALLINT DEFAULT 0 NOT NULL,
  "unique" CHAR(8) DEFAULT '' NOT NULL,
  disk_info TEXT
);
CREATE TABLE store_product_virtual (
  id INTEGER PRIMARY KEY,
  product_id INTEGER DEFAULT 0 NOT NULL,
  attr_unique VARCHAR(20) DEFAULT '' NOT NULL,
  card_no VARCHAR(255) DEFAULT '' NOT NULL,
  card_pwd VARCHAR(255) DEFAULT '' NOT NULL,
  order_id VARCHAR(255) DEFAULT '' NOT NULL,
  order_type SMALLINT DEFAULT 1 NOT NULL,
  uid INTEGER DEFAULT 0 NOT NULL
);
CREATE TABLE store_order_status (
  id SERIAL PRIMARY KEY,
  oid INTEGER DEFAULT 0 NOT NULL,
  change_type VARCHAR(32) DEFAULT '' NOT NULL,
  change_message VARCHAR(256) DEFAULT '' NOT NULL,
  change_time INTEGER DEFAULT 0 NOT NULL
);
CREATE TABLE audit_public_snapshot (position VARCHAR(8) PRIMARY KEY, snapshot JSONB NOT NULL);
CREATE TABLE audit_result (id SMALLINT PRIMARY KEY, audit_key VARCHAR(32) NOT NULL, result JSONB NOT NULL);
`;

interface PublicSnapshot {
  order_count: string;
  cart_count: string;
  sku_count: string;
  card_count: string;
  status_count: string;
  order_sequence: string;
  cart_sequence: string;
  sku_sequence: string;
  card_sequence: string;
  status_sequence: string;
}

export interface VirtualProductDeliveryAuditResult {
  concurrent_single_winner: boolean;
  concurrent_no_duplicate_card: boolean;
  concurrent_loser_retryable: boolean;
  concurrent_retry_completed: boolean;
  replay_idempotent: boolean;
  partial_claim_rolled_back: boolean;
  partial_claim_retry_completed: boolean;
  disk_info_delivered_without_card: boolean;
  delivery_status_evidence_exact: boolean;
  assigned_card_count: number;
}

function schemaName(value: string): string {
  if (!/^codex_virtual_delivery_[a-z0-9_]{8,32}$/.test(value) || value.length > 63) {
    throw new Error("unsafe virtual-delivery audit schema name");
  }
  return value;
}

function auditKey(value: string): string {
  if (!/^vdel-[a-z0-9]{10,20}$/.test(value)) throw new Error("invalid virtual-delivery audit key");
  return value;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Virtual-delivery audit failed: ${message}`);
}

function container(connectionString: string, schema: string, applicationName: string): Container {
  return createContainerFromDb(createDbFromConnectionString(connectionString, 2, {
    searchPath: schemaName(schema),
    applicationName,
  }));
}

async function publicSnapshot(db: DbClient): Promise<PublicSnapshot> {
  const rows = await db.$client.unsafe<Array<{ snapshot: PublicSnapshot }>>(`
    SELECT jsonb_build_object(
      'order_count', (SELECT count(*)::text FROM public.store_order),
      'cart_count', (SELECT count(*)::text FROM public.store_order_cart_info),
      'sku_count', (SELECT count(*)::text FROM public.store_product_attr_value),
      'card_count', (SELECT count(*)::text FROM public.store_product_virtual),
      'status_count', (SELECT count(*)::text FROM public.store_order_status),
      'order_sequence', (SELECT last_value::text FROM public.store_order_id_seq),
      'cart_sequence', (SELECT last_value::text FROM public.store_order_cart_info_id_seq),
      'sku_sequence', (SELECT last_value::text FROM public.store_product_attr_value_id_seq),
      'card_sequence', (SELECT last_value::text FROM public.store_product_virtual_id_seq),
      'status_sequence', (SELECT last_value::text FROM public.store_order_status_id_seq)
    ) AS snapshot
  `);
  if (!rows[0]) throw new Error("could not capture public virtual-delivery snapshot");
  return rows[0].snapshot;
}

async function publicMarkerCount(db: DbClient, key: string): Promise<number> {
  const rows = await db.$client.unsafe<Array<{ count: number }>>(`
    SELECT (
      (SELECT count(*) FROM public.store_order WHERE order_id LIKE $1 || '%') +
      (SELECT count(*) FROM public.store_product_virtual WHERE card_no LIKE $1 || '%')
    )::int AS count
  `, [key]);
  return rows[0]?.count ?? -1;
}

function order(id: number, uid: number, orderId: string): VirtualDeliveryOrder {
  return {
    id,
    uid,
    orderId,
    paid: 1,
    status: 0,
    isDel: 0,
    isSystemDel: 0,
    productType: 1,
  };
}

async function deliverOne(
  c: Container,
  deliveryOrder: VirtualDeliveryOrder,
  now: number,
) {
  return withTx(c, (tx) => deliverPaidVirtualOrders(tx, [deliveryOrder], now));
}

export async function setupVirtualProductDeliveryAudit(
  connectionString: string,
  schemaValue: string,
  keyValue: string,
) {
  const schema = schemaName(schemaValue);
  const key = auditKey(keyValue);
  const admin = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_virtual_delivery_setup",
  });
  try {
    const exists = await admin.$client.unsafe<Array<{ exists: boolean }>>(
      "SELECT to_regnamespace($1) IS NOT NULL AS exists",
      [schema],
    );
    if (exists[0]?.exists) throw new Error("virtual-delivery audit schema already exists");
    const [before, marker] = await Promise.all([
      publicSnapshot(admin),
      publicMarkerCount(admin, key),
    ]);
    assert(marker === 0, "public audit marker already exists");
    await admin.$client.unsafe(`CREATE SCHEMA "${schema}"`);
    const scoped = container(connectionString, schema, "cinashop_virtual_delivery_ddl");
    try {
      await withTx(scoped, async (tx) => {
        await tx.execute(sql.raw(DDL));
        await tx.execute(sql`
          INSERT INTO audit_public_snapshot (position, snapshot)
          VALUES ('before', ${JSON.stringify(before)}::jsonb)
        `);
      });
    } finally {
      await scoped.db.$client.end();
    }
    return { schema_created: true, public_marker_count: marker };
  } finally {
    await admin.$client.end();
  }
}

export async function runVirtualProductDeliveryAudit(
  connectionString: string,
  schemaValue: string,
  keyValue: string,
): Promise<VirtualProductDeliveryAuditResult> {
  const schema = schemaName(schemaValue);
  const key = auditKey(keyValue);
  const primary = container(connectionString, schema, "cinashop_virtual_delivery_primary");
  const concurrent = container(connectionString, schema, "cinashop_virtual_delivery_concurrent");
  const now = 1_786_560_000;
  const orders = [
    order(1, 2100000101, `${key}-one`),
    order(2, 2100000102, `${key}-two`),
    order(3, 2100000103, `${key}-rollback`),
    order(4, 2100000104, `${key}-disk`),
  ];
  try {
    await withTx(primary, async (tx) => {
      await tx.execute(sql`
        INSERT INTO store_order (id, order_id, uid, paid, product_type)
        VALUES
          (1, ${orders[0].orderId}, ${orders[0].uid}, 1, 1),
          (2, ${orders[1].orderId}, ${orders[1].uid}, 1, 1),
          (3, ${orders[2].orderId}, ${orders[2].uid}, 1, 1),
          (4, ${orders[3].orderId}, ${orders[3].uid}, 1, 1)
      `);
      await tx.execute(sql`
        INSERT INTO store_order_cart_info (id, oid, product_id, product_type, sku_unique, cart_num)
        VALUES
          (1, 1, 101, 1, 'VIRT0001', 2),
          (2, 2, 101, 1, 'VIRT0001', 2),
          (3, 3, 102, 1, 'VIRT0002', 1),
          (4, 3, 103, 1, 'VIRT0003', 1),
          (5, 4, 104, 1, 'VIRT0004', 3)
      `);
      await tx.execute(sql`
        INSERT INTO store_product_attr_value (id, product_id, type, "unique", disk_info)
        VALUES
          (1, 101, 0, 'VIRT0001', ''),
          (2, 102, 0, 'VIRT0002', ''),
          (3, 103, 0, 'VIRT0003', ''),
          (4, 104, 0, 'VIRT0004', ${`${key}-shared-disk-secret`})
      `);
      await tx.execute(sql`
        INSERT INTO store_product_virtual
          (id, product_id, attr_unique, card_no, card_pwd)
        VALUES
          (1, 101, 'VIRT0001', ${`${key}-card-1`}, 'pwd-1'),
          (2, 101, 'VIRT0001', ${`${key}-card-2`}, 'pwd-2'),
          (3, 101, 'VIRT0001', ${`${key}-card-3`}, 'pwd-3'),
          (5, 102, 'VIRT0002', ${`${key}-rollback-a`}, 'pwd-a')
      `);
    });

    const race = await Promise.allSettled([
      deliverOne(primary, orders[0], now),
      deliverOne(concurrent, orders[1], now),
    ]);
    const winnerIndex = race.findIndex((entry) => entry.status === "fulfilled");
    assert(winnerIndex >= 0, "concurrent delivery produced no winner");
    const loserIndex = winnerIndex === 0 ? 1 : 0;
    const afterRace = await withTx(primary, async (tx) => tx.execute(sql`
      SELECT
        (SELECT count(*)::int FROM store_product_virtual WHERE uid > 0) AS assigned,
        (SELECT count(DISTINCT order_id)::int FROM store_product_virtual WHERE uid > 0) AS assigned_orders,
        (SELECT count(*)::int FROM store_product_virtual WHERE uid = 0) AS available,
        (SELECT count(*)::int FROM store_order WHERE status = 1 AND delivery_type = 'fictitious') AS delivered_orders,
        (SELECT count(*)::int FROM store_order_status WHERE change_type = 'delivery_fictitious') AS statuses
    `) as unknown as Array<{
      assigned: number;
      assigned_orders: number;
      available: number;
      delivered_orders: number;
      statuses: number;
    }>);
    const raceState = afterRace[0];
    assert(raceState, "concurrent state missing");

    await withTx(primary, async (tx) => {
      await tx.execute(sql`
        INSERT INTO store_product_virtual
          (id, product_id, attr_unique, card_no, card_pwd)
        VALUES (4, 101, 'VIRT0001', ${`${key}-card-4`}, 'pwd-4')
      `);
    });
    const loserRetry = await deliverOne(primary, orders[loserIndex], now + 1);
    const winnerReplay = await deliverOne(primary, orders[winnerIndex], now + 2);

    let partialRejected = false;
    try {
      await deliverOne(primary, orders[2], now + 3);
    } catch {
      partialRejected = true;
    }
    const afterPartialFailure = await withTx(primary, async (tx) => tx.execute(sql`
      SELECT
        (SELECT uid FROM store_product_virtual WHERE id = 5) AS first_card_uid,
        (SELECT status FROM store_order WHERE id = 3) AS order_status,
        (SELECT count(*)::int FROM store_order_status WHERE oid = 3) AS statuses
    `) as unknown as Array<{ first_card_uid: number; order_status: number; statuses: number }>);
    await withTx(primary, async (tx) => {
      await tx.execute(sql`
        INSERT INTO store_product_virtual
          (id, product_id, attr_unique, card_no, card_pwd)
        VALUES (6, 103, 'VIRT0003', ${`${key}-rollback-b`}, 'pwd-b')
      `);
    });
    const partialRetry = await deliverOne(primary, orders[2], now + 4);
    const diskDelivery = await deliverOne(primary, orders[3], now + 5);

    const finalRows = await withTx(primary, async (tx) => tx.execute(sql`
      SELECT
        (SELECT count(*)::int FROM store_product_virtual WHERE uid > 0) AS assigned_cards,
        (SELECT count(DISTINCT card_no)::int FROM store_product_virtual WHERE uid > 0) AS distinct_cards,
        (SELECT count(*)::int FROM store_order WHERE status = 1 AND delivery_type = 'fictitious') AS delivered_orders,
        (SELECT count(*)::int FROM store_order_status WHERE change_type = 'delivery_fictitious') AS statuses,
        (SELECT virtual_info FROM store_order WHERE id = 4) AS disk_virtual_info
    `) as unknown as Array<{
      assigned_cards: number;
      distinct_cards: number;
      delivered_orders: number;
      statuses: number;
      disk_virtual_info: string;
    }>);
    const final = finalRows[0];
    assert(final, "final virtual-delivery state missing");
    const diskInfo = parseVirtualDeliveryInfo(final.disk_virtual_info);
    const diskValid = Array.isArray(diskInfo)
      && diskInfo.length === 1
      && "disk_info" in diskInfo[0]
      && diskInfo[0].disk_info === `${key}-shared-disk-secret`
      && diskInfo[0].quantity === 3;

    const result: VirtualProductDeliveryAuditResult = {
      concurrent_single_winner:
        race.filter((entry) => entry.status === "fulfilled").length === 1
        && race.filter((entry) => entry.status === "rejected").length === 1,
      concurrent_no_duplicate_card:
        raceState.assigned === 2
        && raceState.assigned_orders === 1
        && raceState.available === 2
        && raceState.delivered_orders === 1
        && raceState.statuses === 1,
      concurrent_loser_retryable: race[loserIndex].status === "rejected",
      concurrent_retry_completed: loserRetry.deliveredOrders === 1 && loserRetry.deliveredCards === 2,
      replay_idempotent: winnerReplay.deliveredOrders === 0 && winnerReplay.deliveredCards === 0,
      partial_claim_rolled_back:
        partialRejected
        && afterPartialFailure[0]?.first_card_uid === 0
        && afterPartialFailure[0]?.order_status === 0
        && afterPartialFailure[0]?.statuses === 0,
      partial_claim_retry_completed: partialRetry.deliveredOrders === 1 && partialRetry.deliveredCards === 2,
      disk_info_delivered_without_card:
        diskDelivery.deliveredOrders === 1 && diskDelivery.deliveredCards === 0 && diskValid,
      delivery_status_evidence_exact: final.delivered_orders === 4 && final.statuses === 4,
      assigned_card_count: final.assigned_cards,
    };
    assert(final.assigned_cards === 6 && final.distinct_cards === 6, "assigned-card totals are wrong");
    await withTx(primary, async (tx) => {
      await tx.execute(sql`
        INSERT INTO audit_result (id, audit_key, result)
        VALUES (1, ${key}, ${JSON.stringify(result)}::jsonb)
      `);
    });
    return result;
  } finally {
    await Promise.all([primary.db.$client.end(), concurrent.db.$client.end()]);
  }
}

export async function verifyVirtualProductDeliveryAudit(
  connectionString: string,
  schemaValue: string,
  keyValue: string,
) {
  const schema = schemaName(schemaValue);
  const key = auditKey(keyValue);
  const scoped = container(connectionString, schema, "cinashop_virtual_delivery_verify");
  const admin = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_virtual_delivery_verify_public",
  });
  try {
    const [stored, counts, before, after, marker] = await Promise.all([
      withTx(scoped, async (tx) => tx.execute(sql`
        SELECT audit_key, result FROM audit_result WHERE id = 1
      `) as unknown as Array<{ audit_key: string; result: VirtualProductDeliveryAuditResult }>),
      withTx(scoped, async (tx) => tx.execute(sql`
        SELECT
          (SELECT count(*)::int FROM store_order) AS orders,
          (SELECT count(*)::int FROM store_order_cart_info) AS carts,
          (SELECT count(*)::int FROM store_product_attr_value) AS skus,
          (SELECT count(*)::int FROM store_product_virtual) AS cards,
          (SELECT count(*)::int FROM store_order_status) AS statuses
      `) as unknown as Array<{ orders: number; carts: number; skus: number; cards: number; statuses: number }>),
      withTx(scoped, async (tx) => tx.execute(sql`
        SELECT snapshot FROM audit_public_snapshot WHERE position = 'before'
      `) as unknown as Array<{ snapshot: PublicSnapshot }>),
      publicSnapshot(admin),
      publicMarkerCount(admin, key),
    ]);
    const result = stored[0]?.result;
    const isolated = counts[0];
    assert(stored[0]?.audit_key === key && result, "stored audit result is missing or mismatched");
    assert(
      isolated?.orders === 4
      && isolated.carts === 5
      && isolated.skus === 4
      && isolated.cards === 6
      && isolated.statuses === 4,
      "isolated evidence counts are wrong",
    );
    for (const [name, value] of Object.entries(result)) {
      if (typeof value === "boolean") assert(value, `${name} is false`);
    }
    assert(result.assigned_card_count === 6, "assigned-card result count is wrong");
    assert(JSON.stringify(before[0]?.snapshot) === JSON.stringify(after), "public counts or sequences changed");
    assert(marker === 0, "audit marker leaked into public tables");
    return {
      result,
      isolated_counts: isolated,
      public_unchanged: true,
      public_marker_count: marker,
    };
  } finally {
    await Promise.all([scoped.db.$client.end(), admin.$client.end()]);
  }
}

export async function cleanupVirtualProductDeliveryAudit(
  connectionString: string,
  schemaValue: string,
  keyValue: string,
) {
  const schema = schemaName(schemaValue);
  const key = auditKey(keyValue);
  const admin = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_virtual_delivery_cleanup",
  });
  try {
    const existsBefore = await admin.$client.unsafe<Array<{ exists: boolean }>>(
      "SELECT to_regnamespace($1) IS NOT NULL AS exists",
      [schema],
    );
    if (!existsBefore[0]?.exists) {
      return {
        schema_removed: true,
        public_unchanged: true,
        public_marker_count: await publicMarkerCount(admin, key),
      };
    }
    const before = await admin.$client.unsafe<Array<{ snapshot: PublicSnapshot }>>(
      `SELECT snapshot FROM "${schema}".audit_public_snapshot WHERE position = 'before'`,
    );
    const after = await publicSnapshot(admin);
    assert(JSON.stringify(before[0]?.snapshot) === JSON.stringify(after), "public state changed before cleanup");
    assert((await publicMarkerCount(admin, key)) === 0, "audit marker exists before cleanup");
    await admin.$client.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
    const exists = await admin.$client.unsafe<Array<{ exists: boolean }>>(
      "SELECT to_regnamespace($1) IS NOT NULL AS exists",
      [schema],
    );
    return {
      schema_removed: exists[0]?.exists === false,
      public_unchanged: true,
      public_marker_count: await publicMarkerCount(admin, key),
    };
  } finally {
    await admin.$client.end();
  }
}
