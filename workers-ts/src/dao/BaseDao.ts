/**
 * BaseDao —— 数据访问层基类
 *
 * 对应 PHP app/dao/BaseDao.php。核心能力:
 *   - search(where): 把 where 字典转为 Drizzle 查询, 自动路由到 searcher 或兜底 eq
 *   - get/count/be/value/save/update/delete 等 CRUD
 *   - inc/dec: 原子自增自减 (对应库存/余额操作)
 *
 * 与 PHP 不同: TS 用泛型绑定表结构, 类型安全; searcher 用注册表而非反射。
 *
 * 用法见 UserDao / StoreProductDao。
 */
import { and, eq, getTableColumns, sql, type SQL } from "drizzle-orm";
import type { AnyPgTable, PgColumn } from "drizzle-orm/pg-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { SearcherMap, WhereInput } from "@/models/searchers/types";
import { NotFoundException } from "@/utils/errors";

/** 统一 DB 类型 (postgres.js + Hyperdrive) */
export type DB = PostgresJsDatabase<Record<string, never>>;

/**
 * 每个 Dao 持有一个 Drizzle db 实例 (从 Hyperdrive 建立, app 装配时注入)。
 */
export abstract class BaseDao<TTable extends AnyPgTable> {
  constructor(
    protected readonly db: DB,
    protected readonly table: TTable,
    protected readonly searchers: SearcherMap<TTable> = {},
  ) {}

  /** 列映射 (每次获取, 类型宽松处理) */
  protected get cols(): Record<string, PgColumn> {
    return getTableColumns(this.table) as unknown as Record<string, PgColumn>;
  }

  /** 主键列 (约定所有表都用 id 或 uid 作主键, 子类可重写) */
  protected get pk(): PgColumn {
    return this.cols.id ?? this.cols.uid ?? Object.values(this.cols)[0]!;
  }

  // ─── search: 核心查询构建 ─────────────────────────────────

  /**
   * 把 where 字典合并为一组 SQL 条件。
   * - 命中 searcher 的 key → 调用 searcher
   * - 未命中的 key → 兜底 eq(列, 值); 列不存在则跳过 (与 PHP filterWhere 一致)
   */
  buildWhere(where: WhereInput): SQL | undefined {
    const conds: SQL[] = [];
    const columns = this.cols;
    for (const [key, value] of Object.entries(where)) {
      // undefined / null / 空字符串 → 跳过 (与 PHP 行为一致)
      if (value === undefined || value === null || value === "") continue;

      if (this.searchers[key]) {
        const cond = this.searchers[key](value, where);
        if (cond) conds.push(cond);
        continue;
      }

      // 兜底: 该字段是否真实存在
      const col = columns[key];
      if (col) {
        conds.push(eq(col, value as never));
      }
      // 不存在的字段直接忽略, 防止 SQL 报错
    }
    return conds.length ? and(...conds) : undefined;
  }

  // ─── 读 ───────────────────────────────────────────────────

  /** 按主键或条件取一条 */
  async get(
    id: number | WhereInput,
  ): Promise<TTable["$inferSelect"] | null> {
    const where =
      typeof id === "number"
        ? eq(this.pk, id as never)
        : this.buildWhere(id);

    const rows = await this.db
      .select()
      .from(this.table)
      .where(where ?? sql`true`)
      .limit(1);
    return (rows[0] as TTable["$inferSelect"] | undefined) ?? null;
  }

  /** 按条件取一条 (语义对齐 PHP getOne) */
  async getOne(where: WhereInput): Promise<TTable["$inferSelect"] | null> {
    return this.get(where);
  }

  /** 是否存在 */
  async be(where: WhereInput): Promise<boolean> {
    const cond = this.buildWhere(where);
    const rows = await this.db
      .select({ c: sql<number>`1` })
      .from(this.table)
      .where(cond ?? sql`true`)
      .limit(1);
    return rows.length > 0;
  }

  /** 取单个字段值 */
  async value<K extends keyof TTable["$inferSelect"] & string>(
    where: WhereInput,
    field: K,
  ): Promise<TTable["$inferSelect"][K] | null> {
    const row = await this.getOne(where);
    return (row?.[field] as TTable["$inferSelect"][K] | undefined) ?? null;
  }

  /** count */
  async count(where: WhereInput = {}): Promise<number> {
    const cond = this.buildWhere(where);
    const rows = await this.db
      .select({ c: sql<number>`count(*)::int` })
      .from(this.table)
      .where(cond ?? sql`true`);
    return rows[0]?.c ?? 0;
  }

  /**
   * 列表查询 (对应 PHP BaseDao::selectList)
   * 分页在 service 层用 getPageValue 算好后传入。
   */
  async selectList(opts: {
    where?: WhereInput;
    page?: number;
    limit?: number;
    orderBy?: SQL;
  }): Promise<TTable["$inferSelect"][]> {
    const cond = opts.where ? this.buildWhere(opts.where) : undefined;
    let q = this.db
      .select()
      .from(this.table)
      .where(cond ?? sql`true`)
      .$dynamic();

    if (opts.page && opts.limit) {
      q = q.limit(opts.limit).offset((opts.page - 1) * opts.limit);
    }
    if (opts.orderBy) {
      q = q.orderBy(opts.orderBy);
    }
    return (await q) as TTable["$inferSelect"][];
  }

  // ─── 写 ───────────────────────────────────────────────────

  /** insert (对应 PHP save) */
  async save(
    data: Partial<TTable["$inferInsert"]>,
  ): Promise<TTable["$inferSelect"]> {
    const rows = await this.db
      .insert(this.table)
      .values(data as never)
      .returning();
    if (!rows[0]) throw new Error("insert returned no row");
    return rows[0] as TTable["$inferSelect"];
  }

  /** update (按主键或条件) */
  async update(
    id: number | WhereInput,
    data: Partial<TTable["$inferInsert"]>,
  ): Promise<void> {
    const where =
      typeof id === "number" ? eq(this.pk, id as never) : this.buildWhere(id);
    await this.db
      .update(this.table)
      .set(data as never)
      .where(where ?? sql`true`);
  }

  /** delete (硬删除; 软删除用 update deleteTime) */
  async delete(id: number | WhereInput): Promise<void> {
    const where =
      typeof id === "number" ? eq(this.pk, id as never) : this.buildWhere(id);
    await this.db.delete(this.table).where(where ?? sql`true`);
  }

  /**
   * 软删除 (对应 PHP destroy + SoftDelete trait)
   */
  async softDelete(id: number): Promise<void> {
    await this.update(id, {
      deleteTime: new Date(),
    } as Partial<TTable["$inferInsert"]>);
  }

  // ─── 原子操作 (对应 PHP BaseDao::bc/bcInc/bcDec) ──────────

  /**
   * 原子自增字段 (对应 bcInc)。
   * 用 SQL: UPDATE ... SET field = field + n WHERE <cond>
   */
  async inc(
    where: WhereInput,
    field: keyof TTable["$inferInsert"] & string,
    n: number,
  ): Promise<void> {
    const cond = this.buildWhere(where);
    const col = this.cols[field];
    if (!col) throw new Error(`字段不存在: ${field}`);
    await this.db
      .update(this.table)
      .set({
        [field]: sql`${col} + ${n}`,
      } as never)
      .where(cond ?? sql`true`);
  }

  /**
   * 原子自减, 带"够减"守卫 (修复 PHP 现有超卖 bug)。
   * SQL: UPDATE ... SET field = field - n WHERE <cond> AND field >= n
   * 返回是否实际更新 (false = 不够减)。
   *
   * 这就是计划里提到的关键修复: PHP StoreProductAttrValueDao.php:62 缺这个守卫。
   */
  async dec(
    where: WhereInput,
    field: keyof TTable["$inferInsert"] & string,
    n: number,
  ): Promise<boolean> {
    const condBase = this.buildWhere(where);
    const col = this.cols[field];
    if (!col) throw new Error(`字段不存在: ${field}`);

    // 完整 WHERE = 基础条件 AND field >= n
    const fullCond = condBase
      ? and(condBase, sql`${col} >= ${n}`)
      : sql`${col} >= ${n}`;

    const rows = await this.db
      .update(this.table)
      .set({
        [field]: sql`${col} - ${n}`,
      } as never)
      .where(fullCond)
      .returning({ updated: sql<number>`1` });
    return rows.length > 0;
  }

  // ─── 辅助 ─────────────────────────────────────────────────

  /** 取不到则抛 NotFoundException (service 层常用) */
  async getOrThrow(
    id: number | WhereInput,
    msg = "数据不存在",
  ): Promise<TTable["$inferSelect"]> {
    const row = await this.get(id);
    if (!row) throw new NotFoundException(msg);
    return row;
  }
}
