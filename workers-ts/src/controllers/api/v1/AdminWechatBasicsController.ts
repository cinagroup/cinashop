import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminWechatBaseService } from '@/services/admin/AdminWechatBaseService';
import { AdminWechatOpenService } from '@/services/admin/AdminWechatOpenService';
import { AdminWechatAppService } from '@/services/admin/AdminWechatAppService';
import { AdminWechatRoutineService } from '@/services/admin/AdminWechatRoutineService';
import { AdminPcBaseService } from '@/services/admin/AdminPcBaseService';
import { parseLevelActivationJson } from '@/services/admin/AdminLevelActivationInput';
import { parsePcBaseIntentSave } from '../../../../../view/common/pcBaseIntent';
import { PC_BASE_MAX_BODY_BYTES } from '../../../../../view/common/pcBase';
import { parseWechatBaseSave } from '../../../../../view/common/wechatBase';
import { parseWechatOpenSave } from '../../../../../view/common/wechatOpen';
import { parseWechatAppSave } from '../../../../../view/common/wechatApp';
import { parseWechatRoutineSave } from '../../../../../view/common/wechatRoutine';
import { ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';
import { readBoundedUtf8Text } from '@/utils/request-body';
/** The historical shared URL has five disjoint complete envelopes. No flat
 * generic settings or partial-key discriminator can bypass domain authority. */
export async function save(c: Context<{ Bindings: Env; Variables: AppVariables }>) {
  c.header('Cache-Control', 'private, no-store');
  if (new URL(c.req.url).searchParams.size) throw new ValidateException('配置接口不接受查询参数');
  const text = await readBoundedUtf8Text(c.req.raw, PC_BASE_MAX_BODY_BYTES);
  let body: unknown;
  try { body = parseLevelActivationJson(text); } catch { throw new ValidateException('配置JSON格式无效、字段重复或层级过深'); }
  let base = false, open = false, app = false, pc = false, routine = false;
  try { parseWechatBaseSave(body); base = true; } catch { /* Complete other domain may match. */ }
  try { parseWechatOpenSave(body); open = true; } catch { /* No generic fallback. */ }
  try { parseWechatAppSave(body); app = true; } catch { /* Mobile App is a separate complete domain. */ }
  try { parsePcBaseIntentSave(body); pc = true; } catch { /* Every domain must match its whole envelope. */ }
  try { parseWechatRoutineSave(body); routine = true; } catch { /* Mini Program owns exactly its five-key intent envelope. */ }
  if (Number(base) + Number(open) + Number(app) + Number(pc) + Number(routine) !== 1) throw new ValidateException('请提交完整且唯一的专用配置保存请求');
  // The PC transport does not widen any accepted WeChat domain's limit.
  if (!pc && new TextEncoder().encode(text).byteLength > 65536) throw new ValidateException('微信配置请求不能超过64 KiB');
  const actor = { id: c.get('adminId') ?? 0, authVersion: c.get('socketAuthVersion') ?? '', expiresAt: c.get('socketTokenExp') ?? 0 };
  return jsonOk(c, await (base ? new AdminWechatBaseService(c.get('container'), c.env).save(body, actor)
    : open ? new AdminWechatOpenService(c.get('container'), c.env).save(body, actor)
      : app ? new AdminWechatAppService(c.get('container'), c.env).save(body, actor)
      : routine ? new AdminWechatRoutineService(c.get('container'), c.env).saveConfig(actor, body)
      : new AdminPcBaseService(c.get('container'), c.env).save(body, actor)));
}
