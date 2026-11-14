/** Owned local identity provider/state store. Actual context exchange/signature and SQL scope checks; no WeCom/OAuth production claim. */
import { eq } from 'drizzle-orm';
import { createContainerFromDb } from '@/lib/di';
import { systemConfig, workClient, workClientFollow, workMember } from '@/models/schema';
import { EnterpriseWechatContextService, type WorkContextStateStore } from '@/services/work/EnterpriseWechatContextService';
import type { EditScenario } from './adminOrderEdit';

export async function orderTimelineWork(s: EditScenario) {
  s.env.APP_KEY = 'owned-order-timeline-local-signature-key';
  s.env.WORK_WECHAT_ALLOWED_ORIGINS = 'https://work.example.test';
  // The quote fixture deliberately answers unknown cfg_* keys with "0".
  // These context settings must use the real SQL rows seeded below.
  const kv = s.env.CONFIG_KV;
  s.env.CONFIG_KV = { ...kv, get: async (key: string) =>
    ['cfg_wechat_work_corpid', 'cfg_wechat_work_build_agent_id'].includes(key) ? null : kv.get(key),
  } as typeof kv;
  const corpId = 'ww1234567890abcdef', userid = 'timeline-employee', externalUserid = 'timeline-client';
  await s.f.db.insert(workMember).values({ corpId, userid, enable: 1, status: 1 });
  const [client] = await s.f.db.insert(workClient).values({ corpId, externalUserid, uid: 11, name: 'Owned timeline client' }).returning();
  const [follow] = await s.f.db.insert(workClientFollow).values({ clientId: client.id, userid, isDelUser: 0 }).returning();
  for (const [menuName, value] of Object.entries({ wechat_work_corpid: corpId, wechat_work_build_agent_id: '1000001' })) {
    await s.f.db.delete(systemConfig).where(eq(systemConfig.menuName, menuName));
    await s.f.db.insert(systemConfig).values({ menuName, value, isStore: 0 });
  }
  const states = new Map<string, unknown>();
  const stateStore: WorkContextStateStore = {
    putOnce: async (key, value) => { if (states.has(key)) return false; states.set(key, value); return true; },
    take: async <T>(key: string) => { const value = states.get(key); states.delete(key); return (value ?? null) as T | null; },
  };
  const service = new EnterpriseWechatContextService(createContainerFromDb(s.databases.app), s.env, {
    stateStore, identityProvider: { employeeIdentity: async () => ({ corpId, agentId: 1000001, userid }) },
  });
  const challenge = await service.challenge('https://work.example.test', 'https://work.example.test/?work_oauth=1');
  const issue = () => service.exchange({ origin: 'https://work.example.test', state: challenge.state,
    code: 'owned-local-identity-code', cookieValue: challenge.cookie_value, target: { type: 'client', externalUserid } });
  const context = await issue();
  return { service, context, client, follow, corpId, userid, externalUserid };
}
