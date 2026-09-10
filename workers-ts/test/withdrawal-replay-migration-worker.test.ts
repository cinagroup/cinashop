import { beforeEach,afterEach,describe,expect,it,vi } from 'vitest';
import worker from './integration/WithdrawalReplayMigrationWorker';
import type { PaidRuntimeAuditEnv } from './integration/paid-runtime-audit-bindings';
const mocks = vi.hoisted(() => ({ create:vi.fn(),run:vi.fn(),inspect:vi.fn(),end:vi.fn() }));
vi.mock('@/lib/di',() => ({ createDbFromConnectionString:mocks.create }));
vi.mock('@/migrations/runWithdrawalReplayUpgrade',() => ({ runWithdrawalReplayUpgrade:mocks.run,inspectWithdrawalReplayUpgrade:mocks.inspect }));
const token = 'c'.repeat(64);
let env: PaidRuntimeAuditEnv;
let logs: unknown[][];
const req = (method='POST',path='/migrate/0130',credential=token,operation='0130-user-withdrawal-replay') =>
  new Request(`https://migration.invalid${path}`,{ method,headers:{ 'X-Audit-Token':credential,'X-Migration-Operation':operation } });
beforeEach(async () => {
  vi.resetAllMocks(); logs=[];
  vi.spyOn(console,'error').mockImplementation((...args:unknown[])=>{ logs.push(args); });
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));
  env={ HYPERDRIVE:{ connectionString:'postgresql://synthetic.invalid/test' } as Hyperdrive,
    AUDIT_TOKEN_SHA256:[...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join(''),AUDIT_EXPIRES_AT:String(Date.now()+600_000) };
  mocks.create.mockReturnValue({ $client:{ end:mocks.end } });
  mocks.end.mockResolvedValue(undefined);
  mocks.run.mockResolvedValue({ migration:'0130-user-withdrawal-replay',applied:true,ready:true });
  mocks.inspect.mockResolvedValue({ supported:true,ready:false,withinBudget:true });
});
afterEach(()=>vi.restoreAllMocks());
describe('explicit temporary DB-006 HTTP maintenance capability',()=>{
  it('uses the independent read-only inspector for GET preflight, not the upgrade',async()=>{
    const response=await worker.fetch(req('GET','/preflight/0130'),env);
    expect(await response.json()).toEqual({ supported:true,ready:false,withinBudget:true });
    expect(mocks.inspect).toHaveBeenCalledExactlyOnceWith(mocks.create.mock.results[0].value);
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.end).toHaveBeenCalledExactlyOnceWith({ timeout:1 });
  });
  it.each(['','d'.repeat(64),'c'.repeat(65)])('rejects invalid credential %s before any SQL',async credential=>{
    expect((await worker.fetch(req('POST','/migrate/0130',credential),env)).status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('rejects unset verifier, expired and excessively long-lived tokens',async()=>{
    for(const expiry of ['','0',String(Date.now()+3_600_000)]) {
      env.AUDIT_EXPIRES_AT=expiry;
      expect((await worker.fetch(req(),env)).status).toBe(403);
    }
    env.AUDIT_EXPIRES_AT=String(Date.now()+600_000); env.AUDIT_TOKEN_SHA256='';
    expect((await worker.fetch(req(),env)).status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each(['GET','PUT','DELETE','OPTIONS'])('rejects %s before any SQL',async method=>{
    const response=await worker.fetch(req(method),env);
    expect(response.status).toBe(405); expect(response.headers.get('Allow')).toBe('POST');
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each(['/migrate/0131','/migrate/0130?sql=ignored'])('rejects other operations %s',async path=>{
    expect((await worker.fetch(req('POST',path),env)).status).toBe(404);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('requires an explicit matching operation header',async()=>{
    expect((await worker.fetch(req('POST','/migrate/0130',token,''),env)).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('calls only the fixed upgrade, awaits connection close, and never caches success',async()=>{
    const response=await worker.fetch(req(),env);
    expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ migration:'0130-user-withdrawal-replay',applied:true,ready:true });
    expect(mocks.run).toHaveBeenCalledExactlyOnceWith(mocks.create.mock.results[0].value);
    expect(mocks.end).toHaveBeenCalledExactlyOnceWith({ timeout:1 });
  });
  it.each(['create','run','end'] as const)('reports an unconfirmed outcome and redacts %s errors',async stage=>{
    const error=new Error('private SQL or connection context');
    if(stage==='create') mocks.create.mockImplementation(()=>{ throw error; });
    else mocks[stage].mockRejectedValue(error);
    const response=await worker.fetch(req(),env);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error:'migration outcome unconfirmed; inspect catalog before retry' });
    expect(logs).toContainEqual([JSON.stringify({ event:'withdrawal_replay_upgrade_unconfirmed' })]);
    expect(JSON.stringify(logs)).not.toContain(error.message);
  });
});
