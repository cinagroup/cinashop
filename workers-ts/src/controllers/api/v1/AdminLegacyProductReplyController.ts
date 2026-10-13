import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminProductReplyService } from '@/services/admin/AdminProductReplyService';
import { ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';
import { readBoundedJsonObject } from '@/utils/request-body';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
const service = (c: C) => new AdminProductReplyService(c.get('container'));

function replyId(c: C): number {
  const raw = c.req.param('id') ?? '';
  if (!/^[1-9]\d{0,9}$/.test(raw) || Number(raw) > 2_147_483_647) {
    throw new ValidateException('评价ID无效');
  }
  return Number(raw);
}

export async function list(c: C) {
  return jsonOk(c, await service(c).list(c.req.query()));
}

export async function setReply(c: C) {
  const body = await readBoundedJsonObject(c.req.raw, 8 * 1024);
  return jsonOk(c, await service(c).setReply(replyId(c), body.content), '回复成功!');
}

export async function getReply(c: C) {
  return jsonOk(c, await service(c).getReply(replyId(c)));
}

export async function remove(c: C) {
  await service(c).remove(replyId(c));
  return jsonOk(c, null, '删除成功!');
}
