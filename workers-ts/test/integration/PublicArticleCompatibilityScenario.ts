import { sql } from "drizzle-orm";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  type Container,
  type DbClient,
} from "@/lib/di";
import {
  articleCategory,
  articleContent,
  storeProduct,
  systemArticle,
  userRelation,
  wechatNewsCategory,
} from "@/models/schema";
import { AuthException } from "@/utils/errors";
import {
  PublicArticleCompatibilityService,
  PublicArticleUnavailableException,
} from "@/services/content/PublicArticleCompatibilityService";

export const PUBLIC_ARTICLE_SCHEMA_PREFIX = "codex_public_article_";
export const PUBLIC_ARTICLE_TABLES = [
  "system_article",
  "article_category",
  "article_content",
  "store_product",
  "wechat_news_category",
  "user_relation",
] as const;

const PRIMARY_KEYS: Record<(typeof PUBLIC_ARTICLE_TABLES)[number], string> = {
  system_article: "id",
  article_category: "id",
  article_content: "nid",
  store_product: "id",
  wechat_news_category: "id",
  user_relation: "id",
};

const SERIAL_TABLES = [
  "system_article",
  "article_category",
  "store_product",
  "wechat_news_category",
  "user_relation",
] as const;

const IDS = {
  category: 1_620_000_001,
  secondCategory: 1_620_000_002,
  hiddenCategory: 1_620_000_003,
  product: 1_620_000_101,
  mainArticle: 1_620_001_001,
  bundledArticle: 1_620_001_002,
  newestArticle: 1_620_001_003,
  inactiveArticle: 1_620_001_004,
  hiddenArticle: 1_620_001_005,
  deletedArticle: 1_620_001_006,
  news: 1_620_002_001,
  relation: 1_620_003_001,
  uid: 1_620_004_001,
  rollbackUid: 1_620_004_002,
} as const;

interface PublicFingerprint {
  tables: Record<string, { count: string; max_id: string | null; digest: string }>;
  sequences: Record<string, string | null>;
}

export interface PublicArticleScenarioReport {
  server_version: string;
  schema_created: boolean;
  schema_removed: boolean;
  temporary_schemas_before: number;
  temporary_schemas_after: number;
  public_state_unchanged: boolean;
  assertions: {
    passed: number;
    total: number;
    categories: boolean;
    list_contracts: boolean;
    visibility_fail_closed: boolean;
    body_product_category: boolean;
    visit_atomic: boolean;
    like_idempotent: boolean;
    like_concurrent: boolean;
    anonymous_like_rejected: boolean;
    rollback_atomic: boolean;
    search_path_isolated: boolean;
  };
  guarantees: {
    isolated_schema_ddl_and_fixture_dml_executed: true;
    public_schema_ddl_or_dml_executed: false;
    public_business_rows_or_sequences_changed: false;
    single_flight_advisory_lock: true;
    public_fingerprints_are_bounded_read_only_snapshots: true;
    concurrent_public_writes_can_fail_verification: true;
    fingerprints_returned: false;
    business_ids_returned: false;
  };
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`PUBLIC-ARTICLE integration failed: ${message}`);
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function makeSchemaName(): string {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return `${PUBLIC_ARTICLE_SCHEMA_PREFIX}${Date.now().toString(36)}_${random[0].toString(36)}`
    .slice(0, 63);
}

async function schemaCount(db: DbClient): Promise<number> {
  const rows = await db.$client<Array<{ count: number }>>`
    SELECT count(*)::integer AS count
    FROM pg_namespace
    WHERE starts_with(nspname, ${PUBLIC_ARTICLE_SCHEMA_PREFIX})
  `;
  return Number(rows[0]?.count ?? -1);
}

async function publicFingerprint(db: DbClient): Promise<PublicFingerprint> {
  return db.$client.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
    await tx`SET LOCAL search_path TO public, pg_temp`;
    await tx`SET LOCAL lock_timeout = '2s'`;
    await tx`SET LOCAL statement_timeout = '30s'`;
    const tables: PublicFingerprint["tables"] = {};
    for (const table of PUBLIC_ARTICLE_TABLES) {
      const name = identifier(table);
      const key = identifier(PRIMARY_KEYS[table]);
      const rows = await tx.unsafe<Array<{
        count: string;
        max_id: string | null;
        digest: string;
      }>>(
        `SELECT count(*)::text AS count,
          max(source.${key})::text AS max_id,
          md5(COALESCE(sum(hashtextextended(to_jsonb(source)::text, 0)::numeric)::text, '')) AS digest
         FROM public.${name} AS source`,
      );
      invariant(rows[0], `could not fingerprint public.${table}`);
      tables[table] = rows[0];
    }

    const sequenceNames = SERIAL_TABLES.map((table) => `${table}_id_seq`);
    const rows = await tx<Array<{ sequencename: string; last_value: string | null }>>`
      SELECT sequencename, last_value::text
      FROM pg_sequences
      WHERE schemaname = 'public' AND sequencename = ANY(${sequenceNames})
      ORDER BY sequencename
    `;
    const byName = new Map(rows.map((row) => [row.sequencename, row.last_value]));
    return {
      tables,
      sequences: Object.fromEntries(sequenceNames.map((name) => [name, byName.get(name) ?? null])),
    };
  });
}

async function setupSchema(db: DbClient, schemaName: string): Promise<void> {
  const schema = identifier(schemaName);
  await db.$client.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx`SET LOCAL statement_timeout = '30s'`;
    const sequenceBackedColumns = await tx<Array<{
      table_name: string;
      column_name: string;
      is_identity: string;
    }>>`
      SELECT table_name, column_name, is_identity
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ${tx(PUBLIC_ARTICLE_TABLES)}
        AND (is_identity = 'YES' OR column_default LIKE 'nextval(%')
      ORDER BY table_name, column_name
    `;
    const expectedSequenceColumns = SERIAL_TABLES
      .map((table) => `${table}.id`)
      .sort();
    const actualSequenceColumns = sequenceBackedColumns
      .map((column) => `${column.table_name}.${column.column_name}`)
      .sort();
    invariant(
      JSON.stringify(actualSequenceColumns) === JSON.stringify(expectedSequenceColumns),
      "unexpected production sequence-backed column; refusing an unsafe clone",
    );
    invariant(
      sequenceBackedColumns.every((column) => column.is_identity === "NO"),
      "identity-backed columns require a dedicated isolated clone path",
    );
    await tx.unsafe(`CREATE SCHEMA ${schema}`);
    for (const table of PUBLIC_ARTICLE_TABLES) {
      const name = identifier(table);
      await tx.unsafe(`CREATE TABLE ${schema}.${name} (LIKE public.${name} INCLUDING ALL)`);
    }
    for (const table of SERIAL_TABLES) {
      const name = identifier(table);
      const sequenceName = `${table}_id_seq`;
      const sequence = identifier(sequenceName);
      await tx.unsafe(`CREATE SEQUENCE ${schema}.${sequence} START WITH 1700000000`);
      await tx.unsafe(`ALTER SEQUENCE ${schema}.${sequence} OWNED BY ${schema}.${name}."id"`);
      await tx.unsafe(
        `ALTER TABLE ${schema}.${name} ALTER COLUMN "id" `
        + `SET DEFAULT nextval('${schemaName}.${sequenceName}'::regclass)`,
      );
    }
    const reboundColumns = await tx<Array<{
      table_name: string;
      column_name: string;
      column_default: string | null;
    }>>`
      SELECT table_name, column_name, column_default
      FROM information_schema.columns
      WHERE table_schema = ${schemaName}
        AND (is_identity = 'YES' OR column_default LIKE 'nextval(%')
      ORDER BY table_name, column_name
    `;
    invariant(reboundColumns.length === SERIAL_TABLES.length, "isolated sequence count drifted");
    for (const column of reboundColumns) {
      invariant(
        column.column_name === "id"
          && SERIAL_TABLES.includes(column.table_name as (typeof SERIAL_TABLES)[number])
          && (column.column_default ?? "").includes(`${schemaName}.${column.table_name}_id_seq`),
        "isolated serial default still points outside its schema",
      );
    }
  });
}

async function withSchema<T>(
  db: DbClient,
  schemaName: string,
  callback: (container: Container) => Promise<T>,
): Promise<T> {
  const schema = identifier(schemaName);
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as DbClient;
    await tx.execute(sql.raw(`SET LOCAL search_path TO ${schema}, pg_temp`));
    await tx.execute(sql.raw("SET LOCAL TIME ZONE 'UTC'"));
    await tx.execute(sql.raw("SET LOCAL lock_timeout = '3s'"));
    await tx.execute(sql.raw("SET LOCAL statement_timeout = '30s'"));
    const resolution = await tx.execute(sql.raw(
      `SELECT current_setting('search_path') AS configured_path,
        current_schema() AS current_schema,
        (SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.oid = to_regclass('system_article')) AS resolved_schema`,
    ));
    const rows = Array.isArray(resolution)
      ? resolution
      : (resolution as { rows?: Array<Record<string, unknown>> }).rows ?? [];
    const row = rows[0] as Record<string, unknown> | undefined;
    invariant(row?.configured_path === `${schemaName}, pg_temp`, "search_path is not target, pg_temp");
    invariant(row?.current_schema === schemaName, "current schema escaped target");
    invariant(row?.resolved_schema === schemaName, "unqualified article table escaped target");
    return callback(createContainerFromDb(tx));
  });
}

async function seed(container: Container): Promise<void> {
  const now = Math.floor(Date.parse("2026-08-30T00:00:00.000Z") / 1_000);
  await container.db.insert(articleCategory).values([
    { id: IDS.category, title: "Visible", status: 1, sort: 5, isDel: 0, hidden: 0 },
    { id: IDS.secondCategory, title: "Second", status: 1, sort: 10, isDel: 0, hidden: 0 },
    { id: IDS.hiddenCategory, title: "Hidden", status: 1, sort: 50, isDel: 0, hidden: 1 },
  ]);
  await container.db.insert(storeProduct).values({
    id: IDS.product,
    storeName: "Fixture product",
    image: "/api/assets/fixture",
    price: "19.90",
    otPrice: "29.90",
    isShow: 1,
    isDel: 0,
    isVerify: 1,
  });
  await container.db.insert(systemArticle).values([
    {
      id: IDS.mainArticle,
      cid: IDS.category,
      title: "Main",
      content: "",
      synopsis: "Main synopsis",
      imageInput: "cover-a,cover-b",
      visit: 5,
      likes: 99,
      addTime: now,
      productId: IDS.product,
      isHot: 1,
      status: 1,
      hide: 0,
      isDel: 0,
    },
    {
      id: IDS.bundledArticle,
      cid: IDS.category,
      title: "Bundled",
      content: "Bundled body",
      synopsis: "Bundled synopsis",
      imageInput: "",
      addTime: now + 100,
      isHot: 1,
      isBanner: 1,
      status: 1,
      hide: 0,
      isDel: 0,
    },
    {
      id: IDS.newestArticle,
      cid: IDS.secondCategory,
      title: "Newest",
      content: "Newest body",
      synopsis: "Newest synopsis",
      imageInput: "newest-cover",
      addTime: now + 200,
      isBanner: 1,
      status: 1,
      hide: 0,
      isDel: 0,
    },
    {
      id: IDS.inactiveArticle,
      cid: IDS.category,
      title: "Inactive",
      addTime: now + 300,
      status: 0,
      hide: 0,
      isDel: 0,
    },
    {
      id: IDS.hiddenArticle,
      cid: IDS.category,
      title: "Hidden",
      addTime: now + 400,
      status: 1,
      hide: 1,
      isDel: 0,
    },
    {
      id: IDS.deletedArticle,
      cid: IDS.category,
      title: "Deleted",
      addTime: now + 500,
      status: 1,
      hide: 0,
      isDel: 1,
    },
  ]);
  await container.db.insert(articleContent).values({
    nid: IDS.mainArticle,
    content: "<p>Fallback body</p>",
  });
  await container.db.insert(wechatNewsCategory).values({
    id: IDS.news,
    cateName: "Bundle",
    status: 1,
    newId: `000${IDS.bundledArticle},bad,999999999999999999999999999`,
    addTime: String(now),
  });
  await container.db.insert(userRelation).values({
    id: IDS.relation,
    uid: IDS.uid,
    relationId: IDS.mainArticle,
    type: "like",
    category: "article",
    addTime: now,
  });
}

async function rowState(container: Container) {
  const articleRows = await container.db
    .select({ visit: systemArticle.visit, likes: systemArticle.likes })
    .from(systemArticle)
    .where(sql`${systemArticle.id} = ${IDS.mainArticle}`)
    .limit(1);
  const relationRows = await container.db
    .select({ id: userRelation.id })
    .from(userRelation)
    .where(sql`${userRelation.relationId} = ${IDS.mainArticle}
      AND ${userRelation.type} = 'like' AND ${userRelation.category} = 'article'`);
  invariant(articleRows[0], "fixture article disappeared");
  return { ...articleRows[0], relationCount: relationRows.length };
}

async function installRollbackTrigger(db: DbClient, schemaName: string): Promise<void> {
  const schema = identifier(schemaName);
  await db.$client.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx.unsafe(`CREATE FUNCTION ${schema}.reject_public_article_audit_relation()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.uid = ${IDS.rollbackUid} THEN
          RAISE EXCEPTION 'isolated article relation rejection';
        END IF;
        RETURN NEW;
      END $$`);
    await tx.unsafe(`CREATE TRIGGER reject_public_article_audit_relation
      BEFORE INSERT ON ${schema}."user_relation"
      FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_public_article_audit_relation()`);
  });
}

async function expectUnavailable(action: () => Promise<unknown>): Promise<boolean> {
  try {
    await action();
    return false;
  } catch (error) {
    return error instanceof PublicArticleUnavailableException
      && error.code === 400
      && Array.isArray(error.data)
      && error.data.length === 0;
  }
}

async function expectAuthFailure(action: () => Promise<unknown>): Promise<boolean> {
  try {
    await action();
    return false;
  } catch (error) {
    return error instanceof AuthException;
  }
}

async function dropSchema(db: DbClient, schemaName: string): Promise<void> {
  invariant(schemaName.startsWith(PUBLIC_ARTICLE_SCHEMA_PREFIX), "cleanup prefix guard failed");
  invariant(/^[a-z_][a-z0-9_]{0,62}$/.test(schemaName), "cleanup identifier guard failed");
  await db.$client.unsafe(`DROP SCHEMA ${identifier(schemaName)} CASCADE`);
}

export async function runPublicArticleCompatibilityScenario(
  connectionString: string,
): Promise<PublicArticleScenarioReport> {
  const adminDb = createDbFromConnectionString(connectionString, 2, {
    applicationName: "cinashop_public_article_isolated_admin",
  });
  const runtimeA = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_public_article_isolated_a",
  });
  const runtimeB = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_public_article_isolated_b",
  });
  const lockDb = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_public_article_isolated_lock",
  });
  const schemaName = makeSchemaName();
  let before!: PublicFingerprint;
  let temporarySchemasBefore = -1;
  let schemaCreated = false;
  let schemaRemoved = false;
  let assertions: PublicArticleScenarioReport["assertions"] | undefined;
  let serverVersion = "";
  let advisoryLockAcquired = false;

  try {
    const lockRows = await lockDb.$client<Array<{ acquired: boolean }>>`
      SELECT pg_try_advisory_lock(1346981441, 1381258324) AS acquired
    `;
    invariant(lockRows[0]?.acquired === true, "another PUBLIC-ARTICLE scenario is already running");
    advisoryLockAcquired = true;
    before = await publicFingerprint(adminDb);
    temporarySchemasBefore = await schemaCount(adminDb);
    let scenarioFailure: unknown;
    let cleanupFailure: unknown;
    try {
      const versionRows = await adminDb.$client<Array<{ value: string }>>`
      SELECT current_setting('server_version') AS value
    `;
      serverVersion = versionRows[0]?.value ?? "unknown";
      await setupSchema(adminDb, schemaName);
      schemaCreated = true;
      await withSchema(runtimeA, schemaName, seed);

    const basic = await withSchema(runtimeA, schemaName, async (container) => {
      const service = new PublicArticleCompatibilityService(container);
      const categories = await service.categories();
      const categoryList = await service.list(IDS.category, { page: "1", limit: "10" });
      const allList = await service.list(0, {});
      const hot = await service.hot({});
      const newest = await service.newest({});
      const banner = await service.banner({});
      const detail = await service.details(IDS.uid, IDS.mainArticle);
      const hiddenRejected = await expectUnavailable(() => service.details(IDS.uid, IDS.hiddenArticle));
      const inactiveRejected = await expectUnavailable(() => service.details(IDS.uid, IDS.inactiveArticle));
      const deletedRejected = await expectUnavailable(() => service.details(IDS.uid, IDS.deletedArticle));
      const anonymousRejected = await expectAuthFailure(() => service.like(0, IDS.mainArticle, 1));

      const categoryOk = categories.length === 3
        && categories[0]?.id === 0
        && categories[0]?.title === "热门"
        && categories[1]?.id === IDS.secondCategory
        && categories[2]?.id === IDS.category;
      const listOk = categoryList.length === 1
        && categoryList[0]?.id === IDS.mainArticle
        && categoryList[0]?.visit === "5"
        && categoryList[0]?.likes === 99
        && !hot.some((item) => Object.hasOwn(item, "likes"))
        && !newest.some((item) => Object.hasOwn(item, "likes"))
        && !banner.some((item) => Object.hasOwn(item, "likes"))
        && hot.length === 2
        && newest.length === 3
        && banner.length === 2
        && allList.length === 2
        && !allList.some((item) => item.id === IDS.bundledArticle);
      const detailOk = detail.content === "<p>Fallback body</p>"
        && detail.catename === "Visible"
        && (detail.store_info as Record<string, unknown> | null)?.id === IDS.product
        && detail.is_like === true
        && detail.visit === 6
        && Array.isArray(detail.image_input);
      return {
        categoryOk,
        listOk,
        detailOk,
        visibilityOk: hiddenRejected && inactiveRejected && deletedRejected,
        anonymousRejected,
      };
    });

    const concurrentDetails = await Promise.all([
      withSchema(runtimeA, schemaName, (container) =>
        new PublicArticleCompatibilityService(container).details(IDS.uid, IDS.mainArticle)),
      withSchema(runtimeB, schemaName, (container) =>
        new PublicArticleCompatibilityService(container).details(IDS.uid, IDS.mainArticle)),
    ]);
    const afterDetails = await withSchema(runtimeA, schemaName, rowState);
    const visitValues = concurrentDetails.map((item) => Number(item.visit)).sort((a, b) => a - b);
    const visitAtomic = visitValues[0] === 7 && visitValues[1] === 8 && afterDetails.visit === 8;

    const likeIdempotent = await withSchema(runtimeA, schemaName, async (container) => {
      const service = new PublicArticleCompatibilityService(container);
      await service.like(IDS.uid, IDS.mainArticle, 1);
      await service.like(IDS.uid, IDS.mainArticle, 1);
      const afterAdd = await rowState(container);
      await service.like(IDS.uid, IDS.mainArticle, 0);
      await service.like(IDS.uid, IDS.mainArticle, 0);
      const afterCancel = await rowState(container);
      return afterAdd.likes === 1 && afterAdd.relationCount === 1
        && afterCancel.likes === 0 && afterCancel.relationCount === 0;
    });

    await Promise.all([
      withSchema(runtimeA, schemaName, (container) =>
        new PublicArticleCompatibilityService(container).like(IDS.uid, IDS.mainArticle, 1)),
      withSchema(runtimeB, schemaName, (container) =>
        new PublicArticleCompatibilityService(container).like(IDS.uid, IDS.mainArticle, 1)),
    ]);
    const afterConcurrentLike = await withSchema(runtimeA, schemaName, rowState);
    const likeConcurrent = afterConcurrentLike.likes === 1 && afterConcurrentLike.relationCount === 1;

    await withSchema(runtimeA, schemaName, (container) =>
      new PublicArticleCompatibilityService(container).like(IDS.uid, IDS.mainArticle, 0));
    await installRollbackTrigger(adminDb, schemaName);
    const beforeRollback = await withSchema(runtimeA, schemaName, rowState);
    let triggerRejected = false;
    try {
      await withSchema(runtimeA, schemaName, (container) =>
        new PublicArticleCompatibilityService(container).like(IDS.rollbackUid, IDS.mainArticle, 1));
    } catch {
      triggerRejected = true;
    }
    const afterRollback = await withSchema(runtimeA, schemaName, rowState);
    const rollbackAtomic = triggerRejected
      && JSON.stringify(beforeRollback) === JSON.stringify(afterRollback);

    const checks = [
      basic.categoryOk,
      basic.listOk,
      basic.visibilityOk,
      basic.detailOk,
      visitAtomic,
      likeIdempotent,
      likeConcurrent,
      basic.anonymousRejected,
      rollbackAtomic,
      true,
    ];
    checks.forEach((value, index) => invariant(value, `assertion ${index + 1} failed`));
      assertions = {
        passed: checks.filter(Boolean).length,
        total: checks.length,
        categories: basic.categoryOk,
        list_contracts: basic.listOk,
        visibility_fail_closed: basic.visibilityOk,
        body_product_category: basic.detailOk,
        visit_atomic: visitAtomic,
        like_idempotent: likeIdempotent,
        like_concurrent: likeConcurrent,
        anonymous_like_rejected: basic.anonymousRejected,
        rollback_atomic: rollbackAtomic,
        search_path_isolated: true,
      };
    } catch (error) {
      scenarioFailure = error;
    } finally {
      if (schemaCreated) {
        try {
          await dropSchema(adminDb, schemaName);
          schemaRemoved = true;
        } catch (error) {
          cleanupFailure = error;
        }
      }
    }

    let temporarySchemasAfter = -1;
    let publicStateUnchanged = false;
    let verificationFailure: unknown;
    try {
      const after = await publicFingerprint(adminDb);
      temporarySchemasAfter = await schemaCount(adminDb);
      publicStateUnchanged = JSON.stringify(before) === JSON.stringify(after);
      invariant(!schemaCreated || schemaRemoved, "temporary schema was not removed");
      invariant(temporarySchemasAfter === temporarySchemasBefore, "temporary schema count changed");
      invariant(publicStateUnchanged, "public rows or sequences changed");
    } catch (error) {
      verificationFailure = error;
    }
    const failures = [scenarioFailure, cleanupFailure, verificationFailure]
      .filter((error): error is NonNullable<unknown> => error !== undefined);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "PUBLIC-ARTICLE scenario and cleanup verification failed");
    }
    invariant(assertions, "scenario assertions did not complete");

    return {
      server_version: serverVersion,
      schema_created: schemaCreated,
      schema_removed: schemaRemoved,
      temporary_schemas_before: temporarySchemasBefore,
      temporary_schemas_after: temporarySchemasAfter,
      public_state_unchanged: publicStateUnchanged,
      assertions,
      guarantees: {
        isolated_schema_ddl_and_fixture_dml_executed: true,
        public_schema_ddl_or_dml_executed: false,
        public_business_rows_or_sequences_changed: false,
        single_flight_advisory_lock: true,
        public_fingerprints_are_bounded_read_only_snapshots: true,
        concurrent_public_writes_can_fail_verification: true,
        fingerprints_returned: false,
        business_ids_returned: false,
      },
    };
  } finally {
    if (advisoryLockAcquired) {
      await lockDb.$client`
        SELECT pg_advisory_unlock(1346981441, 1381258324)
      `.catch(() => undefined);
    }
    await Promise.all([
      runtimeA.$client.end({ timeout: 1 }).catch(() => undefined),
      runtimeB.$client.end({ timeout: 1 }).catch(() => undefined),
      adminDb.$client.end({ timeout: 1 }).catch(() => undefined),
      lockDb.$client.end({ timeout: 1 }).catch(() => undefined),
    ]);
  }
}
