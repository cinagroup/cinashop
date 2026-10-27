import {eq,sql} from 'drizzle-orm';
import {agreement,systemAttachment,systemDise,user} from '@/models/schema';
import {membershipHomeFixture} from './membershipHomeFixture';
import {sortedDiyState} from './diyStateFixture';

/** Own additive fixture: the published parent fixtures and their receipts are
 * immutable. Setup controls are separate from all authenticated business GETs. */
export async function membershipClauseFixture(){
 const f=await membershipHomeFixture();
 try{
  await f.exec('CREATE UNIQUE INDEX IF NOT EXISTS membership_clause_fixture_type ON agreement(type)');
  const before=await f.snapshot(),resourcesBefore=f.resources();
  const [source]=await f.db.select().from(systemAttachment).where(eq(systemAttachment.attId,f.platformImage.att_id));
  if(!source)throw Error('Missing actual inherited platform picture');
  const videoId=19001,foreignId=19002,videoKey='attachments/admin/1/2026/10/19000000-0000-4000-8000-000000000001.mp4';
  const videoBytes=new Uint8Array(f.mp4);f.objects.set(videoKey,{bytes:videoBytes,type:'video/mp4'});
  await f.db.insert(systemAttachment).values([{...source,attId:videoId,name:videoKey,attDir:'/api/assets/'+videoId,attSize:String(videoBytes.length),attType:'video/mp4',fileType:2},{...source,attId:foreignId,attDir:'/api/assets/'+foreignId,relationId:77}]);
  const title='后台配置会员协议·原版',html=`<h4 style="font-size:20px;color:#966a32;line-height:1.7">会员协议实际标题</h4><p style="font-size:14px;color:rgb(38,38,38);line-height:1.74;margin-top:8px">协议正文保留原版颜色、字号、行距。<strong>请认真阅读。</strong></p><p>实际平台说明图：</p><img src="${f.platformImage.url}" alt="会员协议说明图"><script>window.__clauseUnsafe=1</script><p onclick="window.__clauseUnsafe=2">安全正文</p>`;
  await f.db.update(agreement).set({title,content:html,status:1,sort:-20}).where(eq(agreement.type,1));
  const other=await f.db.select({id:agreement.id}).from(agreement).where(eq(agreement.type,2));
  if(other.length)await f.db.update(agreement).set({title:'不可回退推广协议',content:'<p>TYPE2_MUST_NOT_FALLBACK</p>',status:1,sort:999}).where(eq(agreement.type,2));
  else await f.db.insert(agreement).values({id:19002,type:2,title:'不可回退推广协议',content:'<p>TYPE2_MUST_NOT_FALLBACK</p>',status:1,sort:999});
  for(const uid of[11,22])await f.db.update(user).set({nickname:'协议只读验收'+uid}).where(eq(user.uid,uid));
  const blocks=structuredClone(f.blocks),footer=blocks.find(row=>row.name==='pageFoot')!;
  footer.menuList=[{name:'会员协议',link:'/pages/annex/vip_clause/index',imgList:[f.platformImage.url,f.platformImage.url]},{name:'会员中心',link:'/pages/annex/vip_paid/index',imgList:[f.platformImage.url,f.platformImage.url]}];
  for(const id of[1,2])await f.db.update(systemDise).set({value:JSON.stringify(blocks),version:'owned-membership-clause-1'}).where(eq(systemDise.id,id));
  const baseline=await f.snapshot();f.cache.clear();
  async function restore(){
   await f.exec('TRUNCATE '+f.tables.map(name=>'"'+name+'"').join(',')+' RESTART IDENTITY');
   await f.db.transaction(async tx=>{
    for(const table of f.tables)if(baseline[table].length)await tx.execute(sql`INSERT INTO ${sql.identifier(table)} SELECT * FROM jsonb_populate_recordset(NULL::${sql.identifier(table)},${JSON.stringify(baseline[table])}::jsonb)`);
    for(const sequence of baseline.__sequences)await tx.execute(sql`SELECT setval(${String(sequence.name)}::regclass,${String(sequence.last)}::bigint,${Boolean(sequence.called)})`);
   });f.cache.clear();
  }
  return{...f,restore,baseline:sortedDiyState(baseline),title,html,blocks,platformVideo:{id:videoId,url:'/api/assets/'+videoId,key:videoKey,bytes:videoBytes},foreignImage:'/api/assets/'+foreignId,setup:{before,after:baseline,resources_before:resourcesBefore,resources_after:f.resources(),legacy_entry:'/pages/annex/vip_clause/index',target:'/pages/user/memberClause',parent_setup:f.setup}};
 }catch(error){await f.close();throw error;}
}
