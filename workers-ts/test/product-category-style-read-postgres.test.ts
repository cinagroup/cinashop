import { afterEach,beforeEach,describe,expect,it } from 'vitest';
import { eq,sql } from 'drizzle-orm';
import { systemDise } from '../src/models/schema';
import { PRODUCT_CATEGORY_STYLES } from '../../view/common/productCategoryStyle';
import { publicProductCategoryStyle } from '../src/services/content/ProductCategoryStyleReadService';
import { observeCategoryDb,productCategoryStyleFixture } from './helpers/productCategoryStyleFixture';
type Fixture=Awaited<ReturnType<typeof productCategoryStyleFixture>>;
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('public category style common authority with actual SELECT-only app LOGIN',()=>{
  let f:Fixture;beforeEach(async()=>{f=await productCategoryStyleFixture();},30000);afterEach(async()=>{await f?.close();},30000);
  it('uses the same saved ordinal for all ten layouts despite table switches or competing system_config',async()=>{
    await f.withRuntimeRole(async app=>{await f.installSelectSlice(app,'app');
      for(const{level,index}of PRODUCT_CATEGORY_STYLES){await f.db.update(systemDise).set({value:JSON.stringify({level,index,opaque:'legacy public extension'})}).where(eq(systemDise.id,88));
        const before=await f.snapshot(),snapshot=await f.readFor(app.db).read(),publicValue=await f.publicFor(app.db).productDetail();
        expect(publicValue.product_category).toEqual({level,index,opaque:'legacy public extension',configured:true,issues:[]});expect(publicValue.product_category).toMatchObject(publicProductCategoryStyle(snapshot));
        expect(publicValue.product_detail.showService).toEqual([2]);expect(snapshot).not.toHaveProperty('opaque');expect(await f.snapshot()).toEqual(before);
      }
      await f.db.update(systemDise).set({value:'{"level":3,"extension":"kept","configured":false,"issues":["forged"]}'}).where(eq(systemDise.id,88));
      const before=await f.snapshot();expect(await f.readFor(app.db).read()).toMatchObject({value:{level:3,index:1},configured:true,editable:true,issues:[]});
      expect((await f.publicFor(app.db).productDetail()).product_category).toEqual({level:3,index:1,extension:'kept',configured:true,issues:[]});expect(await f.snapshot()).toEqual(before);
    });
  });
  it('returns diagnosed display defaults without GET initialization or overriding alias/corrupt data',async()=>{await f.withRuntimeRole(async app=>{await f.installSelectSlice(app,'app');
    for(const patch of[{value:'broken'},{value:'{"level":3,"index":4}'},{templateName:'\tCATEGORY\n'},{type:1},{isDel:1}]){
      await f.db.update(systemDise).set({templateName:'category',type:3,isDel:0,value:'{"level":2,"index":1}',...patch}).where(eq(systemDise.id,88));const before=await f.snapshot(),result=await f.publicFor(app.db).productDetail();
      expect(result.product_category).toMatchObject({level:2,index:1,configured:false});expect(result.product_category.issues).toHaveLength(1);expect(await f.snapshot()).toEqual(before);
    }
    await f.db.delete(systemDise).where(eq(systemDise.id,88));const before=await f.snapshot();expect((await f.publicFor(app.db).productDetail()).product_category).toEqual({level:2,index:1,configured:false,issues:['category_style_missing']});expect(await f.snapshot()).toEqual(before);
  });});
  it('reads an unchanged RR snapshot while a separate actual writer updates the template',async()=>{await f.withRuntimeRole(async app=>{await f.installSelectSlice(app,'app');let observed=false;
    const db=observeCategoryDb(app.db,async(_tx,command)=>{if(!observed&&command.includes("set_config('statement_timeout'")){observed=true;await f.withPeer(async peer=>{await peer.db.update(systemDise).set({value:'{"level":3,"index":3}'}).where(eq(systemDise.id,88));});}});
    expect((await f.readFor(db).read()).value).toEqual({level:2,index:1});expect(observed).toBe(true);expect((await f.readFor(app.db).read()).value).toEqual({level:3,index:3});
  });});
  it('observes readonly RR and actual stricter transaction-local deadlines; ACL failures propagate',async()=>{await f.withRuntimeRole(async app=>{await f.installSelectSlice(app,'app');await app.exec("SET statement_timeout='2000ms'");await app.exec("SET lock_timeout='400ms'");await app.exec("SET idle_in_transaction_session_timeout='2000ms'");let observed=false;
    const db=observeCategoryDb(app.db,async(tx,command)=>{if(!observed&&command.includes("set_config('statement_timeout'")){observed=true;expect((await tx.execute(sql`SELECT current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS readonly,current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock,current_setting('idle_in_transaction_session_timeout') AS idle`))[0]).toEqual({isolation:'repeatable read',readonly:'on',statement:'2s',lock:'400ms',idle:'2s'});}});
    await f.readFor(db).read();expect(observed).toBe(true);await f.exec(`REVOKE SELECT ON system_dise FROM "${app.role}"`);
    await expect(f.readFor(app.db).read()).rejects.toMatchObject({cause:{code:'42501'}});
  });});
});
