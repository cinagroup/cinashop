/**
 * Searcher 注册表类型
 *
 * 对应 PHP ThinkPHP 的 search<Key>Attr($query, $value, $data) 模式。
 *
 * PHP 用反射自动路由: BaseDao::getSearchData() 检查模型是否有 searchKeyAttr 方法。
 * TS 这里改成显式注册表 (类型安全 + 无运行时反射开销)。
 *
 * 一个 searcher 接收当前 where 全量 data, 可基于其他字段做条件判断
 * (对应 PHP 的第 3 个参数 $data)。
 */
import type { SQL } from "drizzle-orm";
import type { AnyPgTable } from "drizzle-orm/pg-core";

/**
 * 单个 searcher: 给定值和完整 where, 返回一个 Drizzle SQL 条件。
 * 返回 undefined 表示该 searcher 在此值下不产生条件 (跳过)。
 *
 * @example
 * const searchers = {
 *   status: (value, data) => {
 *     if (value === 1) return and(eq(isShow,1), eq(isDel,0));
 *     return undefined;
 *   },
 *   keyword: (value, data) =>
 *     value ? like(storeName, `%${value}%`) : undefined,
 * };
 */
export type Searcher = (
  value: unknown,
  data: Record<string, unknown>,
) => SQL | undefined;

/** searcher 注册表: 字段名 → searcher 函数 */
export type SearcherMap<_T extends AnyPgTable> = Record<string, Searcher>;

/**
 * Where 输入: 业务侧传入的查询条件。
 * - 被 searcher 命中的 key → 走 searcher
 * - 未命中的 key → 自动转 eq(字段名, 值) (对应 PHP BaseDao::getSearchData 的兜底)
 */
export type WhereInput = Record<string, unknown>;
