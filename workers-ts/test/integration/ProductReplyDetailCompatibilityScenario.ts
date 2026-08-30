import { sql } from "drizzle-orm";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  type Container,
  type DbClient,
} from "@/lib/di";
import {
  storeProduct,
  storeProductReply,
  storeProductReplyComment,
  systemConfig,
  systemUserLevel,
  user,
  userRelation,
} from "@/models/schema";
import { ReplyService } from "@/services/product/ReplyService";
import { ValidateException } from "@/utils/errors";

export const PRODUCT_REPLY_SCHEMA_PREFIX = "codex_product_reply_";
export const PRODUCT_REPLY_TABLES = [
  "store_product",
  "store_product_reply",
  "store_product_reply_comment",
  "user",
  "user_relation",
  "system_user_level",
  "system_config",
] as const;

const PRIMARY_KEYS: Record<(typeof PRODUCT_REPLY_TABLES)[number], string> = {
  store_product: "id",
  store_product_reply: "id",
  store_product_reply_comment: "id",
  user: "uid",
  user_relation: "id",
  system_user_level: "id",
  system_config: "id",
};

const IDS = {
  userA: 1_721_000_001,
  userB: 1_721_000_002,
  rollbackUser: 1_721_000_003,
  level: 1_721_000_101,
  product: 1_721_000_201,
  visibleReply: 1_721_000_301,
  hiddenReply: 1_721_000_302,
  comment: 1_721_000_401,
  child: 1_721_000_402,
  deletedComment: 1_721_000_403,
  hiddenComment: 1_721_000_404,
} as const;

interface PublicFingerprint {
  tables: Record<string, { count: string; max_id: string | null; digest: string }>;
  sequences: Record<string, string | null>;
}

export interface ProductReplyDetailScenarioReport {
  server_version: string;
  schema_created: boolean;
  schema_removed: boolean;
  temporary_schemas_before: number;
  temporary_schemas_after: number;
  public_state_unchanged: boolean;
  assertions: {
    passed: number;
    total: number;
    detail_shape: boolean;
    view_atomic: boolean;
    visibility_fail_closed: boolean;
    comment_list: boolean;
    reply_insert: boolean;
    content_validation: boolean;
    like_idempotent: boolean;
    like_concurrent: boolean;
    unlike_idempotent: boolean;
    rollback_atomic: boolean;
    search_path_isolated: boolean;
    public_unchanged: boolean;
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
  if (!condition) throw new Error(`PRODUCT-REPLY integration failed: ${message}`);
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function makeSchemaName(): string {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return `${PRODUCT_REPLY_SCHEMA_PREFIX}${Date.now().toString(36)}_${random[0].toString(36)}`
    .slice(0, 63);
}

async function schemaCount(db: DbClient): Promise<number> {
  const rows = await db.$client<Array<{ count: number }>>`
    SELECT count(*)::integer AS count FROM pg_namespace
    WHERE starts_with(nspname, ${PRODUCT_REPLY_SCHEMA_PREFIX})
  `;
  return Number(rows[0]?.count ?? -1);
}

async function sequenceColumns(db: DbClient, schemaName = "public") {
  return db.$client<Array<{ table_name: string; column_name: string; sequence_name: string }>>`
    SELECT columns.table_name, columns.column_name,
      substring(columns.column_default from 'nextval\\(''([^'']+)''::regclass\\)') AS sequence_name
    FROM information_schema.columns AS columns
    WHERE columns.table_schema = ${schemaName}
      AND columns.table_name IN ${db.$client(PRODUCT_REPLY_TABLES)}
      AND columns.column_default LIKE 'nextval(%'
    ORDER BY columns.table_name, columns.column_name
  `;
}

async function publicFingerprint(db: DbClient): Promise<PublicFingerprint> {
  return db.$client.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
    await tx`SET LOCAL search_path TO public, pg_temp`;
    await tx`SET LOCAL lock_timeout = '2s'`;
    await tx`SET LOCAL statement_timeout = '30s'`;
    const tables: PublicFingerprint["tables"] = {};
    for (const table of PRODUCT_REPLY_TABLES) {
      const name = identifier(table);
      const key = identifier(PRIMARY_KEYS[table]);
      const rows = await tx.unsafe<Array<{ count: string; max_id: string | null; digest: string }>>(
        `SELECT count(*)::text AS count, max(source.${key})::text AS max_id,
          md5(COALESCE(sum(hashtextextended(to_jsonb(source)::text, 0)::numeric)::text, '')) AS digest
         FROM public.${name} AS source`,
      );
      invariant(rows[0], `could not fingerprint public.${table}`);
      tables[table] = rows[0];
    }
    const sequences = await tx<Array<{ name: string; last_value: string | null }>>`
      SELECT sequencename AS name, last_value::text
      FROM pg_sequences
      WHERE schemaname = 'public'
        AND sequencename IN (
          SELECT replace(substring(column_default from 'nextval\\(''([^'']+)''::regclass\\)'), 'public.', '')
          FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name IN ${tx(PRODUCT_REPLY_TABLES)}
            AND column_default LIKE 'nextval(%'
        )
      ORDER BY sequencename
    `;
    return { tables, sequences: Object.fromEntries(sequences.map((row) => [row.name, row.last_value])) };
  });
}

async function setupSchema(db: DbClient, schemaName: string): Promise<void> {
  const schema = identifier(schemaName);
  const serials = await sequenceColumns(db);
  invariant(serials.length === PRODUCT_REPLY_TABLES.length, "unexpected serial-column count");
  invariant(
    serials.every((row) => PRIMARY_KEYS[row.table_name as keyof typeof PRIMARY_KEYS] === row.column_name),
    "unexpected sequence-backed column",
  );
  await db.$client.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx`SET LOCAL statement_timeout = '30s'`;
    await tx.unsafe(`CREATE SCHEMA ${schema}`);
    for (const table of PRODUCT_REPLY_TABLES) {
      const name = identifier(table);
      await tx.unsafe(`CREATE TABLE ${schema}.${name} (LIKE public.${name} INCLUDING ALL)`);
    }
    for (const serial of serials) {
      const sequenceBase = serial.sequence_name.split(".").at(-1);
      invariant(sequenceBase, "missing public sequence name");
      const sequence = identifier(sequenceBase);
      const table = identifier(serial.table_name);
      const column = identifier(serial.column_name);
      await tx.unsafe(`CREATE SEQUENCE ${schema}.${sequence} START WITH 1730000000`);
      await tx.unsafe(`ALTER SEQUENCE ${schema}.${sequence} OWNED BY ${schema}.${table}.${column}`);
      await tx.unsafe(
        `ALTER TABLE ${schema}.${table} ALTER COLUMN ${column} `
        + `SET DEFAULT nextval('${schemaName}.${sequenceBase}'::regclass)`,
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
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DbClient;
    await tx.execute(sql.raw(`SET LOCAL search_path TO ${schema}, pg_temp`));
    await tx.execute(sql.raw("SET LOCAL TIME ZONE 'UTC'"));
    await tx.execute(sql.raw("SET LOCAL lock_timeout = '5s'"));
    await tx.execute(sql.raw("SET LOCAL statement_timeout = '45s'"));
    return callback(createContainerFromDb(tx));
  });
}

async function seed(container: Container): Promise<void> {
  const now = Math.floor(Date.parse("2026-08-30T00:00:00.000Z") / 1_000);
  await container.db.insert(systemConfig).values([
    { menuName: "site_name", value: "Audit Shop" },
    { menuName: "site_logo_square", value: "/audit-logo.png" },
    { menuName: "member_func_status", value: "1" },
    { menuName: "member_card_status", value: "1" },
  ]);
  await container.db.insert(systemUserLevel).values({
    id: IDS.level, name: "Gold", grade: 2, isShow: 1, isDel: 0,
  });
  await container.db.insert(user).values([
    {
      uid: IDS.userA, account: "audit-a", nickname: "Audit Alpha", avatar: "/a.png",
      level: IDS.level, status: 1, isDel: 0, isMoneyLevel: 1, isEverLevel: 1,
    },
    {
      uid: IDS.userB, account: "audit-b", nickname: "Audit Beta", avatar: "/b.png",
      status: 1, isDel: 0,
    },
  ]);
  await container.db.insert(storeProduct).values({
    id: IDS.product,
    storeName: "Audit product",
    image: "/product.png",
    isShow: 1,
    isVerify: 1,
    isDel: 0,
  });
  await container.db.insert(storeProductReply).values([
    {
      id: IDS.visibleReply,
      productId: IDS.product,
      uid: IDS.userA,
      nickname: "Audit Alpha",
      avatar: "/a.png",
      comment: "Visible review",
      sku: "Blue XL",
      productScore: 5,
      serviceScore: 4,
      logisticsScore: 3,
      deliveryScore: 3,
      pics: '["/review.png"]',
      praise: 0,
      viewsNum: 3,
      status: 1,
      isDel: 0,
      addTime: now,
    },
    {
      id: IDS.hiddenReply,
      productId: IDS.product,
      uid: IDS.userA,
      nickname: "Hidden",
      comment: "Hidden review",
      status: 0,
      isDel: 0,
      addTime: now,
    },
  ]);
  await container.db.insert(storeProductReplyComment).values([
    {
      id: IDS.comment, replyId: IDS.visibleReply, pid: 0, uid: IDS.userA,
      content: "Root reply", praise: 99, isDel: 0, addTime: now,
    },
    {
      id: IDS.child, replyId: IDS.visibleReply, pid: IDS.comment, uid: 0,
      content: "Merchant child", praise: 0, isDel: 0, addTime: now + 1,
    },
    {
      id: IDS.deletedComment, replyId: IDS.visibleReply, pid: 0, uid: IDS.userA,
      content: "Deleted reply", praise: 7, isDel: 1, addTime: now + 2,
    },
    {
      id: IDS.hiddenComment, replyId: IDS.hiddenReply, pid: 0, uid: IDS.userA,
      content: "Hidden parent reply", praise: 4, isDel: 0, addTime: now + 3,
    },
  ]);
}

async function commentState(container: Container) {
  const rows = await container.db.select({ praise: storeProductReplyComment.praise })
    .from(storeProductReplyComment).where(sql`${storeProductReplyComment.id} = ${IDS.comment}`).limit(1);
  const relations = await container.db.select({ id: userRelation.id }).from(userRelation).where(sql`
    ${userRelation.relationId} = ${IDS.comment}
    AND ${userRelation.type} = 'like' AND ${userRelation.category} = 'comment'
  `);
  invariant(rows[0], "fixture comment disappeared");
  return { praise: rows[0].praise, relationCount: relations.length };
}

async function installRollbackTrigger(db: DbClient, schemaName: string): Promise<void> {
  const schema = identifier(schemaName);
  await db.$client.begin(async (tx) => {
    await tx.unsafe(`CREATE FUNCTION ${schema}.reject_product_reply_audit_relation()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.uid = ${IDS.rollbackUser} THEN
          RAISE EXCEPTION 'isolated reply relation rejection';
        END IF;
        RETURN NEW;
      END $$`);
    await tx.unsafe(`CREATE TRIGGER reject_product_reply_audit_relation
      BEFORE INSERT ON ${schema}."user_relation"
      FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_product_reply_audit_relation()`);
  });
}

async function expectValidation(action: () => Promise<unknown>, message: string): Promise<boolean> {
  try {
    await action();
    return false;
  } catch (error) {
    return error instanceof ValidateException && error.message === message;
  }
}

async function dropSchema(db: DbClient, schemaName: string): Promise<void> {
  invariant(schemaName.startsWith(PRODUCT_REPLY_SCHEMA_PREFIX), "cleanup prefix guard failed");
  invariant(/^[a-z_][a-z0-9_]{0,62}$/.test(schemaName), "cleanup identifier guard failed");
  await db.$client.unsafe(`DROP SCHEMA ${identifier(schemaName)} CASCADE`);
}

export async function runProductReplyDetailCompatibilityScenario(
  connectionString: string,
): Promise<ProductReplyDetailScenarioReport> {
  const admin = createDbFromConnectionString(connectionString, 2, {
    applicationName: "cinashop_product_reply_isolated_admin",
  });
  const runtimeA = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_product_reply_isolated_a",
  });
  const runtimeB = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_product_reply_isolated_b",
  });
  const lockDb = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_product_reply_isolated_lock",
  });
  const schemaName = makeSchemaName();
  let before!: PublicFingerprint;
  let temporarySchemasBefore = -1;
  let schemaCreated = false;
  let schemaRemoved = false;
  let serverVersion = "";
  let advisoryLockAcquired = false;
  let assertions: ProductReplyDetailScenarioReport["assertions"] | undefined;

  try {
    const locks = await lockDb.$client<Array<{ locked: boolean }>>`
      SELECT pg_try_advisory_lock(1721, 7) AS locked
    `;
    advisoryLockAcquired = locks[0]?.locked === true;
    invariant(advisoryLockAcquired, "another isolated product-reply audit is running");
    const versions = await admin.$client<Array<{ version: string }>>`
      SELECT current_setting('server_version') AS version
    `;
    serverVersion = versions[0]?.version ?? "unknown";
    temporarySchemasBefore = await schemaCount(admin);
    before = await publicFingerprint(admin);
    await setupSchema(admin, schemaName);
    schemaCreated = true;

    const searchPathIsolated = await withSchema(admin, schemaName, async (container) => {
      const resolution = await container.db.execute(sql.raw(`
        SELECT current_setting('search_path') AS configured_path,
          current_schema() AS current_schema,
          (SELECT namespace.nspname FROM pg_class AS relation
            JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            WHERE relation.oid = to_regclass('store_product_reply')) AS resolved_schema
      `));
      const rows = Array.isArray(resolution)
        ? resolution
        : (resolution as { rows?: Array<Record<string, unknown>> }).rows ?? [];
      const row = rows[0] as Record<string, unknown> | undefined;
      await seed(container);
      return row?.configured_path === `${schemaName}, pg_temp`
        && row.current_schema === schemaName
        && row.resolved_schema === schemaName;
    });

    const base = await withSchema(runtimeA, schemaName, async (container) => {
      const service = new ReplyService(container);
      const detail = await service.replyInfo(IDS.visibleReply, IDS.userA);
      const stored = await container.db.select({ views: storeProductReply.viewsNum })
        .from(storeProductReply).where(sql`${storeProductReply.id} = ${IDS.visibleReply}`).limit(1);
      const list = await service.commentList(IDS.visibleReply, 1, 20, IDS.userA);
      const hiddenList = await service.commentList(IDS.hiddenReply, 1, 20, IDS.userA);
      const hiddenDetailRejected = await expectValidation(
        () => service.replyInfo(IDS.hiddenReply, IDS.userA),
        "查看的评论不存在",
      );
      const inserted = await service.replyComment(IDS.userA, IDS.visibleReply, "  New root reply  ");
      const insertedRows = await container.db.select().from(storeProductReplyComment)
        .where(sql`${storeProductReplyComment.id} = ${inserted.id}`).limit(1);
      const beforeInvalid = await container.db.select({ count: sql<number>`COUNT(*)::int` })
        .from(storeProductReplyComment);
      const invalid = [
        await expectValidation(() => service.replyComment(IDS.userA, IDS.visibleReply, "  "), "缺少回复内容"),
        await expectValidation(
          () => service.replyComment(IDS.userA, IDS.visibleReply, `bad\u0001text`),
          "回复内容包含非法字符",
        ),
        await expectValidation(
          () => service.replyComment(IDS.userA, IDS.visibleReply, "界".repeat(1_001)),
          "回复内容不能超过1000个字符",
        ),
      ];
      const afterInvalid = await container.db.select({ count: sql<number>`COUNT(*)::int` })
        .from(storeProductReplyComment);
      await service.praiseComment(IDS.userA, IDS.comment);
      await service.praiseComment(IDS.userA, IDS.comment);
      const liked = await commentState(container);
      return {
        detailShape: detail.reply.id === IDS.visibleReply
          && detail.reply.suk === "Blue XL"
          && detail.reply.comment_sum === 1
          && detail.reply.add_time === "2026-08-30 08:00:00"
          && detail.product.id === IDS.product
          && detail.user.level_name === "Gold"
          && detail.user.vip_status === 1
          && detail.star === "4"
          && detail.is_praise === false,
        viewAtomic: detail.reply.views_num === 3 && stored[0]?.views === 4,
        visibility: hiddenList.length === 0 && hiddenDetailRejected,
        commentList: list.length === 1
          && list[0]?.id === IDS.comment
          && list[0]?.children?.id === IDS.child
          && list[0]?.user.level_name === "Gold"
          && Boolean(list[0]?.children?.user.nickname)
          && list[0]?.children?.user.avatar === "/audit-logo.png",
        replyInsert: insertedRows[0]?.replyId === IDS.visibleReply
          && insertedRows[0]?.pid === 0
          && insertedRows[0]?.uid === IDS.userA
          && insertedRows[0]?.content === "New root reply",
        contentValidation: invalid.every(Boolean)
          && beforeInvalid[0]?.count === afterInvalid[0]?.count,
        likeIdempotent: liked.praise === 1 && liked.relationCount === 1,
      };
    });

    await Promise.all([
      withSchema(runtimeA, schemaName, (container) =>
        new ReplyService(container).praiseComment(IDS.userA, IDS.comment)),
      withSchema(runtimeB, schemaName, (container) =>
        new ReplyService(container).praiseComment(IDS.userB, IDS.comment)),
    ]);
    const concurrent = await withSchema(admin, schemaName, commentState);
    const likeConcurrent = concurrent.praise === 2 && concurrent.relationCount === 2;

    const unlikeIdempotent = await withSchema(runtimeA, schemaName, async (container) => {
      const service = new ReplyService(container);
      await service.unpraiseComment(IDS.userA, IDS.comment);
      await service.unpraiseComment(IDS.userA, IDS.comment);
      await service.unpraiseComment(IDS.userB, IDS.comment);
      await service.unpraiseComment(IDS.userB, IDS.comment);
      const state = await commentState(container);
      return state.praise === 0 && state.relationCount === 0;
    });

    await installRollbackTrigger(admin, schemaName);
    const rollbackAtomic = await withSchema(runtimeA, schemaName, async (container) => {
      const beforeState = await commentState(container);
      let rejected = false;
      try {
        await new ReplyService(container).praiseComment(IDS.rollbackUser, IDS.comment);
      } catch {
        rejected = true;
      }
      const afterState = await commentState(container);
      const deletedRejected = await expectValidation(
        () => new ReplyService(container).praiseComment(IDS.userA, IDS.deletedComment),
        "回复不存在",
      );
      const hiddenRejected = await expectValidation(
        () => new ReplyService(container).praiseComment(IDS.userA, IDS.hiddenComment),
        "回复不存在",
      );
      return rejected && deletedRejected && hiddenRejected
        && JSON.stringify(beforeState) === JSON.stringify(afterState);
    });

    assertions = {
      passed: 0,
      total: 12,
      detail_shape: base.detailShape,
      view_atomic: base.viewAtomic,
      visibility_fail_closed: base.visibility,
      comment_list: base.commentList,
      reply_insert: base.replyInsert,
      content_validation: base.contentValidation,
      like_idempotent: base.likeIdempotent,
      like_concurrent: likeConcurrent,
      unlike_idempotent: unlikeIdempotent,
      rollback_atomic: rollbackAtomic,
      search_path_isolated: searchPathIsolated,
      public_unchanged: false,
    };
    const failedAssertions = Object.entries(assertions)
      .filter(([key]) => key !== "passed" && key !== "total" && key !== "public_unchanged")
      .filter(([, value]) => value !== true)
      .map(([key]) => key);
    invariant(
      failedAssertions.length === 0,
      `isolated service assertions failed: ${failedAssertions.join(",")}`,
    );
  } finally {
    if (schemaCreated) {
      await dropSchema(admin, schemaName);
      schemaRemoved = true;
    }
    if (advisoryLockAcquired) {
      await lockDb.$client`SELECT pg_advisory_unlock(1721, 7)`;
    }
  }

  const after = await publicFingerprint(admin);
  const temporarySchemasAfter = await schemaCount(admin);
  const publicUnchanged = JSON.stringify(before) === JSON.stringify(after);
  invariant(publicUnchanged, "public rows or sequences changed during isolated audit");
  invariant(temporarySchemasAfter === temporarySchemasBefore, "temporary schema cleanup drifted");
  invariant(assertions, "isolated assertions were not produced");
  assertions.public_unchanged = publicUnchanged;
  assertions.passed = Object.entries(assertions)
    .filter(([key]) => key !== "passed" && key !== "total")
    .filter(([, value]) => value === true).length;
  invariant(assertions.passed === assertions.total, "assertion count mismatch");

  await Promise.all([
    admin.$client.end({ timeout: 5 }),
    runtimeA.$client.end({ timeout: 5 }),
    runtimeB.$client.end({ timeout: 5 }),
    lockDb.$client.end({ timeout: 5 }),
  ]);
  return {
    server_version: serverVersion,
    schema_created: schemaCreated,
    schema_removed: schemaRemoved,
    temporary_schemas_before: temporarySchemasBefore,
    temporary_schemas_after: temporarySchemasAfter,
    public_state_unchanged: publicUnchanged,
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
}
