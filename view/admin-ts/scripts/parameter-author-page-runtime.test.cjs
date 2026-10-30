const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {runtime,tick,row,child,css,byLabel,text,buttons,replay,click,update,deferred,axios,sourceRepository,all}=require('./helpers/parameter-author-runtime.cjs');
const base='/product/specs/author';
function scenario(name,fn){test(name,async()=>{const runs=[],mount=async options=>{const r=runtime(options);runs.push(r);await tick();return r;};try{await fn(mount);}finally{for(const r of runs)await r.finish();}});}
const journal=r=>[...r.storage].filter(([key])=>key.startsWith('cinashop_parameter_pending_v1_'));
const handler=(r,label,index=0)=>buttons(r,label)[index].props.onClick;
const common=r=>r.load(path.join(sourceRepository,'view/common/parameterAuthor.ts'));
async function prepare(r,name='已编辑模板'){await click(r,'编辑');await update(r,'编辑参数模板名称',name);await click(r,'保存模板');}
async function command(r,id=1,operation='update',operation_id='11111111-1111-4111-8111-111111111111'){
 const a={operation_id,actor_id:7,operation,target_id:operation==='create'?0:id,revision:'a'.repeat(64),payload:operation==='delete'?{}:{name:'原模板',sort:'0',mode:operation==='create'?'replace':'preserve',...(operation==='create'?{specs:[]}:{})},payload_hash:''};a.payload_hash=await common(r).parameterPayloadHash(a);return a;
}
const history=(parent,count)=>Array.from({length:count},(_,i)=>child(parent,parent*10000+i+1,{name:' 参数'+i+'\n名称\t ',value:' 值\r\n'+i+'\u0085 ',sort:i===0?0:-i,status:i%3?0:7,add_time:i===0?0:-i}));
scenario('actual five-column fifteen-row parameter list has no media or template status editor and retains readonly metadata',async mount=>{
 const r=await mount({rows:Array.from({length:16},(_,i)=>row(i+1,{other:'opaque',is_show:9,integral_min:-1,pid:88}))});assert.equal(r.reads().length,1);assert.equal(css(r,'parameter-row').length,15);const table=all(r.tree,n=>n.props?.['aria-label']==='商品参数模板列表')[0];assert.equal(all(table,n=>n.tag==='th').length,5);for(const name of ['ID','参数模板名称','排序','创建时间','操作'])assert.ok(text(table).includes(name));await click(r,'编辑');assert.equal(r.state.editor.mode,'preserve');assert.equal(r.state.editor.row.other,'opaque');assert.equal(r.state.editor.row.is_show,9);assert.equal(byLabel(r,'编辑参数模板名称').tag,'textarea');assert.equal(byLabel(r,'编辑参数模板名称').props.maxlength,undefined);assert.equal(buttons(r,'选择图片').length,0);assert.equal(buttons(r,'启用模板').length,0);assert.equal(r.writes().length,0);
});
scenario('default preserve retains every one of 0 historical child rows without echo or mount repair',async mount=>{
 const specs=history(1,0),r=await mount({rows:[row(1,{specs,other:'read-only',sort:-9})]});await prepare(r);assert.equal(r.state.editor,null);assert.deepEqual(r.state.confirmation.payload,{name:'已编辑模板',sort:'-9',mode:'preserve'});await click(r,'确认提交');assert.deepEqual(r.server.rows[0].specs,specs);assert.equal(r.server.rows[0].other,'read-only');assert.deepEqual(Object.keys(r.writes()[0].body.payload),['name','sort','mode']);assert.equal(journal(r).length,0);assert.equal(r.changes.length,1);
});
scenario('default preserve retains every one of 100 historical child rows without echo or mount repair',async mount=>{
 const specs=history(1,100),r=await mount({rows:[row(1,{specs,other:'read-only',sort:-9})]});await prepare(r);assert.equal(r.state.editor,null);assert.deepEqual(r.state.confirmation.payload,{name:'已编辑模板',sort:'-9',mode:'preserve'});await click(r,'确认提交');assert.deepEqual(r.server.rows[0].specs,specs);assert.equal(r.server.rows[0].other,'read-only');assert.deepEqual(Object.keys(r.writes()[0].body.payload),['name','sort','mode']);assert.equal(journal(r).length,0);assert.equal(r.changes.length,1);
});
scenario('default preserve retains every one of 2000 historical child rows without echo or mount repair',async mount=>{
 const specs=history(1,2000),r=await mount({rows:[row(1,{specs,other:'read-only',sort:-9})]});await prepare(r);assert.equal(r.state.editor,null);assert.deepEqual(r.state.confirmation.payload,{name:'已编辑模板',sort:'-9',mode:'preserve'});await click(r,'确认提交');assert.deepEqual(r.server.rows[0].specs,specs);assert.equal(r.server.rows[0].other,'read-only');assert.deepEqual(Object.keys(r.writes()[0].body.payload),['name','sort','mode']);assert.equal(journal(r).length,0);assert.equal(r.changes.length,1);
});
scenario('same historical blank or control name and signed parent order remain exact on an unchanged save',async mount=>{
 const name=' \u0000\r\n\t\u0085 ',r=await mount({rows:[row(1,{name,sort:-2147483648,specs:[]})]});await click(r,'编辑');assert.equal(byLabel(r,'编辑参数模板名称').props.value,name);assert.equal(byLabel(r,'编辑参数模板排序').props.value,'-2147483648');await click(r,'保存模板');await click(r,'确认提交');assert.equal(r.server.rows[0].name,name);assert.equal(r.server.rows[0].sort,-2147483648);assert.deepEqual(r.server.rows[0].specs,[]);
});
scenario('new multiline parent and child text preserves raw draft and normalizes only after confirmed submission',async mount=>{
 const name='  '+ '🧭'.repeat(250)+'\n\tZ\u0085  ',a=' A\r\nB\tC\u0085 ',v=' V\nQ\rR\tS\u0085 ',r=await mount();await click(r,'新增参数模板');await update(r,'编辑参数模板名称',name);await update(r,'参数名称1',a);await update(r,'参数值1',v);assert.equal(byLabel(r,'参数名称1').tag,'textarea');assert.equal(byLabel(r,'参数值1').props.maxlength,undefined);replay(byLabel(r,'参数名称1').props.onKeydown,{key:'Enter',ctrlKey:false,preventDefault(){}});await tick();assert.equal(r.state.confirmation,null);await click(r,'保存模板');await click(r,'确认提交');const action=r.writes()[0].body;assert.equal(action.payload.name,name);assert.equal(action.payload.specs[0].name,a);assert.equal(action.payload.specs[0].value,v);assert.equal(action.payload_hash,await common(r).parameterPayloadHash(action));assert.equal(r.server.rows.at(-1).name,name.trim());assert.equal(r.server.rows.at(-1).specs[0].value,v.trim());
});
scenario('modern zero text and duplicate parameter names are accepted without importing Supplier or rule restrictions',async mount=>{
 const r=await mount({rows:[row(1,{specs:[child(1,1001),child(1,1002,{name:'材质',value:'丝'})]})]});await click(r,'编辑');await click(r,'编辑/替换全部参数');await update(r,'编辑参数模板名称','0');await update(r,'参数名称1','0');await update(r,'参数值1','0');await update(r,'参数名称2','0');await click(r,'保存模板');await click(r,'确认提交');assert.equal(r.server.rows[0].name,'0');assert.deepEqual(r.server.rows[0].specs.map(x=>x.name),['0','0']);assert.equal(r.server.rows[0].specs[0].value,'0');
});
scenario('zero-row history enters explicit replace with zero rows and can be deliberately saved empty',async mount=>{
 const r=await mount({rows:[row(1,{specs:[]})]});await click(r,'编辑');assert.equal(css(r,'parameter-history-row').length,0);await click(r,'编辑/替换全部参数');assert.equal(css(r,'parameter-entry').length,0);assert.equal(r.state.editor.specs.length,0);await click(r,'保存模板');assert.deepEqual(r.state.confirmation.payload.specs,[]);await click(r,'确认提交');assert.deepEqual(r.server.rows[0].specs,[]);
});
scenario('all one hundred maximum Unicode rows survive paging and a payload larger than legacy64KiB',async mount=>{
 const specs=Array.from({length:100},(_,i)=>child(1,1001+i,{name:'🧭'.repeat(255),value:'😀'.repeat(255),sort:i,status:i%2})),r=await mount({rows:[row(1,{specs})]});await click(r,'编辑');await click(r,'编辑/替换全部参数');assert.equal(css(r,'parameter-entry').length,20);assert.equal(r.state.editor.specs.length,100);assert.equal(buttons(r,'添加参数')[0].props.disabled,true);await click(r,'参数下一页');assert.equal(byLabel(r,'参数值21').props.value,'😀'.repeat(255));await click(r,'保存模板');await click(r,'确认提交');const action=r.writes()[0].body;assert.equal(action.payload.specs.length,100);assert.ok(new TextEncoder().encode(JSON.stringify(action.payload)).length>65536);assert.equal(action.payload_hash,await common(r).parameterPayloadHash(action));assert.equal(r.server.rows[0].specs.length,100);assert.equal(r.server.rows[0].specs[99].name,'🧭'.repeat(255));
});
scenario('two thousand complete replacement rows are copied and paged without truncation then explicitly preserved',async mount=>{
 const specs=history(1,2000),r=await mount({rows:[row(1,{specs})]});await click(r,'编辑');assert.equal(css(r,'parameter-history-row').length,20);await click(r,'参数下一页');assert.ok(text(r.tree).includes('参数20'));await click(r,'编辑/替换全部参数');assert.equal(r.state.editor.specs.length,2000);assert.equal(css(r,'parameter-entry').length,20);assert.ok(text(r.tree).includes('当前全部 2000 项'));await click(r,'保存模板');assert.match(r.state.error,/100/);assert.equal(r.state.confirmation,null);assert.equal(r.writes().length,0);await click(r,'恢复原样保留');await click(r,'保存模板');await click(r,'确认提交');assert.deepEqual(r.server.rows[0].specs,specs);
});
scenario('negative child sort and unknown status require explicit repair while readonly child metadata is not authored',async mount=>{
 const r=await mount({rows:[row(1,{specs:[child(1,1001,{sort:-1,status:7,add_time:-88})]})]});await click(r,'编辑');await click(r,'编辑/替换全部参数');assert.equal(byLabel(r,'参数排序1').props.value,'-1');assert.equal(byLabel(r,'参数状态1').props.value,'7');await click(r,'保存模板');assert.equal(r.state.confirmation,null);await update(r,'参数排序1','0');await click(r,'保存模板');assert.equal(r.state.confirmation,null);await update(r,'参数状态1','0');await click(r,'保存模板');await click(r,'确认提交');assert.deepEqual(r.writes()[0].body.payload.specs,[{name:'材质',value:'棉',sort:'0',status:'0'}]);assert.equal(r.server.rows[0].specs[0].status,0);assert.notEqual(r.server.rows[0].specs[0].id,1001);
});
scenario('clearing the complete replacement needs its own current confirmation and accepts zero only deliberately',async mount=>{
 const r=await mount();await click(r,'编辑');await click(r,'编辑/替换全部参数');const input=byLabel(r,'参数名称1').props.onInput;await click(r,'清空全部新参数稿');const old=handler(r,'确认清空新稿');replay(input,{target:{value:'retired'}});await tick();assert.equal(r.state.editor.specs[0].name,'材质');await click(r,'取消清空');await click(r,'清空全部新参数稿');replay(old);await tick();assert.equal(r.state.editor.specs.length,1);await click(r,'确认清空新稿');assert.equal(r.state.editor.specs.length,0);assert.equal(r.server.rows[0].specs.length,1);await click(r,'保存模板');await click(r,'确认提交');assert.deepEqual(r.server.rows[0].specs,[]);
});
scenario('removed parameter IDs never rebind captured input or remove actions to a successor row',async mount=>{
 const r=await mount();await click(r,'编辑');await click(r,'编辑/替换全部参数');const old=byLabel(r,'参数名称1').props.onInput,remove=handler(r,'删除参数'),id=r.state.editor.specs[0].key;await click(r,'删除参数');assert.equal(r.state.editor.specs.length,0);await click(r,'添加参数');assert.notEqual(r.state.editor.specs[0].key,id);replay(old,{target:{value:'retired'}});replay(remove);await tick();assert.equal(r.state.editor.specs.length,1);assert.equal(r.state.editor.specs[0].name,'');
});
scenario('fast textarea and raw sort typing retain native nodes while save enter and add reject draft ABA',async mount=>{
 const r=await mount();await click(r,'编辑');await click(r,'编辑/替换全部参数');const input=byLabel(r,'参数名称1'),name=byLabel(r,'编辑参数模板名称'),sort=byLabel(r,'编辑参数模板排序'),save=handler(r,'保存模板'),enter=input.props.onKeydown,add=handler(r,'添加参数');replay(input.props.onInput,{target:{value:'A'}});replay(input.props.onInput,{target:{value:'AB'}});replay(name.props.onInput,{target:{value:'X'}});replay(name.props.onInput,{target:{value:'XY'}});replay(sort.props.onInput,{target:{value:'-'}});replay(sort.props.onInput,{target:{value:'-1'}});await tick();assert.equal(byLabel(r,'参数名称1'),input);assert.equal(byLabel(r,'编辑参数模板名称'),name);assert.equal(byLabel(r,'编辑参数模板排序'),sort);assert.equal(input.props.value,'AB');assert.equal(sort.props.value,'-1');await update(r,'参数名称1','材质');await update(r,'编辑参数模板名称','模板1');await update(r,'编辑参数模板排序','0');for(const fn of [save,add])replay(fn);replay(enter,{key:'Enter',ctrlKey:true,preventDefault(){}});await tick();assert.equal(r.state.confirmation,null);assert.equal(r.state.editor.specs.length,1);await click(r,'保存模板');assert.ok(r.state.confirmation);
});
scenario('replacement page ABA retires old inputs and buttons without changing hidden page values',async mount=>{
 const specs=Array.from({length:21},(_,i)=>child(1,1001+i,{name:'名称'+i,value:'值'+i})),r=await mount({rows:[row(1,{specs})]});await click(r,'编辑');await click(r,'编辑/替换全部参数');const old=byLabel(r,'参数值1').props.onInput,remove=handler(r,'删除参数'),save=handler(r,'保存模板');await click(r,'参数下一页');assert.equal(css(r,'parameter-entry').length,1);await click(r,'参数上一页');replay(old,{target:{value:'retired'}});replay(remove);replay(save);await tick();assert.equal(r.state.editor.specs[0].value,'值0');assert.equal(r.state.editor.specs.length,21);assert.equal(r.state.confirmation,null);await click(r,'保存模板');assert.equal(r.state.confirmation.payload.specs.length,21);
});
scenario('case-insensitive literal name search is local and never treats an ID alone as a matching name',async mount=>{
 const r=await mount({rows:Array.from({length:31},(_,i)=>row(i+1,{name:i?'plain':'VIP%_'}))});assert.equal(css(r,'parameter-row').length,15);await click(r,'下一页');assert.equal(css(r,'parameter-row').length,15);await click(r,'下一页');assert.equal(css(r,'parameter-row').length,1);await update(r,'参数模板搜索','vip%_');await click(r,'查询');assert.equal(css(r,'parameter-row').length,1);await update(r,'参数模板搜索','31');await click(r,'查询');assert.equal(css(r,'parameter-row').length,0);await click(r,'重置');assert.equal(css(r,'parameter-row').length,15);assert.equal(r.reads().length,1);
});
scenario('sixty-five Unicode search is retained and applied rather than silently using the old shorter query',async mount=>{
 const r=await mount();await update(r,'参数模板搜索','x'.repeat(65));await click(r,'查询');assert.equal(r.state.filters.keyword,'x'.repeat(65));assert.equal(css(r,'parameter-row').length,0);assert.equal(r.reads().length,1);
});
scenario('delete uses only the parameter command and clamps the last fifteen-row page',async mount=>{
 const r=await mount({rows:Array.from({length:16},(_,i)=>row(i+1))});await click(r,'下一页');await click(r,'删除');assert.match(text(r.tree),/商品直接资料或关联记录引用/);assert.equal(r.writes().length,0);await click(r,'确认提交');assert.deepEqual(r.writes()[0].body.payload,{});assert.equal(r.writes()[0].body.operation,'delete');assert.equal(r.server.rows.length,15);assert.equal(r.state.filters.page,1);assert.equal(r.io.some(c=>c.url.includes('/product/product')),false);
});
scenario('source child mutation or same-ID row replacement retires the entire current editor without serializing it in handlers',async mount=>{
 const r=await mount(),old=handler(r,'编辑');r.state.snapshot.list[0].specs[0].value='updated';replay(old);await tick();assert.equal(r.state.editor,null);await click(r,'编辑');assert.equal(r.state.editor.row.specs[0].value,'updated');const save=handler(r,'保存模板');r.state.snapshot.list[0]={...r.state.snapshot.list[0]};replay(save);await tick();assert.equal(r.state.editor,null);assert.equal(r.state.confirmation,null);assert.equal(r.writes().length,0);
});
scenario('captured actual row textarea save clear and confirmation retire across actor',async mount=>{
 const r=await mount(),edit=handler(r,'编辑'),remove=handler(r,'删除'),refresh=handler(r,'刷新');await click(r,'编辑');await click(r,'编辑/替换全部参数');const input=byLabel(r,'参数名称1').props.onInput,enter=byLabel(r,'参数名称1').props.onKeydown,save=handler(r,'保存模板'),add=handler(r,'添加参数');await click(r,'清空全部新参数稿');const clear=handler(r,'确认清空新稿');await click(r,'取消');await click(r,'删除');const confirm=handler(r,'确认提交');r.sync({token:'B',userInfo:{id:8,level:0}});await tick();const before=r.io.length;for(const fn of [edit,remove,refresh,save,add,clear,confirm])replay(fn);replay(input,{target:{value:'retired'}});replay(enter,{key:'Enter',ctrlKey:true,preventDefault(){}});await tick();assert.equal(r.io.length,before);assert.equal(r.state.editor,null);assert.equal(r.state.confirmation,null);assert.equal(r.writes().length,0);
});
scenario('captured actual row textarea save clear and confirmation retire across token',async mount=>{
 const r=await mount(),edit=handler(r,'编辑'),remove=handler(r,'删除'),refresh=handler(r,'刷新');await click(r,'编辑');await click(r,'编辑/替换全部参数');const input=byLabel(r,'参数名称1').props.onInput,enter=byLabel(r,'参数名称1').props.onKeydown,save=handler(r,'保存模板'),add=handler(r,'添加参数');await click(r,'清空全部新参数稿');const clear=handler(r,'确认清空新稿');await click(r,'取消');await click(r,'删除');const confirm=handler(r,'确认提交');r.sync({token:'B'});await tick();const before=r.io.length;for(const fn of [edit,remove,refresh,save,add,clear,confirm])replay(fn);replay(input,{target:{value:'retired'}});replay(enter,{key:'Enter',ctrlKey:true,preventDefault(){}});await tick();assert.equal(r.io.length,before);assert.equal(r.state.editor,null);assert.equal(r.state.confirmation,null);assert.equal(r.writes().length,0);
});
scenario('captured actual row textarea save clear and confirmation retire across role',async mount=>{
 const r=await mount(),edit=handler(r,'编辑'),remove=handler(r,'删除'),refresh=handler(r,'刷新');await click(r,'编辑');await click(r,'编辑/替换全部参数');const input=byLabel(r,'参数名称1').props.onInput,enter=byLabel(r,'参数名称1').props.onKeydown,save=handler(r,'保存模板'),add=handler(r,'添加参数');await click(r,'清空全部新参数稿');const clear=handler(r,'确认清空新稿');await click(r,'取消');await click(r,'删除');const confirm=handler(r,'确认提交');r.sync({userInfo:{id:7,level:1},uniqueAuth:['product.view']});await tick();const before=r.io.length;for(const fn of [edit,remove,refresh,save,add,clear,confirm])replay(fn);replay(input,{target:{value:'retired'}});replay(enter,{key:'Enter',ctrlKey:true,preventDefault(){}});await tick();assert.equal(r.io.length,before);assert.equal(r.state.editor,null);assert.equal(r.state.confirmation,null);assert.equal(r.writes().length,0);
});
scenario('captured actual row textarea save clear and confirmation retire across route',async mount=>{
 const r=await mount(),edit=handler(r,'编辑'),remove=handler(r,'删除'),refresh=handler(r,'刷新');await click(r,'编辑');await click(r,'编辑/替换全部参数');const input=byLabel(r,'参数名称1').props.onInput,enter=byLabel(r,'参数名称1').props.onKeydown,save=handler(r,'保存模板'),add=handler(r,'添加参数');await click(r,'清空全部新参数稿');const clear=handler(r,'确认清空新稿');await click(r,'取消');await click(r,'删除');const confirm=handler(r,'确认提交');r.route.fullPath='/other';await tick();r.route.fullPath='/product/parameters';await tick();const before=r.io.length;for(const fn of [edit,remove,refresh,save,add,clear,confirm])replay(fn);replay(input,{target:{value:'retired'}});replay(enter,{key:'Enter',ctrlKey:true,preventDefault(){}});await tick();assert.equal(r.io.length,before);assert.equal(r.state.editor,null);assert.equal(r.state.confirmation,null);assert.equal(r.writes().length,0);
});
scenario('captured actual row textarea save clear and confirmation retire across active',async mount=>{
 const r=await mount(),edit=handler(r,'编辑'),remove=handler(r,'删除'),refresh=handler(r,'刷新');await click(r,'编辑');await click(r,'编辑/替换全部参数');const input=byLabel(r,'参数名称1').props.onInput,enter=byLabel(r,'参数名称1').props.onKeydown,save=handler(r,'保存模板'),add=handler(r,'添加参数');await click(r,'清空全部新参数稿');const clear=handler(r,'确认清空新稿');await click(r,'取消');await click(r,'删除');const confirm=handler(r,'确认提交');r.props.active=false;await tick();assert.equal(css(r,'parameter-author').length,0);r.props.active=true;await tick();const before=r.io.length;for(const fn of [edit,remove,refresh,save,add,clear,confirm])replay(fn);replay(input,{target:{value:'retired'}});replay(enter,{key:'Enter',ctrlKey:true,preventDefault(){}});await tick();assert.equal(r.io.length,before);assert.equal(r.state.editor,null);assert.equal(r.state.confirmation,null);assert.equal(r.writes().length,0);
});
scenario('captured actual row textarea save clear and confirmation retire across storage',async mount=>{
 const r=await mount(),edit=handler(r,'编辑'),remove=handler(r,'删除'),refresh=handler(r,'刷新');await click(r,'编辑');await click(r,'编辑/替换全部参数');const input=byLabel(r,'参数名称1').props.onInput,enter=byLabel(r,'参数名称1').props.onKeydown,save=handler(r,'保存模板'),add=handler(r,'添加参数');await click(r,'清空全部新参数稿');const clear=handler(r,'确认清空新稿');await click(r,'取消');await click(r,'删除');const confirm=handler(r,'确认提交');r.sync({},'storage');await tick();const before=r.io.length;for(const fn of [edit,remove,refresh,save,add,clear,confirm])replay(fn);replay(input,{target:{value:'retired'}});replay(enter,{key:'Enter',ctrlKey:true,preventDefault(){}});await tick();assert.equal(r.io.length,before);assert.equal(r.state.editor,null);assert.equal(r.state.confirmation,null);assert.equal(r.writes().length,0);
});
scenario('captured actual row textarea save clear and confirmation retire across same-session',async mount=>{
 const r=await mount(),edit=handler(r,'编辑'),remove=handler(r,'删除'),refresh=handler(r,'刷新');await click(r,'编辑');await click(r,'编辑/替换全部参数');const input=byLabel(r,'参数名称1').props.onInput,enter=byLabel(r,'参数名称1').props.onKeydown,save=handler(r,'保存模板'),add=handler(r,'添加参数');await click(r,'清空全部新参数稿');const clear=handler(r,'确认清空新稿');await click(r,'取消');await click(r,'删除');const confirm=handler(r,'确认提交');r.fireAction('login');await tick();const before=r.io.length;for(const fn of [edit,remove,refresh,save,add,clear,confirm])replay(fn);replay(input,{target:{value:'retired'}});replay(enter,{key:'Enter',ctrlKey:true,preventDefault(){}});await tick();assert.equal(r.io.length,before);assert.equal(r.state.editor,null);assert.equal(r.state.confirmation,null);assert.equal(r.writes().length,0);
});
scenario('captured actual row textarea save clear and confirmation retire across unmount',async mount=>{
 const r=await mount(),edit=handler(r,'编辑'),remove=handler(r,'删除'),refresh=handler(r,'刷新');await click(r,'编辑');await click(r,'编辑/替换全部参数');const input=byLabel(r,'参数名称1').props.onInput,enter=byLabel(r,'参数名称1').props.onKeydown,save=handler(r,'保存模板'),add=handler(r,'添加参数');await click(r,'清空全部新参数稿');const clear=handler(r,'确认清空新稿');await click(r,'取消');await click(r,'删除');const confirm=handler(r,'确认提交');r.unmount();await tick();const before=r.io.length;for(const fn of [edit,remove,refresh,save,add,clear,confirm])replay(fn);replay(input,{target:{value:'retired'}});replay(enter,{key:'Enter',ctrlKey:true,preventDefault(){}});await tick();assert.equal(r.io.length,before);assert.equal(r.state.editor,null);assert.equal(r.state.confirmation,null);assert.equal(r.writes().length,0);
});
scenario('reverse-order response failure and finally cannot clear a newer successful snapshot',async mount=>{
 const wait=deferred();let n=0;const r=await mount({send(c,next){return c.url===base+'/catalog'&&++n===2?wait.promise:next();}});await click(r,'刷新');const old=r.reads().at(-1);await click(r,'刷新');assert.equal(old.signal.aborted,true);wait.reject(Error('old'));await tick();assert.equal(r.state.snapshot.count,2);assert.equal(r.state.loading,false);assert.equal(r.state.error,'');
});
scenario('lost ACK uses original receipt and never repeats the non-idempotent create POST',async mount=>{
 const r=await mount({send(c,next){const result=next();if(c.url===base+'/commit')throw new axios.AxiosError('lost','ERR_NETWORK');return result;}});await click(r,'新增参数模板');await update(r,'编辑参数模板名称','新建');await update(r,'参数名称1','颜色');await update(r,'参数值1','红');await click(r,'保存模板');await click(r,'确认提交');assert.equal(r.writes().length,1);assert.equal(journal(r).length,1);assert.equal(r.server.rows.length,3);await click(r,'读取原回执');assert.equal(r.writes().length,1);assert.equal(r.receiptReads().length,1);assert.equal(journal(r).length,0);assert.equal(r.changes.length,1);
});
scenario('missing receipt remains unknown and explicit seal keeps source unchanged',async mount=>{
 const r=await mount({send(c,next){return c.url===base+'/commit'?{httpStatus:409,status:409,msg:'参数模板已变化，请刷新',data:null}:next();}});await prepare(r);await click(r,'确认提交');assert.match(r.state.error,/参数模板已变化/);assert.equal(journal(r).length,1);await click(r,'读取原回执');assert.match(r.state.error,/结果仍未知/);assert.equal(journal(r).length,1);await click(r,'核对并封存原请求');assert.equal(journal(r).length,0);assert.equal(r.changes.length,0);assert.equal(r.server.rows[0].name,'模板1');
});
scenario('valid owner recovers after product permissions are withdrawn without new catalogue or commit',async mount=>{
 const r=await mount({send(c,next){const result=next();if(c.url===base+'/commit')throw Error('lost');return result;}});await prepare(r);await click(r,'确认提交');r.sync({userInfo:{id:7,level:1},uniqueAuth:[]});await tick();const before=r.reads().length;assert.ok(r.state.pending);await click(r,'读取原回执');assert.equal(journal(r).length,0);assert.equal(r.changes.length,1);assert.equal(r.reads().length,before);assert.equal(r.writes().length,1);
});
scenario('multiple same-owner journals restore sequentially and clear only the verified original UUID',async mount=>{
 const seed=await mount(),a=await command(seed),b=await command(seed,2,'delete','22222222-2222-4222-8222-222222222222');const entries=[a,b].map(x=>['cinashop_parameter_pending_v1_7_'+x.operation_id,JSON.stringify(x)]),r=await mount({storage:entries});assert.equal(r.state.pending.operation_id,a.operation_id);await click(r,'核对并封存原请求');assert.equal(journal(r).length,1);assert.equal(r.state.pending.operation_id,b.operation_id);await click(r,'核对并封存原请求');assert.equal(journal(r).length,0);assert.equal(r.changes.length,0);
});
scenario('late commit reply cannot erase the old-owner journal or update the new owner view',async mount=>{
 const wait=deferred(),r=await mount({send(c,next){return c.url===base+'/commit'?wait.promise.then(next):next();}});await prepare(r);await click(r,'确认提交');const prior=r.writes()[0];r.sync({token:'B',userInfo:{id:8,level:0}});await tick();assert.equal(prior.signal.aborted,true);wait.resolve();await tick();assert.equal(journal(r).length,1);assert.equal(r.changes.length,0);assert.equal(r.state.notice,'');assert.equal(r.state.pending,null);
});
scenario('storage failure prevents dispatch while keeping the confirmation available',async mount=>{
 const r=await mount({persist(key){if(key.startsWith('cinashop_parameter_pending_'))throw Error('storage full');}});await prepare(r);await click(r,'确认提交');assert.equal(r.writes().length,0);assert.equal(journal(r).length,0);assert.match(r.state.error,/storage full/);assert.ok(r.state.confirmation);
});
scenario('invalid new parameter name empty is refused by the actual textarea save',async mount=>{
 const r=await mount();await click(r,'新增参数模板');await update(r,'编辑参数模板名称',"");await update(r,'参数名称1','名称');await update(r,'参数值1','值');await click(r,'保存模板');assert.equal(r.state.confirmation,null);assert.ok(r.state.error);assert.equal(r.writes().length,0);
});
scenario('invalid new parameter name whitespace is refused by the actual textarea save',async mount=>{
 const r=await mount();await click(r,'新增参数模板');await update(r,'编辑参数模板名称',"  ");await update(r,'参数名称1','名称');await update(r,'参数值1','值');await click(r,'保存模板');assert.equal(r.state.confirmation,null);assert.ok(r.state.error);assert.equal(r.writes().length,0);
});
scenario('invalid new parameter name 256-Unicode is refused by the actual textarea save',async mount=>{
 const r=await mount();await click(r,'新增参数模板');await update(r,'编辑参数模板名称',"\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00");await update(r,'参数名称1','名称');await update(r,'参数值1','值');await click(r,'保存模板');assert.equal(r.state.confirmation,null);assert.ok(r.state.error);assert.equal(r.writes().length,0);
});
scenario('invalid new parameter name NUL is refused by the actual textarea save',async mount=>{
 const r=await mount();await click(r,'新增参数模板');await update(r,'编辑参数模板名称',"x\u0000y");await update(r,'参数名称1','名称');await update(r,'参数值1','值');await click(r,'保存模板');assert.equal(r.state.confirmation,null);assert.ok(r.state.error);assert.equal(r.writes().length,0);
});
scenario('invalid new parameter name unpaired-surrogate is refused by the actual textarea save',async mount=>{
 const r=await mount();await click(r,'新增参数模板');await update(r,'编辑参数模板名称',"x\ud800");await update(r,'参数名称1','名称');await update(r,'参数值1','值');await click(r,'保存模板');assert.equal(r.state.confirmation,null);assert.ok(r.state.error);assert.equal(r.writes().length,0);
});
scenario('new raw parent sort -1 is retained visibly but cannot submit',async mount=>{
 const r=await mount();await click(r,'新增参数模板');await update(r,'编辑参数模板名称','新建');await update(r,'参数名称1','名称');await update(r,'参数值1','值');await update(r,'编辑参数模板排序',"-1");assert.equal(byLabel(r,'编辑参数模板排序').props.value,"-1");await click(r,'保存模板');assert.equal(r.state.confirmation,null);assert.ok(r.state.error);assert.equal(r.writes().length,0);
});
scenario('new raw parent sort -0 is retained visibly but cannot submit',async mount=>{
 const r=await mount();await click(r,'新增参数模板');await update(r,'编辑参数模板名称','新建');await update(r,'参数名称1','名称');await update(r,'参数值1','值');await update(r,'编辑参数模板排序',"-0");assert.equal(byLabel(r,'编辑参数模板排序').props.value,"-0");await click(r,'保存模板');assert.equal(r.state.confirmation,null);assert.ok(r.state.error);assert.equal(r.writes().length,0);
});
scenario('new raw parent sort 01 is retained visibly but cannot submit',async mount=>{
 const r=await mount();await click(r,'新增参数模板');await update(r,'编辑参数模板名称','新建');await update(r,'参数名称1','名称');await update(r,'参数值1','值');await update(r,'编辑参数模板排序',"01");assert.equal(byLabel(r,'编辑参数模板排序').props.value,"01");await click(r,'保存模板');assert.equal(r.state.confirmation,null);assert.ok(r.state.error);assert.equal(r.writes().length,0);
});
scenario('new raw parent sort 1e2 is retained visibly but cannot submit',async mount=>{
 const r=await mount();await click(r,'新增参数模板');await update(r,'编辑参数模板名称','新建');await update(r,'参数名称1','名称');await update(r,'参数值1','值');await update(r,'编辑参数模板排序',"1e2");assert.equal(byLabel(r,'编辑参数模板排序').props.value,"1e2");await click(r,'保存模板');assert.equal(r.state.confirmation,null);assert.ok(r.state.error);assert.equal(r.writes().length,0);
});
scenario('new raw parent sort - is retained visibly but cannot submit',async mount=>{
 const r=await mount();await click(r,'新增参数模板');await update(r,'编辑参数模板名称','新建');await update(r,'参数名称1','名称');await update(r,'参数值1','值');await update(r,'编辑参数模板排序',"-");assert.equal(byLabel(r,'编辑参数模板排序').props.value,"-");await click(r,'保存模板');assert.equal(r.state.confirmation,null);assert.ok(r.state.error);assert.equal(r.writes().length,0);
});
scenario('new raw parent sort empty is retained visibly but cannot submit',async mount=>{
 const r=await mount();await click(r,'新增参数模板');await update(r,'编辑参数模板名称','新建');await update(r,'参数名称1','名称');await update(r,'参数值1','值');await update(r,'编辑参数模板排序',"");assert.equal(byLabel(r,'编辑参数模板排序').props.value,"");await click(r,'保存模板');assert.equal(r.state.confirmation,null);assert.ok(r.state.error);assert.equal(r.writes().length,0);
});
scenario('new raw parent sort 2147483648 is retained visibly but cannot submit',async mount=>{
 const r=await mount();await click(r,'新增参数模板');await update(r,'编辑参数模板名称','新建');await update(r,'参数名称1','名称');await update(r,'参数值1','值');await update(r,'编辑参数模板排序',"2147483648");assert.equal(byLabel(r,'编辑参数模板排序').props.value,"2147483648");await click(r,'保存模板');assert.equal(r.state.confirmation,null);assert.ok(r.state.error);assert.equal(r.writes().length,0);
});
scenario('explicit replacement rejects NUL name without repairing source',async mount=>{
 const r=await mount();await click(r,'编辑');await click(r,'编辑/替换全部参数');await update(r,"参数名称1","x\u0000y");await click(r,'保存模板');assert.equal(r.state.confirmation,null);assert.ok(r.state.error);assert.equal(r.writes().length,0);assert.equal(r.server.rows[0].specs[0].name,'材质');
});
scenario('explicit replacement rejects unpaired name without repairing source',async mount=>{
 const r=await mount();await click(r,'编辑');await click(r,'编辑/替换全部参数');await update(r,"参数名称1","x\ud800");await click(r,'保存模板');assert.equal(r.state.confirmation,null);assert.ok(r.state.error);assert.equal(r.writes().length,0);assert.equal(r.server.rows[0].specs[0].name,'材质');
});
scenario('explicit replacement rejects empty value without repairing source',async mount=>{
 const r=await mount();await click(r,'编辑');await click(r,'编辑/替换全部参数');await update(r,"参数值1","");await click(r,'保存模板');assert.equal(r.state.confirmation,null);assert.ok(r.state.error);assert.equal(r.writes().length,0);assert.equal(r.server.rows[0].specs[0].name,'材质');
});
scenario('explicit replacement rejects 256-Unicode value without repairing source',async mount=>{
 const r=await mount();await click(r,'编辑');await click(r,'编辑/替换全部参数');await update(r,"参数值1","\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00");await click(r,'保存模板');assert.equal(r.state.confirmation,null);assert.ok(r.state.error);assert.equal(r.writes().length,0);assert.equal(r.server.rows[0].specs[0].name,'材质');
});
scenario('explicit replacement rejects noncanonical sort without repairing source',async mount=>{
 const r=await mount();await click(r,'编辑');await click(r,'编辑/替换全部参数');await update(r,"参数排序1","01");await click(r,'保存模板');assert.equal(r.state.confirmation,null);assert.ok(r.state.error);assert.equal(r.writes().length,0);assert.equal(r.server.rows[0].specs[0].name,'材质');
});
scenario('explicit replacement rejects negative sort without repairing source',async mount=>{
 const r=await mount();await click(r,'编辑');await click(r,'编辑/替换全部参数');await update(r,"参数排序1","-1");await click(r,'保存模板');assert.equal(r.state.confirmation,null);assert.ok(r.state.error);assert.equal(r.writes().length,0);assert.equal(r.server.rows[0].specs[0].name,'材质');
});
scenario('explicit replacement rejects unknown status without repairing source',async mount=>{
 const r=await mount();await click(r,'编辑');await click(r,'编辑/替换全部参数');await update(r,"参数状态1","2");await click(r,'保存模板');assert.equal(r.state.confirmation,null);assert.ok(r.state.error);assert.equal(r.writes().length,0);assert.equal(r.server.rows[0].specs[0].name,'材质');
});
scenario('complete catalogue rejects malformed tail count instead of exposing a safe subset',async mount=>{
 const r=await mount({send(c,next){const out=next();if(c.url===base+'/catalog'){const x=out.data;x.count++;}return out;}});assert.equal(r.state.snapshot,null);assert.ok(r.state.error);assert.equal(r.writes().length,0);
});
scenario('complete catalogue rejects malformed tail duplicate-parent instead of exposing a safe subset',async mount=>{
 const r=await mount({send(c,next){const out=next();if(c.url===base+'/catalog'){const x=out.data;x.list[1]={...x.list[0]};}return out;}});assert.equal(r.state.snapshot,null);assert.ok(r.state.error);assert.equal(r.writes().length,0);
});
scenario('complete catalogue rejects malformed tail foreign-parent instead of exposing a safe subset',async mount=>{
 const r=await mount({send(c,next){const out=next();if(c.url===base+'/catalog'){const x=out.data;x.list[1].relation_id=9;}return out;}});assert.equal(r.state.snapshot,null);assert.ok(r.state.error);assert.equal(r.writes().length,0);
});
scenario('complete catalogue rejects malformed tail owner instead of exposing a safe subset',async mount=>{
 const r=await mount({send(c,next){const out=next();if(c.url===base+'/catalog'){const x=out.data;x.list[1].owner_id=1;}return out;}});assert.equal(r.state.snapshot,null);assert.ok(r.state.error);assert.equal(r.writes().length,0);
});
scenario('complete catalogue rejects malformed tail wrong-group instead of exposing a safe subset',async mount=>{
 const r=await mount({send(c,next){const out=next();if(c.url===base+'/catalog'){const x=out.data;x.list[1].group=2;}return out;}});assert.equal(r.state.snapshot,null);assert.ok(r.state.error);assert.equal(r.writes().length,0);
});
scenario('complete catalogue rejects malformed tail extra-parent instead of exposing a safe subset',async mount=>{
 const r=await mount({send(c,next){const out=next();if(c.url===base+'/catalog'){const x=out.data;x.list[1].image="unauthorized";}return out;}});assert.equal(r.state.snapshot,null);assert.ok(r.state.error);assert.equal(r.writes().length,0);
});
scenario('complete catalogue rejects malformed tail missing-readonly instead of exposing a safe subset',async mount=>{
 const r=await mount({send(c,next){const out=next();if(c.url===base+'/catalog'){const x=out.data;delete x.list[1].other;}return out;}});assert.equal(r.state.snapshot,null);assert.ok(r.state.error);assert.equal(r.writes().length,0);
});
scenario('complete catalogue rejects malformed tail foreign-child instead of exposing a safe subset',async mount=>{
 const r=await mount({send(c,next){const out=next();if(c.url===base+'/catalog'){const x=out.data;x.list[1].specs[0].type=2;}return out;}});assert.equal(r.state.snapshot,null);assert.ok(r.state.error);assert.equal(r.writes().length,0);
});
scenario('complete catalogue rejects malformed tail duplicate-child instead of exposing a safe subset',async mount=>{
 const r=await mount({send(c,next){const out=next();if(c.url===base+'/catalog'){const x=out.data;x.list[1].specs[0].id=x.list[0].specs[0].id;}return out;}});assert.equal(r.state.snapshot,null);assert.ok(r.state.error);assert.equal(r.writes().length,0);
});
scenario('complete catalogue rejects malformed tail extra-child instead of exposing a safe subset',async mount=>{
 const r=await mount({send(c,next){const out=next();if(c.url===base+'/catalog'){const x=out.data;x.list[1].specs[0].unknown=1;}return out;}});assert.equal(r.state.snapshot,null);assert.ok(r.state.error);assert.equal(r.writes().length,0);
});
scenario('complete catalogue rejects malformed tail bad-child-type instead of exposing a safe subset',async mount=>{
 const r=await mount({send(c,next){const out=next();if(c.url===base+'/catalog'){const x=out.data;x.list[1].specs[0].status="1";}return out;}});assert.equal(r.state.snapshot,null);assert.ok(r.state.error);assert.equal(r.writes().length,0);
});
scenario('complete catalogue rejects malformed tail name-overflow instead of exposing a safe subset',async mount=>{
 const r=await mount({send(c,next){const out=next();if(c.url===base+'/catalog'){const x=out.data;x.list[1].name="😀".repeat(256);}return out;}});assert.equal(r.state.snapshot,null);assert.ok(r.state.error);assert.equal(r.writes().length,0);
});
scenario('complete catalogue rejects malformed tail child-overflow instead of exposing a safe subset',async mount=>{
 const r=await mount({send(c,next){const out=next();if(c.url===base+'/catalog'){const x=out.data;x.list[1].specs=history(2,2001);}return out;}});assert.equal(r.state.snapshot,null);assert.ok(r.state.error);assert.equal(r.writes().length,0);
});
scenario('complete catalogue rejects malformed tail global-child-overflow instead of exposing a safe subset',async mount=>{
 const r=await mount({send(c,next){const out=next();if(c.url===base+'/catalog'){const x=out.data;x.list=Array.from({length:11},(_,i)=>row(i+1,{specs:history(i+1,2000)}));x.count=x.list.length;}return out;}});assert.equal(r.state.snapshot,null);assert.ok(r.state.error);assert.equal(r.writes().length,0);
});
scenario('complete catalogue rejects malformed tail parent-overflow instead of exposing a safe subset',async mount=>{
 const r=await mount({send(c,next){const out=next();if(c.url===base+'/catalog'){const x=out.data;x.list=Array.from({length:2001},(_,i)=>row(i+1,{specs:[]}));x.count=x.list.length;}return out;}});assert.equal(r.state.snapshot,null);assert.ok(r.state.error);assert.equal(r.writes().length,0);
});
scenario('complete catalogue rejects malformed tail ready instead of exposing a safe subset',async mount=>{
 const r=await mount({send(c,next){const out=next();if(c.url===base+'/catalog'){const x=out.data;x.write_ready=1;}return out;}});assert.equal(r.state.snapshot,null);assert.ok(r.state.error);assert.equal(r.writes().length,0);
});
scenario('complete catalogue rejects malformed tail capacity instead of exposing a safe subset',async mount=>{
 const r=await mount({send(c,next){const out=next();if(c.url===base+'/catalog'){const x=out.data;x.can_create=1;}return out;}});assert.equal(r.state.snapshot,null);assert.ok(r.state.error);assert.equal(r.writes().length,0);
});
scenario('mismatched terminal receipt actor never clears the exact pending journal',async mount=>{
 const r=await mount({send(c,next){const out=next();if(c.url===base+'/commit'){const x=out.data;x.actor_id++;}return out;}});await prepare(r);await click(r,'确认提交');assert.equal(journal(r).length,1);assert.ok(r.state.error);assert.equal(r.changes.length,0);
});
scenario('mismatched terminal receipt uuid never clears the exact pending journal',async mount=>{
 const r=await mount({send(c,next){const out=next();if(c.url===base+'/commit'){const x=out.data;x.operation_id='33333333-3333-4333-8333-333333333333';}return out;}});await prepare(r);await click(r,'确认提交');assert.equal(journal(r).length,1);assert.ok(r.state.error);assert.equal(r.changes.length,0);
});
scenario('mismatched terminal receipt hash never clears the exact pending journal',async mount=>{
 const r=await mount({send(c,next){const out=next();if(c.url===base+'/commit'){const x=out.data;x.payload_hash='f'.repeat(64);}return out;}});await prepare(r);await click(r,'确认提交');assert.equal(journal(r).length,1);assert.ok(r.state.error);assert.equal(r.changes.length,0);
});
scenario('mismatched terminal receipt result-id never clears the exact pending journal',async mount=>{
 const r=await mount({send(c,next){const out=next();if(c.url===base+'/commit'){const x=out.data;x.result.id++;}return out;}});await prepare(r);await click(r,'确认提交');assert.equal(journal(r).length,1);assert.ok(r.state.error);assert.equal(r.changes.length,0);
});
scenario('mismatched terminal receipt state never clears the exact pending journal',async mount=>{
 const r=await mount({send(c,next){const out=next();if(c.url===base+'/commit'){const x=out.data;x.state='queued';}return out;}});await prepare(r);await click(r,'确认提交');assert.equal(journal(r).length,1);assert.ok(r.state.error);assert.equal(r.changes.length,0);
});
scenario('mismatched terminal receipt counter never clears the exact pending journal',async mount=>{
 const r=await mount({send(c,next){const out=next();if(c.url===base+'/commit'){const x=out.data;x.result.created=1;}return out;}});await prepare(r);await click(r,'确认提交');assert.equal(journal(r).length,1);assert.ok(r.state.error);assert.equal(r.changes.length,0);
});
scenario('mismatched terminal receipt count never clears the exact pending journal',async mount=>{
 const r=await mount({send(c,next){const out=next();if(c.url===base+'/commit'){const x=out.data;x.result.count=-1;}return out;}});await prepare(r);await click(r,'确认提交');assert.equal(journal(r).length,1);assert.ok(r.state.error);assert.equal(r.changes.length,0);
});
scenario('full source capacity disables only create and a readonly role has no mutation controls',async mount=>{
 const r=await mount({canCreate:false});assert.equal(buttons(r,'新增参数模板')[0].props.disabled,true);replay(handler(r,'新增参数模板'));await tick();assert.equal(r.state.editor,null);await prepare(r);await click(r,'确认提交');assert.equal(r.writes().length,1);const view=await mount({actor:{userInfo:{id:7,level:1},uniqueAuth:['product.view']}});assert.equal(buttons(view,'编辑').length,0);assert.equal(buttons(view,'新增参数模板').length,0);assert.equal(view.reads().length,1);await update(view,'参数模板搜索','模板');await click(view,'查询');assert.equal(view.writes().length,0);
});
scenario('actual parent lazily selects parameter author and retires its nested callbacks across a real tab ABA',async mount=>{
 const r=await mount({page:'pages/product/ProductMetadata.vue'});assert.deepEqual(r.io.map(c=>c.url),['/product/unit/author/catalog']);await click(r,'商品参数模板');assert.equal(r.reads().length,1);assert.equal(css(r,'parameter-row').length,2);await click(r,'编辑');await click(r,'编辑/替换全部参数');const old=byLabel(r,'参数名称1').props.onInput,save=handler(r,'保存模板');await click(r,'保障服务');await click(r,'商品参数模板');const before=r.io.length;replay(old,{target:{value:'retired'}});replay(save);await tick();assert.equal(r.io.length,before);assert.equal(r.state.editor,null);assert.equal(r.io.filter(c=>c.url==='/specs').length,0);assert.equal(r.io.filter(c=>c.url==='/ensure').length,0);assert.equal(r.writes().length,0);
});
scenario('same payload recreated confirmation retires its earlier actual submit closure',async mount=>{
 const r=await mount();await prepare(r);const old=handler(r,'确认提交');await click(r,'取消操作');await prepare(r);const before=r.io.length;replay(old);await tick();assert.equal(r.io.length,before);assert.equal(r.writes().length,0);await click(r,'确认提交');assert.equal(r.writes().length,1);
});
scenario('actual native crypto digest completing after session retirement cannot persist or dispatch',async mount=>{
 let armed=false,r;r=await mount({onDigest(){if(armed){armed=false;r.fireAction('login');}}});await prepare(r);armed=true;await click(r,'确认提交');assert.equal(r.writes().length,0);assert.equal(journal(r).length,0);assert.equal(r.state.confirmation,null);
});
scenario('raw replacement beyond384KiB is refused before confirmation without normalized or truncated hashing',async mount=>{
 const r=await mount();await click(r,'编辑');await click(r,'编辑/替换全部参数');await click(r,'清空全部新参数稿');await click(r,'确认清空新稿');for(let i=0;i<49;i++){await click(r,'添加参数');await update(r,'参数名称'+(i+1),' '.repeat(4000)+'n');await update(r,'参数值'+(i+1),' '.repeat(4000)+'v');}await click(r,'保存模板');assert.equal(r.state.confirmation,null);assert.match(r.state.error,/384KiB/);assert.equal(r.state.editor.specs.length,49);assert.equal(r.writes().length,0);assert.equal(r.server.rows[0].specs[0].name,'材质');
});
scenario('malformed durable journal stays intact and blocks a new action',async mount=>{
 const key='cinashop_parameter_pending_v1_7_11111111-1111-4111-8111-111111111111',r=await mount({storage:[[key,'{bad']]});assert.ok(r.state.pendingError);assert.equal(r.storage.get(key),'{bad');assert.equal(buttons(r,'新增参数模板')[0].props.disabled,true);replay(handler(r,'新增参数模板'));await tick();assert.equal(r.state.editor,null);assert.equal(r.writes().length,0);
});
scenario('inactive parameter child makes no read and can later activate with current controls',async mount=>{
 const r=await mount({active:false});assert.equal(r.io.length,0);assert.equal(css(r,'parameter-author').length,0);r.props.active=true;await tick();assert.equal(r.reads().length,1);await prepare(r);await click(r,'确认提交');assert.equal(r.changes.length,1);assert.equal(r.writes().length,1);
});
scenario('actual Axios message failure retains pending and uses only a valid service message',async mount=>{
 const r=await mount({send(c,next){if(c.url===base+'/commit'){return {httpStatus:409,status:409,msg:'参数模板正在更新，请刷新后重试',data:null};}return next();}});await prepare(r);await click(r,'确认提交');assert.match(r.state.error,/参数模板正在更新，请刷新后重试/);assert.equal(journal(r).length,1);assert.equal(r.changes.length,0);assert.equal(r.server.rows[0].name,'模板1');
});
scenario('actual Axios blank failure retains pending and uses only a valid service message',async mount=>{
 const r=await mount({send(c,next){if(c.url===base+'/commit'){return {httpStatus:409,status:409,msg:'  ',data:null};}return next();}});await prepare(r);await click(r,'确认提交');assert.match(r.state.error,/Request failed with status code 409/);assert.equal(journal(r).length,1);assert.equal(r.changes.length,0);assert.equal(r.server.rows[0].name,'模板1');
});
scenario('actual Axios missing failure retains pending and uses only a valid service message',async mount=>{
 const r=await mount({send(c,next){if(c.url===base+'/commit'){return {httpStatus:409,status:409,data:null};}return next();}});await prepare(r);await click(r,'确认提交');assert.match(r.state.error,/Request failed with status code 409/);assert.equal(journal(r).length,1);assert.equal(r.changes.length,0);assert.equal(r.server.rows[0].name,'模板1');
});
scenario('actual Axios wrong-type failure retains pending and uses only a valid service message',async mount=>{
 const r=await mount({send(c,next){if(c.url===base+'/commit'){return {httpStatus:409,status:409,msg:{secret:'not rendered'},data:null};}return next();}});await prepare(r);await click(r,'确认提交');assert.match(r.state.error,/Request failed with status code 409/);assert.equal(r.state.error.includes('not rendered'),false);assert.equal(journal(r).length,1);assert.equal(r.changes.length,0);assert.equal(r.server.rows[0].name,'模板1');
});
scenario('actual Axios network failure retains pending and uses only a valid service message',async mount=>{
 const r=await mount({send(c,next){if(c.url===base+'/commit'){throw new axios.AxiosError('Network Error',axios.AxiosError.ERR_NETWORK);}return next();}});await prepare(r);await click(r,'确认提交');assert.match(r.state.error,/Network Error/);assert.equal(journal(r).length,1);assert.equal(r.changes.length,0);assert.equal(r.server.rows[0].name,'模板1');
});
