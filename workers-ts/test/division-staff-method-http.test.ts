import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '@/app';
import { createToken, md5 } from '@/utils/jwt';
import { divisionStaffFixture } from './helpers/divisionStaffFixture';
const wiring=vi.hoisted(()=>({open:vi.fn()}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),createContainer:wiring.open}));
describe('actual legacy employee GET write cannot be triggered by Hono HEAD fallback',()=>{
  let f:Awaited<ReturnType<typeof divisionStaffFixture>>,token:string;
  const app=createApp();
  beforeAll(async()=>{f=await divisionStaffFixture();wiring.open.mockImplementation(()=>f.container);token=(await createToken(22,'api',md5(f.password),f.env.APP_KEY)).token;},30000);
  afterAll(async()=>{await f?.close();},30000);
  it('authenticated HEAD preserves every account, order and brokerage fact and returns private method rejection',async()=>{
    const before=await f.snapshot();const response=await app.request('/api/division/agent/del_staff/44',{method:'HEAD',headers:{'Authori-zation':`Bearer ${token}`}},f.env);
    expect(response.status).toBe(405);expect(response.headers.get('cache-control')).toContain('private, no-store');expect(response.headers.get('pragma')).toBe('no-cache');
    expect(await f.snapshot()).toEqual(before);
    const actual=await app.request('/api/division/agent/del_staff/44',{headers:{'Authori-zation':`Bearer ${token}`}},f.env);
    expect((await actual.json() as {status:number}).status).toBe(200);expect((await f.snapshot()).users.find(row=>row.uid===44)).toMatchObject({agentId:0,staffId:0,divisionType:0});
  });
});
