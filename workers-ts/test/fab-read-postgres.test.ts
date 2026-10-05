/** Actual public controllers on the production app SELECT slice, local R2 only.
 * This is a seven-table native fixture, not full runtime commissioning. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { AppVariables, Env } from '../src/env';
import { createContainerFromDb } from '../src/lib/di';
import { systemDise } from '../src/models/schema';
import { suspended } from '../src/controllers/api/v1/DiyHomeController';
import { asset } from '../src/controllers/system/AttachmentController';
import { fabBindings, fabSettingsFixture, fabStored } from './helpers/fabSettingsFixture';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('FAB common native public projection and signed media',()=>{
  let f:Awaited<ReturnType<typeof fabSettingsFixture>>,fetchGuard:ReturnType<typeof vi.spyOn>;
  beforeEach(async()=>{
    f=await fabSettingsFixture();fetchGuard=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{throw Error('FAB read has no provider or remote media calls');});
  },30_000);
  afterEach(async()=>{if(fetchGuard) expect(fetchGuard).not.toHaveBeenCalled();fetchGuard?.mockRestore();await f?.close();},30_000);
  type Peer=Parameters<Parameters<typeof f.withRuntimeRole>[0]>[0];
  async function profiles(run:(app:Peer)=>Promise<void>) {
    await f.withRuntimeRole(app=>f.withRuntimeRole(async admin=>{
      await f.installSlice(app,admin);expect((await app.exec('SELECT current_user,session_user'))[0]).toEqual({current_user:app.role,session_user:app.role});
      expect(app.pid).not.toBe(admin.pid);await run(app);
    }));
  }
  it('shares authoritative six-key JSON consumption with Admin without publishing opaque attrs or source identities',async()=>{
    await profiles(async app=>{
      const before=await f.snapshot(),admin=await f.serviceFor(app.db).read(),value=await f.publicFor(app.db).read();
      expect(admin.row).toMatchObject({id:88,status:0,is_show:0});
      expect(value).toEqual({is_show:1,index:3,shifting:78,main_ago_image:'/legacy/before.png',main_after_image:'/legacy/after.png',
        button:fabStored().button.map(({img,url})=>({img,url}))});
      expect(Object.keys(value)).toEqual(['is_show','index','shifting','main_ago_image','main_after_image','button']);
      expect(JSON.stringify(value)).not.toContain('future');expect(JSON.stringify(value)).not.toContain('extra_root');expect(JSON.stringify(value)).not.toContain('source_id');
      expect(await f.snapshot()).toEqual(before);
    });
  });
  it('retains all four geometries, full 0..100 offsets and masks unused historical main fields by style',async()=>{
    await profiles(async app=>{
      for(const index of [1,2,3,4]) {
        const stored={...fabStored(),index,shifting:index===1?0:100};
        await f.db.update(systemDise).set({value:JSON.stringify(stored),status:0,isShow:0}).where(eq(systemDise.id,88));const before=await f.snapshot();
        const value=await f.publicFor(app.db).read();expect(value).toMatchObject({is_show:1,index,shifting:stored.shifting});expect(value.button).toHaveLength(3);
        expect(value.main_ago_image).toBe(index===4?'':'/legacy/before.png');expect(value.main_after_image).toBe(index===3?'/legacy/after.png':'');
        expect(await f.snapshot()).toEqual(before);
      }
      await f.db.update(systemDise).set({value:JSON.stringify({...fabStored(),is_show:0})}).where(eq(systemDise.id,88));expect((await f.publicFor(app.db).read()).is_show).toBe(0);
    });
  });
  it('retains safe siblings and external mini-program paths while making one historical unsafe target/media unclickable',async()=>{
    await profiles(async app=>{
      const stored={...fabStored(),button:[
        {img:'/safe.png',url:'/pages/unknown/index',future:{keep:'never public'}},
        {img:'/api/assets/42',url:'https://example.com/private'},
        {img:'/third.png',url:'packageA/detail/index?x=1@APPID=wx0123456789abcdef'},
      ]};
      await f.db.update(systemDise).set({value:JSON.stringify(stored)}).where(eq(systemDise.id,88));const before=await f.snapshot();
      const snapshot=await f.serviceFor(app.db).read();expect(snapshot.editable).toBe(true);expect(snapshot.issues.length).toBeGreaterThan(0);
      const value=await f.publicFor(app.db).read();expect(value).toMatchObject({is_show:1,index:3});expect(value.button).toEqual([
        {img:'/safe.png',url:''},{img:'',url:''},{img:'/third.png',url:'packageA/detail/index?x=1@APPID=wx0123456789abcdef'},
      ]);
      expect(JSON.stringify(value)).not.toContain('/api/assets/42');expect(JSON.stringify(value)).not.toContain('never public');expect(await f.snapshot()).toEqual(before);
    });
  });
  it('hides ambiguous/corrupt/missing identities without seeding while large safe opaque values do not discard usable core fields',async()=>{
    await profiles(async app=>{
      for(const patch of [{templateName:' SUSPENDED_WINDOW '},{type:2},{value:'{bad'},
        {value:'{"opaque":9007199254740993}'},{value:'{"opaque":1.234567890123456789}'},{value:'{"opaque":1e-999}'}]) {
        await f.db.update(systemDise).set({templateName:'suspended_window',type:3,value:JSON.stringify(fabStored()),...patch}).where(eq(systemDise.id,88));const before=await f.snapshot();
        expect((await f.publicFor(app.db).read()).is_show).toBe(0);expect(await f.snapshot()).toEqual(before);
      }
      await f.db.update(systemDise).set({templateName:'suspended_window',type:3,value:JSON.stringify({...fabStored(),opaque:'x'.repeat(100_001)})}).where(eq(systemDise.id,88));
      expect((await f.publicFor(app.db).read()).is_show).toBe(1);
      await f.db.insert(systemDise).values({templateName:' suspended_window ',type:3,value:'{}'});let before=await f.snapshot();
      expect((await f.publicFor(app.db).read()).is_show).toBe(0);expect(await f.snapshot()).toEqual(before);
      await f.exec("DELETE FROM system_dise WHERE lower(btrim(template_name))='suspended_window'");before=await f.snapshot();
      expect((await f.publicFor(app.db).read()).is_show).toBe(0);expect(await f.snapshot()).toEqual(before);
    });
  });
  it('serves the actual DIY controller and verified platform raster asset under a distinct non-owner app LOGIN',async()=>{
    await f.db.update(systemDise).set({value:JSON.stringify({...fabStored(),main_ago_image:'/api/assets/41',button:[
      {img:'/api/assets/41',url:'/pages/index/index'},{img:'/two.png',url:'https://example.com'},{img:'/three.png',url:'/pages/cart/index'},
    ]})}).where(eq(systemDise.id,88));
    await profiles(async peer=>{
      await expect(peer.exec('CREATE TABLE public.fab_forbidden(id integer)')).rejects.toMatchObject({code:'42501'});
      await expect(peer.exec("UPDATE system_dise SET value='{}' WHERE id=88")).rejects.toMatchObject({code:'42501'});
      const gets:string[]=[];
      type LocalObject=Pick<R2ObjectBody,'body'|'httpEtag'|'size'|'writeHttpMetadata'>;
      // A local R2 get boundary uses the actual field types consumed by the
      // resolver. Unused methods/bindings are intentionally unavailable.
      const bindings={...fabBindings,ASSETS_BUCKET:{get:async(key:string):Promise<LocalObject>=>{
        gets.push(key);return {body:new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array([4,5,6]));controller.close();}}),
          httpEtag:'"fab-owned-raster"',size:3,writeHttpMetadata:(headers:Headers)=>headers.set('Content-Type','image/png')};
      }}} satisfies Pick<Env,'APP_KEY'> & {ASSETS_BUCKET:{get:(key:string)=>Promise<LocalObject>}};
      const env=bindings as unknown as Env,container=createContainerFromDb(peer.db),http=new Hono<{Bindings:Env;Variables:AppVariables}>();
      http.use('*',async(c,next)=>{c.set('container',container);c.set('uid',0);await next();});
      http.get('/api/diy/get_suspended',suspended);http.get('/api/assets/:id',asset);
      const before=await f.snapshot(),response=await http.request('/api/diy/get_suspended',undefined,env);
      expect(response.status).toBe(200);expect(response.headers.get('Cache-Control')).toContain('no-store');
      const body=await response.json<{status:number;data:{is_show:number;main_ago_image:string;button:Array<{img:string;url:string}>}}>();
      expect(body.status).toBe(200);expect(body.data.is_show).toBe(1);expect(gets).toEqual([]);
      const url=new URL(body.data.main_ago_image,'https://owned.local'),expires=url.searchParams.get('expires')!,signature=url.searchParams.get('signature')!;
      expect(url.pathname).toBe('/api/assets/41');expect(Number(expires)).toBeGreaterThan(Math.floor(Date.now()/1000));
      expect(signature).toBe(createHmac('sha256',bindings.APP_KEY).update(`GET\n/api/assets/41\n${expires}`).digest('base64url'));
      expect(body.data.button[0].img).toBe(body.data.main_ago_image);
      const image=await http.request(url.pathname+url.search,undefined,env);expect(image.status).toBe(200);expect(image.headers.get('Content-Type')).toBe('image/png');expect(image.headers.get('Cache-Control')).toBe('private, no-store');
      expect([...new Uint8Array(await image.arrayBuffer())]).toEqual([4,5,6]);
      expect((await http.request(`/api/assets/41?expires=${expires}&signature=invalid`,undefined,env)).status).toBe(404);
      expect(gets).toEqual(['attachments/admin/1/2026/10/00000000-0000-4000-8000-000000000041.png']);expect(await f.snapshot()).toEqual(before);
    });
  });
});
