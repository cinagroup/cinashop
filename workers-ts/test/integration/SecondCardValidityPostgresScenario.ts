import { sql } from "drizzle-orm";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  type DbClient,
  withTx,
} from "@/lib/di";
import { storeOrderCartInfo } from "@/models/schema";
import { activatePaidSecondCardValidity } from "@/services/order/SecondCardValidityService";

const PREFIX = "codex_second_card_validity_";
const TABLE = "store_order_cart_info";
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

function identifier(value: string): string {
  if (!SAFE_IDENTIFIER.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function schemaName(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return PREFIX + [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function publicFingerprint(db: DbClient) {
  const [row] = await db.$client<Array<{
    rows: number;
    digest: string;
    sequence_value: number | null;
    temporary_schemas: number;
  }>>`
    SELECT
      (SELECT count(*)::int FROM public.store_order_cart_info) AS rows,
      (SELECT md5(COALESCE(string_agg(md5(to_jsonb(item)::text), '' ORDER BY item.id), ''))
         FROM public.store_order_cart_info item) AS digest,
      (SELECT last_value::float8 FROM public.store_order_cart_info_id_seq) AS sequence_value,
      (SELECT count(*)::int FROM pg_namespace WHERE nspname LIKE ${`${PREFIX}%`})
        AS temporary_schemas
  `;
  if (!row) throw new Error("public second-card fingerprint unavailable");
  return row;
}

async function productionState(db: DbClient) {
  return db.$client.begin(async (tx) => {
    await tx`SET TRANSACTION READ ONLY`;
    await tx`SET LOCAL search_path TO public, pg_temp`;
    await tx`SET LOCAL statement_timeout TO '10s'`;
    const products = await tx<Array<{
      product_type: number;
      owner_type: number;
      products: number;
      active_skus: number;
      retired_skus: number;
    }>>`
      SELECT p.product_type, p.type AS owner_type,
        count(DISTINCT p.id)::int AS products,
        count(av.id) FILTER (WHERE av.type = 0 AND coalesce(av.is_retired, 0) = 0)::int
          AS active_skus,
        count(av.id) FILTER (WHERE av.type = 0 AND coalesce(av.is_retired, 0) = 1)::int
          AS retired_skus
      FROM public.store_product p
      LEFT JOIN public.store_product_attr_value av ON av.product_id = p.id
      WHERE p.is_del = 0
      GROUP BY p.product_type, p.type
      ORDER BY p.product_type, p.type
    `;
    const [relations] = await tx<Array<{
      branch_products: number;
      branch_skus: number;
      virtual_cards: number;
      second_card_order_lines: number;
      second_card_paid_lines: number;
      second_card_unactivated_paid_lines: number;
    }>>`
      SELECT
        (SELECT count(*)::int FROM public.store_branch_product) AS branch_products,
        (SELECT count(*)::int FROM public.store_branch_product_attr_value) AS branch_skus,
        (SELECT count(*)::int FROM public.store_product_virtual) AS virtual_cards,
        (SELECT count(*)::int FROM public.store_order_cart_info WHERE product_type = 4)
          AS second_card_order_lines,
        (SELECT count(*)::int FROM public.store_order_cart_info cart
          JOIN public.store_order orders ON orders.id = cart.oid
          WHERE cart.product_type = 4 AND orders.paid = 1) AS second_card_paid_lines,
        (SELECT count(*)::int FROM public.store_order_cart_info cart
          JOIN public.store_order orders ON orders.id = cart.oid
          WHERE cart.product_type = 4 AND orders.paid = 1
            AND cart.write_start = 0 AND cart.write_end = 0) AS second_card_unactivated_paid_lines
    `;
    return { products, relations };
  });
}

async function provision(db: DbClient, schema: string): Promise<void> {
  await db.$client.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx`SET LOCAL statement_timeout = '30s'`;
    await tx.unsafe(`CREATE SCHEMA ${identifier(schema)}`);
    await tx.unsafe(
      `CREATE TABLE ${identifier(schema)}.${identifier(TABLE)} `
      + `(LIKE public.${identifier(TABLE)} INCLUDING ALL)`,
    );
  });
}

async function dropSchema(db: DbClient, schema: string): Promise<void> {
  await db.$client.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx`SET LOCAL statement_timeout = '30s'`;
    await tx.unsafe(`DROP SCHEMA IF EXISTS ${identifier(schema)} CASCADE`);
  });
}

function snapshot(writeValid: 1 | 2 | 3, writeDays: number, writeStart: number, writeEnd: number) {
  return JSON.stringify({
    product: { id: 1, storeName: "isolated second-card fixture" },
    sku: {
      id: 1,
      unique: "SCARD001",
      suk: "默认",
      price: "10.00",
      write_valid: writeValid,
      write_days: writeDays,
      write_start: writeStart,
      write_end: writeEnd,
    },
  });
}

export async function runSecondCardValidityPostgresScenario(connectionString: string) {
  const root = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_second_card_validity_root",
  });
  const schema = schemaName();
  const before = await publicFingerprint(root).catch(async (error) => {
    await root.$client.end({ timeout: 1 });
    throw error;
  });
  const production = await productionState(root);
  let isolated: DbClient | undefined;
  let result: Record<string, unknown> | undefined;
  let cleanupSucceeded = false;
  try {
    await provision(root, schema);
    isolated = createDbFromConnectionString(connectionString, 2, {
      searchPath: schema,
      applicationName: "cinashop_second_card_validity_isolated",
    });
    const container = createContainerFromDb(isolated);
    await withTx(container, async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL search_path TO ${identifier(schema)}, pg_temp`));
      await tx.insert(storeOrderCartInfo).values([
        {
          id: 2_000_000_001, uid: 1, oid: 101, cartId: "audit-after-days", productId: 1,
          productType: 4, skuUnique: "SCARD001", cartNum: 1, surplusNum: 1,
          splitSurplusNum: 1, writeTimes: 10, writeSurplusTimes: 10,
          writeStart: 0, writeEnd: 0, cartInfo: snapshot(2, 7, 0, 0), unique: "audit_validity_after_days_1",
        },
        {
          id: 2_000_000_002, uid: 1, oid: 101, cartId: "audit-fixed", productId: 2,
          productType: 4, skuUnique: "SCARD002", cartNum: 1, surplusNum: 1,
          splitSurplusNum: 1, writeTimes: 5, writeSurplusTimes: 5,
          writeStart: 1_700_000_000, writeEnd: 1_900_000_000,
          cartInfo: snapshot(3, 0, 1_700_000_000, 1_900_000_000),
          unique: "audit_validity_fixed_000002",
        },
        {
          id: 2_000_000_003, uid: 1, oid: 102, cartId: "audit-unlimited", productId: 3,
          productType: 4, skuUnique: "SCARD003", cartNum: 1, surplusNum: 1,
          splitSurplusNum: 1, writeTimes: 3, writeSurplusTimes: 3,
          writeStart: 0, writeEnd: 0, cartInfo: snapshot(1, 0, 0, 0),
          unique: "audit_validity_unlimited_003",
        },
        {
          id: 2_000_000_004, uid: 1, oid: 102, cartId: "audit-physical", productId: 4,
          productType: 0, skuUnique: "PHYS0001", cartNum: 1, surplusNum: 1,
          splitSurplusNum: 1, writeStart: 0, writeEnd: 0,
          cartInfo: JSON.stringify({ sku: { id: 4 } }), unique: "audit_validity_physical_004",
        },
      ]);
    });

    const paidAt = 1_800_000_000;
    const first = await withTx(container, async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL search_path TO ${identifier(schema)}, pg_temp`));
      return activatePaidSecondCardValidity(tx, [{ id: 101, paid: 1 }, { id: 102, paid: 1 }], paidAt);
    });
    const firstRows = await withTx(container, async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL search_path TO ${identifier(schema)}, pg_temp`));
      return tx.select().from(storeOrderCartInfo).orderBy(storeOrderCartInfo.id);
    });
    const replay = await withTx(container, async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL search_path TO ${identifier(schema)}, pg_temp`));
      return activatePaidSecondCardValidity(tx, [{ id: 101, paid: 1 }, { id: 102, paid: 1 }], paidAt + 300);
    });
    const replayRows = await withTx(container, async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL search_path TO ${identifier(schema)}, pg_temp`));
      return tx.select().from(storeOrderCartInfo).orderBy(storeOrderCartInfo.id);
    });
    let unpaidRejected = false;
    try {
      await withTx(container, async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL search_path TO ${identifier(schema)}, pg_temp`));
        await activatePaidSecondCardValidity(tx, [{ id: 101, paid: 0 }], paidAt);
      });
    } catch (error) {
      unpaidRejected = error instanceof Error && error.message.includes("已支付");
    }
    const byId = new Map(firstRows.map((row) => [row.id, row]));
    const afterDays = byId.get(2_000_000_001);
    const fixed = byId.get(2_000_000_002);
    const unlimited = byId.get(2_000_000_003);
    const physical = byId.get(2_000_000_004);
    result = {
      production,
      first_matched: first.matched,
      first_changed: first.changed,
      purchase_days_started_at_payment: afterDays?.writeStart === paidAt
        && afterDays.writeEnd === paidAt + 7 * 86_400,
      fixed_window_preserved: fixed?.writeStart === 1_700_000_000
        && fixed.writeEnd === 1_900_000_000,
      unlimited_window_preserved: unlimited?.writeStart === 0 && unlimited.writeEnd === 0,
      physical_line_ignored: physical?.writeStart === 0 && physical.writeEnd === 0,
      replay_changed: replay.changed,
      replay_did_not_drift: JSON.stringify(firstRows) === JSON.stringify(replayRows),
      unpaid_order_rejected: unpaidRejected,
    };
    if (
      result.first_matched !== 3
      || result.first_changed !== 1
      || result.purchase_days_started_at_payment !== true
      || result.fixed_window_preserved !== true
      || result.unlimited_window_preserved !== true
      || result.physical_line_ignored !== true
      || result.replay_changed !== 0
      || result.replay_did_not_drift !== true
      || result.unpaid_order_rejected !== true
    ) throw new Error("isolated second-card validity assertion failed");
  } finally {
    let cleanupFailure: unknown;
    if (isolated) {
      try { await isolated.$client.end({ timeout: 1 }); } catch (error) { cleanupFailure = error; }
    }
    try {
      try {
        await dropSchema(root, schema);
        cleanupSucceeded = true;
      } catch (error) {
        cleanupFailure ??= error;
      }
      const after = await publicFingerprint(root);
      const publicStateUnchanged = before.rows === after.rows
        && before.digest === after.digest
        && before.sequence_value === after.sequence_value;
      if (!cleanupSucceeded || after.temporary_schemas !== before.temporary_schemas) {
        throw new Error("isolated second-card validity schema cleanup failed");
      }
      if (!publicStateUnchanged) throw new Error("public state changed during second-card validity audit");
      if (cleanupFailure) throw cleanupFailure;
      if (result) {
        result.cleanup_succeeded = true;
        result.temporary_schema_count_unchanged = true;
        result.public_state_unchanged = true;
      }
    } finally {
      await root.$client.end({ timeout: 1 });
    }
  }
  return result;
}
