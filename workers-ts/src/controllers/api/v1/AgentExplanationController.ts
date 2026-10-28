import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AgentExplanationReadService } from '@/services/user/AgentExplanationReadService';
import { ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';

/** Closed public read: no client type, HTML, attachment IDs, query or body.
 * Hono's implicit HEAD remains the ordinary empty-body GET representation. */
export function assertAgentExplanationReadRequest(request: Request): void {
  const length = request.headers.get('content-length');
  if (!['GET', 'HEAD'].includes(request.method) || request.url.includes('?') || request.url.includes('#')
    || request.body !== null || request.headers.has('transfer-encoding') || length !== null && length !== '0')
    throw new ValidateException('分销说明仅支持无查询参数和请求体的读取');
}

export async function explanation(c: Context<{ Bindings: Env; Variables: AppVariables }>) {
  c.header('Cache-Control', 'private, no-store');
  assertAgentExplanationReadRequest(c.req.raw);
  return jsonOk(c, await new AgentExplanationReadService(c.get('container'), c.env).read());
}
