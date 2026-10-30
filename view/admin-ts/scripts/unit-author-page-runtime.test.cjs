const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {runtime,tick,row,catalog,css,byLabel,text,buttons,replay,click,update,deferred,all,axios,sourceRepository}=require('./helpers/unit-author-runtime.cjs');
const base='/product/unit/author';
function scenario(name,fn){test(name,async()=>{const runs=[];const mount=async options=>{const r=runtime(options);runs.push(r);await tick();return r;};try{await fn(mount);}finally{for(const r of runs)await r.finish();}});}
const journal=r=>[...r.storage].filter(([key])=>key.startsWith('cinashop_unit_pending_v1_'));
const handler=(r,label)=>buttons(r,label)[0].props.onClick;
const common=r=>r.load(path.join(sourceRepository,'view/common/unitAuthor.ts'));
async function prepare(r,name='编辑后的单位'){await click(r,'编辑');await update(r,'编辑单位名称',name);await click(r,'保存');}
async function action(r,id=1,operation='update',operation_id='11111111-1111-4111-8111-111111111111'){
 const a={operation_id,actor_id:7,operation,target_id:operation==='create'?0:id,revision:'a'.repeat(64),payload:operation==='delete'?{}:{name:'原操作',sort:0},payload_hash:''};a.payload_hash=await common(r).unitPayloadHash(a);return a;
}
scenario('actual current Unit SFC reads one complete catalog and exposes exactly name and raw sort without a status writer',async mount=>{
 const r=await mount();assert.equal(r.reads().length,1);assert.equal(css(r,'unit-row').length,2);await click(r,'编辑');assert.equal(byLabel(r,'编辑单位名称').props.value,'单位1');assert.equal(byLabel(r,'编辑单位名称').props.maxlength,undefined);assert.equal(r.io.length,1);assert.ok(!text(r.tree).includes('图库'));assert.deepEqual(Object.keys(r.state.editor.draft),['name','sort']);assert.equal(byLabel(r,'编辑单位排序').props.value,'0');assert.ok(!buttons(r,'停用').length);assert.equal(byLabel(r,'编辑单位名称').props.maxlength,undefined);
});
scenario('create preserves raw command and displays normalized server readback',async mount=>{
 const r=await mount();await click(r,'新增单位');await update(r,'编辑单位名称','  新用户  ');await click(r,'保存');assert.equal(r.writes().length,0);await click(r,'确认提交');const a=r.writes()[0].body;assert.deepEqual(a.payload,{name:'  新用户  ',sort:0});assert.equal(a.payload_hash,await common(r).unitPayloadHash(a));assert.equal(journal(r).length,0);assert.equal(r.server.rows.at(-1).name,'新用户');assert.match(text(r.tree),/操作已完成/);
});
for(const name of ['😀'.repeat(50),'  历史名称  ','','\u0000历史\u0085'])scenario('exact historical name is kept without normalization '+JSON.stringify(name.slice(0,8)),async mount=>{
 const r=await mount({rows:[row(1,{name:name})]});await click(r,'编辑');assert.equal(byLabel(r,'编辑单位名称').props.value,name);await click(r,'保存');await click(r,'确认提交');assert.equal(r.writes()[0].body.payload.name,name);assert.equal(r.server.rows[0].name,name);
});
for(const name of ['','  ','x'.repeat(16),'😀'.repeat(16),'坏\u0000值','坏\u0085值','坏\ud800值','坏\udc00值'])scenario('new invalid name blocks confirmation and I/O '+JSON.stringify(name.slice(0,10)),async mount=>{
 const r=await mount();await click(r,'新增单位');await update(r,'编辑单位名称',name);await click(r,'保存');assert.equal(r.state.confirmation,null);assert.equal(r.writes().length,0);assert.ok(r.state.error);
});
scenario('15 Unicode names and whitespace raw budget do not use UTF16 maxlength',async mount=>{
 const r=await mount();await click(r,'新增单位');const value=' '.repeat(100)+'😀'.repeat(15)+' ';await update(r,'编辑单位名称',value);assert.equal(byLabel(r,'编辑单位名称').props.value,value);assert.equal(byLabel(r,'编辑单位名称').props.maxlength,undefined);assert.match(text(r.tree),/15 \/ 15/);await click(r,'保存');await click(r,'确认提交');assert.equal(r.writes()[0].body.payload.name,value);
});
scenario('native input node and issued fast input listener remain stable; old save rejects draft ABA',async mount=>{
 const r=await mount();await click(r,'编辑');const input=byLabel(r,'编辑单位名称'),oldSave=handler(r,'保存'),oldCancel=handler(r,'取消');replay(input.props.onInput,{target:{value:'A'}});replay(input.props.onInput,{target:{value:'AB'}});await tick();assert.equal(byLabel(r,'编辑单位名称'),input);assert.equal(input.props.value,'AB');await update(r,'编辑单位名称','单位1');replay(oldSave);replay(oldCancel);await tick();assert.ok(r.state.editor);assert.equal(r.state.confirmation,null);await click(r,'保存');assert.ok(r.state.confirmation);
});
scenario('actual enter-key confirm is retired by draft changes while current enter works',async mount=>{
 const r=await mount();await click(r,'编辑');const old=byLabel(r,'编辑单位名称').props.onKeyup;await update(r,'编辑单位名称','改变');replay(old,{key:'Enter'});await tick();assert.equal(r.state.confirmation,null);replay(byLabel(r,'编辑单位名称').props.onKeyup,{key:'Enter'});await tick();assert.ok(r.state.confirmation);assert.equal(r.writes().length,0);
});
scenario('search uses case-insensitive literal names and original fifteen-row pages with reset',async mount=>{
 const rows=Array.from({length:31},(_,i)=>row(i+1,{name:i===0?'VIP%_':`会员${i}`})),r=await mount({rows});assert.equal(css(r,'unit-row').length,15);await click(r,'下一页');assert.equal(css(r,'unit-row').length,15);await click(r,'下一页');assert.equal(css(r,'unit-row').length,1);await update(r,'单位名称','vip%_');await click(r,'查询');assert.equal(css(r,'unit-row').length,1);assert.match(text(r.tree),/VIP%_/);assert.equal(r.state.filters.page,1);await click(r,'重置');assert.equal(css(r,'unit-row').length,15);assert.equal(r.reads().length,1);
});
scenario('search input stays mounted for rapid typing while stale query/row/pagination handlers retire on ABA',async mount=>{
 const r=await mount({rows:Array.from({length:17},(_,i)=>row(i+1))}),input=byLabel(r,'单位名称'),oldSearch=handler(r,'查询'),oldEdit=handler(r,'编辑'),oldNext=handler(r,'下一页');replay(input.props.onInput,{target:{value:'A'}});replay(input.props.onInput,{target:{value:'AB'}});await tick();assert.equal(byLabel(r,'单位名称'),input);assert.equal(input.props.value,'AB');await update(r,'单位名称','');replay(oldSearch);replay(oldEdit);replay(oldNext);await tick();assert.equal(r.state.editor,null);assert.equal(r.state.filters.page,1);await click(r,'下一页');assert.equal(r.state.filters.page,2);
});
scenario('native search accepts51 Unicode instead of retaining an old50 query; overflow is explicit without DOM drift',async mount=>{
 const name='😀'.repeat(50),r=await mount({rows:[row(1,{name:name})]});await update(r,'单位名称',name);await click(r,'查询');assert.equal(css(r,'unit-row').length,1);const longer=name+'😀';await update(r,'单位名称',longer);assert.equal(byLabel(r,'单位名称').props.value,longer);await click(r,'查询');assert.equal(r.state.filters.keyword,longer);assert.equal(css(r,'unit-row').length,0);assert.equal(r.reads().length,1);const overflow='x'.repeat(4097);await update(r,'单位名称',overflow);assert.equal(byLabel(r,'单位名称').props.value,overflow);assert.equal(r.state.filters.draft,overflow);await click(r,'查询');assert.match(text(r.tree),/搜索名称不能超过4096/);assert.equal(r.state.filters.keyword,longer);assert.equal(r.writes().length,0);
});
scenario('delete requires explicit confirmation and clamps the final page',async mount=>{
 const r=await mount({rows:Array.from({length:16},(_,i)=>row(i+1))});await click(r,'下一页');await click(r,'删除');assert.equal(r.writes().length,0);assert.match(text(r.tree),/已被商品使用的单位不能改名或删除/);await click(r,'确认提交');assert.equal(r.writes()[0].body.operation,'delete');assert.equal(r.state.filters.page,1);assert.equal(css(r,'unit-row').length,15);
});
scenario('occupied delete leaves the row and exact command unknown until explicit resolve',async mount=>{
 const r=await mount({send(c,next){return c.url===base+'/commit'?{httpStatus:409,status:409,msg:'该单位正在使用，不能删除',data:null}:next();}});await click(r,'删除');await click(r,'确认提交');assert.equal(css(r,'unit-row').length,2);assert.equal(journal(r).length,1);assert.match(text(r.tree),/正在使用/);await click(r,'读取原回执');assert.match(text(r.tree),/结果仍未知/);await click(r,'核对并封存原请求');assert.equal(journal(r).length,0);assert.equal(r.server.rows.length,2);assert.match(text(r.tree),/未应用/);
});
scenario('double captured confirmation dispatches once and persists before transport',async mount=>{
 const wait=deferred(),r=await mount({send(c,next){if(c.url===base+'/commit'){assert.equal(journal(r).length,1);return wait.promise.then(next);}return next();}});await prepare(r);const submit=handler(r,'确认提交');replay(submit);replay(submit);await tick();assert.equal(r.writes().length,1);wait.resolve();await tick();assert.equal(journal(r).length,0);
});
scenario('lost committed reply recovers one original action without a second POST',async mount=>{
 let once=true;const r=await mount({send(c,next){const result=next();if(c.url===base+'/commit'&&once){once=false;throw new axios.AxiosError('lost','ERR_NETWORK');}return result;}});await prepare(r);await click(r,'确认提交');assert.deepEqual(JSON.parse(journal(r)[0][1]),r.writes()[0].body);await click(r,'读取原回执');assert.equal(r.writes().length,1);assert.equal(journal(r).length,0);assert.equal(r.server.rows[0].name,'编辑后的单位');
});
scenario('missing receipt is unknown and only explicit retry uses the same UUID and payload',async mount=>{
 let n=0;const r=await mount({send(c,next){if(c.url===base+'/commit'&&n++===0)throw new axios.AxiosError('lost','ERR_NETWORK');return next();}});await prepare(r);await click(r,'确认提交');assert.equal(buttons(r,'原样重试').length,0);await click(r,'读取原回执');assert.equal(journal(r).length,1);await click(r,'原样重试');assert.deepEqual(r.writes()[0].body,r.writes()[1].body);assert.equal(journal(r).length,0);
});
scenario('storage failure blocks I/O and leaves the confirmation available',async mount=>{
 const r=await mount({persist(key){if(key.startsWith('cinashop_unit_pending'))throw Error('storage unavailable');}});await prepare(r);await click(r,'确认提交');assert.equal(r.writes().length,0);assert.ok(r.state.confirmation);assert.match(text(r.tree),/storage unavailable/);
});
scenario('same actor multiple journal records restore one by one after committed and not-applied results',async mount=>{
 const r=await mount(),a=await action(r),b=await action(r,2,'delete','22222222-2222-4222-8222-222222222222');for(const x of [b,a])r.storage.set(`cinashop_unit_pending_v1_7_${x.operation_id}`,JSON.stringify(x));r.receipts.set(a.operation_id,{...a,state:'committed',result:{id:1,created:0,updated:1,count:2,revision:'b'.repeat(64)}});delete r.receipts.get(a.operation_id).payload;r.sync();await tick();assert.equal(r.state.pending.operation_id,a.operation_id);await click(r,'读取原回执');assert.equal(r.state.pending.operation_id,b.operation_id);assert.equal(journal(r).length,1);await click(r,'核对并封存原请求');assert.equal(journal(r).length,0);
});
scenario('withdrawn view/manage still lets the live owner resolve the original command',async mount=>{
 const r=await mount({send(c,next){if(c.url===base+'/commit')throw new axios.AxiosError('lost','ERR_NETWORK');return next();}});await prepare(r);await click(r,'确认提交');r.sync({userInfo:{id:7,level:1},uniqueAuth:[]});await tick();assert.equal(buttons(r,'新增单位').length,0);await click(r,'读取原回执');assert.equal(buttons(r,'原样重试').length,0);await click(r,'核对并封存原请求');assert.equal(journal(r).length,0);
});
for(const permission of ['product.view','order.manage','user.manage'])scenario('permission '+permission+' cannot author',async mount=>{
 const r=await mount({actor:{userInfo:{id:7,level:1},uniqueAuth:[permission]}});assert.equal(buttons(r,'新增单位').length,0);assert.equal(r.reads().length,permission==='product.view'?1:0);assert.equal(r.writes().length,0);
});
scenario('readiness false and private-source capacity block create without blocking existing rows',async mount=>{
 const r=await mount({writeReady:false});assert.equal(buttons(r,'新增单位')[0].props.disabled,true);replay(handler(r,'新增单位'));await tick();assert.equal(r.state.editor,null);assert.equal(css(r,'unit-row').length,2);const full=await mount({canCreate:false});assert.equal(buttons(full,'新增单位')[0].props.disabled,true);replay(handler(full,'新增单位'));await tick();assert.equal(full.state.editor,null);await click(full,'编辑');assert.ok(full.state.editor);
});
for(const transition of ['route','actor','session','storage','role','unmount'])scenario('captured native input/save/row/delete confirmation retire after '+transition,async mount=>{
 const r=await mount(),edit=handler(r,'编辑'),remove=handler(r,'删除');await click(r,'编辑');const input=byLabel(r,'编辑单位名称').props.onInput,save=handler(r,'保存');await click(r,'取消');await click(r,'删除');const confirm=handler(r,'确认提交');
 if(transition==='route'){r.route.fullPath='/product/units?x';r.route.fullPath='/product/units';}if(transition==='actor')r.sync({token:'B',userInfo:{id:8,level:0}});if(transition==='session')r.fireAction('login');if(transition==='storage')r.sync({},'storage');if(transition==='role'){r.actor.uniqueAuth=['product.view'];r.actor.uniqueAuth=[];}if(transition==='unmount')r.unmount();await tick();for(const fn of [edit,remove,save,confirm])replay(fn);replay(input,{target:{value:'retired'}});await tick();assert.equal(r.state.editor,null);assert.equal(r.state.confirmation,null);assert.equal(r.writes().length,0);
});
scenario('same-object row mutation and identical replacement invalidate captured row controls',async mount=>{
 const r=await mount(),edit=handler(r,'编辑'),remove=handler(r,'删除');r.state.snapshot.list[0].name='new';replay(edit);replay(remove);await tick();assert.equal(r.state.editor,null);assert.equal(r.state.confirmation,null);const current=handler(r,'编辑');r.state.snapshot.list[0]={...r.state.snapshot.list[0]};replay(current);await tick();assert.equal(r.state.editor,null);await click(r,'编辑');assert.equal(r.state.editor.draft.name,'new');
});
scenario('refresh aborts the previous reader; stale failure cannot clear the new successful snapshot',async mount=>{
 const wait=deferred();let n=0;const r=await mount({send(c,next){if(c.url===base+'/catalog'&&++n===2)return wait.promise;return next();}});const oldRefresh=handler(r,'刷新');replay(oldRefresh);await tick();const previous=r.reads().at(-1);await click(r,'刷新');assert.equal(previous.signal.aborted,true);wait.reject(Error('old reader'));await tick();assert.equal(r.state.snapshot.count,2);assert.equal(r.state.loading,false);assert.equal(r.state.error,'');
});
scenario('a late committed reply cannot remove the prior owner journal or set a new owner notice',async mount=>{
 const wait=deferred(),r=await mount({send(c,next){return c.url===base+'/commit'?wait.promise.then(next):next();}});await prepare(r);await click(r,'确认提交');const old=r.writes()[0];r.sync({token:'B',userInfo:{id:8,level:0}});await tick();assert.equal(old.signal.aborted,true);wait.resolve();await tick();assert.equal(journal(r).length,1);assert.equal(r.state.notice,'');assert.equal(r.state.pending,null);
});
scenario('session retirement during native digest prevents both persistence and dispatch',async mount=>{
 let armed=false,r; r=await mount({onDigest(){if(armed){armed=false;r.fireAction('login');}}});await prepare(r);armed=true;await click(r,'确认提交');assert.equal(r.writes().length,0);assert.equal(journal(r).length,0);assert.equal(r.state.confirmation,null);
});
for(const bad of ['duplicate','count','overflow','extra','row-extra','name','revision','ready','can-create','sort','foreign','hidden'])scenario('complete catalog fails closed for '+bad,async mount=>{
 const r=await mount({send(c,next){const result=next();if(c.url===base+'/catalog'){const x=result.data;if(bad==='duplicate')x.list[1]={...x.list[0]};if(bad==='count')x.count++;if(bad==='overflow'){x.list=Array.from({length:20001},(_,i)=>row(i+1));x.count=x.list.length;}if(bad==='extra')x.extra=1;if(bad==='row-extra')x.list[0].avatar='forbidden';if(bad==='name')x.list[0].name='😀'.repeat(51);if(bad==='revision')x.revision='bad';if(bad==='ready')x.write_ready=1;if(bad==='can-create')x.can_create=1;if(bad==='sort')x.list[0].sort=32768;if(bad==='foreign')x.list[0].relation_id=77;if(bad==='hidden')x.list[0].status=0;}return result;}});assert.equal(r.state.snapshot,null);assert.ok(r.state.error);assert.equal(css(r,'unit-row').length,0);assert.equal(r.writes().length,0);
});
for(const bad of ['actor','uuid','hash','extra','state','result-id','counter','not-applied-count'])scenario('receipt rejects mismatch '+bad+' and preserves journal',async mount=>{
 const r=await mount({send(c,next){const result=next();if(c.url===base+'/commit'){const x=result.data;if(bad==='actor')x.actor_id++;if(bad==='uuid')x.operation_id='33333333-3333-4333-8333-333333333333';if(bad==='hash')x.payload_hash='f'.repeat(64);if(bad==='extra')x.payload={};if(bad==='state')x.state='queued';if(bad==='result-id')x.result.id++;if(bad==='counter')x.result.created=1;if(bad==='not-applied-count'){x.state='not_applied';x.result={id:x.target_id,created:0,updated:0,count:1,revision:x.revision};}}return result;}});await prepare(r);await click(r,'确认提交');assert.equal(journal(r).length,1);assert.ok(r.state.error);assert.equal(r.state.pending.operation,'update');
});
scenario('malformed persisted command is retained and cannot write',async mount=>{
 const key='cinashop_unit_pending_v1_7_11111111-1111-4111-8111-111111111111',r=await mount({storage:[[key,'{bad']]});assert.ok(r.state.pendingError);assert.equal(r.storage.get(key),'{bad');assert.equal(buttons(r,'新增单位')[0].props.disabled,true);assert.equal(r.writes().length,0);
});
scenario('new edit and new unknown request clear a previous successful notice',async mount=>{
 let n=0;const r=await mount({send(c,next){if(c.url===base+'/commit'&&++n===2)throw new axios.AxiosError('lost','ERR_NETWORK');return next();}});await prepare(r);await click(r,'确认提交');assert.ok(r.state.notice);await click(r,'编辑');assert.equal(r.state.notice,'');await update(r,'编辑单位名称','第二笔');await click(r,'保存');await click(r,'确认提交');assert.equal(r.state.notice,'');assert.equal(journal(r).length,1);
});

for(const rawSort of ['','-','-0','01','1e2','1.5','32768','-32769','-1'])scenario('new raw sort stays visible and blocks submission without normalization '+JSON.stringify(rawSort),async mount=>{
 const r=await mount();await click(r,'新增单位');await update(r,'编辑单位名称','明确的新单位');await update(r,'编辑单位排序',rawSort);assert.equal(byLabel(r,'编辑单位排序').props.value,rawSort);assert.equal(r.state.editor.rawSort,rawSort);assert.equal(r.state.editor.draft.sort,0);await click(r,'保存');assert.ok(r.state.editor);assert.equal(r.state.confirmation,null);assert.equal(r.writes().length,0);assert.ok(r.state.error);
});
scenario('native raw sort input stays mounted for fast typing and does not reuse a save captured before sort ABA',async mount=>{
 const r=await mount();await click(r,'编辑');const input=byLabel(r,'编辑单位排序'),oldSave=handler(r,'保存');replay(input.props.onInput,{target:{value:'1'}});replay(input.props.onInput,{target:{value:'12'}});await tick();assert.equal(byLabel(r,'编辑单位排序'),input);assert.equal(input.props.value,'12');assert.equal(r.state.editor.draft.sort,0);await update(r,'编辑单位排序','0');replay(oldSave);await tick();assert.equal(r.state.confirmation,null);await update(r,'编辑单位排序','32767');await click(r,'保存');assert.deepEqual(r.state.confirmation.payload,{name:'单位1',sort:32767});await click(r,'确认提交');assert.equal(r.writes()[0].body.payload.sort,32767);assert.equal(r.server.rows[0].sort,32767);
});
scenario('name edit preserves the exact historical negative smallint while a different negative sort is rejected',async mount=>{
 const r=await mount({rows:[row(1,{name:'😀'.repeat(50),sort:-32768})]});await click(r,'编辑');assert.equal(byLabel(r,'编辑单位排序').props.value,'-32768');await update(r,'编辑单位名称','新名字');await update(r,'编辑单位排序','-32767');await click(r,'保存');assert.equal(r.state.confirmation,null);assert.equal(byLabel(r,'编辑单位排序').props.value,'-32767');await update(r,'编辑单位排序','-32768');await click(r,'保存');await click(r,'确认提交');assert.deepEqual(r.writes()[0].body.payload,{name:'新名字',sort:-32768});
});
scenario('changing a historical50-character name requires the new15-character rule while sort-only edits preserve it',async mount=>{
 const name='😀'.repeat(50),r=await mount({rows:[row(1,{name,sort:-5})]});await click(r,'编辑');await update(r,'编辑单位名称',name+'x');await click(r,'保存');assert.equal(r.state.confirmation,null);await update(r,'编辑单位名称',name);await update(r,'编辑单位排序','7');await click(r,'保存');await click(r,'确认提交');assert.deepEqual(r.writes()[0].body.payload,{name,sort:7});assert.equal(r.server.rows[0].name,name);
});
scenario('active false mounts no unit UI or reads; explicit activation loads one catalog and current controls work',async mount=>{
 const r=await mount({active:false});assert.equal(css(r,'unit-author').length,0);assert.equal(r.io.length,0);r.props.active=true;await tick();assert.equal(r.reads().length,1);assert.equal(css(r,'unit-row').length,2);await click(r,'编辑');await update(r,'编辑单位排序','5');await click(r,'保存');await click(r,'确认提交');assert.equal(r.changes.length,1);
});
scenario('hide then show retires captured native inputs, enter, row, refresh and confirmation through active ABA',async mount=>{
 const r=await mount(),edit=handler(r,'编辑'),remove=handler(r,'删除'),refresh=handler(r,'刷新');await click(r,'编辑');const name=byLabel(r,'编辑单位名称').props.onInput,sort=byLabel(r,'编辑单位排序').props.onInput,enter=byLabel(r,'编辑单位排序').props.onKeyup;await click(r,'取消');await click(r,'删除');const submit=handler(r,'确认提交');r.props.active=false;await tick();assert.equal(css(r,'unit-author').length,0);assert.equal(r.state.editor,null);assert.equal(r.state.confirmation,null);r.props.active=true;await tick();assert.equal(css(r,'unit-row').length,2);assert.equal(r.reads().length,2);const before=r.io.length;for(const fn of [edit,remove,refresh,submit])replay(fn);replay(name,{target:{value:'old'}});replay(sort,{target:{value:'99'}});replay(enter,{key:'Enter'});await tick();assert.equal(r.io.length,before);assert.equal(r.state.editor,null);assert.equal(r.state.confirmation,null);await click(r,'编辑');assert.equal(r.state.editor.rawSort,'0');
});
scenario('hidden-tab late commit cannot erase durable journal and visible owner can later recover it',async mount=>{
 const wait=deferred(),r=await mount({send(c,next){return c.url===base+'/commit'?wait.promise.then(next):next();}});await prepare(r);await click(r,'确认提交');const original=r.writes()[0];assert.equal(journal(r).length,1);r.props.active=false;await tick();assert.equal(original.signal.aborted,true);const reads=r.reads().length;wait.resolve();await tick();assert.equal(journal(r).length,1);assert.equal(r.reads().length,reads);assert.equal(r.changes.length,0);assert.equal(css(r,'unit-author').length,0);r.props.active=true;await tick();assert.ok(r.state.pending);await click(r,'读取原回执');assert.equal(journal(r).length,0);assert.equal(r.writes().length,1);assert.equal(r.changes.length,1);
});
scenario('not-applied resolve emits no changed event',async mount=>{
 const r=await mount({send(c,next){if(c.url===base+'/commit')throw new axios.AxiosError('lost','ERR_NETWORK');return next();}});await prepare(r);await click(r,'确认提交');await click(r,'核对并封存原请求');assert.equal(r.changes.length,0);assert.equal(journal(r).length,0);assert.equal(r.server.rows[0].name,'单位1');
});
scenario('private capacity disables only create and existing unit edit still dispatches name plus sort',async mount=>{
 const r=await mount({canCreate:false});assert.equal(buttons(r,'新增单位')[0].props.disabled,true);replay(handler(r,'新增单位'));await tick();assert.equal(r.state.editor,null);assert.match(text(r.tree),/容量上限/);await click(r,'编辑');await update(r,'编辑单位排序','8');await click(r,'保存');await click(r,'确认提交');assert.deepEqual(r.writes()[0].body.payload,{name:'单位1',sort:8});assert.equal(r.changes.length,1);
});
scenario('real ProductMetadata parent initially mounts only unit reader and loads each other domain only on its actual tab event',async mount=>{
 const r=await mount({page:'pages/product/ProductMetadata.vue'});assert.deepEqual(r.io.map(c=>c.url),[base+'/catalog']);assert.equal(css(r,'unit-row').length,2);for(const [tab,url]of [['保障服务','/product/ensure/author/catalog'],['SKU 规格模板','/product/rule/author/catalog'],['商品参数模板','/product/specs/author/catalog'],['搜索热词','/product/words/author/catalog']]){const before=r.io.length;await click(r,tab);assert.equal(r.io.length,before+1);assert.equal(r.io.at(-1).url,url);assert.equal(r.io.at(-1).method,'GET');assert.equal(css(r,'unit-author').length,0);}await click(r,'商品单位');assert.equal(r.reads().length,2);assert.equal(r.io.filter(c=>c.url==='/product/unit').length,0);assert.equal(r.writes().length,0);assert.equal(r.messages.length,0);
});
scenario('actual parent tab switch retires old unit native handlers through tab ABA',async mount=>{
 const r=await mount({page:'pages/product/ProductMetadata.vue'});await click(r,'编辑');const input=byLabel(r,'编辑单位排序').props.onInput,save=handler(r,'保存');await click(r,'取消');await click(r,'删除');const confirm=handler(r,'确认提交');await click(r,'保障服务');await click(r,'商品单位');const before=r.io.length;replay(save);replay(confirm);replay(input,{target:{value:'99'}});await tick();assert.equal(r.io.length,before);assert.equal(r.state.editor,null);assert.equal(r.state.confirmation,null);await click(r,'编辑');assert.equal(r.state.editor.rawSort,'0');
});
scenario('real parent late unit catalog is aborted on leaving the units tab and cannot restore a hidden editor',async mount=>{
 const wait=deferred();let n=0;const r=await mount({page:'pages/product/ProductMetadata.vue',send(c,next){if(c.url===base+'/catalog'&&++n===2)return wait.promise.then(next);return next();}});await click(r,'刷新');const previous=r.reads().at(-1);await click(r,'保障服务');assert.equal(previous.signal.aborted,true);wait.resolve();await tick();assert.equal(r.state.snapshot,null);assert.equal(css(r,'unit-author').length,0);await click(r,'商品单位');assert.equal(r.state.snapshot.count,2);assert.equal(r.state.loading,false);assert.equal(r.state.error,'');
});
