import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import worker from './integration/OrphanTestCleanupWorker';
import type {OrphanCleanupEnv} from './integration/orphan-cleanup-bindings';
const mocks=vi.hoisted(()=>({create:vi.fn(),remove:vi.fn(),status:vi.fn(),end:vi.fn()}));
vi.mock('@/lib/di',()=>({createDbFromConnectionString:mocks.create}));
vi.mock('@/migrations/orphanTestOrderCleanup',()=>({deleteOrphanTestOrders:mocks.remove,inspectOrphanCleanupResult:mocks.status}));
const token='a'.repeat(64),operation='delete-backed-up-12-orphan-test-orders';
let env:OrphanCleanupEnv,logs:unknown[][];
function req(path='/cleanup',method='POST',credential=token,op=operation,body?:string) {
  return new Request('https://cleanup.invalid'+path,{method,headers:{'X-Audit-Token':credential,'X-Maintenance-Operation':op},body});
}
beforeEach(async()=>{
  vi.resetAllMocks();logs=[];vi.spyOn(console,'error').mockImplementation((...a:unknown[])=>{logs.push(a);});
  const h=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));
  env={HYPERDRIVE:{connectionString:'postgresql://synthetic.invalid/test'} as Hyperdrive,
    AUDIT_TOKEN_SHA256:[...new Uint8Array(h)].map(b=>b.toString(16).padStart(2,'0')).join(''),
    AUDIT_EXPIRES_AT:String(Date.now()+600_000),ORPHAN_BACKUP_SHA256:'b'.repeat(64)};
  mocks.create.mockReturnValue({$client:{end:mocks.end}});mocks.end.mockResolvedValue(undefined);
  mocks.remove.mockResolvedValue({scope:'orphan-test-order-cleanup',ready:true});
  mocks.status.mockResolvedValue({scope:'orphan-test-cleanup-result',remainingOrphans:0});
});
afterEach(()=>vi.restoreAllMocks());
describe('single-purpose orphan cleanup HTTP boundary',()=>{
  it.each(['','c'.repeat(64),'A'.repeat(64)])('rejects invalid credential before connecting',async token=>{
    expect((await worker.fetch(req('/cleanup','POST',token),env)).status).toBe(403);expect(mocks.create).not.toHaveBeenCalled();
  });
  it('requires expiry and a deployment-pinned backup digest',async()=>{
    for(const overrides of [{AUDIT_EXPIRES_AT:'0'},{AUDIT_EXPIRES_AT:String(Date.now()+3_600_000)},{ORPHAN_BACKUP_SHA256:''}])
      expect((await worker.fetch(req(),{...env,...overrides})).status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('requires the exact POST operation without caller input',async()=>{
    expect((await worker.fetch(req('/cleanup','GET'),env)).status).toBe(405);
    expect((await worker.fetch(req('/cleanup','POST',token,''),env)).status).toBe(400);
    expect((await worker.fetch(req('/cleanup?ids=1'),env)).status).toBe(404);
    expect((await worker.fetch(req('/cleanup','POST',token,operation,'{}'),env)).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('dispatches once with the pinned digest and awaits close',async()=>{
    const response=await worker.fetch(req(),env);
    expect(response.status).toBe(200);expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith(mocks.create.mock.results[0].value,env.ORPHAN_BACKUP_SHA256);
    expect(mocks.end).toHaveBeenCalledExactlyOnceWith({timeout:1});expect(logs).toHaveLength(0);
  });
  it('accepts an empty network POST stream without accepting caller payloads',async()=>{
    const body=new ReadableStream<Uint8Array>({start(controller){controller.close();}});
    const request=new Request('https://cleanup.invalid/cleanup',{method:'POST',
      headers:{'X-Audit-Token':token,'X-Maintenance-Operation':operation},body,duplex:'half'} as RequestInit);
    expect(request.body).not.toBeNull();
    expect((await worker.fetch(request,env)).status).toBe(200);expect(mocks.remove).toHaveBeenCalledOnce();
  });
  it('keeps independent status read-only',async()=>{
    expect((await worker.fetch(req('/status','POST'),env)).status).toBe(405);
    expect((await worker.fetch(req('/status','GET'),env)).status).toBe(200);
    expect(mocks.status).toHaveBeenCalledOnce();expect(mocks.remove).not.toHaveBeenCalled();
  });
  it.each(['create','remove','end'] as const)('redacts %s failure and never retries deletion',async stage=>{
    if(stage==='create')mocks.create.mockImplementation(()=>{throw Error('PRIVATE ROW DATA');});
    else mocks[stage].mockRejectedValue(Error('PRIVATE ROW DATA'));
    const response=await worker.fetch(req(),env);
    expect(response.status).toBe(503);expect(JSON.stringify(await response.json())).not.toContain('PRIVATE');
    expect(JSON.stringify(logs)).not.toContain('PRIVATE');expect(mocks.remove.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
