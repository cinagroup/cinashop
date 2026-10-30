import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {createAdminStoreFixture} from './helpers/adminStoreFixture';
import {systemAttachment,systemStore,systemConfig} from '@/models/schema';
import {PublicLocationStoreService} from '@/services/system/PublicLocationStoreService';
import type {Env} from '@/env';
describe('existing nearby-store producer current platform media authorisation',()=>{
 let f:Awaited<ReturnType<typeof createAdminStoreFixture>>,service:PublicLocationStoreService;
 const env={APP_KEY:'owned-store-public-image-key',CONFIG_KV:{get:async()=>null,put:async()=>{}}} as unknown as Env;
 const image=(attId:number,patch={})=>({attId,type:1,relationId:0,moduleType:1,fileType:1,imageType:8,attDir:`/api/assets/${attId}`,sattDir:`/api/assets/${attId}`,name:`attachments/admin/1/store-${attId}.png`,attType:'image/png',...patch});
 beforeAll(async()=>{f=await createAdminStoreFixture();service=new PublicLocationStoreService(f.container,env);vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('No provider I/O'));},30000);
 afterAll(async()=>{expect(fetch).not.toHaveBeenCalled();vi.restoreAllMocks();await f.close();});
 beforeEach(async()=>{await f.reset();await f.db.insert(systemConfig).values([{menuName:'store_func_status',value:'1'}]);await f.db.insert(systemStore).values([{id:10,name:'原公开门店',isShow:1,isStore:1,image:'/api/assets/1',oblongImage:'/api/assets/2'},{id:20,name:'隐藏门店',isShow:0,isStore:1,image:'/api/assets/3'},{id:30,name:'已删门店',isDel:1,isShow:1,isStore:1}]);await f.db.insert(systemAttachment).values([image(1),image(2,{type:3,relationId:9,moduleType:3,name:'attachments/user/9/private.png'}),image(3)]);});
 async function snapshot(){return {stores:await f.db.select().from(systemStore),assets:await f.db.select().from(systemAttachment),sequences:Array.from(await f.db.execute(sql`SELECT sequencename,last_value FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename`))};}
 it('signs existing eligible logo and blanks private existing oblong without creating another author slot',async()=>{const before=await snapshot(),rows=await service.nearbyStore({},0);expect(rows.map(r=>r.id)).toEqual([10]);expect(rows[0].image).toMatch(/^\/api\/assets\/1\?expires=\d+&signature=/);expect(rows[0].oblong_image).toBe('');expect(await snapshot()).toEqual(before);});
 it('checks both historical image fields against current realm metadata before signing',async()=>{await f.db.update(systemStore).set({image:'/api/assets/2',oblongImage:'/api/assets/3'}).where(eq(systemStore.id,10));const [row]=await service.nearbyStore({},0);expect(row.image).toBe('');expect(row.oblong_image).toMatch(/^\/api\/assets\/3\?expires=/);});
 it('does not project credentials, unsafe paths or malformed canonical IDs and preserves public paging and raw storage',async()=>{await f.db.update(systemStore).set({image:'/api/assets/01',oblongImage:'javascript:bad',bankCode:'private-bank'}).where(eq(systemStore.id,10));const before=await snapshot(),rows=await service.nearbyStore({page:'1',limit:'1'},0);expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({image:'',oblong_image:''});expect(JSON.stringify(rows)).not.toContain('private-bank');expect(await snapshot()).toEqual(before);});
});
