import { eq, sql } from "drizzle-orm";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  type Container,
  type DbClient,
  withTx,
} from "@/lib/di";
import { legacyCache, systemGroup, systemGroupData } from "@/models/schema";
import { DatabaseCacheService } from "@/services/system/DatabaseCacheService";
import {
  LegacyContentService,
  PRODUCT_DRAFT_TTL_SECONDS,
} from "@/services/system/LegacyContentService";

const TABLES = ["cache", "system_group", "system_group_data"] as const;
const SEQUENCES = ["system_group_id_seq", "system_group_data_id_seq"] as const;

interface Fingerprint {
  count: string;
  digest: string;
}

interface PublicSnapshot {
  tables: Record<string, Fingerprint>;
  sequences: Record<string, string | null>;
}

export interface LegacyContentPostgresReport {
  server_version: string;
  schema_created: boolean;
  schema_removed: boolean;
  public_state_unchanged: boolean;
  safe_defaults: {
    kf_empty: boolean;
    open_disabled: boolean;
    agreements_empty: boolean;
    urls_empty: boolean;
  };
  atomic_save: {
    rows: number;
    content_round_trip: boolean;
  };
  atomic_rollback: {
    rejected: boolean;
    all_rows_unchanged: boolean;
  };
  open_adv_upsert: {
    rows: number;
    latest_value_visible: boolean;
  };
  product_draft: {
    unknown_fields_removed: boolean;
    ttl_seconds: number;
    expired_hidden: boolean;
    explicit_delete: boolean;
  };
  uni_app_urls: {
    cache_fallback: boolean;
    active_group_overrides_cache: boolean;
    legacy_fields_flattened: boolean;
  };
  invalid_json: {
    fallback_returned: boolean;
    row_preserved: boolean;
  };
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Legacy content integration failed: ${message}`);
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function schemaName(): string {
  const random = crypto.getRandomValues(new Uint32Array(1))[0];
  return `codex_legacy_content_${Date.now().toString(36)}_${random.toString(36)}`.slice(0, 63);
}

async function publicSnapshot(db: DbClient): Promise<PublicSnapshot> {
  const tables: Record<string, Fingerprint> = {};
  for (const table of TABLES) {
    const rows = await db.$client.unsafe<Array<Fingerprint>>(`
      SELECT count(*)::text AS count,
        md5(COALESCE(string_agg(md5(to_jsonb(t)::text), '' ORDER BY md5(to_jsonb(t)::text)), '')) AS digest
      FROM public.${identifier(table)} t
    `);
    assertCondition(rows[0], `could not fingerprint public.${table}`);
    tables[table] = rows[0];
  }
  const rows = await db.$client<{ sequencename: string; last_value: string | null }[]>`
    SELECT sequencename, last_value::text
    FROM pg_sequences
    WHERE schemaname = 'public' AND sequencename = ANY(${[...SEQUENCES]})
    ORDER BY sequencename
  `;
  const sequences = Object.fromEntries(SEQUENCES.map((name) => [name, null])) as Record<string, string | null>;
  for (const row of rows) sequences[row.sequencename] = row.last_value;
  return { tables, sequences };
}

async function setupSchema(db: DbClient, schema: string): Promise<void> {
  const target = identifier(schema);
  await db.$client.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx`SET LOCAL statement_timeout = '30s'`;
    await tx.unsafe(`CREATE SCHEMA ${target}`);
    for (const table of TABLES) {
      await tx.unsafe(`CREATE TABLE ${target}.${identifier(table)} (LIKE public.${identifier(table)} INCLUDING ALL)`);
    }
  });
}

async function withSchema<T>(
  root: Container,
  schema: string,
  callback: (scoped: Container) => Promise<T>,
): Promise<T> {
  return withTx(root, async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL search_path TO ${identifier(schema)}`));
    await tx.execute(sql`SET LOCAL lock_timeout = '3s'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '30s'`);
    return callback(createContainerFromDb(tx));
  });
}

async function cacheSignature(container: Container): Promise<string> {
  const rows = await container.db.execute(sql`
    SELECT md5(COALESCE(string_agg(md5(to_jsonb(t)::text), '' ORDER BY md5(to_jsonb(t)::text)), '')) AS digest
    FROM cache t
  `) as unknown as Array<{ digest: string }>;
  return rows[0]?.digest ?? "";
}

const FIRST_CONTENT = {
  kf_adv: "<p>08:00-18:00</p>",
  open_adv: {
    status: 1,
    time: 5,
    interval_time: 12,
    type: "pic",
    value: [{ img: "https://cdn.example.test/splash-one.webp", link: "/pages/index/index", status: 1 }],
    video_link: "",
  },
  agreements: {
    privacy: "privacy-v1",
    user: "user-v1",
    cancel: "cancel-v1",
    supplier: "supplier-v1",
    agent: "agent-v1",
  },
};

export async function runLegacyContentPostgresScenario(
  connectionString: string,
): Promise<LegacyContentPostgresReport> {
  const schema = schemaName();
  const adminDb = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_legacy_content_audit_admin",
  });
  const clients: DbClient[] = [];
  let created = false;
  let removed = false;
  let before: PublicSnapshot | undefined;
  let after: PublicSnapshot | undefined;
  let report: Omit<LegacyContentPostgresReport, "schema_removed" | "public_state_unchanged"> | undefined;
  try {
    const version = await adminDb.$client<{ server_version: string }[]>`
      SELECT current_setting('server_version') AS server_version
    `;
    before = await publicSnapshot(adminDb);
    await setupSchema(adminDb, schema);
    created = true;

    const primary = createContainerFromDb(createDbFromConnectionString(connectionString, 1, {
      applicationName: "cinashop_legacy_content_audit_primary",
    }));
    clients.push(primary.db);

    const defaults = await withSchema(primary, schema, async (scoped) =>
      new LegacyContentService(scoped).runtimeContent()
    );
    const safeDefaults = {
      kf_empty: defaults.kf_adv === "",
      open_disabled: defaults.open_adv.status === 0 && defaults.open_adv.value.length === 0,
      agreements_empty: Object.values(defaults.agreements).every((value) => value === ""),
      urls_empty: defaults.uni_app_url.length === 0,
    };
    assertCondition(Object.values(safeDefaults).every(Boolean), "empty tables did not return safe defaults");

    const saved = await withSchema(primary, schema, async (scoped) =>
      new LegacyContentService(scoped).saveRuntimeContent(FIRST_CONTENT)
    );
    const savedRows = await withSchema(primary, schema, (scoped) =>
      scoped.db.execute(sql`SELECT count(*)::int AS count FROM cache`)
    ) as unknown as Array<{ count: number }>;
    const atomicSave = {
      rows: savedRows[0]?.count ?? 0,
      content_round_trip: saved.kf_adv === FIRST_CONTENT.kf_adv
        && saved.open_adv.value[0]?.img === FIRST_CONTENT.open_adv.value[0]?.img
        && saved.agreements.privacy === FIRST_CONTENT.agreements.privacy,
    };
    assertCondition(atomicSave.rows === 7 && atomicSave.content_round_trip, "atomic runtime save diverged");

    const beforeRejectedSave = await withSchema(primary, schema, cacheSignature);
    await withSchema(primary, schema, (scoped) => scoped.db.execute(sql.raw(`
      CREATE FUNCTION reject_privacy_cache_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'forced privacy cache failure'; END $$;
      CREATE TRIGGER reject_privacy_cache_write BEFORE INSERT OR UPDATE ON cache
      FOR EACH ROW WHEN (NEW.key = 'privacy') EXECUTE FUNCTION reject_privacy_cache_write();
    `)));
    let rejected = false;
    try {
      await withSchema(primary, schema, async (scoped) =>
        new LegacyContentService(scoped).saveRuntimeContent({
          ...FIRST_CONTENT,
          kf_adv: "must-roll-back",
          agreements: { ...FIRST_CONTENT.agreements, privacy: "must-roll-back" },
        })
      );
    } catch {
      rejected = true;
    } finally {
      await withSchema(primary, schema, (scoped) => scoped.db.execute(sql.raw(`
        DROP TRIGGER IF EXISTS reject_privacy_cache_write ON cache;
        DROP FUNCTION IF EXISTS reject_privacy_cache_write();
      `)));
    }
    const afterRejectedSave = await withSchema(primary, schema, cacheSignature);
    const atomicRollback = {
      rejected,
      all_rows_unchanged: beforeRejectedSave === afterRejectedSave,
    };
    assertCondition(Object.values(atomicRollback).every(Boolean), "failed runtime save was not atomic");

    const openResult = await withSchema(primary, schema, async (scoped) => {
      const service = new LegacyContentService(scoped);
      await service.saveOpenAdv({
        ...FIRST_CONTENT.open_adv,
        value: [{ img: "https://cdn.example.test/splash-two.webp", link: "pages/user/index", status: 1 }],
      });
      const current = await service.openAdv();
      const rows = await scoped.db.select({ key: legacyCache.key }).from(legacyCache)
        .where(eq(legacyCache.key, "open_adv"));
      return { current, rows };
    });
    const openAdvUpsert = {
      rows: openResult.rows.length,
      latest_value_visible: openResult.current.value[0]?.img.endsWith("splash-two.webp") === true,
    };
    assertCondition(openAdvUpsert.rows === 1 && openAdvUpsert.latest_value_visible, "open ad UPSERT diverged");

    const productDraft = await withSchema(primary, schema, async (scoped) => {
      const service = new LegacyContentService(scoped);
      const savedDraft = await service.saveProductDraft(42, {
        store_name: "isolated draft",
        price: "19.90",
        attrs: [{ suk: "default", stock: 3 }],
        unknown_server_field: "must not persist",
      });
      const cacheRows = await scoped.db.select({
        expireTime: legacyCache.expireTime,
        addTime: legacyCache.addTime,
      }).from(legacyCache).where(eq(legacyCache.key, "42_product_data")).limit(1);
      await scoped.db.update(legacyCache)
        .set({ expireTime: Math.floor(Date.now() / 1_000) - 1 })
        .where(eq(legacyCache.key, "42_product_data"));
      const expired = await service.productDraft(42);
      await service.saveProductDraft(42, { store_name: "delete-me" });
      await service.deleteProductDraft(42);
      const deleted = await scoped.db.select({ key: legacyCache.key }).from(legacyCache)
        .where(eq(legacyCache.key, "42_product_data"));
      return {
        savedDraft,
        ttl: (cacheRows[0]?.expireTime ?? 0) - (cacheRows[0]?.addTime ?? 0),
        expired,
        deleted,
      };
    });
    const productDraftReport = {
      unknown_fields_removed: !("unknown_server_field" in productDraft.savedDraft),
      ttl_seconds: productDraft.ttl,
      expired_hidden: Array.isArray(productDraft.expired) && productDraft.expired.length === 0,
      explicit_delete: productDraft.deleted.length === 0,
    };
    assertCondition(
      productDraftReport.unknown_fields_removed
      && productDraftReport.ttl_seconds === PRODUCT_DRAFT_TTL_SECONDS
      && productDraftReport.expired_hidden
      && productDraftReport.explicit_delete,
      "product draft lifecycle diverged",
    );

    const urlResult = await withSchema(primary, schema, async (scoped) => {
      const cache = new DatabaseCacheService(scoped);
      const service = new LegacyContentService(scoped);
      await cache.set("uni_app_url", [{ name: "cached", url: "pages/cached/index", parameter: "from=cache" }]);
      const fallback = await service.uniAppUrls();
      await scoped.db.insert(systemGroup).values({
        id: 101,
        name: "UniApp routes",
        configName: "uni_app_link",
      });
      await scoped.db.insert(systemGroupData).values({
        id: 501,
        gid: 101,
        sort: 10,
        status: 1,
        value: JSON.stringify({
          name: { type: "input", value: "orders" },
          url: { type: "input", value: "pages/order/list" },
          parameter: { type: "input", value: "status=0" },
        }),
      });
      const active = await service.uniAppUrls();
      return { fallback, active };
    });
    const uniAppUrls = {
      cache_fallback: urlResult.fallback[0]?.url === "pages/cached/index",
      active_group_overrides_cache: urlResult.active.length === 1 && urlResult.active[0]?.url === "pages/order/list",
      legacy_fields_flattened: urlResult.active[0]?.name === "orders" && urlResult.active[0]?.parameter === "status=0",
    };
    assertCondition(Object.values(uniAppUrls).every(Boolean), "UniApp URL precedence diverged");

    const invalidJson = await withSchema(primary, schema, async (scoped) => {
      await scoped.db.update(legacyCache).set({ result: "{not-json" }).where(eq(legacyCache.key, "agent"));
      const fallback = await new LegacyContentService(scoped).agreement("agent");
      const rows = await scoped.db.select({ result: legacyCache.result }).from(legacyCache)
        .where(eq(legacyCache.key, "agent")).limit(1);
      return { fallback, row: rows[0] };
    });
    const invalidJsonReport = {
      fallback_returned: invalidJson.fallback === "",
      row_preserved: invalidJson.row?.result === "{not-json",
    };
    assertCondition(Object.values(invalidJsonReport).every(Boolean), "invalid JSON read performed an unsafe mutation");

    report = {
      server_version: version[0]?.server_version ?? "unknown",
      schema_created: true,
      safe_defaults: safeDefaults,
      atomic_save: atomicSave,
      atomic_rollback: atomicRollback,
      open_adv_upsert: openAdvUpsert,
      product_draft: productDraftReport,
      uni_app_urls: uniAppUrls,
      invalid_json: invalidJsonReport,
    };
  } finally {
    try {
      await Promise.all(clients.map((db) => db.$client.end({ timeout: 1 })));
      if (created) await adminDb.$client.unsafe(`DROP SCHEMA IF EXISTS ${identifier(schema)} CASCADE`);
      const rows = await adminDb.$client<{ removed: boolean }[]>`
        SELECT to_regnamespace(${schema}) IS NULL AS removed
      `;
      removed = rows[0]?.removed === true;
      after = await publicSnapshot(adminDb);
    } finally {
      await adminDb.$client.end({ timeout: 1 });
    }
  }
  assertCondition(report, "scenario did not produce a report");
  assertCondition(removed, "temporary schema was not removed");
  assertCondition(before && after, "public snapshots are missing");
  const publicUnchanged = JSON.stringify(before) === JSON.stringify(after);
  assertCondition(publicUnchanged, "public tables or sequences changed");
  return { ...report, schema_removed: removed, public_state_unchanged: publicUnchanged };
}
