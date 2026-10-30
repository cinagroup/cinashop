const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {runtime,tick,row,css,byLabel,text,buttons,replay,click,update,deferred,axios,sourceRepository}=require('./helpers/rule-author-runtime.cjs');
const base='/product/rule/author';
function scenario(name,fn){test(name,async()=>{const runs=[],mount=async options=>{const r=runtime(options);runs.push(r);await tick();return r;};try{await fn(mount);}finally{for(const r of runs)await r.finish();}});}
const journal=r=>[...r.storage].filter(([key])=>key.startsWith('cinashop_rule_pending_v1_'));
const handler=(r,label,index=0)=>buttons(r,label)[index].props.onClick;
const common=r=>r.load(path.join(sourceRepository,'view/common/ruleAuthor.ts'));
async function prepare(r,name='已编辑模板'){await click(r,'编辑');await update(r,'编辑规格模板名称',name);await click(r,'保存模板');}
async function command(r,id=1,operation='update',operation_id='11111111-1111-4111-8111-111111111111'){
 const a={operation_id,actor_id:7,operation,target_id:operation==='create'?0:id,revision:'a'.repeat(64),payload:operation==='delete'?{}:{rule_name:'原模板',mode:operation==='create'?'replace':'preserve',...(operation==='create'?{spec:[{value:'颜色',detail:['红']}]}:{})},payload_hash:''};a.payload_hash=await common(r).rulePayloadHash(a);return a;
}
scenario('real five-column catalogue retains every raw source and has no media status or sorting editor',async mount=>{
 const r=await mount({rows:[row(1,{rule_value:null}),row(2,{rule_value:'{broken'})]});assert.equal(r.reads().length,1);assert.equal(css(r,'rule-row').length,2);for(const label of ['ID','模板分类名称','规格名','规格值','操作'])assert.ok(text(r.tree).includes(label));await click(r,'编辑');assert.equal(r.state.editor.mode,'preserve');assert.equal(r.state.editor.row.rule_value,null);assert.equal(byLabel(r,'编辑规格模板名称').props.maxlength,undefined);assert.equal(buttons(r,'选择图标').length,0);assert.equal(buttons(r,'隐藏').length,0);assert.equal(r.writes().length,0);
});
for(const raw of [null,'','0','null','[]','{}','false','{invalid','[{"value":"颜色","detail":["红"],"unknown":1}]','[{"value":"颜色","detail":["红",3]}]'])scenario('name-only preserve never serializes or drops historical raw '+JSON.stringify(raw),async mount=>{
 const r=await mount({rows:[row(1,{rule_value:raw})]});await prepare(r);assert.deepEqual(r.state.confirmation.payload,{rule_name:'已编辑模板',mode:'preserve'});await click(r,'确认提交');assert.equal(r.server.rows[0].rule_value,raw);assert.deepEqual(r.writes()[0].body.payload,{rule_name:'已编辑模板',mode:'preserve'});assert.equal(r.changes.length,1);assert.equal(journal(r).length,0);
});
scenario('valid formatted JSON stays byte-exact on default preserve and cancelled explicit replacement',async mount=>{
 const raw=' [ { "detail": [" 红 ","蓝"], "value": " 颜色 " } ] ';const r=await mount({rows:[row(1,{rule_value:raw})]});await click(r,'编辑');assert.equal(r.state.editor.dimensions.length,0);await click(r,'编辑/替换全部规格');assert.equal(byLabel(r,'维度名称1').props.value,' 颜色 ');assert.equal(byLabel(r,'规格值1-1').props.value,' 红 ');await click(r,'恢复原样保留');await click(r,'保存模板');await click(r,'确认提交');assert.equal(r.server.rows[0].rule_value,raw);assert.equal(r.writes()[0].body.payload.mode,'preserve');
});
scenario('new template uses raw 32 and64 Unicode inputs without UTF16 truncation and hashes the raw replacement',async mount=>{
 const r=await mount(),name=' '+ '🧭'.repeat(32)+' ';await click(r,'新增规格模板');await update(r,'编辑规格模板名称',name);await update(r,'维度名称1','😀'.repeat(32));await update(r,'规格值1-1','😀'.repeat(64));await click(r,'保存模板');assert.equal(r.writes().length,0);await click(r,'确认提交');const a=r.writes()[0].body;assert.equal(a.payload.rule_name,name);assert.equal(a.payload.spec[0].detail[0],'😀'.repeat(64));assert.equal(a.payload_hash,await common(r).rulePayloadHash(a));assert.equal(r.server.rows.at(-1).rule_name,'🧭'.repeat(32));assert.equal(r.changes.length,1);
});
scenario('modern template name zero is accepted independently of the PHP legacy falsy route',async mount=>{
 const r=await mount();await prepare(r,'0');await click(r,'确认提交');assert.equal(r.server.rows[0].rule_name,'0');
});
for(const name of ['','  ','😀'.repeat(33),'x\u0085y','x\ud800'])scenario('invalid new name prevents actual submission '+JSON.stringify(name.slice(0,8)),async mount=>{
 const r=await mount();await click(r,'新增规格模板');await update(r,'编辑规格模板名称',name);await update(r,'维度名称1','颜色');await update(r,'规格值1-1','红');await click(r,'保存模板');assert.equal(r.state.confirmation,null);assert.ok(r.state.error);assert.equal(r.writes().length,0);
});
scenario('null historical structure becomes an explicit complete replacement starting with blank fields',async mount=>{
 const r=await mount({rows:[row(1,{rule_value:null})]});await click(r,'编辑');await click(r,'编辑/替换全部规格');assert.equal(byLabel(r,'维度名称1').props.value,'');assert.match(text(r.tree),/替换全部原始规格结构/);await update(r,'维度名称1','材质');await update(r,'规格值1-1','棉');await click(r,'保存模板');assert.equal(r.state.confirmation.payload.mode,'replace');await click(r,'确认提交');assert.deepEqual(JSON.parse(r.server.rows[0].rule_value),[{value:'材质',detail:['棉']}]);
});
scenario('dimension and value adds removals preserve stable IDs and stale removed callbacks cannot edit their successor',async mount=>{
 const r=await mount();await click(r,'编辑');await click(r,'编辑/替换全部规格');await click(r,'添加维度');await update(r,'维度名称2','尺码');await update(r,'规格值2-1','M');const old=byLabel(r,'维度名称2').props.onInput,oldValue=byLabel(r,'规格值2-1').props.onInput,remove=handler(r,'删除维度',1),add=handler(r,'添加规格值',1);const id=r.state.editor.dimensions[1].key;await click(r,'删除维度',1);await click(r,'添加维度');assert.notEqual(r.state.editor.dimensions[1].key,id);replay(old,{target:{value:'retired'}});replay(oldValue,{target:{value:'retired'}});replay(remove);replay(add);await tick();assert.equal(r.state.editor.dimensions[1].value,'');assert.equal(r.state.editor.dimensions[1].detail.length,1);await update(r,'维度名称2','尺寸');await update(r,'规格值2-1','L');await click(r,'添加规格值',1);const valueId=r.state.editor.dimensions[1].detail[1].key,stale=byLabel(r,'规格值2-2').props.onInput;await click(r,'删除规格值',3);await click(r,'添加规格值',1);assert.notEqual(r.state.editor.dimensions[1].detail[1].key,valueId);replay(stale,{target:{value:'retired'}});await tick();assert.equal(r.state.editor.dimensions[1].detail[1].value,'');
});
scenario('native inputs keep their actual nodes for fast typing but captured save enter and add reject draft ABA',async mount=>{
 const r=await mount();await click(r,'编辑');await click(r,'编辑/替换全部规格');const input=byLabel(r,'规格值1-1'),name=byLabel(r,'编辑规格模板名称'),save=handler(r,'保存模板'),enter=input.props.onKeyup,add=handler(r,'添加规格值');replay(input.props.onInput,{target:{value:'A'}});replay(input.props.onInput,{target:{value:'AB'}});replay(name.props.onInput,{target:{value:'X'}});replay(name.props.onInput,{target:{value:'XY'}});await tick();assert.equal(byLabel(r,'规格值1-1'),input);assert.equal(byLabel(r,'编辑规格模板名称'),name);assert.equal(input.props.value,'AB');await update(r,'规格值1-1','红');await update(r,'编辑规格模板名称','模板1');for(const fn of [save,add])replay(fn);replay(enter,{key:'Enter'});await tick();assert.equal(r.state.confirmation,null);assert.equal(r.state.editor.dimensions[0].detail.length,2);await click(r,'保存模板');assert.ok(r.state.confirmation);
});
scenario('duplicate values and dimension names are explicit errors without silent deduplication',async mount=>{
 const r=await mount();await click(r,'编辑');await click(r,'编辑/替换全部规格');await update(r,'规格值1-2','红');await click(r,'保存模板');assert.equal(r.state.confirmation,null);assert.match(r.state.error,/重复/);assert.equal(r.state.editor.dimensions[0].detail.length,2);await update(r,'规格值1-2','蓝');await click(r,'添加维度');await update(r,'维度名称2','颜色');await update(r,'规格值2-1','绿');await click(r,'保存模板');assert.equal(r.state.confirmation,null);assert.match(r.state.error,/重复/);assert.equal(r.writes().length,0);
});
scenario('complete 3 by50 dimensions with64 Unicode values are retained and extra add is refused',async mount=>{
 const spec=Array.from({length:3},(_,i)=>({value:'维度'+i,detail:Array.from({length:50},(_,j)=>'🧭'.repeat(62)+String(j).padStart(2,'0'))})),r=await mount({rows:[row(1,{rule_value:JSON.stringify(spec)})]});await click(r,'编辑');await click(r,'编辑/替换全部规格');await click(r,'添加维度');assert.equal(r.state.editor.dimensions.length,3);await click(r,'添加规格值');assert.equal(r.state.editor.dimensions[0].detail.length,50);await click(r,'保存模板');await click(r,'确认提交');assert.deepEqual(r.writes()[0].body.payload.spec,spec);assert.deepEqual(JSON.parse(r.server.rows[0].rule_value),spec);
});
scenario('full historical overflow is preserved and repair does not import a three-dimension safe subset',async mount=>{
 const raw=JSON.stringify(Array.from({length:4},(_,i)=>({value:'维度'+i,detail:['值']}))),r=await mount({rows:[row(1,{rule_value:raw})]});await click(r,'编辑');await click(r,'编辑/替换全部规格');assert.equal(r.state.editor.dimensions.length,1);assert.equal(r.state.editor.dimensions[0].value,'');await click(r,'恢复原样保留');await click(r,'保存模板');await click(r,'确认提交');assert.equal(r.server.rows[0].rule_value,raw);
});
scenario('case-insensitive literal name search retains ten-row paging without remote list rereads',async mount=>{
 const r=await mount({rows:Array.from({length:21},(_,i)=>row(i+1,{rule_name:i?'模板'+i:'VIP%_'}))});assert.equal(css(r,'rule-row').length,10);await click(r,'下一页');assert.equal(css(r,'rule-row').length,10);await click(r,'下一页');assert.equal(css(r,'rule-row').length,1);await update(r,'规格模板搜索','vip%_');await click(r,'查询');assert.equal(css(r,'rule-row').length,1);await click(r,'重置');assert.equal(css(r,'rule-row').length,10);assert.equal(r.reads().length,1);
});
scenario('long search input is kept visible and queries the actual65-Unicode literal rather than a stale shorter value',async mount=>{
 const r=await mount();await update(r,'规格模板搜索','x'.repeat(65));await click(r,'查询');assert.equal(r.state.filters.keyword,'x'.repeat(65));assert.equal(css(r,'rule-row').length,0);assert.equal(r.reads().length,1);
});
scenario('physical deletion requests only the template API and clamps the last page',async mount=>{
 const r=await mount({rows:Array.from({length:11},(_,i)=>row(i+1))});await click(r,'下一页');await click(r,'删除');assert.match(text(r.tree),/不修改任何商品已复制/);assert.equal(r.writes().length,0);await click(r,'确认提交');assert.deepEqual(r.writes()[0].body.payload,{});assert.equal(r.writes()[0].body.operation,'delete');assert.equal(r.server.rows.length,10);assert.equal(r.state.filters.page,1);
});
for(const mode of ['actor','token','role','route','active','storage','same-session','unmount'])scenario('captured real native callbacks retire across '+mode,async mount=>{
 const r=await mount(),edit=handler(r,'编辑'),remove=handler(r,'删除'),refresh=handler(r,'刷新');await click(r,'编辑');await click(r,'编辑/替换全部规格');const input=byLabel(r,'规格值1-1').props.onInput,enter=byLabel(r,'规格值1-1').props.onKeyup,save=handler(r,'保存模板'),add=handler(r,'添加维度');await click(r,'取消');await click(r,'删除');const confirm=handler(r,'确认提交');if(mode==='actor')r.sync({token:'B',userInfo:{id:8,level:0}});if(mode==='token')r.sync({token:'B'});if(mode==='role')r.sync({userInfo:{id:7,level:1},uniqueAuth:['product.view']});if(mode==='route'){r.route.fullPath='/other';await tick();r.route.fullPath='/product/rules';}if(mode==='active'){r.props.active=false;await tick();r.props.active=true;}if(mode==='storage')r.sync({},'storage');if(mode==='same-session')r.fireAction('login');if(mode==='unmount')r.unmount();await tick();const before=r.io.length;for(const fn of [edit,remove,refresh,save,add,confirm])replay(fn);replay(input,{target:{value:'retired'}});replay(enter,{key:'Enter'});await tick();assert.equal(r.io.length,before);assert.equal(r.state.editor,null);assert.equal(r.state.confirmation,null);assert.equal(r.writes().length,0);
});
scenario('same-object row change and same-ID replacement retire captured current row callbacks',async mount=>{
 const r=await mount(),old=handler(r,'编辑');r.state.snapshot.list[0].rule_value='{new raw';replay(old);await tick();assert.equal(r.state.editor,null);const next=handler(r,'删除');r.state.snapshot.list[0]={...r.state.snapshot.list[0]};replay(next);await tick();assert.equal(r.state.confirmation,null);await click(r,'编辑');assert.equal(r.state.editor.row.rule_value,'{new raw');
});
scenario('reverse-order response failure and finally cannot clear a newer successful snapshot',async mount=>{
 const wait=deferred();let n=0;const r=await mount({send(c,next){return c.url===base+'/catalog'&&++n===2?wait.promise:next();}});await click(r,'刷新');const old=r.reads().at(-1);await click(r,'刷新');assert.equal(old.signal.aborted,true);wait.reject(Error('old'));await tick();assert.equal(r.state.snapshot.count,2);assert.equal(r.state.loading,false);assert.equal(r.state.error,'');
});
scenario('lost ACK uses original receipt and never repeats the non-idempotent create POST',async mount=>{
 const r=await mount({send(c,next){const result=next();if(c.url===base+'/commit')throw new axios.AxiosError('lost','ERR_NETWORK');return result;}});await click(r,'新增规格模板');await update(r,'编辑规格模板名称','新建');await update(r,'维度名称1','颜色');await update(r,'规格值1-1','红');await click(r,'保存模板');await click(r,'确认提交');assert.equal(r.writes().length,1);assert.equal(journal(r).length,1);assert.equal(r.server.rows.length,3);await click(r,'读取原回执');assert.equal(r.writes().length,1);assert.equal(r.receiptReads().length,1);assert.equal(journal(r).length,0);assert.equal(r.changes.length,1);
});
scenario('missing receipt remains unknown and explicit seal keeps source unchanged',async mount=>{
 const r=await mount({send(c,next){return c.url===base+'/commit'?{httpStatus:409,status:409,msg:'规格模板已变化，请刷新',data:null}:next();}});await prepare(r);await click(r,'确认提交');assert.match(r.state.error,/规格模板已变化/);assert.equal(journal(r).length,1);await click(r,'读取原回执');assert.match(r.state.error,/结果仍未知/);assert.equal(journal(r).length,1);await click(r,'核对并封存原请求');assert.equal(journal(r).length,0);assert.equal(r.changes.length,0);assert.equal(r.server.rows[0].rule_name,'模板1');
});
scenario('valid owner recovers after product permissions are withdrawn without new catalogue or commit',async mount=>{
 const r=await mount({send(c,next){const result=next();if(c.url===base+'/commit')throw Error('lost');return result;}});await prepare(r);await click(r,'确认提交');r.sync({userInfo:{id:7,level:1},uniqueAuth:[]});await tick();const before=r.reads().length;assert.ok(r.state.pending);await click(r,'读取原回执');assert.equal(journal(r).length,0);assert.equal(r.changes.length,1);assert.equal(r.reads().length,before);assert.equal(r.writes().length,1);
});
scenario('multiple same-owner journals restore sequentially and clear only the verified original UUID',async mount=>{
 const seed=await mount(),a=await command(seed),b=await command(seed,2,'delete','22222222-2222-4222-8222-222222222222');const entries=[a,b].map(x=>['cinashop_rule_pending_v1_7_'+x.operation_id,JSON.stringify(x)]),r=await mount({storage:entries});assert.equal(r.state.pending.operation_id,a.operation_id);await click(r,'核对并封存原请求');assert.equal(journal(r).length,1);assert.equal(r.state.pending.operation_id,b.operation_id);await click(r,'核对并封存原请求');assert.equal(journal(r).length,0);assert.equal(r.changes.length,0);
});
scenario('late commit reply cannot erase the old-owner journal or update the new owner view',async mount=>{
 const wait=deferred(),r=await mount({send(c,next){return c.url===base+'/commit'?wait.promise.then(next):next();}});await prepare(r);await click(r,'确认提交');const prior=r.writes()[0];r.sync({token:'B',userInfo:{id:8,level:0}});await tick();assert.equal(prior.signal.aborted,true);wait.resolve();await tick();assert.equal(journal(r).length,1);assert.equal(r.changes.length,0);assert.equal(r.state.notice,'');assert.equal(r.state.pending,null);
});
scenario('storage failure prevents dispatch while keeping the confirmation available',async mount=>{
 const r=await mount({persist(key){if(key.startsWith('cinashop_rule_pending_'))throw Error('storage full');}});await prepare(r);await click(r,'确认提交');assert.equal(r.writes().length,0);assert.equal(journal(r).length,0);assert.match(r.state.error,/storage full/);assert.ok(r.state.confirmation);
});
for(const bad of ['count','duplicate','foreign','extra','row-extra','raw-type','name','ready','capacity'])scenario('complete catalogue rejects malformed tail '+bad,async mount=>{
 const r=await mount({send(c,next){const out=next();if(c.url===base+'/catalog'){const x=out.data;if(bad==='count')x.count++;if(bad==='duplicate')x.list[1]={...x.list[0]};if(bad==='foreign')x.list[1].type=2;if(bad==='extra')x.extra=1;if(bad==='row-extra')x.list[1].image='x';if(bad==='raw-type')x.list[1].rule_value=[];if(bad==='name')x.list[1].rule_name='😀'.repeat(33);if(bad==='ready')x.write_ready=1;if(bad==='capacity')x.can_create=1;}return out;}});assert.equal(r.state.snapshot,null);assert.ok(r.state.error);assert.equal(r.writes().length,0);
});
for(const bad of ['actor','uuid','hash','result-id','state','counter'])scenario('mismatched terminal receipt retains original journal '+bad,async mount=>{
 const r=await mount({send(c,next){const out=next();if(c.url===base+'/commit'){const x=out.data;if(bad==='actor')x.actor_id++;if(bad==='uuid')x.operation_id='33333333-3333-4333-8333-333333333333';if(bad==='hash')x.payload_hash='f'.repeat(64);if(bad==='result-id')x.result.id++;if(bad==='state')x.state='queued';if(bad==='counter')x.result.created=1;}return out;}});await prepare(r);await click(r,'确认提交');assert.equal(journal(r).length,1);assert.ok(r.state.error);assert.equal(r.changes.length,0);
});
scenario('capacity disables only creation while view-only renders no mutation controls',async mount=>{
 const r=await mount({canCreate:false});assert.equal(buttons(r,'新增规格模板')[0].props.disabled,true);replay(handler(r,'新增规格模板'));await tick();assert.equal(r.state.editor,null);await prepare(r);await click(r,'确认提交');assert.equal(r.writes().length,1);const view=await mount({actor:{userInfo:{id:7,level:1},uniqueAuth:['product.view']}});assert.equal(buttons(view,'编辑').length,0);assert.equal(buttons(view,'新增规格模板').length,0);assert.equal(view.reads().length,1);
});
scenario('actual parent lazily selects dedicated rule catalogue and retires old nested handlers through tab ABA',async mount=>{
 const r=await mount({page:'pages/product/ProductMetadata.vue'});assert.deepEqual(r.io.map(c=>c.url),['/product/unit/author/catalog']);await click(r,'SKU 规格模板');assert.equal(r.reads().length,1);assert.equal(css(r,'rule-row').length,2);await click(r,'编辑');await click(r,'编辑/替换全部规格');const old=byLabel(r,'规格值1-1').props.onInput,save=handler(r,'保存模板');await click(r,'保障服务');await click(r,'SKU 规格模板');const before=r.io.length;replay(old,{target:{value:'retired'}});replay(save);await tick();assert.equal(r.io.length,before);assert.equal(r.state.editor,null);assert.equal(r.io.filter(c=>c.url==='/product/rule').length,0);assert.equal(r.io.filter(c=>c.url==='/ensure').length,0);
});

scenario('cancelled and recreated confirmation retires the exact old native submit even for identical payload',async mount=>{
 const r=await mount();await prepare(r);const old=handler(r,'确认提交');await click(r,'取消操作');await prepare(r);const before=r.io.length;replay(old);await tick();assert.equal(r.io.length,before);assert.equal(r.writes().length,0);await click(r,'确认提交');assert.equal(r.writes().length,1);
});
scenario('retirement during real native crypto digest prevents persistence and any dispatch',async mount=>{
 let armed=false,r;r=await mount({onDigest(){if(armed){armed=false;r.fireAction('login');}}});await prepare(r);armed=true;await click(r,'确认提交');assert.equal(r.writes().length,0);assert.equal(journal(r).length,0);assert.equal(r.state.confirmation,null);
});
scenario('complete valid but excessive raw whitespace payload is refused without silent normalized hashing',async mount=>{
 const spec=[{value:'颜色',detail:Array.from({length:13},(_,i)=>' '.repeat(4000)+i)}],r=await mount({rows:[row(1,{rule_value:JSON.stringify(spec)})]});await click(r,'编辑');await click(r,'编辑/替换全部规格');assert.equal(r.state.editor.dimensions[0].detail.length,13);await click(r,'保存模板');assert.equal(r.state.confirmation,null);assert.match(r.state.error,/48KiB/);assert.equal(r.writes().length,0);assert.equal(r.server.rows[0].rule_value,JSON.stringify(spec));
});
scenario('malformed durable journal remains retained and blocks every new write',async mount=>{
 const key='cinashop_rule_pending_v1_7_11111111-1111-4111-8111-111111111111',r=await mount({storage:[[key,'{bad']]});assert.ok(r.state.pendingError);assert.equal(r.storage.get(key),'{bad');assert.equal(buttons(r,'新增规格模板')[0].props.disabled,true);replay(handler(r,'新增规格模板'));await tick();assert.equal(r.state.editor,null);assert.equal(r.writes().length,0);
});
scenario('active false performs no reads until true and current controls work after an actual hide show',async mount=>{
 const r=await mount({active:false});assert.equal(r.io.length,0);assert.equal(css(r,'rule-author').length,0);r.props.active=true;await tick();assert.equal(r.reads().length,1);await prepare(r);await click(r,'确认提交');assert.equal(r.changes.length,1);assert.equal(r.writes().length,1);
});
