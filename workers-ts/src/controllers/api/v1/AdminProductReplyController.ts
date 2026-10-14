import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminProductReplyService, productReplyId } from '@/services/admin/AdminProductReplyService';
import { ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';
import { readBoundedUtf8Text } from '@/utils/request-body';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
function context(c: C) {
  c.header('Cache-Control', 'private, no-store'); c.header('Pragma', 'no-cache');
  return { service: new AdminProductReplyService(c.get('container'), c.env.APP_KEY), query: new URL(c.req.url).searchParams,
    actor: { id: c.get('adminId') ?? 0, authVersion: c.get('socketAuthVersion') ?? '', expiresAt: c.get('socketTokenExp') ?? 0 } };
}
async function body(c: C, allowEmpty = false): Promise<unknown> {
  if (new URL(c.req.url).searchParams.size) throw new ValidateException('商品评价写入不接受查询参数');
  const text = await readBoundedUtf8Text(c.req.raw, 64 * 1024);
  if (allowEmpty && text === '') return undefined;
  try { return JSON.parse(text) as unknown; } catch { throw new ValidateException('商品评价JSON格式错误'); }
}

export async function list(c: C) { const x = context(c); return jsonOk(c, await x.service.list(x.query, x.actor)); }
export async function getReply(c: C) { const x = context(c); return jsonOk(c, await x.service.getReply(productReplyId(c.req.param('id')), x.query, x.actor)); }
export async function comments(c: C) { const x = context(c); return jsonOk(c, await x.service.comments(productReplyId(c.req.param('id')), x.query, x.actor)); }
export async function setReply(c: C) { const x = context(c); await x.service.setReply(productReplyId(c.req.param('id')), await body(c), x.actor); return c.json({ status: 200, msg: '回复成功!' }); }
export async function saveComment(c: C) { const x = context(c); await x.service.saveComment(productReplyId(c.req.param('replyId')), productReplyId(c.req.param('id')), await body(c), x.actor); return c.json({ status: 200, msg: '保存成功' }); }
export async function remove(c: C) { const x = context(c); await x.service.remove(productReplyId(c.req.param('id')), x.query, await body(c, true), x.actor); return c.json({ status: 200, msg: '删除成功!' }); }
export async function removeComment(c: C) { const x = context(c); await x.service.removeComment(productReplyId(c.req.param('id')), x.query, await body(c, true), x.actor); return c.json({ status: 200, msg: '删除成功' }); }

export async function modernList(c: C) { const x = context(c); return jsonOk(c, await x.service.list(x.query, x.actor, false)); }
export async function modernStatus(c: C) { const x = context(c); await x.service.status(productReplyId(c.req.param('id')), await body(c), x.actor); return jsonOk(c, null, '操作成功'); }
export async function modernRemove(c: C) { const x = context(c); await x.service.remove(productReplyId(c.req.param('id')), x.query, await body(c, true), x.actor, false); return jsonOk(c, null, '已删除'); }
