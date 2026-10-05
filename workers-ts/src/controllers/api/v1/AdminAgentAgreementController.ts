import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminAgentAgreementService, type AgentAgreementActor } from '@/services/admin/AdminAgentAgreementService';
import { ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';
import { readBoundedJsonObject } from '@/utils/request-body';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

function noStore(c: C) {
  c.header('Cache-Control', 'private, no-store, max-age=0');
  c.header('Pragma', 'no-cache');
}

function service(c: C) { return new AdminAgentAgreementService(c.get('container')); }

function actor(c: C): AgentAgreementActor {
  const admin = c.get('adminInfo');
  if (!admin) throw new ValidateException('管理员身份缺失');
  return { id: admin.id, name: admin.realName || admin.account,
    ip: (c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For')?.split(',')[0] ?? '').trim().slice(0, 45) };
}

export async function getAgentAgreement(c: C) {
  noStore(c);
  return jsonOk(c, await service(c).read());
}

export async function setAgentAgreement(c: C) {
  noStore(c);
  const rawId = c.req.param('id') ?? '';
  if (!/^(?:0|[1-9]\d*)$/.test(rawId)) throw new ValidateException('分销说明 ID 错误');
  return jsonOk(c, await service(c).save(Number(rawId),
    await readBoundedJsonObject(c.req.raw, 768 * 1024), actor(c)), '分销说明保存成功');
}
