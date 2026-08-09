/**
 * 请求参数解析助手
 *
 * 对应 PHP app/Request.php 的 getMore() —— 把 Hono 的查询参数/body
 * 按声明式 schema 提取为 {key: value}, 并支持:
 *   - 类型强制 (number / boolean / int)
 *   - 默认值
 *   - 输出 key 重命名 (对应 PHP ['keyword','','','store_name'] 第 4 元素)
 *
 * PHP 的 getMore 既支持关联数组 (suffix=false) 也支持位置数组 (suffix=true);
 * TS 这里只做关联数组, 位置数组在控制器里直接解构即可。
 */
import type { Context } from "hono";

/** 强制类型: d=int, f=float, b=bool, s=string (默认) */
export type Cast = "d" | "f" | "b" | "s";

/** 单个参数声明 */
export interface ParamSpec {
  /** 入参字段名 */
  name: string;
  /** 类型强制 */
  cast?: Cast;
  /** 默认值 (undefined 表示必填, 缺失抛 ValidateException) */
  default?: string | number | boolean | null;
  /** 输出 key (重命名), 默认等于 name */
  as?: string;
}

/** 简写: 字符串 = 必填字段; 元组 = [name, default?, cast?, as?] */
export type ParamDecl =
  | string
  | [string]
  | [string, SpecDefault]
  | [string, SpecDefault, Cast]
  | [string, SpecDefault, Cast, string];

type SpecDefault = string | number | boolean | null;

/** 把简写归一化为 ParamSpec */
function normalize(decl: ParamDecl): ParamSpec {
  if (typeof decl === "string") {
    return { name: decl, default: undefined };
  }
  const [name, def, cast, as] = decl;
  return { name, default: def, cast, as };
}

/** 类型强制 */
function castValue(raw: string, cast: Cast | undefined): unknown {
  if (raw === "" || raw === undefined || raw === null) return raw;
  switch (cast) {
    case "d": {
      const n = Number.parseInt(raw, 10);
      return Number.isNaN(n) ? 0 : n;
    }
    case "f": {
      const n = Number.parseFloat(raw);
      return Number.isNaN(n) ? 0 : n;
    }
    case "b":
      return raw === "1" || raw === "true" || raw === "on";
    case "s":
    default:
      return raw;
  }
}

/** 从 context 拿到原始值 (query 优先 GET, json 优先 POST) */
function pickRaw(c: Context, name: string): string | undefined {
  const method = c.req.method;
  // GET/HEAD/DELETE 只取 query
  if (method === "GET" || method === "HEAD" || method === "DELETE") {
    return c.req.query(name) ?? undefined;
  }
  // POST/PUT/PATCH: 优先 body, 兜底 query
  // 注意: parseBody 是 async 的, 这里改用同步的 raw().then 缓存
  // 为了保持 getMore 同步, 我们要求调用方先用 body 中间件把 body 注入 c.var
  const body = (c.get("body") ?? {}) as Record<string, unknown>;
  const v = body[name];
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v === null) return undefined;
  return c.req.query(name) ?? undefined;
}

/**
 * 声明式提取参数 → 关联对象
 *
 * @example
 * const where = getMore(c, [
 *   { name: "keyword", default: "", as: "store_name" },
 *   { name: "news", default: 0, cast: "d", as: "is_new" },
 * ]);
 * // → { store_name: string, is_new: number }
 */
export function getMore(
  c: Context,
  specs: (ParamSpec | ParamDecl)[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const decl of specs) {
    const spec = typeof decl === "string" ? normalize(decl) : "name" in decl ? decl : normalize(decl);
    const raw = pickRaw(c, spec.name);

    if (raw === undefined || raw === null || raw === "") {
      if (spec.default === undefined) {
        // 必填但缺失 → 留空字符串, 由 validate 层报错 (与 PHP 行为一致)
        out[spec.as ?? spec.name] = "";
      } else {
        out[spec.as ?? spec.name] = spec.default;
      }
      continue;
    }
    out[spec.as ?? spec.name] = castValue(raw, spec.cast);
  }
  return out;
}
