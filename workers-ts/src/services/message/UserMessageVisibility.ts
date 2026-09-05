import { and, eq, inArray, or, sql } from "drizzle-orm";
import { systemMessage } from "@/models/schema";
import { ValidateException } from "@/utils/errors";

/** The same audience filter protects list, detail and the personal-home unread counter. */
export function visibleSystemMessageWhere(uid: number) {
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new ValidateException("用户ID无效");
  return and(eq(systemMessage.status, 1), eq(systemMessage.isDel, 0), inArray(systemMessage.type, [0, 1]),
    or(eq(systemMessage.userId, 0), eq(systemMessage.userId, uid)));
}

export function userUnreadMessageCount(uid: number) {
  // Explicit qualified identifiers survive Drizzle's single-table SELECT field rewriting.
  return sql<number>`(SELECT count(DISTINCT system_message.id)::int FROM system_message
    LEFT JOIN user_message ON user_message.message_id = system_message.id
      AND user_message.uid = ${uid} AND user_message.is_read = 1
    WHERE ${visibleSystemMessageWhere(uid)} AND system_message.look = 0 AND user_message.id IS NULL)`;
}
