import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createDbFromConnectionString } from '../src/lib/di';
import { systemDise } from '../src/models/schema';
import { fabCanonical, fabHash, FabSettingsRejected, FabSettingsStaleVersion } from '../src/services/admin/AdminFabSettingsInput';
import { FAB_SETTINGS_LOCK_NAMESPACE } from '../src/services/admin/AdminFabSettingsService';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';
import { fabActor, fabSettingsFixture, fabStored, fabNewValues, observeFabDb } from './helpers/fabSettingsFixture';

type Fixture = Awaited<ReturnType<typeof fabSettingsFixture>>;
type Peer = Parameters<Parameters<Fixture['withRuntimeRole']>[0]>[0];
function gate() { let resolve!: () => void; const promise = new Promise<void>(done=>{resolve=done;}); return {promise,resolve}; }
const input = (revision:string,values:unknown=fabNewValues())=>({request_id:crypto.randomUUID(),revision,values});
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('complete native FAB settings with genuine production ACL intersection',()=>{
  let f:Fixture;
  beforeEach(async()=>{f=await fabSettingsFixture();},30_000);
  afterEach(async()=>{await f?.close();},30_000);
  const profiles=(run:(admin:Peer,app:Peer)=>Promise<void>)=>f.withRuntimeRole(app=>f.withRuntimeRole(async admin=>{
    await f.installSlice(app,admin);
    for(const peer of [admin,app]) expect((await peer.exec('SELECT current_user,session_user'))[0]).toEqual({current_user:peer.role,session_user:peer.role});
    expect(admin.pid).not.toBe(app.pid);await run(admin,app);
  }));
  it('reads the named singleton despite seed row status/is_show zero, and retains app read-only and no-DDL boundaries',async()=>{
    await profiles(async(admin,app)=>{
      const before=await f.snapshot(),page=await f.serviceFor(app.db).read();
      expect(page).toMatchObject({present:true,row:{id:88,status:0,is_show:0,is_del:0},editable:true,values:{is_show:1,index:3,shifting:78}});
      expect(page.values!.button).toHaveLength(3);expect(new Set(page.values!.button.map(row=>row.source_id)).size).toBe(3);
      expect(await f.snapshot()).toEqual(before);
      for(const peer of [admin,app]) {
        expect((await outcome(peer.exec('CREATE TABLE public.forbidden_fab(id int)'))).ok).toBe(false);
        expect((await outcome(peer.exec('SET ROLE finance_test'))).ok).toBe(false);
      }
      for(const statement of ["UPDATE system_dise SET value='{}' WHERE id=88","INSERT INTO system_dise(name) VALUES('bad')","DELETE FROM system_dise WHERE id=88"])
        expect((await outcome(app.exec(statement))).ok).toBe(false);
      expect(await f.snapshot()).toEqual(before);
    });
  });
  it('preserves root and per-button opaque attributes through reorder, duplicate image/link pairs, replacement and deletion',async()=>{
    const stored=fabStored();stored.button[1].img=stored.button[0].img;stored.button[1].url=stored.button[0].url;
    await f.db.update(systemDise).set({value:JSON.stringify(stored)}).where(eq(systemDise.id,88));
    await profiles(async admin=>{
      const service=f.serviceFor(admin.db),page=await service.read(),rows=page.values!.button;
      const values={...page.values!,button:[{...rows[1],img:'/new-two.png'},rows[0],{source_id:null,img:'/new.png',url:'https://example.com/new'}]};
      const body=input(page.revision,values),receipt=await service.save(body,fabActor);
      expect(receipt.payload_hash).toBe(await fabHash(fabCanonical(body).canonical));
      const row=(await f.db.select().from(systemDise).where(eq(systemDise.id,88)))[0],saved=JSON.parse(row.value!);
      expect(saved.extra_root).toEqual(stored.extra_root);expect(saved.button).toEqual([
        {...stored.button[1],img:'/new-two.png'},stored.button[0],{img:'/new.png',url:'https://example.com/new'}]);
      expect(saved.button.some((row:Record<string,unknown>)=>Object.hasOwn(row,'source_id'))).toBe(false);
      expect(row).toMatchObject({id:88,status:0,isShow:0,type:3,templateName:'suspended_window',addTime:1725589137});
      expect(await service.receipt(body.request_id,fabActor)).toEqual(receipt);
      const before=await f.snapshot();expect(await service.save(body,fabActor)).toEqual(receipt);expect(await f.snapshot()).toEqual(before);
    });
  });
  it('saves all four complete styles, including hidden configurations and zero-child styles one/two',async()=>{
    await profiles(async admin=>{
      const service=f.serviceFor(admin.db);
      for(const index of [1,2,3,4] as const) {
        const page=await service.read(),child={source_id:null,img:'/child.png',url:'/pages/index/index'};
        const values={is_show:0,index,shifting:index===4?100:0,main_ago_image:index===4?'':'/before.png',main_after_image:index===3?'/after.png':'',button:index>=3?[child,child,child]:[]};
        await service.save(input(page.revision,values),fabActor);
        const saved=(await service.read()).values!;
        expect({...saved,button:saved.button.map(({img,url})=>({img,url}))}).toEqual({...values,button:values.button.map(({img,url})=>({img,url}))});
        expect(saved.button.every(row=>/^[a-f0-9]{64}$/.test(row.source_id!))).toBe(true);
        expect((await f.publicFor(admin.db).read()).is_show).toBe(0);
      }
      expect((await f.snapshot()).logs).toHaveLength(4);
    });
  });
  it('initializes a missing template only after explicit confirmed save and atomically replays before later CAS changes',async()=>{
    await f.db.delete(systemDise).where(eq(systemDise.id,88));
    await profiles(async admin=>{
      const service=f.serviceFor(admin.db),before=await f.snapshot(),page=await service.read();
      expect(page).toMatchObject({present:false,row:null,editable:true,values:{is_show:1,index:1,shifting:1}});expect(await f.snapshot()).toEqual(before);
      expect(page.values!.button).toHaveLength(4);expect(page.image_previews.button).toEqual(['','','','']);
      const body=input(page.revision),receipt=await service.save(body,fabActor);expect(receipt.id).toBeGreaterThan(100);
      const row=(await f.db.select().from(systemDise).where(eq(systemDise.id,receipt.id)))[0];expect(row).toMatchObject({templateName:'suspended_window',type:3,status:0,isShow:0});
      expect(JSON.parse(row.value!)).toEqual(fabNewValues());
      await f.db.update(systemDise).set({title:'later metadata'}).where(eq(systemDise.id,receipt.id));
      const after=await f.snapshot();expect(await service.save(body,fabActor)).toEqual(receipt);expect(await f.snapshot()).toEqual(after);
    });
  });
  it('diagnoses duplicates, normalized aliases, corrupt JSON and imprecise opaque numbers without inserting or journaling',async()=>{
    await profiles(async admin=>{
      const service=f.serviceFor(admin.db);
      for(const patch of [{templateName:' SUSPENDED_WINDOW '},{type:2},{isDel:1},{value:'{bad'},
        {value:'{"opaque":9007199254740993}'},{value:'{"opaque":1.234567890123456789}'},{value:'{"opaque":1e-999}'}]) {
        await f.db.update(systemDise).set({templateName:'suspended_window',type:3,isDel:0,value:JSON.stringify(fabStored()),...patch}).where(eq(systemDise.id,88));
        const before=await f.snapshot(),page=await service.read();expect(page.present).toBe(true);expect(page.editable).toBe(false);expect(page.issues.length).toBeGreaterThan(0);
        await expect(service.save(input(page.revision),fabActor)).rejects.toBeInstanceOf(FabSettingsRejected);expect(await f.snapshot()).toEqual(before);
      }
      await f.db.update(systemDise).set({templateName:'suspended_window',type:3,isDel:0,value:JSON.stringify(fabStored())}).where(eq(systemDise.id,88));
      await f.db.insert(systemDise).values({id:89,templateName:' suspended_window ',type:3,value:'{}'});
      const before=await f.snapshot(),page=await service.read();expect(page.editable).toBe(false);expect(page.row).toBeNull();
      await expect(service.save(input(page.revision),fabActor)).rejects.toBeInstanceOf(FabSettingsRejected);expect(await f.snapshot()).toEqual(before);
    });
  });
  it('retains malformed concrete fields as diagnostics and explicitly repairs them while preserving mergeable extensions',async()=>{
    const stored={...fabStored(),is_show:'invalid',index:99,shifting:9007199254740993,main_ago_image:7,button:'invalid'};
    await f.db.update(systemDise).set({value:JSON.stringify(stored)}).where(eq(systemDise.id,88));
    await profiles(async admin=>{
      const service=f.serviceFor(admin.db),page=await service.read();expect(page.editable).toBe(true);expect(page.values).toMatchObject({is_show:null,index:null,shifting:null,main_ago_image:null,button:[]});
      expect(page.raw_values).toMatchObject({is_show:'invalid',button:'invalid'});
      await service.save(input(page.revision),fabActor);const saved=JSON.parse((await f.db.select().from(systemDise).where(eq(systemDise.id,88)))[0].value!);
      expect(saved).toMatchObject({...fabNewValues(),extra_root:stored.extra_root});
    });
  });
  it('rejects stale xmin, reused source ids, private/nonimage attachments and unknown page links before all DML',async()=>{
    await profiles(async admin=>{
      const service=f.serviceFor(admin.db),initial=await service.read();await f.db.update(systemDise).set({status:1}).where(eq(systemDise.id,88));
      let before=await f.snapshot();const stale=input(initial.revision);await expect(service.save(stale,fabActor)).rejects.toMatchObject({name:'FabSettingsStaleVersion',request_id:stale.request_id,payload_hash:await fabHash(fabCanonical(stale).canonical)});expect(await f.snapshot()).toEqual(before);
      const page=await service.read(),row=page.values!.button[0];
      for(const values of [{...fabNewValues(),main_ago_image:'/api/assets/42'},{...fabNewValues(),main_ago_image:'/api/assets/43'},
        {...fabNewValues(),button:[{...row,source_id:initial.values!.button[0].source_id}]},
        {...fabNewValues(),button:[row,row]}, {...fabNewValues(),button:[{source_id:null,img:'/i.png',url:'/pages/unknown/index'}]}]) {
        before=await f.snapshot();await expect(service.save(input(page.revision,values),fabActor)).rejects.toBeInstanceOf(FabSettingsRejected);expect(await f.snapshot()).toEqual(before);
      }
    });
  });
  it('rolls back explicit initialization and audit together on a genuine late journal SQL failure',async()=>{
    await f.db.delete(systemDise).where(eq(systemDise.id,88));
    await f.exec("CREATE FUNCTION public.fail_fab_journal() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'owned late journal failure'; END$$");
    await f.exec('CREATE TRIGGER fail_fab_journal BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION public.fail_fab_journal()');
    await profiles(async admin=>{
      const service=f.serviceFor(admin.db),body=input((await service.read()).revision),before=await f.snapshot(),result=await outcome(service.save(body,fabActor));
      expect(result.ok).toBe(false);if(!result.ok) {expect(result.error).not.toBeInstanceOf(FabSettingsRejected);expect(result.error).not.toBeInstanceOf(FabSettingsStaleVersion);}
      expect(await f.snapshot()).toEqual(before);
    });
  });
  it('serializes the same UUID across exact independent Admin LOGIN sessions and denies cross-actor reuse',async()=>{
    await profiles(async(admin,app)=>{
      const secondDb=createDbFromConnectionString(admin.connectionString,1),service=f.serviceFor(admin.db),body=input((await service.read()).revision),held=gate(),release=gate();
      try { await f.withPeer(async sentinel=>{
        const holder=sentinel.db.transaction(async tx=>{await tx.execute(sql`SELECT pg_advisory_xact_lock(${FAB_SETTINGS_LOCK_NAMESPACE},0)`);held.resolve();await release.promise;});await held.promise;
        const [identity]=await secondDb.execute(sql`SELECT pg_backend_pid() AS pid,current_user AS role,session_user AS session`);expect(identity.role).toBe(admin.role);expect(identity.session).toBe(admin.role);
        const a=outcome(service.save(body,fabActor)),b=outcome(f.serviceFor(secondDb).save(body,fabActor));
        try { await waitForFinanceBlock(f.db,admin.pid,sentinel.pid);await waitForFinanceBlock(f.db,Number(identity.pid),sentinel.pid); }
        finally {release.resolve();await holder;}
        const [one,two]=await Promise.all([a,b]);expect(one.ok).toBe(true);expect(two).toEqual(one);
        expect((await f.snapshot()).logs).toHaveLength(1);
      });
        const before=await f.snapshot();await expect(service.save(body,{id:8})).rejects.not.toBeInstanceOf(FabSettingsRejected);expect(await f.snapshot()).toEqual(before);
        expect((await outcome(app.exec("INSERT INTO system_dise(name) VALUES('denied')"))).ok).toBe(false);
      } finally {release.resolve();await secondDb.$client.end({timeout:5});}
    });
  });
  it('waits before row locks for an actual legacy writer and rereads its committed phantom under READ COMMITTED',async()=>{
    await profiles(async admin=>{
      const service=f.serviceFor(admin.db),body=input((await service.read()).revision),entered=gate(),release=gate();
      await f.withPeer(async writer=>{
        const holder=writer.db.transaction(async tx=>{await tx.insert(systemDise).values({templateName:'suspended_window',type:3,value:'{}'});entered.resolve();await release.promise;});await entered.promise;
        const saving=outcome(service.save(body,fabActor));
        try {await waitForFinanceBlock(f.db,admin.pid,writer.pid);expect((await f.exec(`SELECT mode FROM pg_locks WHERE pid=${admin.pid} AND relation='system_dise'::regclass AND NOT granted`))[0].mode).toBe('ShareRowExclusiveLock');}
        finally {release.resolve();await holder;}
        const result=await saving;expect(result.ok).toBe(false);if(!result.ok) expect(result.error).toBeInstanceOf(FabSettingsStaleVersion);
        expect((await f.snapshot()).logs).toHaveLength(0);expect((await service.read()).editable).toBe(false);
      });
    });
  });
  it('holds the catalog fence through journal commit and blocks a direct importer INSERT by exact PID',async()=>{
    await profiles(async admin=>{
      const body=input((await f.serviceFor(admin.db).read()).revision),entered=gate(),release=gate();let gated=false;
      const db=observeFabDb(admin.db,async(_tx,command)=>{if(!gated && /LOCK TABLE.*system_dise.*SHARE ROW EXCLUSIVE/i.test(command)){gated=true;entered.resolve();await release.promise;}});
      const saving=outcome(f.serviceFor(db).save(body,fabActor));await entered.promise;
      await f.withPeer(async writer=>{
        const inserting=outcome(writer.db.insert(systemDise).values({templateName:'suspended_window',type:3,value:'{}'}));
        try {await waitForFinanceBlock(f.db,writer.pid,admin.pid);expect((await f.exec(`SELECT mode FROM pg_locks WHERE pid=${admin.pid} AND relation='system_dise'::regclass AND granted`)).some(row=>row.mode==='ShareRowExclusiveLock')).toBe(true);}
        finally {release.resolve();}
        expect((await saving).ok).toBe(true);expect((await inserting).ok).toBe(true);
      });
      expect((await f.snapshot()).logs).toHaveLength(1);
    });
  });
  it('holds actual platform attachment share locks through commit and prevents concurrent deletion during validation',async()=>{
    await profiles(async admin=>{
      const body=input((await f.serviceFor(admin.db).read()).revision,{...fabNewValues(),main_ago_image:'/api/assets/41'}),entered=gate(),release=gate();let gated=false;
      const db=observeFabDb(admin.db,async(_tx,command)=>{if(!gated && /system_attachment.*for share/i.test(command)){gated=true;entered.resolve();await release.promise;}});
      const saving=outcome(f.serviceFor(db).save(body,fabActor));await entered.promise;
      await f.withPeer(async writer=>{
        const deleting=outcome(writer.exec('DELETE FROM system_attachment WHERE att_id=41'));
        try {await waitForFinanceBlock(f.db,writer.pid,admin.pid);}
        finally {release.resolve();}
        expect((await saving).ok).toBe(true);expect((await deleting).ok).toBe(true);
      });
      expect((await f.serviceFor(admin.db).read()).issues).toContain('图片素材不可用或不属于平台，请修复');
      expect((await f.snapshot()).logs).toHaveLength(1);
    });
  });
  it('observes the real transaction-local 5/2/5 deadlines preserving stricter session limits',async()=>{
    await profiles(async admin=>{
      await admin.exec("SET statement_timeout='2000ms'");await admin.exec("SET lock_timeout='400ms'");await admin.exec("SET idle_in_transaction_session_timeout='2000ms'");
      let observed=false;const db=observeFabDb(admin.db,async(tx,command)=>{
        if(!observed && command.includes("set_config('statement_timeout'")) {observed=true;const [limits]=await tx.execute(sql`SELECT current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock,current_setting('idle_in_transaction_session_timeout') AS idle`);
          expect(limits).toEqual({statement:'2s',lock:'400ms',idle:'2s'});}
      });
      await f.serviceFor(db).read();expect(observed).toBe(true);
    });
  });
});
