import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  USER_CENTER_DESIGN_COVERAGE_GATES, classifyUserCenterDesignCoverage,
  hasUserCenterDesignContract, inspectUserCenterDesignCoverage, userCenterDesignSourceFiles,
  type UserCenterDesignGate,
} from '../scripts/user-center-design-coverage';

const screens = ['/setting/user-center-design'];
const sources = Object.fromEntries(Object.entries(userCenterDesignSourceFiles()).map(([role,file]) => [role, existsSync(resolve('..',file)) ? readFileSync(resolve('..',file),'utf8') : '']));
const baseline = inspectUserCenterDesignCoverage(screens,sources);
type Mutant = [string,string,string,string,UserCenterDesignGate];
const mutants: Mutant[] = [
  ['statistics actual personal card navigation','mobile',"openMerchant('statistics')","previewStats()",'statisticsTwoStyles'],
  ['statistics actual waiting-shipment navigation','mobile',"openMerchant('unshipped')","previewStats()",'statisticsTwoStyles'],
  ['statistics scoped typed reader','merchantStatsPage',"controller.read('statistics',isMerchantStatistics)","fakeStats('statistics',isMerchantStatistics)",'statisticsTwoStyles'],
  ['statistics true manager scope','managerStatistics','requireStoreManagerScope(db,uid,storeId)','fakeManagerScope(db,uid,storeId)','statisticsTwoStyles'],
  ['statistics actual root predicate','managerStatistics','pid>=0','pid=0','statisticsTwoStyles'],
  ['statistics actual signed request','merchantApi','uni.request({','fakeRequest({','statisticsTwoStyles'],
  ['customer statistics alias preserves its partial boundary','navigation','"/pages/admin/order/index": { target: "/pages/customer-work/statistics", coverage: "partial_replacement" }','"/pages/admin/order/index": { target: "/pages/customer-work/statistics", coverage: "candidate_covered" }','statisticsTwoStyles'],
  ['merchant statistics destination is actually registered','navigation','"/pages/merchant/statistics",','"/pages/merchant/unregistered-statistics",','statisticsTwoStyles'],
  ['save template action','admin','@click="controller.save()"','@click="previewOnly()"','adminScreen'],
  ['actual Admin controller construction','admin','new UserCenterDesignController(','new FakeDesignController(','adminScreen'],
  ['PHP video property4 default','contract','property: [0, 1, 2, 3, 4]','property: [0, 1, 2, 3, 5]','sixBlockContract'],
  ['strict full root guard call','contract','keys(value, USER_CENTER_DESIGN_KEYS)','"keys(value, USER_CENTER_DESIGN_KEYS)"','sixBlockContract'],
  ['save strict value validation','input','isUserCenterDesignValue(body.value)','acceptAnyValue(body.value)','sixBlockContract'],
  ['member info control payload','admin',':model-value="state.draft.member.per_show_type"',':model-value="0"','memberEditor'],
  ['member style payload assignment','admin','draft.member.style=value','draft.order.style=1','memberEditor'],
  ['member property real controller call','admin','controller.toggleProperty(option.id,checked)','fakeProperty(option.id,checked)','memberEditor'],
  ['order style control action','admin',"setStyle('order',value)","fakeStyle('order',value)",'orderStatisticsEditor'],
  ['statistics show control','admin',':model-value="state.draft.orderStatic.is_show"',':model-value="1"','orderStatisticsEditor'],
  ['all actual list rows','admin','(item,index) in state.draft[listKey].list','(item,index) in []','listEditors'],
  ['actual list reorder controller','controller','[list[index],list[next]]=[list[next]!,list[index]!]','void list','listEditors'],
  ['actual normal list removal','controller','draft[key].list.splice(index,1)','void index','listEditors'],
  ['type1 list new payload','admin','draft.menu.list.push({...item,type:1})','draft.menu.list.push({...item,type:2})','listEditors'],
  ['preview loops actually use both menus','preview',"const menuKeys=['menu','merMenu']","const menuKeys=['menu']",'previewsSix'],
  ['preview actual property binding','preview','v-for="item in value.member.property"','v-for="item in [0,1,2]"','previewsSix'],
  ['asset picker actual query','picker','await apiUserCenterAssets(','await fakeAssets(','assetLinkPicker'],
  ['link picker actual query','picker','await apiUserCenterLinkTargets(','await fakeLinks(','assetLinkPicker'],
  ['asset picker actual selection','picker','choose(row.canonical_url,row.preview_url)','choose(row.preview_url,row.preview_url)','assetLinkPicker'],
  ['save one actual route prefix','v1Routes',"v1Routes.post('/admin/config/user-center-design/save', adminAuth, AdminUserCenterDesign.save)","v1Routes.post('/admin/config/other/save', adminAuth, AdminUserCenterDesign.save)",'dedicatedRoutes'],
  ['actual route is not a same-name string','adminRoutes',"adminapiRoutes.get('/config/user-center-design', adminAuth, AdminUserCenterDesign.read)","String(\"adminapiRoutes.get('/config/user-center-design', adminAuth, AdminUserCenterDesign.read)\")",'dedicatedRoutes'],
  ['HTTP uses bounded dedicated input','httpController','readUserCenterDesignBody(c.req.raw)','c.req.json()','dedicatedRoutes'],
  ['1592 exact menu identity','permission','menu.id === 1592 && menu.authType === 1','menu.id === 1592 && menu.authType === 2','permissions1592'],
  ['1592 never grants manage','permission',"resolved.add('user_center_design.view')","resolved.add('user_center_design.manage')",'permissions1592'],
  ['three authority actual catalog hash','reader',"themeHash({template:'member',type:3,member,groups,data})","themeHash({template:'member',type:3,member})",'sharedThreeAuthority'],
  ['shared read actual producer call','reader','readUserCenterDesignSnapshot(tx)','"readUserCenterDesignSnapshot(tx)"','sharedThreeAuthority'],
  ['collection lock actual function','service','await lockDiseCatalogForMutation(tx);','const fake="await lockDiseCatalogForMutation(tx)";','atomicMutation'],
  ['whole collection fresh revision','service','catalog.revision!==canonical.revision','false','atomicMutation'],
  ['actor UUID receipt binding','service','journals[0].actor!==id','false','atomicMutation'],
  ['actual journal insertion','service','await tx.insert(systemLog)','await fakeJournal(systemLog)','atomicMutation'],
  ['actual member write','service','await tx.update(systemDise)','await fakeUpdate(systemDise)','atomicMutation'],
  ['real removed row disable','service','tx.update(systemGroupData).set({status:0})','tx.update(systemGroupData).set({sort:0})','atomicMutation'],
  ['merchant list cardinality','service','items.length!==old.length','false','merchantImmutable'],
  ['merchant source and URL fixed','service','next.sourceId===item.sourceId&&next.url===item.url','next.sourceId===item.sourceId','merchantImmutable'],
  ['merchant payload edit refuses URL','admin',"key!=='merMenu'||field!=='url'","true",'merchantImmutable'],
  ['generic normalized member deletion','crud','templateName === "member"','templateName === "unused"','genericProtection'],
  ['generic list does not expose member','crud',"['product_detail','member'].includes(normalizeDiseTemplateName(row.templateName))","['product_detail'].includes(normalizeDiseTemplateName(row.templateName))",'genericProtection'],
  ['a newly registered generic group write blocks parity','adminRoutes',"adminapiRoutes.get('/config/user-center-design', adminAuth, AdminUserCenterDesign.read);","adminapiRoutes.get('/config/user-center-design', adminAuth, AdminUserCenterDesign.read);\nadminapiRoutes.post('/setting/system_group_data/save',adminAuth,AdminUserCenterDesign.save);",'genericProtection'],
  ['persist full frozen original before submit','controller','this.ports.storage.setItem(key, JSON.stringify(frozen))','void frozen','actorRecovery'],
  ['pending original actor fence','controller','row.actor !== actor','false','actorRecovery'],
  ['rejection proof exact payload','controller','data.payloadHash === pending.fingerprint','true','actorRecovery'],
  ['actual receipt lookup','controller','this.ports.receipt(value.input.operationId, job.controller.signal)','fakeReceipt(value.input.operationId, job.controller.signal)','actorRecovery'],
  ['public canonical ordered image projection','publicReader','publicUserCenterDesignValue(snapshot.value!,snapshot.imagePreviews)','fakeProjection(snapshot.value!)','publicProjection'],
  ['real public menu endpoint consumer','mobileConsumer',"parseUserCenterMenu(await scope.request('/menu/user'),scope.owner.uid)","fakeMenu(await scope.request('/menu/user'),scope.owner.uid)",'publicProjection'],
  ['public DTO strict value guard','mobileDecoder','isPublicUserCenterDesignValue(value.diy_data)','true','publicProjection'],
  ['real private asset selected UI','mobile','v-for="item in properties"','v-for="item in fixedSample"','realNineAssets'],
  ['real financial withdrawable source','publicReader','UserFinanceReadService.commissionSummary(scoped,uid,now)','fakeCommission(scoped,uid,now)','realNineAssets'],
  ['member asset selection actual filter','mobileDecoder','diy_data.member.property.includes(item.id)','true','realNineAssets'],
  ['actual member photo binding','mobile',':src="media(profile?.avatar)"',':src="sampleAvatar"','memberFiveStyles'],
  ['style4 real commission value','mobile','{{ commission.brokerage_price }}','{{ 100 }}','memberFiveStyles'],
  ['style2 actual level discount','mobile','Number(profile.vip_discount)/10','10','memberFiveStyles'],
  ['three order styles use actual choice','mobile',':class="`order-style-${design.order.style}`"',':class="`order-style-1`"','orderThreeStyles'],
  ['five actual order entries','mobile','v-for="item in orderEntries"','v-for="item in []"','orderThreeStyles'],
  ['actual deadline reload','mobileConsumer','pending.stop_time*1000<=clock.value){void load();}','pending.stop_time*1000<=clock.value){void snapshot;}','orderThreeStyles'],
  ['carousel actual poster array','mobile','(item,index) in design.poster.list','(item,index) in fixedBanners','posterCarousel'],
  ['carousel real autoplay','mobile',':autoplay="true"',':autoplay="false"','posterCarousel'],
  ['carousel actual nav','mobile',"openMenu('poster',index)","previewPoster(index)",'posterCarousel'],
  ['actual both menu blocks','mobile',':block="design.merMenu"',':block="design.menu"','menuThreeStyles'],
  ['actual menu row picture','menus',':src="media(item.pic)"',':src="fixedIcon"','menuThreeStyles'],
  ['video real category query','collectionConsumer',"scope.request<unknown>('/collect/user','GET',{page:next,limit:LIMIT,category},true)","scope.request<unknown>('/collect/user','GET',{page:next,limit:LIMIT,category:'product'},true)",'videoCollections'],
  ['video real delete category','collectionConsumer',"scope.request<unknown>('/collect/del','POST',{id:[id],category},true)","scope.request<unknown>('/collect/del','POST',{id:[id]},true)",'videoCollections'],
  ['video actual renderer source','collection',':src="media(playing.video_url)"',':src="fixedMovie"','videoCollections'],
  ['backend actual video relation list','collectionService','this.videoCollection(uid,page,limit)','this.productCollection(uid,page,limit)','videoCollections'],
  ['member-code real QR data','mobileConsumer','qr.addData(code.value)','qr.addData("000000")','memberCode'],
  ['member-code strict actual actor','mobileConsumer','row.actor_uid!==scope.owner.uid','false','memberCode'],
  ['member-code real expiry','mobileConsumer','row.expires_at<=now','false','memberCode'],
  ['member-code actual server source','profileController','service(c).paymentCodeSnapshot(uid(c))','fakeCode(uid(c))','memberCode'],
  ['account hide clears private state','mobileConsumer','onHide(()=>{visible=false;clear();})','onHide(()=>{visible=false;})','userLifecycle'],
  ['logout actual server revoke','mobileConsumer',"scope.request('/logout','GET',{},true)","fakeLogout('/logout','GET',{},true)",'userLifecycle'],
  ['request deadline abort actual transport','mobileApi','task?.abort();','void task;','requestDeadline'],
  ['request deadline actual timeout','mobileApi','timer=setTimeout(','timer=fakeTimeout(','requestDeadline'],
];
describe('complete personal-centre connected source gates',()=>{
  it('connects actual two-style statistic actions while keeping unimplemented work customer-service and delivery roles partial',()=>{
    expect(baseline.adminScreen).toBe(true);
    expect(baseline.statisticsTwoStyles).toBe(true);
    expect(baseline.menuRoleGates).toBe(false);
    expect(classifyUserCenterDesignCoverage(baseline)).toBe('partial');
    expect(hasUserCenterDesignContract(sources.contract!)).toBe(true);
  });
  it('requires every gate before candidate and an actual screen before partial',()=>{
    const all=Object.fromEntries(USER_CENTER_DESIGN_COVERAGE_GATES.map(key=>[key,true]));
    expect(classifyUserCenterDesignCoverage(all)).toBe('candidate');
    for(const key of USER_CENTER_DESIGN_COVERAGE_GATES)expect(classifyUserCenterDesignCoverage({...all,[key]:false}),key).toBe(key==='adminScreen'?'missing':'partial');
    expect(classifyUserCenterDesignCoverage({})).toBe('missing');
  });
  it.each(mutants)('%s',(name,role,before,after,gate)=>{
    expect(baseline[gate],`${name}: current live gate`).toBe(true);
    expect(sources[role]?.includes(before),`${name}: actual mutation target`).toBe(true);
    const value=inspectUserCenterDesignCoverage(screens,{...sources,[role]:sources[role]!.split(before).join(after)});
    expect(value[gate],`${name}: removed connection`).toBe(false);
    expect(classifyUserCenterDesignCoverage(value)).not.toBe('candidate');
  });
  it('rejects file-wide comments, imports and unrelated functions as source evidence',()=>{
    const onlyComments=Object.fromEntries(Object.entries(sources).map(([role,source])=>[role,`/* ${source.replace(/\*\//gu,'* /')} */`]));
    expect(Object.values(inspectUserCenterDesignCoverage(screens,onlyComments)).every(value=>!value)).toBe(true);
    const original=sources.picker!,needle='await apiUserCenterAssets(';
    expect(original.includes(needle)).toBe(true);
    const unrelated=original.replace(needle,'await fakeAssets(')+'\nfunction unrelated(){return apiUserCenterAssets({page:1,limit:20});}\n';
    expect(inspectUserCenterDesignCoverage(screens,{...sources,picker:unrelated}).assetLinkPicker).toBe(false);
  });
});
