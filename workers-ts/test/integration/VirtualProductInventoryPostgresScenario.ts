import { sql } from "drizzle-orm";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  withTx,
  type Container,
  type DbClient,
} from "../../src/lib/di";
import { VirtualProductInventoryService } from "../../src/services/product/VirtualProductInventoryService";

const DDL = `
CREATE TABLE store_product (
  id SERIAL PRIMARY KEY,
  type SMALLINT DEFAULT 0 NOT NULL,
  relation_id INTEGER DEFAULT 0 NOT NULL,
  product_type SMALLINT DEFAULT 0 NOT NULL,
  store_name VARCHAR(256) DEFAULT '' NOT NULL,
  is_del SMALLINT DEFAULT 0 NOT NULL,
  stock INTEGER DEFAULT 0 NOT NULL,
  is_sold SMALLINT DEFAULT 0 NOT NULL
);
CREATE TABLE store_product_attr_value (
  id SERIAL PRIMARY KEY,
  product_id INTEGER DEFAULT 0 NOT NULL,
  product_type SMALLINT DEFAULT 0 NOT NULL,
  suk VARCHAR(512) DEFAULT '' NOT NULL,
  stock INTEGER DEFAULT 0 NOT NULL,
  sum_stock INTEGER DEFAULT 0 NOT NULL,
  sales INTEGER DEFAULT 0 NOT NULL,
  "unique" CHAR(8) DEFAULT '' NOT NULL,
  cost NUMERIC(12,2) DEFAULT 0 NOT NULL,
  type SMALLINT DEFAULT 0 NOT NULL,
  disk_info TEXT
);
CREATE TABLE store_product_virtual (
  id SERIAL PRIMARY KEY,
  product_id INTEGER DEFAULT 0 NOT NULL,
  store_id INTEGER DEFAULT 0 NOT NULL,
  attr_unique VARCHAR(20) DEFAULT '' NOT NULL,
  card_no VARCHAR(255) DEFAULT '' NOT NULL,
  card_pwd VARCHAR(255) DEFAULT '' NOT NULL,
  card_unique VARCHAR(32) DEFAULT '' NOT NULL,
  order_id VARCHAR(255) DEFAULT '' NOT NULL,
  order_type SMALLINT DEFAULT 1 NOT NULL,
  uid INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX spv_product_attr_available
  ON store_product_virtual (product_id, attr_unique, uid, id);
CREATE INDEX spv_store_product ON store_product_virtual (store_id, product_id, id);
CREATE INDEX spv_card_unique ON store_product_virtual (card_unique);
CREATE TABLE store_product_stock_record (
  id SERIAL PRIMARY KEY,
  store_id INTEGER DEFAULT 0 NOT NULL,
  product_id INTEGER DEFAULT 0 NOT NULL,
  "unique" VARCHAR(32) DEFAULT '' NOT NULL,
  cost_price NUMERIC(12,2) DEFAULT 0 NOT NULL,
  number INTEGER DEFAULT 0 NOT NULL,
  pm SMALLINT DEFAULT 1 NOT NULL,
  add_time INTEGER DEFAULT 0 NOT NULL
);
CREATE TABLE system_virtual_inventory_export (
  id SERIAL PRIMARY KEY,
  token_hash VARCHAR(64) NOT NULL,
  actor_type VARCHAR(16) NOT NULL,
  actor_id INTEGER NOT NULL,
  supplier_id INTEGER DEFAULT 0 NOT NULL,
  product_id INTEGER NOT NULL,
  attr_unique VARCHAR(20) NOT NULL,
  reason VARCHAR(500) NOT NULL,
  requested_count INTEGER NOT NULL,
  exported_count INTEGER DEFAULT 0 NOT NULL,
  status VARCHAR(16) DEFAULT 'READY' NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  CONSTRAINT svie_actor_type_ck CHECK (actor_type IN ('admin', 'supplier')),
  CONSTRAINT svie_status_ck CHECK (status IN ('READY', 'CONSUMED', 'EXPIRED')),
  CONSTRAINT svie_identity_ck CHECK (actor_id > 0 AND supplier_id >= 0 AND product_id > 0),
  CONSTRAINT svie_count_ck CHECK (
    requested_count > 0 AND requested_count <= 1000
      AND exported_count >= 0 AND exported_count <= 1000
  ),
  CONSTRAINT svie_expiry_ck CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX svie_token_hash_uq ON system_virtual_inventory_export (token_hash);
CREATE INDEX svie_actor_history ON system_virtual_inventory_export (actor_type, actor_id, id);
CREATE INDEX svie_product_history ON system_virtual_inventory_export (product_id, attr_unique, id);
CREATE INDEX svie_ready_expiry ON system_virtual_inventory_export (expires_at, id)
  WHERE status = 'READY';
CREATE TABLE audit_public_snapshot (position VARCHAR(8) PRIMARY KEY, snapshot JSONB NOT NULL);
CREATE TABLE audit_result (id SMALLINT PRIMARY KEY, audit_key VARCHAR(32) NOT NULL, result JSONB NOT NULL);
`;

interface PublicSnapshot {
  product_count: string;
  sku_count: string;
  card_count: string;
  stock_record_count: string;
  export_audit_count: string;
  product_sequence: string;
  sku_sequence: string;
  card_sequence: string;
  stock_record_sequence: string;
  export_audit_sequence: string;
}

export interface VirtualProductInventoryAuditResult {
  concurrent_exactly_once: boolean;
  replay_idempotent: boolean;
  supplier_cross_tenant_blocked: boolean;
  admin_cross_owner_visible: boolean;
  fixed_content_import_blocked: boolean;
  non_card_product_blocked: boolean;
  password_only_supported: boolean;
  response_contains_no_passwords: boolean;
  card_numbers_masked: boolean;
  cursor_pagination_works: boolean;
  supplier_store_id_written: boolean;
  inventory_stock_increment_exact: boolean;
  stock_audit_exact: boolean;
  existing_legacy_store_id_tolerated: boolean;
  alert_classification_exact: boolean;
  alert_cursor_pagination_works: boolean;
  alert_supplier_tenant_isolated: boolean;
  alert_excludes_fixed_and_physical: boolean;
  alert_response_contains_no_secrets: boolean;
  export_admin_supported: boolean;
  export_creation_contains_no_secrets: boolean;
  export_ticket_hash_only: boolean;
  export_available_only: boolean;
  export_supplier_tenant_bound: boolean;
  export_concurrent_exactly_once: boolean;
  export_replay_blocked: boolean;
  export_expired_blocked: boolean;
  export_audit_exact: boolean;
}

function schemaName(value: string): string {
  if (!/^codex_virtual_inventory_[a-z0-9_]{8,28}$/.test(value) || value.length > 63) {
    throw new Error("unsafe virtual-inventory audit schema name");
  }
  return value;
}

function auditKey(value: string): string {
  if (!/^vinv-[a-z0-9]{10,18}$/.test(value)) throw new Error("invalid virtual-inventory audit key");
  return value;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Virtual-inventory audit failed: ${message}`);
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
      'product_count', (SELECT count(*)::text FROM public.store_product),
      'sku_count', (SELECT count(*)::text FROM public.store_product_attr_value),
      'card_count', (SELECT count(*)::text FROM public.store_product_virtual),
      'stock_record_count', (SELECT count(*)::text FROM public.store_product_stock_record),
      'export_audit_count', (SELECT count(*)::text FROM public.system_virtual_inventory_export),
      'product_sequence', (SELECT last_value::text FROM public.store_product_id_seq),
      'sku_sequence', (SELECT last_value::text FROM public.store_product_attr_value_id_seq),
      'card_sequence', (SELECT last_value::text FROM public.store_product_virtual_id_seq),
      'stock_record_sequence', (SELECT last_value::text FROM public.store_product_stock_record_id_seq),
      'export_audit_sequence', (SELECT last_value::text FROM public.system_virtual_inventory_export_id_seq)
    ) AS snapshot
  `);
  if (!rows[0]) throw new Error("could not capture public virtual-inventory snapshot");
  return rows[0].snapshot;
}

async function publicMarkerCount(db: DbClient, key: string): Promise<number> {
  const rows = await db.$client.unsafe<Array<{ count: number }>>(`
    SELECT (
      (SELECT count(*) FROM public.store_product WHERE store_name LIKE $1 || '%') +
      (SELECT count(*) FROM public.store_product_virtual WHERE card_no LIKE $1 || '%')
    )::int AS count
  `, [key]);
  return rows[0]?.count ?? -1;
}

async function rejected(action: () => Promise<unknown>, message: string): Promise<boolean> {
  try {
    await action();
    return false;
  } catch (error) {
    return error instanceof Error && error.message.includes(message);
  }
}

export async function setupVirtualProductInventoryAudit(
  connectionString: string,
  schemaValue: string,
  keyValue: string,
) {
  const schema = schemaName(schemaValue);
  const key = auditKey(keyValue);
  const admin = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_virtual_inventory_setup",
  });
  try {
    const exists = await admin.$client.unsafe<Array<{ exists: boolean }>>(
      "SELECT to_regnamespace($1) IS NOT NULL AS exists",
      [schema],
    );
    if (exists[0]?.exists) throw new Error("virtual-inventory audit schema already exists");
    const [before, marker] = await Promise.all([publicSnapshot(admin), publicMarkerCount(admin, key)]);
    assert(marker === 0, "public audit marker already exists");
    await admin.$client.unsafe(`CREATE SCHEMA "${schema}"`);
    const scoped = container(connectionString, schema, "cinashop_virtual_inventory_ddl");
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

export async function runVirtualProductInventoryAudit(
  connectionString: string,
  schemaValue: string,
  keyValue: string,
): Promise<VirtualProductInventoryAuditResult> {
  const schema = schemaName(schemaValue);
  const key = auditKey(keyValue);
  const primary = container(connectionString, schema, "cinashop_virtual_inventory_primary");
  const concurrent = container(connectionString, schema, "cinashop_virtual_inventory_concurrent");
  const platform = new VirtualProductInventoryService(primary);
  const supplier = new VirtualProductInventoryService(primary);
  const secondSupplierConnection = new VirtualProductInventoryService(concurrent);
  const supplierA = { kind: "supplier" as const, supplierId: 7001 };
  const supplierB = { kind: "supplier" as const, supplierId: 7002 };
  try {
    await withTx(primary, async (tx) => {
      await tx.execute(sql`
        INSERT INTO store_product (id, type, relation_id, product_type, store_name, stock)
        VALUES
          (101, 0, 0, 1, ${`${key}-platform`}, 0),
          (102, 2, 7001, 1, ${`${key}-supplier-a`}, 0),
          (103, 2, 7002, 1, ${`${key}-supplier-b`}, 0),
          (104, 2, 7001, 1, ${`${key}-fixed`}, 3),
          (105, 0, 0, 0, ${`${key}-physical`}, 0)
      `);
      await tx.execute(sql`
        INSERT INTO store_product_attr_value
          (id, product_id, product_type, suk, stock, sum_stock, sales, "unique", cost, type, disk_info)
        VALUES
          (201, 101, 1, '平台规格', 0, 0, 0, 'VPLA0001', 1.00, 0, ''),
          (202, 102, 1, '供应商A', 0, 0, 0, 'VSUP0001', 2.00, 0, ''),
          (203, 103, 1, '供应商B', 0, 0, 0, 'VSUP0002', 2.00, 0, ''),
          (204, 104, 1, '固定内容', 3, 3, 0, 'VFIX0001', 0.00, 0, 'shared secret'),
          (205, 105, 0, '实物规格', 0, 0, 0, 'VPHY0001', 0.00, 0, '')
      `);
      // Historical PHP supplier rows could incorrectly retain store_id=0.
      await tx.execute(sql`
        INSERT INTO store_product_virtual
          (id, product_id, store_id, attr_unique, card_no, card_pwd, card_unique, order_id, uid)
        VALUES
          (301, 102, 0, 'VSUP0001', ${`${key}-legacy-assigned`}, 'legacy-secret', 'legacy-digest', 'ORDER-OLD', 42)
      `);
    });

    const platformImport = await platform.importCards({ kind: "admin" }, 101, {
      attr_unique: "VPLA0001",
      cards: [
        { card_no: `${key}-platform-1`, card_pwd: "platform-secret-1" },
        { card_no: "", card_pwd: "platform-password-only" },
        { card_no: "", card_pwd: "platform-password-only" },
      ],
    });
    const supplierBatch = {
      attr_unique: "VSUP0001",
      cards: [
        { card_no: `${key}-supplier-1`, card_pwd: "supplier-secret-1" },
        { card_no: `${key}-supplier-2`, card_pwd: "supplier-secret-2" },
      ],
    };
    const race = await Promise.all([
      supplier.importCards(supplierA, 102, supplierBatch),
      secondSupplierConnection.importCards(supplierA, 102, supplierBatch),
    ]);
    const replay = await supplier.importCards(supplierA, 102, supplierBatch);

    const [crossTenantRead, crossTenantWrite, fixedBlocked, physicalBlocked] = await Promise.all([
      rejected(() => supplier.inventory(supplierB, 102, {}), "不属于当前供应商"),
      rejected(() => supplier.importCards(supplierB, 102, supplierBatch), "不属于当前供应商"),
      rejected(() => supplier.importCards(supplierA, 104, {
        attr_unique: "VFIX0001",
        cards: [{ card_no: "fixed", card_pwd: "blocked" }],
      }), "固定虚拟内容"),
      rejected(() => platform.inventory({ kind: "admin" }, 105, {}), "仅卡密商品"),
    ]);

    const adminView = await platform.inventory({ kind: "admin" }, 102, {
      attr_unique: "VSUP0001",
      status: "all",
      limit: "1",
    });
    const nextPage = adminView.next_cursor
      ? await platform.inventory({ kind: "admin" }, 102, {
          attr_unique: "VSUP0001",
          status: "all",
          limit: "1",
          cursor: String(adminView.next_cursor),
        })
      : null;
    const supplierView = await supplier.inventory(supplierA, 102, {
      attr_unique: "VSUP0001",
      status: "all",
      limit: "100",
    });
    const serializedViews = JSON.stringify({ adminView, nextPage, supplierView });

    const adminExportActor = { kind: "admin" as const, actorId: 9000 };
    const supplierExportActor = {
      kind: "supplier" as const,
      actorId: 9001,
      supplierId: 7001,
    };
    const supplierBExportActor = {
      kind: "supplier" as const,
      actorId: 9002,
      supplierId: 7002,
    };
    const adminExportTicket = await platform.createExportTicket(adminExportActor, 101, {
      attr_unique: "VPLA0001",
      confirm: "EXPORT_AVAILABLE_VIRTUAL_CARDS",
      reason: "production inventory recovery audit",
    });
    const adminExport = await platform.consumeExportTicket(adminExportActor, 101, {
      ticket: adminExportTicket.ticket,
    });
    const supplierExportTicket = await supplier.createExportTicket(supplierExportActor, 102, {
      attr_unique: "VSUP0001",
      confirm: "EXPORT_AVAILABLE_VIRTUAL_CARDS",
      reason: "supplier inventory reconciliation audit",
    });
    const supplierCrossTenantExport = await rejected(
      () => supplier.consumeExportTicket(supplierBExportActor, 102, {
        ticket: supplierExportTicket.ticket,
      }),
      "导出票据无效或已失效",
    );
    const supplierExportRace = await Promise.allSettled([
      supplier.consumeExportTicket(supplierExportActor, 102, {
        ticket: supplierExportTicket.ticket,
      }),
      secondSupplierConnection.consumeExportTicket(supplierExportActor, 102, {
        ticket: supplierExportTicket.ticket,
      }),
    ]);
    const supplierExportSuccesses = supplierExportRace.flatMap((item) =>
      item.status === "fulfilled" ? [item.value] : [],
    );
    const supplierExportFailures = supplierExportRace.flatMap((item) =>
      item.status === "rejected"
        ? [item.reason instanceof Error ? item.reason.message : String(item.reason)]
        : [],
    );
    const supplierExportReplayBlocked = await rejected(
      () => supplier.consumeExportTicket(supplierExportActor, 102, {
        ticket: supplierExportTicket.ticket,
      }),
      "导出票据无效或已失效",
    );
    const expiringTicket = await supplier.createExportTicket(supplierExportActor, 102, {
      attr_unique: "VSUP0001",
      confirm: "EXPORT_AVAILABLE_VIRTUAL_CARDS",
      reason: "expired ticket behavior audit",
    });
    await withTx(primary, async (tx) => {
      await tx.execute(sql`
        UPDATE system_virtual_inventory_export
        SET created_at = NOW() - INTERVAL '120 seconds',
            expires_at = NOW() - INTERVAL '60 seconds'
        WHERE actor_type = 'supplier' AND actor_id = 9001 AND status = 'READY'
      `);
    });
    const expiredExportBlocked = await rejected(
      () => supplier.consumeExportTicket(supplierExportActor, 102, {
        ticket: expiringTicket.ticket,
      }),
      "导出票据无效或已失效",
    );
    const exportAuditState = await withTx(primary, async (tx) => tx.execute(sql`
      SELECT
        count(*)::int AS audit_rows,
        count(*) FILTER (WHERE status = 'CONSUMED')::int AS consumed_rows,
        count(*) FILTER (WHERE status = 'EXPIRED')::int AS expired_rows,
        count(*) FILTER (WHERE consumed_at IS NOT NULL)::int AS consumed_time_rows,
        COALESCE(sum(exported_count), 0)::int AS exported_units,
        bool_and(length(token_hash) = 64)::boolean AS hashes_are_sha256,
        bool_and(token_hash <> ${adminExportTicket.ticket}
          AND token_hash <> ${supplierExportTicket.ticket}
          AND token_hash <> ${expiringTicket.ticket})::boolean AS no_plaintext_ticket
      FROM system_virtual_inventory_export
    `) as unknown as Array<{
      audit_rows: number;
      consumed_rows: number;
      expired_rows: number;
      consumed_time_rows: number;
      exported_units: number;
      hashes_are_sha256: boolean;
      no_plaintext_ticket: boolean;
    }>);
    const exportAudit = exportAuditState[0];
    const serializedExportTickets = JSON.stringify({
      adminExportTicket,
      supplierExportTicket,
      expiringTicket,
    });
    const supplierExport = supplierExportSuccesses[0];
    const state = await withTx(primary, async (tx) => tx.execute(sql`
      SELECT
        (SELECT stock FROM store_product WHERE id = 101) AS platform_product_stock,
        (SELECT stock FROM store_product_attr_value WHERE id = 201) AS platform_sku_stock,
        (SELECT stock FROM store_product WHERE id = 102) AS supplier_product_stock,
        (SELECT stock FROM store_product_attr_value WHERE id = 202) AS supplier_sku_stock,
        (SELECT count(*)::int FROM store_product_virtual WHERE product_id = 102 AND store_id = 7001) AS scoped_cards,
        (SELECT count(*)::int FROM store_product_virtual WHERE product_id = 102 AND store_id = 0) AS legacy_cards,
        (SELECT count(*)::int FROM store_product_virtual WHERE product_id = 101 AND card_no = '') AS password_only_cards,
        (SELECT count(*)::int FROM store_product_stock_record WHERE product_id IN (101, 102)) AS stock_records,
        (SELECT COALESCE(sum(number), 0)::int FROM store_product_stock_record WHERE product_id IN (101, 102)) AS stock_record_units
    `) as unknown as Array<{
      platform_product_stock: number;
      platform_sku_stock: number;
      supplier_product_stock: number;
      supplier_sku_stock: number;
      scoped_cards: number;
      legacy_cards: number;
      password_only_cards: number;
      stock_records: number;
      stock_record_units: number;
    }>);
    const final = state[0];
    assert(final, "final inventory state missing");
    await withTx(primary, async (tx) => {
      await tx.execute(sql`UPDATE store_product_attr_value SET stock = 4 WHERE id = 202`);
    });
    const [adminAlerts, supplierAlerts, supplierBAlerts, shortageAlerts] = await Promise.all([
      platform.alerts({ kind: "admin" }, { threshold: "5", level: "all", limit: "1" }),
      supplier.alerts(supplierA, { threshold: "5", level: "all", limit: "30" }),
      supplier.alerts(supplierB, { threshold: "5", level: "all", limit: "30" }),
      platform.alerts({ kind: "admin" }, { threshold: "5", level: "shortage", limit: "30" }),
    ]);
    const secondAlertPage = adminAlerts.next_cursor
      ? await platform.alerts({ kind: "admin" }, {
          threshold: "5",
          level: "all",
          limit: "1",
          cursor: String(adminAlerts.next_cursor),
        })
      : null;
    const serializedAlerts = JSON.stringify({
      adminAlerts,
      secondAlertPage,
      supplierAlerts,
      supplierBAlerts,
      shortageAlerts,
    });
    const insertedTotal = race.reduce((sum, item) => sum + item.inserted, 0);
    const result: VirtualProductInventoryAuditResult = {
      concurrent_exactly_once:
        insertedTotal === 2
        && race.filter((item) => item.inserted === 2).length === 1
        && race.filter((item) => item.skipped_existing === 2).length === 1,
      replay_idempotent: replay.inserted === 0 && replay.skipped_existing === 2,
      supplier_cross_tenant_blocked: crossTenantRead && crossTenantWrite,
      admin_cross_owner_visible:
        adminView.product.id === 102
        && adminView.product.owner_type === 2
        && adminView.product.owner_id === 7001,
      fixed_content_import_blocked: fixedBlocked,
      non_card_product_blocked: physicalBlocked,
      password_only_supported:
        platformImport.inserted === 2
        && platformImport.skipped_request_duplicates === 1
        && final.password_only_cards === 1,
      response_contains_no_passwords:
        !serializedViews.includes("supplier-secret")
        && !serializedViews.includes("legacy-secret")
        && !serializedViews.includes("platform-secret")
        && !serializedViews.includes("card_pwd")
        && !serializedViews.includes("cardPwd"),
      card_numbers_masked:
        supplierView.list.length === 3
        && supplierView.list.every((item) => item.card_no_masked.startsWith("•"))
        && !serializedViews.includes(`${key}-supplier-1`)
        && !serializedViews.includes(`${key}-legacy-assigned`),
      cursor_pagination_works:
        adminView.list.length === 1
        && adminView.next_cursor !== null
        && nextPage?.list.length === 1
        && nextPage.list[0].id < adminView.list[0].id,
      supplier_store_id_written: final.scoped_cards === 2,
      inventory_stock_increment_exact:
        final.platform_product_stock === 2
        && final.platform_sku_stock === 2
        && final.supplier_product_stock === 2
        && final.supplier_sku_stock === 2,
      stock_audit_exact: final.stock_records === 2 && final.stock_record_units === 4,
      existing_legacy_store_id_tolerated:
        final.legacy_cards === 1
        && supplierView.summary.total_cards === 3
        && supplierView.summary.available_cards === 2
        && supplierView.summary.assigned_cards === 1,
      alert_classification_exact:
        adminAlerts.summary.products_scanned === 2
        && adminAlerts.summary.skus_scanned === 2
        && adminAlerts.summary.alert_products === 2
        && adminAlerts.summary.alert_skus === 2
        && adminAlerts.summary.shortage_skus === 1
        && adminAlerts.summary.low_buffer_skus === 1
        && shortageAlerts.list.length === 1
        && shortageAlerts.list[0]?.product_id === 102
        && shortageAlerts.list[0]?.buffer === -2,
      alert_cursor_pagination_works:
        adminAlerts.list.length === 1
        && adminAlerts.list[0]?.sku_id === 201
        && adminAlerts.next_cursor === 201
        && secondAlertPage?.list.length === 1
        && secondAlertPage.list[0]?.sku_id === 202
        && secondAlertPage.next_cursor === null,
      alert_supplier_tenant_isolated:
        supplierAlerts.list.length === 1
        && supplierAlerts.list[0]?.product_id === 102
        && supplierAlerts.list[0]?.owner_id === 7001
        && supplierBAlerts.summary.products_scanned === 0
        && supplierBAlerts.list.length === 0,
      alert_excludes_fixed_and_physical:
        !serializedAlerts.includes(`${key}-fixed`)
        && !serializedAlerts.includes(`${key}-physical`)
        && !serializedAlerts.includes(`${key}-supplier-b`),
      alert_response_contains_no_secrets:
        !serializedAlerts.includes("card_no")
        && !serializedAlerts.includes("card_pwd")
        && !serializedAlerts.includes("supplier-secret")
        && !serializedAlerts.includes("legacy-secret")
        && !serializedAlerts.includes("shared secret"),
      export_admin_supported:
        adminExport.exported_count === 2
        && adminExport.cards.length === 2
        && adminExport.product.id === 101,
      export_creation_contains_no_secrets:
        !serializedExportTickets.includes("platform-secret")
        && !serializedExportTickets.includes("supplier-secret")
        && !serializedExportTickets.includes("legacy-secret")
        && !serializedExportTickets.includes("card_pwd"),
      export_ticket_hash_only:
        exportAudit?.hashes_are_sha256 === true
        && exportAudit.no_plaintext_ticket === true,
      export_available_only:
        supplierExport?.exported_count === 2
        && supplierExport.cards.length === 2
        && supplierExport.cards.every((card) => card.card_pwd.startsWith("supplier-secret-"))
        && !JSON.stringify(supplierExport).includes("legacy-secret"),
      export_supplier_tenant_bound: supplierCrossTenantExport,
      export_concurrent_exactly_once:
        supplierExportSuccesses.length === 1
        && supplierExportFailures.length === 1
        && supplierExportFailures[0]?.includes("导出票据无效或已失效") === true,
      export_replay_blocked: supplierExportReplayBlocked,
      export_expired_blocked: expiredExportBlocked,
      export_audit_exact:
        exportAudit?.audit_rows === 3
        && exportAudit.consumed_rows === 2
        && exportAudit.expired_rows === 1
        && exportAudit.consumed_time_rows === 2
        && exportAudit.exported_units === 4,
    };
    for (const [name, value] of Object.entries(result)) assert(value, `${name} is false`);
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

export async function verifyVirtualProductInventoryAudit(
  connectionString: string,
  schemaValue: string,
  keyValue: string,
) {
  const schema = schemaName(schemaValue);
  const key = auditKey(keyValue);
  const scoped = container(connectionString, schema, "cinashop_virtual_inventory_verify");
  const admin = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_virtual_inventory_verify_public",
  });
  try {
    const [stored, counts, before, after, marker] = await Promise.all([
      withTx(scoped, async (tx) => tx.execute(sql`
        SELECT audit_key, result FROM audit_result WHERE id = 1
      `) as unknown as Array<{ audit_key: string; result: VirtualProductInventoryAuditResult }>),
      withTx(scoped, async (tx) => tx.execute(sql`
        SELECT
          (SELECT count(*)::int FROM store_product) AS products,
          (SELECT count(*)::int FROM store_product_attr_value) AS skus,
          (SELECT count(*)::int FROM store_product_virtual) AS cards,
          (SELECT count(*)::int FROM store_product_stock_record) AS stock_records,
          (SELECT count(*)::int FROM system_virtual_inventory_export) AS export_audits
      `) as unknown as Array<{
        products: number;
        skus: number;
        cards: number;
        stock_records: number;
        export_audits: number;
      }>),
      withTx(scoped, async (tx) => tx.execute(sql`
        SELECT snapshot FROM audit_public_snapshot WHERE position = 'before'
      `) as unknown as Array<{ snapshot: PublicSnapshot }>),
      publicSnapshot(admin),
      publicMarkerCount(admin, key),
    ]);
    const result = stored[0]?.result;
    assert(stored[0]?.audit_key === key && result, "stored audit result is missing or mismatched");
    for (const [name, value] of Object.entries(result)) assert(value, `${name} is false`);
    assert(
      counts[0]?.products === 5
      && counts[0]?.skus === 5
      && counts[0]?.cards === 5
      && counts[0]?.stock_records === 2
      && counts[0]?.export_audits === 3,
      "isolated evidence counts are wrong",
    );
    assert(JSON.stringify(before[0]?.snapshot) === JSON.stringify(after), "public counts or sequences changed");
    assert(marker === 0, "audit marker leaked into public tables");
    return {
      result,
      isolated_counts: counts[0],
      public_unchanged: true,
      public_marker_count: marker,
    };
  } finally {
    await Promise.all([scoped.db.$client.end(), admin.$client.end()]);
  }
}

export async function cleanupVirtualProductInventoryAudit(
  connectionString: string,
  schemaValue: string,
  keyValue: string,
) {
  const schema = schemaName(schemaValue);
  const key = auditKey(keyValue);
  const admin = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_virtual_inventory_cleanup",
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
    const existsAfter = await admin.$client.unsafe<Array<{ exists: boolean }>>(
      "SELECT to_regnamespace($1) IS NOT NULL AS exists",
      [schema],
    );
    assert(!existsAfter[0]?.exists, "virtual-inventory audit schema still exists after cleanup");
    return { schema_removed: true, public_unchanged: true, public_marker_count: 0 };
  } finally {
    await admin.$client.end();
  }
}
