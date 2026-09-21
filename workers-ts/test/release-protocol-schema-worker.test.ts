import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import worker from './integration/ReleaseProtocolSchemaWorker';
import type { ReleaseProtocolSchemaEnv } from './integration/release-protocol-schema-bindings';
const mocks=vi.hoisted(()=>({create:vi.fn(),apply:vi.fn(),inspect:vi.fn(),end:vi.fn()}));
vi.mock('@/lib/di',()=>({createDbFromConnectionString:mocks.create}));
vi.mock('@/migrations/runReleaseProtocolSchema',()=>({RELEASE_PROTOCOL_OPERATION:'reviewed-indexes-and-0155-0160-schema-v1',
  inspectReleaseProtocolSchema:mocks.inspect,runReleaseProtocolSchema:mocks.apply}));
const token='a'.repeat(64),operation='reviewed-indexes-and-0155-0160-schema-v1';
let env:ReleaseProtocolSchemaEnv,logs:unknown[][];
const req=(path='/apply',method='POST',auth=token,op=operation,body='')=>new Request('https://maintenance.invalid'+path,
  {method,headers:{'X-Audit-Token':auth,'X-Migration-Operation':op},...(method==='POST'?{body}:{})});
beforeEach(async()=>{
  vi.resetAllMocks();logs=[];vi.spyOn(console,'error').mockImplementation((...args:unknown[])=>{logs.push(args);});
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))),b=>b.toString(16).padStart(2,'0')).join('');
  env={AUDIT_TOKEN_SHA256:hash,AUDIT_EXPIRES_AT:String(Date.now()+600000),HYPERDRIVE:{connectionString:'postgresql://synthetic.invalid/test'} as Hyperdrive};
  mocks.create.mockReturnValue({$client:{end:mocks.end}});mocks.end.mockResolvedValue(undefined);
  mocks.apply.mockResolvedValue({schemaReady:true,runtimeCommissioned:false});mocks.inspect.mockResolvedValue({schemaReady:false,runtimeCommissioned:false});
});
afterEach(()=>vi.restoreAllMocks());
describe('fixed release schema maintenance HTTP',()=>{
  it.each(['','x'.repeat(64),'b'.repeat(64)])('requires a valid short-lived token %s',async auth=>{
    expect((await worker.fetch(req('/apply','POST',auth),env)).status).toBe(403);expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each(['0','invalid',String(Date.now()+3600000)])('rejects invalid expiry %s',async expiry=>{
    expect((await worker.fetch(req(),{...env,AUDIT_EXPIRES_AT:expiry})).status).toBe(403);expect(mocks.create).not.toHaveBeenCalled();
  });
  it('rejects paths, input, methods and missing explicit operation before SQL',async()=>{
    expect((await worker.fetch(req('/unknown'),env)).status).toBe(404);
    expect((await worker.fetch(req('/apply?role=other'),env)).status).toBe(404);
    expect((await worker.fetch(req('/apply','GET'),env)).status).toBe(405);
    expect((await worker.fetch(req('/apply','POST',token,''),env)).status).toBe(400);
    expect((await worker.fetch(req('/apply','POST',token,operation,'select 1'),env)).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('executes one fixed target operation then closes before response',async()=>{
    const response=await worker.fetch(req(),env);expect(response.status).toBe(200);expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(mocks.apply).toHaveBeenCalledExactlyOnceWith(mocks.create.mock.results[0].value,
      {database:'postgres',maintenanceRole:'postgres',pricingOwner:'cinashop_pricing_owner_v1'});
    expect(mocks.inspect).not.toHaveBeenCalled();expect(mocks.end).toHaveBeenCalledExactlyOnceWith({timeout:1});
  });
  it('status is only read-only inspection',async()=>{
    expect((await worker.fetch(req('/status','GET'),env)).status).toBe(200);expect(mocks.inspect).toHaveBeenCalledOnce();expect(mocks.apply).not.toHaveBeenCalled();
  });
  it.each(['create','apply','end'] as const)('never retries %s failure and redacts raw errors',async stage=>{
    const error=Object.assign(Error('private sql or connection string'),{code:'55P03'});
    if(stage==='create')mocks.create.mockImplementation(()=>{throw error;});else mocks[stage].mockRejectedValue(error);
    const response=await worker.fetch(req(),env);expect(response.status).toBe(503);
    expect(await response.json()).toEqual({error:'outcome unconfirmed; inspect catalog before further action',sqlState:'55P03'});
    expect(mocks.apply.mock.calls.length).toBeLessThanOrEqual(1);
    expect(JSON.stringify(logs)).not.toContain('private sql');
  });
});
