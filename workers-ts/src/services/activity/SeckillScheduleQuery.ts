import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { storeSeckill } from "@/models/schema";
import { ValidateException } from "@/utils/errors";

// SQL companion to SeckillScheduleService, checked against its pure policy on real SQL.
// ECMAScript trim whitespace (all BMP), not PostgreSQL's locale-dependent \s class.
const TRIM = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

/** Invalid CSV yields an empty set. Nested CASE protects casts regardless of planner order. */
function ids(column: SQLWrapper): SQL {
  return sql`(SELECT CASE WHEN count(*) BETWEEN 1 AND 64 AND bool_and(parsed.id IS NOT NULL)
    THEN array_agg(parsed.id) ELSE '{}'::integer[] END
    FROM (SELECT CASE WHEN trimmed.raw ~ '^[1-9][0-9]{0,9}$'
      THEN CASE WHEN trimmed.raw::bigint <= 2147483647 THEN trimmed.raw::integer END END AS id
      FROM (SELECT btrim(tokens.value, ${TRIM}) AS raw
        FROM unnest(string_to_array(CASE WHEN char_length(${column}) <= 1024 THEN ${column} ELSE '' END, ',')) AS tokens(value)
      ) AS trimmed
    ) AS parsed)`;
}

function minutes(column: SQLWrapper, end = false): SQL {
  const pattern = end ? '^(([01][0-9]|2[0-3]):?[0-5][0-9]|24:?00)$' : '^([01][0-9]|2[0-3]):?[0-5][0-9]$';
  return sql`CASE WHEN ${column} ~ ${pattern} THEN
    left(replace(${column}, ':', ''), 2)::integer * 60 + right(${column}, 2)::integer END`;
}

function instant(column: SQLWrapper, end: boolean): SQL {
  return sql`CASE WHEN ${column} IS NULL THEN ${end ? "Infinity" : "-Infinity"}::numeric
    WHEN isfinite(${column}) THEN floor(extract(epoch FROM ${column}) * 1000) END`;
}

/** Browse a requested slot during the current date window, even before/after its daily session.
 * All eligibility filtering happens BEFORE LIMIT/OFFSET. No application-side short-page filter.
 * Does not grant product visibility, stock, price or per-user purchase authority.
 */
export function seckillCatalogSchedulePredicate(timeId: string, now = new Date()): SQL {
  if (typeof timeId !== "string" || !/^[1-9]\d{0,9}$/.test(timeId) || Number(timeId) > 2_147_483_647 || !Number.isFinite(now.getTime())) {
    throw new ValidateException("秒杀时段查询参数无效");
  }
  const clock = now.getTime(), dayStart = Math.floor((clock + 28_800_000) / 86_400_000) * 86_400_000 - 28_800_000;
  const childIds = ids(storeSeckill.timeId), parentIds = ids(sql`parent.time_id`);
  const from = minutes(sql`slot.start_time`), to = minutes(sql`slot.end_time`, true);
  return sql`EXISTS (
    SELECT 1 FROM (SELECT ${childIds} AS child_ids,
      ${instant(storeSeckill.startTime, false)} AS starts,
      ${instant(storeSeckill.stopTime, true)} AS raw_end) AS child
    LEFT JOIN store_activity AS parent ON parent.id = ${storeSeckill.activityId}
    CROSS JOIN LATERAL (SELECT ${parentIds} AS parent_ids,
      child.raw_end + CASE WHEN mod(child.raw_end + 28800000, 86400000) = 0 THEN 86400000 ELSE 1 END AS ends) AS config
    CROSS JOIN LATERAL (SELECT array(SELECT unnest(child.child_ids)
      INTERSECT SELECT unnest(CASE WHEN ${storeSeckill.activityId} = 0 THEN child.child_ids ELSE config.parent_ids END)) AS slot_ids,
      greatest(child.starts, CASE WHEN ${storeSeckill.activityId} = 0 THEN '-Infinity'::numeric ELSE parent.start_day::bigint * 1000 END) AS starts,
      least(config.ends, CASE WHEN ${storeSeckill.activityId} = 0 THEN 'Infinity'::numeric ELSE parent.end_day::bigint * 1000 + 86400000 END) AS ends
    ) AS allowed
    WHERE ${storeSeckill.status} = 1 AND ${storeSeckill.isShow} = 1 AND ${storeSeckill.isDel} = 0
      AND child.starts IS NOT NULL AND child.raw_end IS NOT NULL
      AND (${storeSeckill.activityId} = 0 OR (parent.type = 1 AND parent.status = 1 AND parent.is_del = 0
        AND parent.start_day > 0 AND parent.end_day >= parent.start_day
        AND mod(parent.start_day::bigint + 28800, 86400) = 0 AND mod(parent.end_day::bigint + 28800, 86400) = 0))
      AND ${clock}::numeric >= allowed.starts AND ${clock}::numeric < allowed.ends
      AND ${Number(timeId)} = ANY(allowed.slot_ids)
      AND NOT EXISTS (SELECT 1 FROM store_seckill_time AS slot WHERE slot.id = ANY(allowed.slot_ids) AND slot.status = 1
        AND ((${from}) IS NULL OR (${to}) IS NULL OR (${from}) >= (${to})))
      AND EXISTS (SELECT 1 FROM store_seckill_time AS slot WHERE slot.id = ${Number(timeId)} AND slot.status = 1
        AND ${dayStart}::numeric + (${from}) * 60000 < allowed.ends
        AND ${dayStart}::numeric + (${to}) * 60000 > allowed.starts)
  )`;
}
