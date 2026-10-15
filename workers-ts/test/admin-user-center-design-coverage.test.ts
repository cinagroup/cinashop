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
  ['manager middleware actual factory','v1Routes','const managerAuth = managerRuntimeAuthMiddleware();','const managerAuth = authMiddleware({force:true});','statisticsTwoStyles'],
  ['manager middleware actual import','v1Routes','"@/middleware/manager-runtime-auth"','"@/middleware/fake-manager-runtime-auth"','statisticsTwoStyles'],
  ['manager authenticated producer','managerAuth','return (c, next) => authenticate(c, async () => {','return (c, next) => fakeAuthenticate(c, async () => {','statisticsTwoStyles'],
  ['manager forced application authentication','managerAuth','authMiddleware({force:true})','authMiddleware({force:false})','statisticsTwoStyles'],
  ['manager authentication actual import','managerAuth',"'./auth'","'./fake-auth'",'statisticsTwoStyles'],
  ['manager session actual import','managerAuth',"'@/lib/di'","'@/lib/fake-di'",'statisticsTwoStyles'],
  ['manager independent connection producer','managerAuth','createManagerDatabaseSession(c.env)','createApplicationDatabaseSession(c.env)','statisticsTwoStyles'],
  ['manager container is installed','managerAuth',"c.set('container', session.container)","c.set('container', application)",'statisticsTwoStyles'],
  ['manager original application restored','managerAuth',"c.set('container', application)","c.set('container', session.container)",'statisticsTwoStyles'],
  ['manager session always closes','managerAuth','await session.close();','void session;','statisticsTwoStyles'],
  ['manager independent binding','managerSession','const binding = env.HYPERDRIVE_MANAGER;','const binding = env.HYPERDRIVE;','statisticsTwoStyles'],
  ['manager rejects App binding alias','managerSession','binding === env.HYPERDRIVE','false','statisticsTwoStyles'],
  ['manager rejects Admin binding alias','managerSession','binding === env.HYPERDRIVE_ADMIN','false','statisticsTwoStyles'],
  ['manager rejects identical App connection','managerSession','binding.connectionString === env.HYPERDRIVE?.connectionString','false','statisticsTwoStyles'],
  ['manager rejects identical Admin connection','managerSession','binding.connectionString === env.HYPERDRIVE_ADMIN?.connectionString','false','statisticsTwoStyles'],
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
  ["bounded operational controller import", "adminRoutes", "'@/controllers/api/v1/AdminOperationalGroupDataController'", "'@/controllers/api/v1/FakeOperationalGroupDataController'", "genericProtection"],
  ["operational write keeps authenticated handler", "adminRoutes", "adminapiRoutes.post('/setting/group_data', adminAuth, AdminOperationalGroup.create)", "adminapiRoutes.post('/setting/group_data', adminAuth, AdminUserCenterDesign.save)", "genericProtection"],
  ["operational write cannot drop authentication", "adminRoutes", "adminapiRoutes.delete('/setting/group_data/:id', adminAuth, AdminOperationalGroup.remove)", "adminapiRoutes.delete('/setting/group_data/:id', AdminOperationalGroup.remove)", "genericProtection"],
  ["new operational alias is still rejected", "adminRoutes", "adminapiRoutes.post('/setting/group_data/save_all', adminAuth, AdminOperationalGroup.saveAll);", "adminapiRoutes.post('/setting/group_data/save_all', adminAuth, AdminOperationalGroup.saveAll);\nadminapiRoutes.post('/setting/operational_group_data/save',adminAuth,AdminOperationalGroup.saveAll);", "genericProtection"],
  ["operational controller actual service import", "operationalController", "'@/services/admin/AdminOperationalGroupDataService'", "'@/services/admin/FakeOperationalGroupDataService'", "genericProtection"],
  ["operational controller actual mutation", "operationalController", "x.service.mutate(operation,c.req.param('id'),input,x.actor)", "fakeMutate(operation,c.req.param('id'),input,x.actor)", "genericProtection"],
  ["operational handler operation binding", "operationalController", "write(c,'replace')", "write(c,'create')", "genericProtection"],
  ["operational HTTP bounded body", "operationalController", "readBoundedUtf8Text(c.req.raw,256*1024)", "readBoundedUtf8Text(c.req.raw,1024*1024)", "genericProtection"],
  ["operational exact six image group boundary", "operationalInput", "integral_shop_banner:'积分商城轮播图',", "integral_shop_banner:'积分商城轮播图',routine_my_menus:'用户菜单',", "genericProtection"],
  ["operational name rejects unknown groups", "operationalInput", "typeof value!=='string'||!Object.hasOwn(OPERATIONAL_GROUPS,value)", "typeof value!=='string'", "genericProtection"],
  ["operational actual input guard import", "operationalService", "from './AdminOperationalGroupDataInput'", "from './FakeOperationalGroupDataInput'", "genericProtection"],
  ["operational database group name is validated", "operationalService", "operationalName(current.configName);", "fakeOperationalName(current.configName);", "genericProtection"],
  ["operational group definition remains supported", "operationalService", "operationalFields(current.fields);return current;", "fakeFields(current.fields);return current;", "genericProtection"],
  ["operational group is rechecked after table fence", "operationalService", "const group=await this.group(tx,scope,true);", "const group=initial;", "genericProtection"],
  ["operational row reader stays group scoped", "operationalService", "where(eq(systemGroupData.gid,group.id))", "where(eq(systemGroupData.gid,1))", "genericProtection"],
  ["operational write keeps current authority barrier", "operationalService", "await acquireAdminAuthorityWriteBarrier(tx);", "await fakeAuthorityBarrier(tx);", "genericProtection"],
  ["operational write uses real transaction", "operationalService", "return this.transaction(actor,true,async tx=>", "return fakeTransaction(actor,true,async tx=>", "genericProtection"],
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
  it('connects actual two-style statistic actions while keeping the complete legacy operator replacement partial',()=>{
    expect(baseline.adminScreen).toBe(true);
    expect(baseline.statisticsTwoStyles).toBe(true);
    expect(baseline.menuRoleGates).toBe(false);
    expect(classifyUserCenterDesignCoverage(baseline)).toBe('partial');
    expect(hasUserCenterDesignContract(sources.contract!)).toBe(true);
  });
  const managerRoutes=[...sources.v1Routes!.matchAll(/^v1Routes\.(get|post)\('([^']+)',managerAuth,([^\n]+)\);$/gmu)]
    .filter(row=>row[2]!.startsWith('/store/manager/'));
  it('checks the complete 29-route authenticated manager boundary',()=>{expect(managerRoutes).toHaveLength(29);});
  it.each(managerRoutes.map(row=>[row[2]!,row[0]]))('rejects bare application auth on actual manager route %s',(_path,route)=>{
    expect(baseline.statisticsTwoStyles).toBe(true);
    const altered=sources.v1Routes!.replace(route,route.replace(',managerAuth,',',authMiddleware({force:true}),'));
    expect(inspectUserCenterDesignCoverage(screens,{...sources,v1Routes:altered}).statisticsTwoStyles).toBe(false);
  });
  it('keeps the registered cashier read/write pages within the existing partial legacy work boundary',()=>{
    const pages=JSON.parse(sources.pages!) as {pages:Array<{path:string}>};
    for(const name of ['cashierRecords','cashierRecord','cashier']){
      expect(pages.pages.some(page=>page.path===`pages/customer-work/${name}`)).toBe(true);
      expect(sources.navigation).toContain(`"/pages/customer-work/${name}",`);
      const source=readFileSync(resolve('..',`view/uniapp-ts/src/pages/customer-work/${name}.vue`),'utf8');
      expect(source).toContain('useCustomerWork(');
      if(name==='cashier'){
        expect(source).toContain('useCustomerWorkCashier(manager');
        expect(source).toContain('data.capabilities.cashier_second_card !== true');
      }else{
        expect(source).toContain('useCustomerCashierRead(manager)');
        expect(source).toContain('await reader.read(');
      }
    }
    expect(sources.navigation).toContain('"/pages/admin/work/index": { target: "/pages/customer-work/index", coverage: "partial_replacement" }');
    expect(baseline.menuRoleGates).toBe(false);expect(classifyUserCenterDesignCoverage(baseline)).toBe('partial');
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
