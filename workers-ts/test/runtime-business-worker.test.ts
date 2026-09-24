import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({open:vi.fn(),close:vi.fn(),inspect:vi.fn(),apply:vi.fn(),shipping:vi.fn(),audit:vi.fn(),exercise:vi.fn()}));
vi.mock('../src/lib/di',()=>({createDbFromConnectionString:mocks.open}));
vi.mock('../src/migrations/runRuntimeBusinessCommissioning',()=>({RUNTIME_COMMISSION_OPERATION:'isolated-business-runtime-v2-purchase-evidence',
  RUNTIME_SHIPPING_OPERATION:'shipping-replay-schema-0154-v1',runRuntimeShippingPrerequisite:mocks.shipping,
  inspectRuntimeBusinessCommissioning:mocks.inspect,runRuntimeBusinessCommissioning:mocks.apply}));
vi.mock('../src/migrations/auditRuntimeBusinessPrivileges',()=>({auditRuntimeBusinessPrivileges:mocks.audit}));
vi.mock('./integration/RuntimeBusinessProbe',()=>({RUNTIME_PROBE_OPERATION:'isolated-runtime-rollback-exercise-v1',exerciseRuntimeBusiness:mocks.exercise}));
import worker,{type RuntimeBusinessCommissionEnv} from './integration/RuntimeBusinessCommissionWorker';

describe('fixed runtime commissioning maintenance boundary',()=>{
  const token='a'.repeat(64);
  let env:RuntimeBusinessCommissionEnv;
  beforeEach(async()=>{
    vi.resetAllMocks();mocks.close.mockResolvedValue(undefined);mocks.open.mockReturnValue({$client:{end:mocks.close}});
    mocks.inspect.mockResolvedValue({operation:'isolated-business-runtime-v2-purchase-evidence',applyEnabled:false});
    mocks.apply.mockResolvedValue({operation:'isolated-business-runtime-v2-purchase-evidence',grantsApplied:true});
    mocks.audit.mockResolvedValue({ready:true,failures:[]});
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));
    env={AUDIT_TOKEN_SHA256:[...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join(''),
      AUDIT_EXPIRES_AT:String(Date.now()+600000),HYPERDRIVE:{connectionString:'app-test'},
      HYPERDRIVE_ADMIN:{connectionString:'admin-test'},HYPERDRIVE_MAINTENANCE:{connectionString:'maintenance-test'}} as RuntimeBusinessCommissionEnv;
  });
  const request=(path='/status',method='GET',headers:Record<string,string>={},body?:string)=>
    new Request('https://owned.invalid'+path,{method,headers:{'X-Audit-Token':token,...headers},...(body?{body}: {})});
  it.each(['absent','wrong','expired','too-long'] as const)('rejects %s authorization before opening SQL',async mode=>{
    if(mode==='expired')env.AUDIT_EXPIRES_AT=String(Date.now()-1);
    if(mode==='too-long')env.AUDIT_EXPIRES_AT=String(Date.now()+3600000);
    const r=await worker.fetch(request('/status','GET',mode==='absent'?{'X-Audit-Token':''}:mode==='wrong'?{'X-Audit-Token':'b'.repeat(64)}:{}),env);
    expect(r.status).toBe(403);expect(mocks.open).not.toHaveBeenCalled();
  });
  it.each([['/apply','GET',405],['/status','POST',405],['/status?sql=select','GET',404],['/unknown','GET',404]] as const)
    ('rejects %s %s before SQL',async(path,method,status)=>{
      expect((await worker.fetch(request(path,method),env)).status).toBe(status);expect(mocks.open).not.toHaveBeenCalled();
    });
  it('requires the exact operation and an empty body',async()=>{
    expect((await worker.fetch(request('/apply','POST'),env)).status).toBe(400);
    expect((await worker.fetch(request('/apply','POST',{'X-Migration-Operation':'isolated-business-runtime-v2-purchase-evidence'},'{}'),env)).status).toBe(400);
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it('does not reuse historical v1 grant authorization for the evidence-capable profile',async()=>{
    expect((await worker.fetch(request('/apply','POST',{'X-Migration-Operation':'isolated-business-runtime-v1'}),env)).status).toBe(400);
    expect(mocks.open).not.toHaveBeenCalled();expect(mocks.apply).not.toHaveBeenCalled();
  });
  it('selects maintenance only for fixed status and closes the connection',async()=>{
    const response=await worker.fetch(request(),env);expect(response.status).toBe(200);expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(mocks.open.mock.calls[0][0]).toBe('maintenance-test');expect(mocks.apply).not.toHaveBeenCalled();expect(mocks.close).toHaveBeenCalledTimes(1);
  });
  it('keeps schema-only authorization separate from business grants',async()=>{
    const grant={'X-Migration-Operation':'isolated-business-runtime-v2-purchase-evidence'},schema={'X-Migration-Operation':'shipping-replay-schema-0154-v1'};
    expect((await worker.fetch(request('/shipping-schema','GET'),env)).status).toBe(405);
    expect((await worker.fetch(request('/shipping-schema','POST',grant),env)).status).toBe(400);
    expect((await worker.fetch(request('/apply','POST',schema),env)).status).toBe(400);
    expect(mocks.open).not.toHaveBeenCalled();
    mocks.shipping.mockResolvedValue({operation:'shipping-replay-schema-0154-v1',businessGrantsApplied:false});
    expect((await worker.fetch(request('/shipping-schema','POST',schema),env)).status).toBe(200);
    expect(mocks.shipping).toHaveBeenCalledTimes(1);expect(mocks.apply).not.toHaveBeenCalled();
  });
  it('verifies two distinct bound LOGINs, caps diagnostics, and never opens maintenance',async()=>{
    mocks.audit.mockResolvedValue({ready:false,failures:Array.from({length:100},(_,i)=>'missing-'+i)});
    const response=await worker.fetch(request('/verify'),env);expect(response.status).toBe(200);
    const result=await response.json() as {ready:boolean;profiles:{failureCount:number;failures:string[]}[]};
    expect(result.ready).toBe(false);expect(result.profiles.every(p=>p.failureCount===100&&p.failures.length===40)).toBe(true);
    expect(mocks.open.mock.calls.map(c=>c[0])).toEqual(['app-test','admin-test']);expect(mocks.close).toHaveBeenCalledTimes(2);
  });
  it('requires separate exercise authorization and verified profiles before synthetic service writes',async()=>{
    const headers={'X-Migration-Operation':'isolated-runtime-rollback-exercise-v1'};
    expect((await worker.fetch(request('/exercise','GET'),env)).status).toBe(405);
    expect((await worker.fetch(request('/exercise','POST',{'X-Migration-Operation':'isolated-business-runtime-v2-purchase-evidence'}),env)).status).toBe(400);
    mocks.audit.mockResolvedValueOnce({ready:false,failures:['staff_boundary']});
    const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    try{
      expect((await worker.fetch(request('/exercise','POST',headers),env)).status).toBe(503);
      expect(mocks.exercise).not.toHaveBeenCalled();
      mocks.exercise.mockResolvedValue({passed:true,rolledBack:true});
      const response=await worker.fetch(request('/exercise','POST',headers),env);
      expect(response.status).toBe(200);expect(mocks.exercise.mock.calls.map(c=>c[1])).toEqual(['app','admin']);
      expect(mocks.open.mock.calls.every(c=>c[0]!=='maintenance-test')).toBe(true);
    }finally{log.mockRestore();}
  });
  it('runs only the exact fixed mutation and never returns nested SQL or connection secrets',async()=>{
    mocks.apply.mockRejectedValue({message:'private-data',cause:{code:'42501',query:'private-query'}});
    const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    try{
      const response=await worker.fetch(request('/apply','POST',{'X-Migration-Operation':'isolated-business-runtime-v2-purchase-evidence'}),env);
      expect(response.status).toBe(503);const text=await response.text();expect(text).toContain('42501');expect(text).not.toContain('private');
      expect(mocks.close).toHaveBeenCalledTimes(1);
    }finally{log.mockRestore();}
  });
});
