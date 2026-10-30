const test=require('node:test'),assert=require('node:assert/strict'),axios=require('axios'),path=require('node:path');
const {runtime,tick,row,catalog,css,byLabel,text,buttons,replay,click,update,deferred}=require('./helpers/group-author-runtime.cjs');
const base='/user/group/author';
function scenario(name,fn){test(name,async()=>{const runs=[];const mount=async options=>{const r=runtime(options);runs.push(r);await tick();return r;};try{await fn(mount);}finally{for(const r of runs)await r.finish();}});}
const journal=r=>[...r.storage].filter(([key])=>key.startsWith('cinashop_group_pending_v1_'));
const handler=(r,label)=>buttons(r,label)[0].props.onClick;
const common=r=>r.load(path.resolve(__dirname,'../../common/groupAuthor.ts'));
async function prepare(r,name='编辑后的分组'){await click(r,'编辑');await update(r,'编辑分组名称',name);await click(r,'保存');}
async function action(r,id=1,operation='update',operation_id='11111111-1111-4111-8111-111111111111'){
 const a={operation_id,actor_id:7,operation,target_id:operation==='create'?0:id,revision:'a'.repeat(64),payload:operation==='delete'?{}:{group_name:'原操作'},payload_hash:''};a.payload_hash=await common(r).groupPayloadHash(a);return a;
}
scenario('actual current page reads one complete catalog and exposes only the name field',async mount=>{
 const r=await mount();assert.equal(r.reads().length,1);assert.equal(css(r,'group-row').length,2);await click(r,'编辑');assert.equal(byLabel(r,'编辑分组名称').props.value,'分组1');assert.equal(byLabel(r,'编辑分组名称').props.maxlength,undefined);assert.equal(r.io.length,1);assert.ok(!text(r.tree).includes('图库'));assert.deepEqual(Object.keys(r.state.editor.draft),['group_name']);
});
scenario('create preserves raw command and displays normalized server readback',async mount=>{
 const r=await mount();await click(r,'新增分组');await update(r,'编辑分组名称','  新用户  ');await click(r,'保存');assert.equal(r.writes().length,0);await click(r,'确认提交');const a=r.writes()[0].body;assert.deepEqual(a.payload,{group_name:'  新用户  '});assert.equal(a.payload_hash,await common(r).groupPayloadHash(a));assert.equal(journal(r).length,0);assert.equal(r.server.rows.at(-1).group_name,'新用户');assert.match(text(r.tree),/操作已完成/);
});
for(const name of ['😀'.repeat(64),'  历史名称  ','','\u0000历史\u0085'])scenario('exact historical name is kept without normalization '+JSON.stringify(name.slice(0,8)),async mount=>{
 const r=await mount({rows:[row(1,{group_name:name})]});await click(r,'编辑');assert.equal(byLabel(r,'编辑分组名称').props.value,name);await click(r,'保存');await click(r,'确认提交');assert.equal(r.writes()[0].body.payload.group_name,name);assert.equal(r.server.rows[0].group_name,name);
});
for(const name of ['','  ','x'.repeat(65),'😀'.repeat(65),'坏\u0000值','坏\u0085值','坏\ud800值','坏\udc00值'])scenario('new invalid name blocks confirmation and I/O '+JSON.stringify(name.slice(0,10)),async mount=>{
 const r=await mount();await click(r,'新增分组');await update(r,'编辑分组名称',name);await click(r,'保存');assert.equal(r.state.confirmation,null);assert.equal(r.writes().length,0);assert.ok(r.state.error);
});
scenario('64 Unicode names and whitespace raw budget do not use UTF16 maxlength',async mount=>{
 const r=await mount();await click(r,'新增分组');const value=' '.repeat(100)+'😀'.repeat(64)+' ';await update(r,'编辑分组名称',value);assert.equal(byLabel(r,'编辑分组名称').props.value,value);assert.equal(byLabel(r,'编辑分组名称').props.maxlength,undefined);assert.match(text(r.tree),/64 \/ 64/);await click(r,'保存');await click(r,'确认提交');assert.equal(r.writes()[0].body.payload.group_name,value);
});
scenario('native input node and issued fast input listener remain stable; old save rejects draft ABA',async mount=>{
 const r=await mount();await click(r,'编辑');const input=byLabel(r,'编辑分组名称'),oldSave=handler(r,'保存'),oldCancel=handler(r,'取消');replay(input.props.onInput,{target:{value:'A'}});replay(input.props.onInput,{target:{value:'AB'}});await tick();assert.equal(byLabel(r,'编辑分组名称'),input);assert.equal(input.props.value,'AB');await update(r,'编辑分组名称','分组1');replay(oldSave);replay(oldCancel);await tick();assert.ok(r.state.editor);assert.equal(r.state.confirmation,null);await click(r,'保存');assert.ok(r.state.confirmation);
});
scenario('actual enter-key confirm is retired by draft changes while current enter works',async mount=>{
 const r=await mount();await click(r,'编辑');const old=byLabel(r,'编辑分组名称').props.onKeyup;await update(r,'编辑分组名称','改变');replay(old,{key:'Enter'});await tick();assert.equal(r.state.confirmation,null);replay(byLabel(r,'编辑分组名称').props.onKeyup,{key:'Enter'});await tick();assert.ok(r.state.confirmation);assert.equal(r.writes().length,0);
});
scenario('search uses case-insensitive literal names and page ten with reset',async mount=>{
 const rows=Array.from({length:25},(_,i)=>row(i+1,{group_name:i===0?'VIP%_':`会员${i}`})),r=await mount({rows});assert.equal(css(r,'group-row').length,10);await click(r,'下一页');assert.equal(css(r,'group-row').length,10);await click(r,'下一页');assert.equal(css(r,'group-row').length,5);await update(r,'分组名称','vip%_');await click(r,'查询');assert.equal(css(r,'group-row').length,1);assert.match(text(r.tree),/VIP%_/);assert.equal(r.state.filters.page,1);await click(r,'重置');assert.equal(css(r,'group-row').length,10);assert.equal(r.reads().length,1);
});
scenario('search input stays mounted for rapid typing while stale query/row/pagination handlers retire on ABA',async mount=>{
 const r=await mount({rows:Array.from({length:12},(_,i)=>row(i+1))}),input=byLabel(r,'分组名称'),oldSearch=handler(r,'查询'),oldEdit=handler(r,'编辑'),oldNext=handler(r,'下一页');replay(input.props.onInput,{target:{value:'A'}});replay(input.props.onInput,{target:{value:'AB'}});await tick();assert.equal(byLabel(r,'分组名称'),input);assert.equal(input.props.value,'AB');await update(r,'分组名称','');replay(oldSearch);replay(oldEdit);replay(oldNext);await tick();assert.equal(r.state.editor,null);assert.equal(r.state.filters.page,1);await click(r,'下一页');assert.equal(r.state.filters.page,2);
});
scenario('native search accepts65 Unicode instead of retaining an old64 query; overflow is explicit without DOM drift',async mount=>{
 const name='😀'.repeat(64),r=await mount({rows:[row(1,{group_name:name})]});await update(r,'分组名称',name);await click(r,'查询');assert.equal(css(r,'group-row').length,1);const longer=name+'😀';await update(r,'分组名称',longer);assert.equal(byLabel(r,'分组名称').props.value,longer);await click(r,'查询');assert.equal(r.state.filters.keyword,longer);assert.equal(css(r,'group-row').length,0);assert.equal(r.reads().length,1);const overflow='x'.repeat(4097);await update(r,'分组名称',overflow);assert.equal(byLabel(r,'分组名称').props.value,overflow);assert.equal(r.state.filters.draft,overflow);await click(r,'查询');assert.match(text(r.tree),/搜索名称不能超过4096/);assert.equal(r.state.filters.keyword,longer);assert.equal(r.writes().length,0);
});
scenario('delete requires explicit confirmation and clamps the final page',async mount=>{
 const r=await mount({rows:Array.from({length:11},(_,i)=>row(i+1))});await click(r,'下一页');await click(r,'删除');assert.equal(r.writes().length,0);assert.match(text(r.tree),/已关联用户的分组不能删除/);await click(r,'确认提交');assert.equal(r.writes()[0].body.operation,'delete');assert.equal(r.state.filters.page,1);assert.equal(css(r,'group-row').length,10);
});
scenario('occupied delete leaves the row and exact command unknown until explicit resolve',async mount=>{
 const r=await mount({send(c,next){return c.url===base+'/commit'?{httpStatus:409,status:409,msg:'该分组仍有用户，不能删除',data:null}:next();}});await click(r,'删除');await click(r,'确认提交');assert.equal(css(r,'group-row').length,2);assert.equal(journal(r).length,1);assert.match(text(r.tree),/仍有用户/);await click(r,'读取原回执');assert.match(text(r.tree),/结果仍未知/);await click(r,'核对并封存原请求');assert.equal(journal(r).length,0);assert.equal(r.server.rows.length,2);assert.match(text(r.tree),/未应用/);
});
scenario('double captured confirmation dispatches once and persists before transport',async mount=>{
 const wait=deferred(),r=await mount({send(c,next){if(c.url===base+'/commit'){assert.equal(journal(r).length,1);return wait.promise.then(next);}return next();}});await prepare(r);const submit=handler(r,'确认提交');replay(submit);replay(submit);await tick();assert.equal(r.writes().length,1);wait.resolve();await tick();assert.equal(journal(r).length,0);
});
scenario('lost committed reply recovers one original action without a second POST',async mount=>{
 let once=true;const r=await mount({send(c,next){const result=next();if(c.url===base+'/commit'&&once){once=false;throw new axios.AxiosError('lost','ERR_NETWORK');}return result;}});await prepare(r);await click(r,'确认提交');assert.deepEqual(JSON.parse(journal(r)[0][1]),r.writes()[0].body);await click(r,'读取原回执');assert.equal(r.writes().length,1);assert.equal(journal(r).length,0);assert.equal(r.server.rows[0].group_name,'编辑后的分组');
});
scenario('missing receipt is unknown and only explicit retry uses the same UUID and payload',async mount=>{
 let n=0;const r=await mount({send(c,next){if(c.url===base+'/commit'&&n++===0)throw new axios.AxiosError('lost','ERR_NETWORK');return next();}});await prepare(r);await click(r,'确认提交');assert.equal(buttons(r,'原样重试').length,0);await click(r,'读取原回执');assert.equal(journal(r).length,1);await click(r,'原样重试');assert.deepEqual(r.writes()[0].body,r.writes()[1].body);assert.equal(journal(r).length,0);
});
scenario('storage failure blocks I/O and leaves the confirmation available',async mount=>{
 const r=await mount({persist(key){if(key.startsWith('cinashop_group_pending'))throw Error('storage unavailable');}});await prepare(r);await click(r,'确认提交');assert.equal(r.writes().length,0);assert.ok(r.state.confirmation);assert.match(text(r.tree),/storage unavailable/);
});
scenario('same actor multiple journal records restore one by one after committed and not-applied results',async mount=>{
 const r=await mount(),a=await action(r),b=await action(r,2,'delete','22222222-2222-4222-8222-222222222222');for(const x of [b,a])r.storage.set(`cinashop_group_pending_v1_7_${x.operation_id}`,JSON.stringify(x));r.receipts.set(a.operation_id,{...a,state:'committed',result:{id:1,created:0,updated:1,count:2,revision:'b'.repeat(64)}});delete r.receipts.get(a.operation_id).payload;r.sync();await tick();assert.equal(r.state.pending.operation_id,a.operation_id);await click(r,'读取原回执');assert.equal(r.state.pending.operation_id,b.operation_id);assert.equal(journal(r).length,1);await click(r,'核对并封存原请求');assert.equal(journal(r).length,0);
});
scenario('withdrawn view/manage still lets the live owner resolve the original command',async mount=>{
 const r=await mount({send(c,next){if(c.url===base+'/commit')throw new axios.AxiosError('lost','ERR_NETWORK');return next();}});await prepare(r);await click(r,'确认提交');r.sync({userInfo:{id:7,level:1},uniqueAuth:[]});await tick();assert.equal(buttons(r,'新增分组').length,0);await click(r,'读取原回执');assert.equal(buttons(r,'原样重试').length,0);await click(r,'核对并封存原请求');assert.equal(journal(r).length,0);
});
for(const permission of ['user.view','order.manage','store.manage'])scenario('permission '+permission+' cannot author',async mount=>{
 const r=await mount({actor:{userInfo:{id:7,level:1},uniqueAuth:[permission]}});assert.equal(buttons(r,'新增分组').length,0);assert.equal(r.reads().length,permission==='user.view'?1:0);assert.equal(r.writes().length,0);
});
scenario('readiness false and capacity twenty thousand block create without blocking read',async mount=>{
 const r=await mount({writeReady:false});assert.equal(buttons(r,'新增分组')[0].props.disabled,true);replay(handler(r,'新增分组'));await tick();assert.equal(r.state.editor,null);assert.equal(css(r,'group-row').length,2);const full=await mount({rows:Array.from({length:20000},(_,i)=>row(i+1))});assert.equal(buttons(full,'新增分组')[0].props.disabled,true);replay(handler(full,'新增分组'));await tick();assert.equal(full.state.editor,null);await click(full,'编辑');assert.ok(full.state.editor);
});
for(const transition of ['route','actor','session','storage','role','unmount'])scenario('captured native input/save/row/delete confirmation retire after '+transition,async mount=>{
 const r=await mount(),edit=handler(r,'编辑'),remove=handler(r,'删除');await click(r,'编辑');const input=byLabel(r,'编辑分组名称').props.onInput,save=handler(r,'保存');await click(r,'取消');await click(r,'删除');const confirm=handler(r,'确认提交');
 if(transition==='route'){r.route.fullPath='/user/groups?x';r.route.fullPath='/user/groups';}if(transition==='actor')r.sync({token:'B',userInfo:{id:8,level:0}});if(transition==='session')r.fireAction('login');if(transition==='storage')r.sync({},'storage');if(transition==='role'){r.actor.uniqueAuth=['user.view'];r.actor.uniqueAuth=[];}if(transition==='unmount')r.unmount();await tick();for(const fn of [edit,remove,save,confirm])replay(fn);replay(input,{target:{value:'retired'}});await tick();assert.equal(r.state.editor,null);assert.equal(r.state.confirmation,null);assert.equal(r.writes().length,0);
});
scenario('same-object row mutation and identical replacement invalidate captured row controls',async mount=>{
 const r=await mount(),edit=handler(r,'编辑'),remove=handler(r,'删除');r.state.snapshot.list[0].group_name='new';replay(edit);replay(remove);await tick();assert.equal(r.state.editor,null);assert.equal(r.state.confirmation,null);const current=handler(r,'编辑');r.state.snapshot.list[0]={...r.state.snapshot.list[0]};replay(current);await tick();assert.equal(r.state.editor,null);await click(r,'编辑');assert.equal(r.state.editor.draft.group_name,'new');
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
for(const bad of ['duplicate','count','overflow','extra','row-extra','name','revision','ready'])scenario('complete catalog fails closed for '+bad,async mount=>{
 const r=await mount({send(c,next){const result=next();if(c.url===base+'/catalog'){const x=result.data;if(bad==='duplicate')x.list[1]={...x.list[0]};if(bad==='count')x.count++;if(bad==='overflow'){x.list=Array.from({length:20001},(_,i)=>row(i+1));x.count=x.list.length;}if(bad==='extra')x.extra=1;if(bad==='row-extra')x.list[0].avatar='forbidden';if(bad==='name')x.list[0].group_name='😀'.repeat(65);if(bad==='revision')x.revision='bad';if(bad==='ready')x.write_ready=1;}return result;}});assert.equal(r.state.snapshot,null);assert.ok(r.state.error);assert.equal(css(r,'group-row').length,0);assert.equal(r.writes().length,0);
});
for(const bad of ['actor','uuid','hash','extra','state','result-id','counter','not-applied-count'])scenario('receipt rejects mismatch '+bad+' and preserves journal',async mount=>{
 const r=await mount({send(c,next){const result=next();if(c.url===base+'/commit'){const x=result.data;if(bad==='actor')x.actor_id++;if(bad==='uuid')x.operation_id='33333333-3333-4333-8333-333333333333';if(bad==='hash')x.payload_hash='f'.repeat(64);if(bad==='extra')x.payload={};if(bad==='state')x.state='queued';if(bad==='result-id')x.result.id++;if(bad==='counter')x.result.created=1;if(bad==='not-applied-count'){x.state='not_applied';x.result={id:x.target_id,created:0,updated:0,count:1,revision:x.revision};}}return result;}});await prepare(r);await click(r,'确认提交');assert.equal(journal(r).length,1);assert.ok(r.state.error);assert.equal(r.state.pending.operation,'update');
});
scenario('malformed persisted command is retained and cannot write',async mount=>{
 const key='cinashop_group_pending_v1_7_11111111-1111-4111-8111-111111111111',r=await mount({storage:[[key,'{bad']]});assert.ok(r.state.pendingError);assert.equal(r.storage.get(key),'{bad');assert.equal(buttons(r,'新增分组')[0].props.disabled,true);assert.equal(r.writes().length,0);
});
scenario('new edit and new unknown request clear a previous successful notice',async mount=>{
 let n=0;const r=await mount({send(c,next){if(c.url===base+'/commit'&&++n===2)throw new axios.AxiosError('lost','ERR_NETWORK');return next();}});await prepare(r);await click(r,'确认提交');assert.ok(r.state.notice);await click(r,'编辑');assert.equal(r.state.notice,'');await update(r,'编辑分组名称','第二笔');await click(r,'保存');await click(r,'确认提交');assert.equal(r.state.notice,'');assert.equal(journal(r).length,1);
});
