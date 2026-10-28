const test=require('node:test');
const {assert,clone,deferred,tick,rawQuery,row,report,envelope,media,harness,elements,text}=require('./helpers/extract-directory-runtime.cjs');
const query=()=>({page:1,limit:20,status:null,extract_type:'',keyword:'',start:0,stop:0});
const owner=call=>call.headers['Authori-zation']==='Bearer B'?22:9;
const listed=call=>envelope(report(owner(call),rawQuery(call.url)));
function readonly(calls){assert.ok(calls.length);for(const call of calls){assert.equal(call.method,'GET');assert.equal(call.cache,'no-store');assert.equal(call.credentials,'same-origin');assert.equal(call.headers.Accept,'application/json');assert.ok(call.signal instanceof AbortSignal);assert.ok(/^Bearer [AB]$/.test(call.headers['Authori-zation']));assert.ok(call.url.startsWith('/adminapi/extract/directory'));}}

test('drafts do not fetch; accepted filters survive failed search and own pagination/retry',async t=>{
  let fail=false;const h=harness({fetch:call=>fail?envelope(null,{code:400,msg:'临时读取失败'}):listed(call)}),m=h.mount();t.after(()=>m.unmount());await tick();const s=m.state;
  assert.equal(h.calls.length,1);assert.deepEqual(s.accepted.value,query());assert.equal(s.count.value,41);assert.equal(s.list.value.length,20);
  s.draft.keyword='0';s.draft.status='0';s.draft.extract_type='weixin';assert.equal(h.calls.length,1);assert.equal(s.dirty.value,true);
  assert.equal(await s.search(),true);const accepted={...query(),keyword:'0',status:0,extract_type:'weixin'};assert.deepEqual(s.accepted.value,accepted);
  const prior=s.report.value;s.draft.keyword='00';fail=true;assert.equal(await s.search(),false);assert.equal(s.report.value,prior);assert.deepEqual(s.accepted.value,accepted);assert.equal(s.error.value,'临时读取失败');
  fail=false;assert.equal(await s.changePage(2),true);assert.deepEqual(rawQuery(h.calls.at(-1).url),{...accepted,page:2});assert.equal(s.draft.keyword,'00');assert.equal(s.dirty.value,true);
  assert.equal(await s.retry(),true);assert.deepEqual(rawQuery(h.calls.at(-1).url),{...accepted,page:2});assert.equal(await s.changePage(1001),false);assert.equal(await s.changePage(4),false);
  assert.equal(await s.resetFilters(),true);assert.deepEqual(s.accepted.value,query());assert.equal(s.draft.keyword,'');readonly(h.calls);
});

test('new list generation aborts and ignores older success and older HTTP error',async t=>{
  const pending=[];const h=harness({fetch:(call,n)=>{if(n===1)return listed(call);const d=deferred();pending.push({call,...d});return d.promise;}}),m=h.mount();t.after(()=>m.unmount());await tick();const s=m.state;
  s.draft.keyword='first';const first=s.search();s.draft.keyword='second';const second=s.search();assert.equal(pending.length,2);assert.equal(pending[0].call.signal.aborted,true);
  pending[1].resolve(listed(pending[1].call));assert.equal(await second,true);assert.equal(s.accepted.value.keyword,'second');
  pending[0].resolve(envelope(null,{http:401,code:410000,msg:'旧会话'}));assert.equal(await first,false);assert.equal(s.accepted.value.keyword,'second');assert.equal(h.storage.get('admin_token'),'A');assert.equal(h.window.location.href,'/finance/extract');assert.equal(s.loading.value,false);
  readonly(h.calls);
});

test('captured owner is immutable, unchanged focus preserves filters, ABA invalidates old callbacks',async t=>{
  const h=harness(),m=h.mount();t.after(()=>m.unmount());await tick();const s=m.state;
  s.draft.keyword='saved';await s.search();const a=s.owner.capture(),stamp=s.owner.stamp(),calls=h.calls.length;assert.ok(Object.isFrozen(a));assert.equal(a.current(),true);
  h.window.dispatchEvent(new Event('focus'));await tick();assert.equal(s.owner.stamp(),stamp);assert.equal(s.accepted.value.keyword,'saved');assert.equal(h.calls.length,calls);
  h.setSession('B',22);h.setSession('A',9);await tick();assert.equal(a.current(),false);assert.equal(a.id,9);assert.equal(a.token,'A');assert.equal(s.accepted.value.keyword,'');assert.notEqual(s.owner.stamp(),stamp);
  readonly(h.calls);
});

test('replacement owner retains its own report after old owner completes with 401',async t=>{
  const old=deferred();let oldCall;const h=harness({fetch:(call,n)=>{if(n===2){oldCall=call;return old.promise;}return listed(call);}}),m=h.mount();t.after(()=>m.unmount());await tick();const s=m.state;
  s.draft.keyword='old';const request=s.search();h.setSession('B',22);await tick();assert.equal(s.report.value.actor_id,22);assert.equal(s.accepted.value.keyword,'');
  old.resolve(envelope(null,{http:401,code:410000,msg:'旧登录已失效'}));assert.equal(await request,false);assert.equal(oldCall.signal.aborted,true);assert.equal(s.report.value.actor_id,22);assert.equal(h.storage.get('admin_token'),'B');assert.equal(h.window.location.href,'/finance/extract');readonly(h.calls);
});

test('live capability loss clears retained data/media and blocks reads until a fresh permitted identity',async t=>{
  const h=harness(),m=h.mount();t.after(()=>m.unmount());await tick();const s=m.state;s.draft.keyword='sensitive';await s.search();const retained=s.list.value[0];
  h.setSession('A',9,[]);await tick();assert.equal(s.canView.value,false);assert.equal(s.report.value,null);assert.equal(s.accepted.value,null);assert.equal(s.media.value,null);assert.equal(s.draft.keyword,'');const n=h.calls.length;
  assert.equal(await s.search(),false);assert.equal(await s.openMedia(retained),false);assert.equal(h.calls.length,n);
  h.setSession('A',9,['extract.manage']);await tick();assert.equal(s.canView.value,true);assert.ok(s.report.value);assert.equal(s.accepted.value.keyword,'');readonly(h.calls);
});

test('current forbidden list response clears private state without a write or confirmation path',async t=>{
  let forbidden=false;const h=harness({fetch:call=>forbidden?envelope(null,{http:403,code:400011,msg:'没有权限'}):listed(call)}),m=h.mount();t.after(()=>m.unmount());await tick();const s=m.state;
  forbidden=true;assert.equal(await s.retry(),false);assert.equal(s.report.value,null);assert.equal(s.accepted.value,null);assert.equal(s.canView.value,false);assert.equal(s.blocked.value,true);const n=h.calls.length;assert.equal(await s.retry(),false);assert.equal(h.calls.length,n);readonly(h.calls);
});

test('media opts in to current rows only; list refresh invalidates retained row objects',async t=>{
  const h=harness({fetch:call=>call.url.includes('/media?')?envelope(media({id:Number(call.url.split('/')[4]),revision:'a'.repeat(64)},owner(call),1700000000)):listed(call)}),m=h.mount();t.after(()=>m.unmount());await tick();const s=m.state,original=s.list.value[0],n=h.calls.length;
  assert.equal(await s.openMedia(clone(original)),false);assert.equal(h.calls.length,n);
  assert.equal(await s.openMedia(original),true);assert.equal(s.media.value.state,'ready');assert.ok(s.mediaImage.value.src.startsWith('/api/assets/14?'));assert.equal(h.calls.length,n+1);
  const req=h.calls.at(-1);assert.equal(req.url,`/adminapi/extract/directory/41/media?revision=${'a'.repeat(64)}`);
  await s.retry();assert.equal(s.media.value,null);assert.equal(await s.openMedia(original),false);assert.equal(s.mediaImage.value,null);readonly(h.calls);
});

test('media generation/close suppress reverse replies; unavailable returns no preview',async t=>{
  const pending=[];const h=harness({fetch:call=>{if(!call.url.includes('/media?'))return listed(call);const d=deferred();pending.push({call,...d});return d.promise;}}),m=h.mount();t.after(()=>m.unmount());await tick();const s=m.state,[one,two]=s.list.value;
  const a=s.openMedia(one),b=s.openMedia(two);assert.equal(pending[0].call.signal.aborted,true);
  pending[1].resolve(envelope(media(two,9,1700000000,{available:false,reference:null,preview:null,expires:null})));assert.equal(await b,true);assert.equal(s.media.value.id,two.id);assert.equal(s.media.value.state,'unavailable');assert.equal(s.mediaImage.value,null);
  pending[0].resolve(envelope(media(one,9,1700000000)));assert.equal(await a,false);assert.equal(s.media.value.id,two.id);assert.equal(s.mediaImage.value,null);
  const late=s.openMedia(one);s.closeMedia();pending[2].resolve(envelope(media(one,9,1700000000)));assert.equal(await late,false);assert.equal(s.media.value,null);readonly(h.calls);
});

test('900-second media expiry erases src without auto-renew; explicit retry and stale image errors are fenced',async t=>{
  const h=harness({fetch:call=>call.url.includes('/media?')?envelope(media({id:Number(call.url.split('/')[4]),revision:'a'.repeat(64)},owner(call),Math.floor(h.clock.now/1000))):listed(call)}),m=h.mount();t.after(()=>m.unmount());await tick();const s=m.state;
  await s.openMedia(s.list.value[0]);const old={...s.mediaImage.value},n=h.calls.length;await h.advance(900000);assert.equal(s.media.value.state,'expired');assert.equal(s.media.value.preview,'');assert.equal(s.mediaImage.value,null);assert.equal(h.calls.length,n);
  assert.equal(await s.retryMedia(),true);const current={...s.mediaImage.value};assert.notEqual(current.key,old.key);s.imageFailed(old.src,old.key);assert.equal(s.mediaImage.value.key,current.key);
  s.imageFailed(current.src,current.key);assert.equal(s.media.value.state,'error');assert.equal(s.mediaImage.value,null);assert.equal(s.media.value.expires,null);readonly(h.calls);
});

test('media revision conflict clears report and viewer; retry reuses accepted query',async t=>{
  const h=harness({fetch:call=>call.url.includes('/media?')?envelope(null,{http:409,code:409,msg:'记录版本已变化'}):listed(call)}),m=h.mount();t.after(()=>m.unmount());await tick();const s=m.state;s.draft.keyword='accepted';await s.search();const accepted=clone(s.accepted.value);
  assert.equal(await s.openMedia(s.list.value[0]),false);assert.equal(s.report.value,null);assert.equal(s.media.value,null);assert.deepEqual(s.accepted.value,accepted);assert.match(s.error.value,/记录已变化/);
  s.draft.keyword='unapplied';await s.retry();assert.deepEqual(rawQuery(h.calls.at(-1).url),accepted);readonly(h.calls);
});

test('unmount aborts both outstanding reads and erases all private preview state',async()=>{
  const pending=[];const h=harness({fetch:(call,n)=>{if(n===1)return listed(call);const d=deferred();pending.push({call,...d});return d.promise;}}),m=h.mount();await tick();const s=m.state,one=s.list.value[0];const request=s.openMedia(one);
  m.unmount();assert.equal(pending[0].call.signal.aborted,true);assert.equal(s.report.value,null);assert.equal(s.accepted.value,null);assert.equal(s.media.value,null);pending[0].resolve(envelope(media(one,9,1700000000)));assert.equal(await request,false);assert.equal(s.mediaImage.value,null);
});

test('calendar shortcuts use Shanghai dates independently of workstation timezone',()=>{
  const h=harness(),{extractDirectoryShortcut:shortcut}=h.load('composables/useExtractDirectory.ts');
  // 2024-01-01 00:30 Shanghai is still 2023-12-31 in UTC/Los Angeles.
  const now=1704040200;
  assert.deepEqual(shortcut('today',now),['2024/01/01 00:00','2024/01/01 00:30']);
  assert.deepEqual(shortcut('yesterday',now),['2023/12/31 00:00','2023/12/31 00:00']);
  assert.deepEqual(shortcut('recent7',now),['2023/12/26 00:00','2024/01/01 00:30']);
  assert.deepEqual(shortcut('last-month',now),['2023/12/01 00:00','2023/12/31 00:00']);
  assert.deepEqual(shortcut('month',now),['2024/01/01 00:00','2024/01/01 00:30']);
});

test('compiled readonly page renders exact signed money and anomalous historical state without review writes',async t=>{
  const huge='123456789012345678901234567890.01';
  const h=harness({fetch:call=>{const q=rawQuery(call.url),record=row(1,{uid:0,nickname:'历史用户',extract_type:'legacy-channel',net_amount:'-2.00',fee_amount:'0.50',gross_amount:'-1.50',status:-32768,media_available:false,mark:'历史备注',fail_msg:'保留历史说明'});return envelope(report(9,q,1,{list:[record],statistics:{price:'-1.50',priced:'0.00',brokerage_count:huge,brokerage_not:huge}}));}}),m=h.mountPage();t.after(()=>m.unmount());await tick();const rendered=text(m.tree);
  for(const value of ['提现申请','待提现金额','佣金总金额','已提现金额','未提现金额','¥'+huge,'历史用户','用户 ID：0','¥-2.00','申请金额 ¥-1.50','未知状态（-32768）','legacy-channel','保留历史说明'])assert.ok(rendered.includes(value),value);
  assert.equal(elements(m.tree,n=>n.props?.['data-element']==='el-date-picker')[0].props['show-now'],false);
  assert.equal(elements(m.tree,n=>n.tag==='img').length,0);assert.ok(!/实现分片|尚未迁移|只读新页|测试夹具|900秒|立即撤销/.test(rendered));
  assert.equal(elements(m.tree,n=>n.tag==='button'&&/审核通过|拒绝|付款|打款/.test(text(n))).length,0);readonly(h.calls);
});


test('compiled page retains the accepted expanded date caption after media409 clears the report',async t=>{
  const midnight=1704038400,nextMidnight=1704124800;
  const h=harness({fetch:call=>{
    if(call.url.includes('/media?'))return envelope(null,{http:409,code:409,msg:'记录版本已变化'});
    const q=rawQuery(call.url),data=report(9,{...q,start:0,stop:0},1);
    if(q.start!==0){assert.equal(q.start,midnight);assert.equal(q.stop,midnight);data.query=q;data.period={start:midnight,stop:midnight,effective_stop:nextMidnight,rule:'equal-plus-day'};}
    return envelope(data);
  }}),m=h.mountPage();t.after(()=>m.unmount());await tick();const s=m.state;
  s.draft.dates=['2024/01/01 00:00','2024/01/01 00:00'];assert.equal(await s.search(),true);await tick();
  const caption='2024/01/01 00:00 至 2024/01/02 00:00（含结束时刻）';assert.ok(text(m.tree).includes(caption));
  assert.equal(await s.openMedia(s.list[0]),false);await tick();assert.equal(s.report,null);assert.equal(s.accepted.start,midnight);assert.equal(s.media,null);
  assert.equal(s.error,'记录已变化，请重新查询列表');assert.equal(elements(m.tree,n=>n.props?.['data-element']==='el-alert'&&n.props?.['data-title']==='记录已变化，请重新查询列表').length,1);assert.ok(text(m.tree).includes(caption));readonly(h.calls);
});

test('existing finance route defaults to directory; authorized review survives while tab/identity changes really unmount reads',async t=>{
  const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
  const {sourceRoot,fallbackRoot,vue}=require('./helpers/extract-directory-runtime.cjs');
  const read=relative=>fs.readFileSync(fs.existsSync(path.join(sourceRoot,relative))?path.join(sourceRoot,relative):path.join(fallbackRoot,relative),'utf8');
  // Preserve the actual route import and every byte of the legacy review/API
  // workspace. This suite does not claim new async-write fences for that code.
  assert.match(read('router/index.ts'),/path: "finance\/extract",\s*name: "finance-extract",\s*component: \(\) => import\("@\/pages\/finance\/ExtractList\.vue"\)/);
  assert.equal(crypto.createHash('sha256').update(read('pages/finance/ExtractReview.vue')).digest('hex'),'b48ae8ae063f714933084fc5824580313031ccc500ac08ba31b6497b4a177407');
  const delayed=deferred();let pendingMedia;
  const h=harness({fetch:call=>{if(call.url.includes('/media?')){pendingMedia=call;return delayed.promise;}return listed(call);}}),m=h.mountPage('ExtractList.vue');t.after(()=>m.unmount());await tick();
  const tab=label=>elements(m.tree,n=>n.props?.role==='tab'&&text(n)===label)[0];
  const directory=()=>vue.proxyRefs(h.instances.get(path.join(sourceRoot,'pages/finance/AdminExtractList.vue')));
  assert.ok(tab('提现申请'));assert.equal(tab('提现审核'),undefined);assert.equal(h.calls.length,1);assert.equal(h.legacyCalls.length,0);
  h.setSession('A',9,['extract.manage']);await tick();assert.ok(tab('提现审核'));const d=directory();d.draft.keyword='private draft';await d.search();
  const mediaRequest=d.openMedia(d.list[0]);assert.ok(pendingMedia);assert.equal(d.media.state,'loading');const staleReviewA=tab('提现审核').props.onClick;
  staleReviewA();await tick();assert.equal(elements(m.tree,n=>Object.hasOwn(n.props,'data-extract-directory')).length,0);assert.equal(d.report,null);assert.equal(d.media,null);assert.equal(pendingMedia.signal.aborted,true);
  delayed.resolve(envelope(media({id:41,revision:'a'.repeat(64)},9,1700000000)));assert.equal(await mediaRequest,false);
  assert.ok(text(m.tree).includes('原审核用户'));assert.ok(elements(m.tree,n=>n.tag==='button'&&text(n)==='通过').length);assert.ok(elements(m.tree,n=>n.tag==='button'&&text(n)==='拒绝').length);
  assert.deepEqual(h.legacyCalls.map(x=>[x.method,x.url]),[['GET','/extract/list']]);
  tab('提现申请').props.onClick();await tick();assert.equal(directory().draft.keyword,'');assert.ok(directory().report);assert.equal(elements(m.tree,n=>n.props?.id==='extract-review-panel').length,0);
  tab('提现审核').props.onClick();await tick();h.setSession('B',22,['extract.manage']);await tick();assert.ok(directory().report);assert.equal(directory().report.actor_id,22);const before=h.legacyCalls.length;
  staleReviewA();await tick();assert.equal(h.legacyCalls.length,before);assert.ok(elements(m.tree,n=>n.props?.id==='extract-directory-panel').length);
  const staleReviewB=tab('提现审核').props.onClick;staleReviewB();await tick();assert.ok(text(m.tree).includes('原审核用户'));
  h.setSession('B',22,['extract.view']);await tick();assert.equal(tab('提现审核'),undefined);assert.ok(directory().report);staleReviewB();await tick();assert.equal(elements(m.tree,n=>n.props?.id==='extract-review-panel').length,0);
  h.setSession('B',22,[],0);await tick();assert.ok(tab('提现审核'),'Existing super-admin review access remains available');
  assert.equal(h.legacyCalls.filter(x=>x.method!=='GET').length,0);assert.equal(h.notices.length,0);readonly(h.calls);
});


// Pure contracts share the same actual-source loader as the UI tests. There
// are no absolute source paths, stripped imports or second API implementation.
const apiHarness=harness(),api=apiHarness.load('api/extractDirectory.ts');
const revision='a'.repeat(64),source={id:3,uid:11,revision,extract_type:'alipay',media_available:true};
const contractMedia=()=>({version:1,actor_id:9,id:3,revision,available:true,reference:'/api/assets/14',preview:'/api/assets/14?expires=1700000900&signature='+'A'.repeat(43),expires:1700000900});
test('Shanghai IANA retains actual historical summer time and normal epoch display',()=>{
 assert.equal(api.extractDirectoryShanghaiTime(581126400),'1988/06/01 09:00');
 assert.equal(api.extractDirectoryShanghaiTime(1700000000),'2023/11/15 06:13');
 assert.equal(api.extractDirectoryShanghaiTime(0),'');
 assert.match(api.extractDirectoryShanghaiTime(2147570047),/^2038\/01\/20 /);
 assert.equal(api.extractDirectoryDateInput('1988/06/01 09:00'),581126400);
});
test('historical IANA midnight expands inclusively, equal input takes precedence',()=>{
 assert.deepEqual(api.extractDirectoryPeriod(581090400,581094000),{start:581090400,stop:581094000,effective_stop:581180400,rule:'midnight-plus-day'});
 assert.equal(api.extractDirectoryPeriod(581094000,581094000).rule,'equal-plus-day');
});
test('wall input rejects invalid calendar, incomplete time and query epoch bounds',()=>{
 for(const s of ['2023/02/29 12:00','2024/01/01','2024/01/01 24:00','1970/01/01 08:00','2038/02/01 00:00']) assert.throws(()=>api.extractDirectoryDateInput(s));
});
test('exact private media ticket binds row, owner and natural 900s deadline',()=>{
 const m=contractMedia();assert.deepEqual(api.decodeExtractDirectoryMedia(m,9,source,1700000000),m);
 assert.throws(()=>api.decodeExtractDirectoryMedia(m,10,source,1700000000));
 assert.throws(()=>api.decodeExtractDirectoryMedia(m,9,{...source,id:4},1700000000));
 assert.throws(()=>api.decodeExtractDirectoryMedia(m,9,{...source,revision:'b'.repeat(64)},1700000000));
 assert.throws(()=>api.decodeExtractDirectoryMedia(m,9,source,1699999999));
 assert.throws(()=>api.decodeExtractDirectoryMedia(m,9,source,1700000900));
});
test('media cannot introduce external, encoded, alternate, duplicated or unowned preview',()=>{
 const m=contractMedia();for(const preview of ['https://evil.invalid'+m.preview,'//evil.invalid'+m.preview,m.preview.replace('/api/','/adminapi/'),m.preview+'&extra=1',m.preview+'&expires=1700000900',m.preview.replace('/14?','/%31%34?')]) assert.throws(()=>api.decodeExtractDirectoryMedia({...m,preview},9,source,1700000000));
 for(const changed of [{media_available:false},{uid:0},{extract_type:'bank'}]) assert.throws(()=>api.decodeExtractDirectoryMedia(m,9,{...source,...changed},1700000000));
 assert.throws(()=>api.decodeExtractDirectoryMedia({...m,reference:'/api/assets/15'},9,source,1700000000));
});
test('unavailable response has exactly null references and no hidden leakage',()=>{
 const m={...contractMedia(),available:false,reference:null,preview:null,expires:null};assert.deepEqual(api.decodeExtractDirectoryMedia(m,9,source,1700000000),m);
 for(const key of ['reference','preview','expires']) assert.throws(()=>api.decodeExtractDirectoryMedia({...m,[key]:key==='expires'?1:'/api/assets/14'},9,source,1700000000));
 assert.throws(()=>api.decodeExtractDirectoryMedia({...m,object_key:'private'},9,source,1700000000));
});
test('query preserves raw PHP search string zero while rejecting implicit/coerced scalars',()=>{
 const q=api.extractDirectoryDefaults();assert.equal(api.normalizeExtractDirectoryQuery({...q,keyword:'0'}).keyword,'0');
 assert.equal(api.normalizeExtractDirectoryQuery({...q,keyword:'00'}).keyword,'00');
 for(const change of [{page:'1'},{page:0},{limit:21},{status:-0},{keyword:'a\u0000b'},{start:60,stop:0}]) assert.throws(()=>api.normalizeExtractDirectoryQuery({...q,...change}));
});


test('Shanghai IANA fold has two valid historical epochs while ambiguous and nonexistent wall inputs are refused',()=>{
 assert.equal(api.extractDirectoryShanghaiTime(589912200),'1988/09/11 01:30');
 assert.equal(api.extractDirectoryShanghaiTime(589915800),'1988/09/11 01:30');
 assert.throws(()=>api.extractDirectoryDateInput('1988/09/11 01:30'),/重复时段/);
 assert.throws(()=>api.extractDirectoryDateInput('1988/04/17 02:30'),/不存在/);
 assert.equal(apiHarness.calls.length,0,'Pure contracts issue no fetch');
});
