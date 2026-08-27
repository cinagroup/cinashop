import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  type Container,
  type DbClient,
  withTx,
} from "@/lib/di";
import {
  storeDiscounts,
  storeDiscountsProducts,
  storeProduct,
  storeProductAttr,
  storeProductAttrResult,
  storeProductAttrValue,
  userLabel,
} from "@/models/schema";
import { AdminDiscountPackageService } from "@/services/activity/AdminDiscountPackageService";
import { NotFoundException, ValidateException } from "@/utils/errors";

const CLONED_TABLES = [
  "store_discounts",
  "store_discounts_products",
  "store_product",
  "store_product_attr",
  "store_product_attr_result",
  "store_product_attr_value",
  "user_label",
] as const;

const LOCAL_SEQUENCE_TABLES = CLONED_TABLES;

const PUBLIC_FINGERPRINTS = [
  ["store_discounts", "TRUE"],
  ["store_discounts_products", "TRUE"],
  ["store_product_attr", "type = 5"],
  ["store_product_attr_result", "type = 5"],
  ["store_product_attr_value", "type = 5"],
] as const;

interface Fingerprint {
  count: string;
  digest: string;
}

interface PublicSnapshot {
  tables: Record<string, Fingerprint>;
  sequences: Record<string, string | null>;
}

export interface AdminDiscountPackagePostgresReport {
  server_version: string;
  schema_created: boolean;
  schema_removed: boolean;
  temporary_schemas_after: number;
  public_state_unchanged: boolean;
  option_queries: {
    products: number;
    base_skus: number;
    labels: number;
  };
  fixed_save: {
    discount_id: number;
    entries: number;
    activity_attrs: number;
    activity_results: number;
    activity_skus: number;
    product_ids: string;
    link_ids: string;
    min_price: string;
    listed_available: boolean;
  };
  mix_update: {
    retained_entry_id: boolean;
    retained_activity_unique: boolean;
    removed_entry_cleaned: boolean;
    entries: number;
    activity_skus: number;
    product_ids: string;
    link_ids: string;
    refund_disabled: boolean;
    custom_form_round_trip: boolean;
  };
  forced_failure_rollback: {
    rejected: boolean;
    state_unchanged: boolean;
  };
  status_validation: {
    future_schedule_enabled: boolean;
    not_started_effective_status: number;
    required_out_of_stock_rejected: boolean;
    restored_enable_succeeded: boolean;
  };
  soft_delete: {
    hidden_from_detail: boolean;
    hidden_from_list: boolean;
    row_soft_deleted: boolean;
    associations_preserved: boolean;
  };
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Admin discount-package integration failed: ${message}`);
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function makeSchemaName(): string {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return `codex_admin_discount_${Date.now().toString(36)}_${random[0].toString(36)}`.slice(0, 63);
}

function localSequenceName(table: string): string {
  return `${table}_id_seq_admin_discount_it`;
}

async function publicSnapshot(db: DbClient): Promise<PublicSnapshot> {
  const tables: Record<string, Fingerprint> = {};
  for (const [table, predicate] of PUBLIC_FINGERPRINTS) {
    const rows = await db.$client.unsafe<Array<Fingerprint>>(`
      SELECT count(*)::text AS count,
        md5(COALESCE(string_agg(md5(to_jsonb(t)::text), '' ORDER BY md5(to_jsonb(t)::text)), '')) AS digest
      FROM public.${identifier(table)} t
      WHERE ${predicate}
    `);
    assertCondition(rows[0], `could not fingerprint public.${table}`);
    tables[table] = rows[0];
  }
  const names = LOCAL_SEQUENCE_TABLES.map((table) => `${table}_id_seq`);
  const rows = await db.$client<{ sequencename: string; last_value: string | null }[]>`
    SELECT sequencename, last_value::text
    FROM pg_sequences
    WHERE schemaname = 'public' AND sequencename = ANY(${names})
    ORDER BY sequencename
  `;
  const found = new Map(rows.map((row) => [row.sequencename, row.last_value]));
  return {
    tables,
    sequences: Object.fromEntries(names.map((name) => [name, found.get(name) ?? null])),
  };
}

async function setupSchema(db: DbClient, schemaName: string): Promise<void> {
  const schema = identifier(schemaName);
  await db.$client.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx`SET LOCAL statement_timeout = '30s'`;
    await tx.unsafe(`CREATE SCHEMA ${schema}`);
    for (const table of CLONED_TABLES) {
      const tableName = identifier(table);
      await tx.unsafe(`CREATE TABLE ${schema}.${tableName} (LIKE public.${tableName} INCLUDING ALL)`);
    }
    for (const table of LOCAL_SEQUENCE_TABLES) {
      const tableName = identifier(table);
      const sequenceName = identifier(localSequenceName(table));
      await tx.unsafe(`CREATE SEQUENCE ${schema}.${sequenceName}`);
      await tx.unsafe(`ALTER SEQUENCE ${schema}.${sequenceName} OWNED BY ${schema}.${tableName}."id"`);
      await tx.unsafe(
        `ALTER TABLE ${schema}.${tableName} ALTER COLUMN "id" SET DEFAULT nextval('${schemaName}.${localSequenceName(table)}'::regclass)`,
      );
    }
  });
}

async function withSchema<T>(
  db: DbClient,
  schemaName: string,
  callback: (container: Container) => Promise<T>,
): Promise<T> {
  return withTx(createContainerFromDb(db), async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL search_path TO ${identifier(schemaName)}`));
    await tx.execute(sql`SET LOCAL lock_timeout = '3s'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '30s'`);
    return callback(createContainerFromDb(tx));
  });
}

async function seed(container: Container, schemaName: string): Promise<void> {
  const now = Math.floor(Date.now() / 1_000);
  await container.db.insert(storeProduct).values([
    {
      id: 1,
      storeName: "Admin discount audit product one",
      image: "audit-one.png",
      price: "20.00",
      otPrice: "25.00",
      stock: 10,
      productType: 0,
      specType: 1,
      isShow: 1,
      isVerify: 1,
      isDel: 0,
      sort: 30,
      addTime: now,
    },
    {
      id: 2,
      storeName: "Admin discount audit product two",
      image: "audit-two.png",
      price: "18.00",
      otPrice: "22.00",
      stock: 8,
      productType: 0,
      specType: 0,
      isShow: 1,
      isVerify: 1,
      isDel: 0,
      sort: 20,
      addTime: now,
    },
    {
      id: 3,
      storeName: "Admin discount audit product three",
      image: "audit-three.png",
      price: "12.00",
      otPrice: "15.00",
      stock: 6,
      productType: 0,
      specType: 0,
      isShow: 1,
      isVerify: 1,
      isDel: 0,
      sort: 10,
      addTime: now,
    },
  ]);
  await container.db.insert(storeProductAttr).values([
    { id: 1, productId: 1, attrName: "Color", attrValues: "Red,Blue", type: 0 },
    { id: 2, productId: 2, attrName: "Size", attrValues: "M", type: 0 },
    { id: 3, productId: 3, attrName: "Style", attrValues: "A", type: 0 },
  ]);
  await container.db.insert(storeProductAttrValue).values([
    {
      id: 1,
      productId: 1,
      suk: "Red",
      unique: "BASE0001",
      price: "20.00",
      otPrice: "25.00",
      cost: "8.00",
      stock: 4,
      sumStock: 4,
      type: 0,
    },
    {
      id: 2,
      productId: 1,
      suk: "Blue",
      unique: "BASE0002",
      price: "21.00",
      otPrice: "25.00",
      cost: "8.00",
      stock: 6,
      sumStock: 6,
      type: 0,
    },
    {
      id: 3,
      productId: 2,
      suk: "M",
      unique: "BASE0003",
      price: "18.00",
      otPrice: "22.00",
      cost: "7.00",
      stock: 8,
      sumStock: 8,
      type: 0,
    },
    {
      id: 4,
      productId: 3,
      suk: "A",
      unique: "BASE0004",
      price: "12.00",
      otPrice: "15.00",
      cost: "5.00",
      stock: 6,
      sumStock: 6,
      type: 0,
    },
  ]);
  await container.db.insert(userLabel).values([
    { id: 1, name: "Audit VIP", status: 1, sort: 10, addTime: now },
    { id: 2, name: "Audit member", status: 1, sort: 20, addTime: now },
  ]);

  const sequenceValues: Array<[string, number]> = [
    ["store_product", 3],
    ["store_product_attr", 3],
    ["store_product_attr_value", 4],
    ["user_label", 2],
  ];
  for (const [table, value] of sequenceValues) {
    await container.db.execute(sql.raw(
      `SELECT setval('${schemaName}.${localSequenceName(table)}'::regclass, ${value}, true)`,
    ));
  }
}

async function packageState(container: Container, discountId: number) {
  const discounts = await container.db.select().from(storeDiscounts)
    .where(eq(storeDiscounts.id, discountId)).limit(1);
  const entries = await container.db.select().from(storeDiscountsProducts)
    .where(eq(storeDiscountsProducts.discountId, discountId)).orderBy(asc(storeDiscountsProducts.id));
  const entryIds = entries.map((entry) => entry.id);
  const [attrs, results, skus] = entryIds.length
    ? await Promise.all([
        container.db.select().from(storeProductAttr).where(and(
          eq(storeProductAttr.type, 5),
          inArray(storeProductAttr.productId, entryIds),
        )).orderBy(asc(storeProductAttr.id)),
        container.db.select().from(storeProductAttrResult).where(and(
          eq(storeProductAttrResult.type, 5),
          inArray(storeProductAttrResult.productId, entryIds),
        )).orderBy(asc(storeProductAttrResult.id)),
        container.db.select().from(storeProductAttrValue).where(and(
          eq(storeProductAttrValue.type, 5),
          inArray(storeProductAttrValue.productId, entryIds),
        )).orderBy(asc(storeProductAttrValue.id)),
      ])
    : [[], [], []];
  return { discounts, entries, attrs, results, skus };
}

async function stateSignature(container: Container, discountId: number): Promise<string> {
  return JSON.stringify(await packageState(container, discountId));
}

function fixedInput() {
  return {
    id: 0,
    title: "Production Hyperdrive fixed package audit",
    image: "fixed-audit.png",
    type: 0,
    is_limit: 1,
    limit_num: 9,
    link_ids: [1],
    is_time: 0,
    sort: 5,
    free_shipping: 1,
    status: 1,
    is_support_refund: 1,
    delivery_type: [1, 2],
    freight: 2,
    custom_form: { source: "production-hyperdrive-isolated-audit" },
    products: [
      {
        product_id: 1,
        attr: [
          { unique: "BASE0001", price: "7.00" },
          { unique: "BASE0002", price: "8.00" },
        ],
      },
      { product_id: 2, attr: [{ unique: "BASE0003", price: "7.50" }] },
    ],
  };
}

function mixInput(discountId: number, now: number) {
  return {
    id: discountId,
    title: "Production Hyperdrive mix package audit",
    image: "mix-audit.png",
    type: 1,
    is_limit: 0,
    limit_num: 0,
    link_ids: [2, 1],
    is_time: 1,
    start_time: now + 86_400,
    stop_time: now + 172_800,
    sort: 9,
    free_shipping: 0,
    status: 0,
    is_support_refund: 0,
    delivery_type: "1,3",
    freight: 1,
    custom_form: { audited: true, mode: "mix" },
    products: [
      {
        product_id: 1,
        required: 1,
        skus: [{ base_unique: "BASE0001", price: "6.25" }],
      },
      {
        product_id: 3,
        required: 0,
        skus: [{ base_unique: "BASE0004", price: "3.75" }],
      },
    ],
  };
}

async function createFailureTrigger(db: DbClient, schemaName: string): Promise<void> {
  const schema = identifier(schemaName);
  await db.$client.unsafe(`
    CREATE FUNCTION ${schema}.admin_discount_fail_result() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'forced admin discount result failure';
    END
    $$
  `);
  await db.$client.unsafe(`
    CREATE TRIGGER admin_discount_fail_result
    BEFORE INSERT ON ${schema}.store_product_attr_result
    FOR EACH ROW EXECUTE FUNCTION ${schema}.admin_discount_fail_result()
  `);
}

async function dropFailureTrigger(db: DbClient, schemaName: string): Promise<void> {
  const schema = identifier(schemaName);
  await db.$client.unsafe(`DROP TRIGGER IF EXISTS admin_discount_fail_result ON ${schema}.store_product_attr_result`);
  await db.$client.unsafe(`DROP FUNCTION IF EXISTS ${schema}.admin_discount_fail_result()`);
}

export async function runAdminDiscountPackagePostgresScenario(
  connectionString: string,
): Promise<AdminDiscountPackagePostgresReport> {
  const schemaName = makeSchemaName();
  const schema = identifier(schemaName);
  const root = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_admin_discount_audit_root",
  });
  const scoped = createDbFromConnectionString(connectionString, 1, {
    searchPath: schemaName,
    applicationName: "cinashop_admin_discount_audit_main",
  });
  let created = false;
  let removed = false;
  let before: PublicSnapshot | undefined;
  let after: PublicSnapshot | undefined;
  let temporarySchemasAfter = -1;
  let report: Omit<
    AdminDiscountPackagePostgresReport,
    "schema_removed" | "temporary_schemas_after" | "public_state_unchanged"
  > | undefined;
  try {
    const versionRows = await root.$client<{ server_version: string }[]>`
      SELECT current_setting('server_version') AS server_version
    `;
    before = await publicSnapshot(root);
    await setupSchema(root, schemaName);
    created = true;
    await withSchema(scoped, schemaName, (container) => seed(container, schemaName));

    const [productOptions, labels] = await withSchema(scoped, schemaName, (container) => {
      const service = new AdminDiscountPackageService(container);
      return Promise.all([
        service.productOptions({ keyword: "Admin discount audit", page: 1, limit: 10 }),
        service.labelOptions({ keyword: "Audit" }),
      ]);
    });
    const optionQueries = {
      products: productOptions.list.length,
      base_skus: productOptions.list.reduce((total, product) => total + product.skus.length, 0),
      labels: labels.length,
    };
    assertCondition(
      optionQueries.products === 3 && optionQueries.base_skus === 4 && optionQueries.labels === 2,
      "product or label option queries did not return isolated fixtures",
    );

    const { fixed, fixedState, fixedList } = await withSchema(scoped, schemaName, async (container) => {
      const service = new AdminDiscountPackageService(container);
      const saved = await service.save(fixedInput());
      return {
        fixed: saved,
        fixedState: await packageState(container, saved.id),
        fixedList: await service.list({ title: "Production Hyperdrive fixed", page: 1, limit: 10 }),
      };
    });
    const fixedSave = {
      discount_id: fixed.id,
      entries: fixedState.entries.length,
      activity_attrs: fixedState.attrs.length,
      activity_results: fixedState.results.length,
      activity_skus: fixedState.skus.length,
      product_ids: fixed.productIds,
      link_ids: fixed.linkIds,
      min_price: fixed.min_price,
      listed_available: fixedList.list[0]?.available === true,
    };
    assertCondition(
      fixedSave.entries === 2
      && fixedSave.activity_attrs === 2
      && fixedSave.activity_results === 2
      && fixedSave.activity_skus === 3
      && fixedSave.product_ids === "1,2"
      && fixedSave.link_ids === "1"
      && fixedSave.min_price === "14.50"
      && fixedSave.listed_available,
      "fixed package persistence or list availability diverged",
    );

    const retainedEntry = fixedState.entries.find((entry) => entry.productId === 1);
    const removedEntry = fixedState.entries.find((entry) => entry.productId === 2);
    const retainedSku = fixedState.skus.find((sku) => sku.productId === retainedEntry?.id && sku.suk === "Red");
    assertCondition(retainedEntry && removedEntry && retainedSku, "fixed package fixture relationships are incomplete");

    const now = Math.floor(Date.now() / 1_000);
    const { mix, mixState, removedRows } = await withSchema(scoped, schemaName, async (container) => {
      const service = new AdminDiscountPackageService(container);
      const saved = await service.save(mixInput(fixed.id, now));
      const state = await packageState(container, fixed.id);
      const cleanedRows = await Promise.all([
        container.db.select().from(storeDiscountsProducts).where(eq(storeDiscountsProducts.id, removedEntry.id)),
        container.db.select().from(storeProductAttr).where(and(
          eq(storeProductAttr.productId, removedEntry.id),
          eq(storeProductAttr.type, 5),
        )),
        container.db.select().from(storeProductAttrResult).where(and(
          eq(storeProductAttrResult.productId, removedEntry.id),
          eq(storeProductAttrResult.type, 5),
        )),
        container.db.select().from(storeProductAttrValue).where(and(
          eq(storeProductAttrValue.productId, removedEntry.id),
          eq(storeProductAttrValue.type, 5),
        )),
      ]);
      return { mix: saved, mixState: state, removedRows: cleanedRows };
    });
    const retainedEntryAfter = mixState.entries.find((entry) => entry.productId === 1);
    const retainedSkuAfter = mixState.skus.find((sku) => sku.productId === retainedEntryAfter?.id && sku.suk === "Red");
    const mixUpdate = {
      retained_entry_id: retainedEntryAfter?.id === retainedEntry.id,
      retained_activity_unique: retainedSkuAfter?.unique === retainedSku.unique,
      removed_entry_cleaned: removedRows.every((rows) => rows.length === 0),
      entries: mixState.entries.length,
      activity_skus: mixState.skus.length,
      product_ids: mix.productIds,
      link_ids: mix.linkIds,
      refund_disabled: mix.isSupportRefund === 0,
      custom_form_round_trip: mix.customForm === JSON.stringify({ audited: true, mode: "mix" }),
    };
    assertCondition(
      mixUpdate.retained_entry_id
      && mixUpdate.retained_activity_unique
      && mixUpdate.removed_entry_cleaned
      && mixUpdate.entries === 2
      && mixUpdate.activity_skus === 2
      && mixUpdate.product_ids === "1"
      && mixUpdate.link_ids === "1,2"
      && mixUpdate.refund_disabled
      && mixUpdate.custom_form_round_trip,
      "mix update did not preserve retained identities or clean removed activity rows",
    );

    const signatureBefore = await withSchema(
      scoped,
      schemaName,
      (container) => stateSignature(container, fixed.id),
    );
    await createFailureTrigger(root, schemaName);
    let rollbackRejected = false;
    try {
      await withSchema(scoped, schemaName, (container) =>
        new AdminDiscountPackageService(container).save({
          ...mixInput(fixed.id, now),
          title: "This title must roll back",
          products: [
            { product_id: 1, required: 1, skus: [{ base_unique: "BASE0001", price: "1.00" }] },
            { product_id: 3, required: 0, skus: [{ base_unique: "BASE0004", price: "2.00" }] },
          ],
        })
      );
    } catch {
      rollbackRejected = true;
    } finally {
      await dropFailureTrigger(root, schemaName);
    }
    const signatureAfter = await withSchema(
      scoped,
      schemaName,
      (container) => stateSignature(container, fixed.id),
    );
    const forcedFailureRollback = {
      rejected: rollbackRejected,
      state_unchanged: signatureBefore === signatureAfter,
    };
    assertCondition(
      forcedFailureRollback.rejected && forcedFailureRollback.state_unchanged,
      "forced persistence failure did not roll back every package table",
    );

    const { futureStatus, futureDetail } = await withSchema(scoped, schemaName, async (container) => {
      const service = new AdminDiscountPackageService(container);
      const status = await service.setStatus(fixed.id, 1);
      return { futureStatus: status, futureDetail: await service.detail(fixed.id) };
    });
    await withSchema(scoped, schemaName, async (container) => {
      await new AdminDiscountPackageService(container).setStatus(fixed.id, 0);
      await container.db.update(storeProduct).set({ stock: 0 }).where(eq(storeProduct.id, 1));
    });
    let stockRejected = false;
    try {
      await withSchema(scoped, schemaName, (container) =>
        new AdminDiscountPackageService(container).setStatus(fixed.id, 1)
      );
    } catch (error) {
      stockRejected = error instanceof ValidateException;
    }
    const restoredStatus = await withSchema(scoped, schemaName, async (container) => {
      await container.db.update(storeProduct).set({ stock: 10 }).where(eq(storeProduct.id, 1));
      return new AdminDiscountPackageService(container).setStatus(fixed.id, 1);
    });
    const statusValidation = {
      future_schedule_enabled: futureStatus.status === 1,
      not_started_effective_status: futureDetail.effective_status,
      required_out_of_stock_rejected: stockRejected,
      restored_enable_succeeded: restoredStatus.status === 1,
    };
    assertCondition(
      statusValidation.future_schedule_enabled
      && statusValidation.not_started_effective_status === 0
      && statusValidation.required_out_of_stock_rejected
      && statusValidation.restored_enable_succeeded,
      "scheduled enable or required-product stock validation diverged",
    );

    const { detailHidden, deletedList, deletedState } = await withSchema(
      scoped,
      schemaName,
      async (container) => {
        const service = new AdminDiscountPackageService(container);
        await service.remove(fixed.id);
        let hidden = false;
        try {
          await service.detail(fixed.id);
        } catch (error) {
          hidden = error instanceof NotFoundException;
        }
        const [list, state] = await Promise.all([
          service.list({ title: "Production Hyperdrive mix", page: 1, limit: 10 }),
          packageState(container, fixed.id),
        ]);
        return { detailHidden: hidden, deletedList: list, deletedState: state };
      },
    );
    const softDelete = {
      hidden_from_detail: detailHidden,
      hidden_from_list: deletedList.count === 0,
      row_soft_deleted: deletedState.discounts[0]?.isDel === 1,
      associations_preserved:
        deletedState.entries.length === 2
        && deletedState.results.length === 2
        && deletedState.skus.length === 2,
    };
    assertCondition(
      softDelete.hidden_from_detail
      && softDelete.hidden_from_list
      && softDelete.row_soft_deleted
      && softDelete.associations_preserved,
      "soft delete visibility or source-compatible association preservation diverged",
    );

    report = {
      server_version: versionRows[0]?.server_version ?? "unknown",
      schema_created: true,
      option_queries: optionQueries,
      fixed_save: fixedSave,
      mix_update: mixUpdate,
      forced_failure_rollback: forcedFailureRollback,
      status_validation: statusValidation,
      soft_delete: softDelete,
    };
  } finally {
    try {
      await scoped.$client.end({ timeout: 1 });
      if (created) {
        await root.$client.begin(async (tx) => {
          await tx`SET LOCAL lock_timeout = '3s'`;
          await tx`SET LOCAL statement_timeout = '30s'`;
          await tx.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        });
      }
      const rows = await root.$client<{ removed: boolean }[]>`
        SELECT to_regnamespace(${schemaName}) IS NULL AS removed
      `;
      removed = rows[0]?.removed === true;
      const auditSchemas = await root.$client<{ count: number }[]>`
        SELECT count(*)::integer AS count
        FROM pg_namespace
        WHERE nspname LIKE 'codex_admin_discount_%'
      `;
      temporarySchemasAfter = auditSchemas[0]?.count ?? -1;
      after = await publicSnapshot(root);
    } finally {
      await root.$client.end({ timeout: 1 });
    }
  }
  assertCondition(report, "scenario did not produce a report");
  assertCondition(removed, "temporary schema was not removed");
  assertCondition(temporarySchemasAfter === 0, "one or more temporary Admin discount schemas remain");
  assertCondition(before && after, "public snapshots are missing");
  const publicStateUnchanged = JSON.stringify(before) === JSON.stringify(after);
  assertCondition(publicStateUnchanged, "public package rows or sequences changed");
  return {
    ...report,
    schema_removed: removed,
    temporary_schemas_after: temporarySchemasAfter,
    public_state_unchanged: publicStateUnchanged,
  };
}
