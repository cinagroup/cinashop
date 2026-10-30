const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {runtime,tick,row,signed,css,byLabel,text,buttons,replay,click,update,deferred,all,axios,sourceRepository}=require('./helpers/hotword-author-runtime.cjs');
const base='/product/words/author';
function scenario(name,fn){test(name,async()=>{const runs=[];const mount=async options=>{const r=runtime(options);runs.push(r);await tick();return r;};try{await fn(mount);}finally{for(const r of runs)await r.finish();}});}
const journal=r=>[...r.storage].filter(([key])=>key.startsWith('cinashop_hotword_pending_v1_'));
const handler=(r,label,index=0)=>buttons(r,label)[index].props.onClick;
const common=r=>r.load(path.join(sourceRepository,'view/common/hotwordAuthor.ts'));
function rejectedResponses(r){const errors=[];r.load(path.join(sourceRepository,'view/admin-ts/src/utils/request.ts')).default.interceptors.response.use(undefined,error=>{errors.push(error);return Promise.reject(error);});return errors;}
async function prepare(r,name='编辑后热词'){await click(r,'编辑');await update(r,'编辑热词名称',name);await click(r,'保存热词');}
async function action(r,id=1,operation='update',operation_id='11111111-1111-4111-8111-111111111111'){
 const a={operation_id,actor_id:7,operation,target_id:operation==='create'?0:id,revision:'a'.repeat(64),payload:operation==='delete'?{}:operation==='show'?{is_show:0}:{name:'原热词',color:'#666',bg_color:'#f5f5f5',border_color:'',icon:'/api/assets/501',sort:'0',is_search:'0',is_show:'1'},payload_hash:''};a.payload_hash=await common(r).hotwordPayloadHash(a);return a;
}
scenario('actual six-column editor opens eight raw fields and original advanced setting defaults0 without hidden-field clearing',async mount=>{
 const r=await mount();for(const label of ['ID','热词','是否显示','排序','创建时间','操作'])assert.ok(text(r.tree).includes(label));await click(r,'添加热词');assert.deepEqual(Object.keys(r.state.editor.draft),['name','color','bg_color','border_color','icon','sort','is_search','is_show']);assert.equal(String(r.state.editor.draft.is_search),'0');assert.equal(byLabel(r,'热词高级设置').props.value,'0');assert.equal(byLabel(r,'字体颜色'),undefined);assert.equal(byLabel(r,'热词图标原始地址'),undefined);assert.equal(byLabel(r,'编辑热词名称').props.maxlength,undefined);assert.equal(r.writes().length,0);await update(r,'热词高级设置','1');assert.ok(byLabel(r,'字体颜色'));assert.ok(byLabel(r,'热词图标原始地址'));
});
for(const icon of ['http://legacy.example/icon.png','javascript:old','/api/assets/999?ticket=old','https://legacy.example/icon.png',''])scenario('same historical raw icon and all other legacy values survive unrelated name-preserving edit '+icon,async mount=>{
 const original=row(1,{name:'😀'.repeat(128),color:'red',bg_color:'old-bg',border_color:'old-border',icon,sort:-32768,is_search:7,is_show:-3,preview:{color:'',bg_color:'',border_color:'',icon:''}}),r=await mount({rows:[original]});await click(r,'编辑');assert.equal(byLabel(r,'编辑热词名称').props.value,original.name);assert.equal(byLabel(r,'编辑热词排序').props.value,'-32768');assert.equal(byLabel(r,'热词高级设置').props.value,'7');await update(r,'编辑热词排序','4');await click(r,'保存热词');await click(r,'确认提交');const a=r.writes()[0].body;for(const key of ['name','color','bg_color','border_color','icon','is_search','is_show'])assert.equal(a.payload[key],String(original[key]));assert.equal(a.payload.sort,'4');assert.equal(r.server.rows[0].sort,4);assert.equal(r.server.rows[0].name,original.name);assert.equal(r.server.rows[0].icon,icon);assert.equal(r.server.rows[0].is_hot,0);
});
for(const name of ['', '  ', '😀'.repeat(16), 'x\nword', 'x\u007fword', 'x\ud800'])scenario('new invalid hotword blocks actual confirmation '+JSON.stringify(name),async mount=>{
 const r=await mount();await click(r,'添加热词');await update(r,'编辑热词名称',name.replace('\\n','\n').replace('\\u007f','\u007f').replace('\\ud800','\ud800'));await click(r,'保存热词');assert.equal(r.state.confirmation,null);assert.ok(r.state.error);assert.equal(r.writes().length,0);
});
scenario('fifteen supplementary Unicode characters remain intact and command hashes raw surrounding whitespace',async mount=>{
 const r=await mount();await click(r,'添加热词');const name='  '+'🧭'.repeat(15)+' ';await update(r,'编辑热词名称',name);await click(r,'保存热词');await click(r,'确认提交');const a=r.writes()[0].body;assert.equal(a.payload.name,name);assert.equal(a.payload_hash,await common(r).hotwordPayloadHash(a));assert.equal(r.server.rows.at(-1).name,name.trim());assert.equal(r.server.rows.at(-1).is_search,0);
});
scenario('advanced0 hides all four optional controls without erasing their raw colour and icon values',async mount=>{
 const r=await mount();await click(r,'编辑');const original=JSON.parse(JSON.stringify(r.state.editor.draft));await update(r,'字体颜色','rgba(1,2,3,.5)');await update(r,'背景颜色','#abc');await update(r,'边框颜色','transparent');await update(r,'热词高级设置','0');assert.equal(byLabel(r,'字体颜色'),undefined);assert.equal(byLabel(r,'热词图标原始地址'),undefined);await click(r,'保存热词');await click(r,'确认提交');const a=r.writes()[0].body;assert.equal(a.payload.color,'rgba(1,2,3,.5)');assert.equal(a.payload.bg_color,'#abc');assert.equal(a.payload.border_color,'transparent');assert.equal(a.payload.icon,original.icon);assert.equal(a.payload.is_search,'0');
});
for(const colour of ['url(https://evil.invalid)','rgb(256,0,0)','#12345','x'.repeat(33)])scenario('changed unsafe colour blocks actual submission '+colour,async mount=>{
 const r=await mount();await click(r,'编辑');await update(r,'字体颜色',colour);await click(r,'保存热词');assert.equal(r.state.confirmation,null);assert.ok(r.state.error);assert.equal(r.writes().length,0);
});
scenario('three actual colour-picker listeners support alpha and old saved picker listener retires on editor cancellation',async mount=>{
 const r=await mount();await click(r,'编辑');const pickers=all(r.tree,n=>n.props?.['data-element']==='el-color-picker');assert.equal(pickers.length,3);for(const p of pickers)assert.ok(Object.hasOwn(p.props,'show-alpha'));const old=pickers[0].props['onUpdate:modelValue'];replay(old,'rgba(1,2,3,.5)');await tick();assert.equal(byLabel(r,'字体颜色').props.value,'rgba(1,2,3,.5)');await click(r,'取消');await click(r,'编辑');replay(old,'#abcdef');await tick();assert.equal(r.state.editor.draft.color,'#666');assert.equal(r.writes().length,0);
});
scenario('gallery stores only canonical icon in eight raw fields and never signed preview material',async mount=>{
 const r=await mount();await click(r,'添加热词');await update(r,'编辑热词名称',' 新热词 ');await update(r,'热词高级设置','1');await click(r,'选择图标');await click(r,'选择此图',1);assert.equal(r.state.editor.draft.icon,'/api/assets/502');assert.equal(r.state.editor.iconPreview,signed(502));await click(r,'保存热词');await click(r,'确认提交');const a=r.writes()[0].body;assert.equal(a.payload.icon,'/api/assets/502');assert.equal(Object.keys(a.payload).length,8);assert.equal(JSON.stringify(a).includes('signature'),false);assert.equal(r.changes.length,1);
});
scenario('raw safe stable URL input and explicit clear preserve current address entry capability',async mount=>{
 const r=await mount();await click(r,'编辑');await update(r,'热词图标原始地址','https://cdn.example.test/a.png');assert.equal(r.state.editor.draft.icon,'https://cdn.example.test/a.png');await click(r,'保存热词');await click(r,'确认提交');assert.equal(r.writes()[0].body.payload.icon,'https://cdn.example.test/a.png');await click(r,'编辑');await click(r,'移除图标');await click(r,'保存热词');await click(r,'确认提交');assert.equal(r.writes()[1].body.payload.icon,'');
});
for(const value of ['','-','-0','01','1e2','1.5','1000','32768','-1'])scenario('new raw sort stays visible and refuses noncanonical or out-of-budget input '+JSON.stringify(value),async mount=>{
 const r=await mount();await click(r,'添加热词');await update(r,'编辑热词名称','新热词');await update(r,'编辑热词排序',value);assert.equal(byLabel(r,'编辑热词排序').props.value,value);await click(r,'保存热词');assert.equal(r.state.confirmation,null);assert.ok(r.state.error);assert.equal(r.writes().length,0);
});
scenario('same native name/sort nodes accept fast typing while save and Enter reject draft ABA',async mount=>{
 const r=await mount();await click(r,'编辑');const n=byLabel(r,'编辑热词名称'),s=byLabel(r,'编辑热词排序'),save=handler(r,'保存热词'),enter=s.props.onKeyup;for(const value of ['A','AB','ABC'])replay(n.props.onInput,{target:{value}});for(const value of ['1','12'])replay(s.props.onInput,{target:{value}});await tick();assert.strictEqual(byLabel(r,'编辑热词名称'),n);assert.strictEqual(byLabel(r,'编辑热词排序'),s);assert.equal(n.props.value,'ABC');assert.equal(s.props.value,'12');await update(r,'编辑热词名称','热词1');await update(r,'编辑热词排序','0');replay(save);replay(enter,{key:'Enter'});await tick();assert.equal(r.state.confirmation,null);await click(r,'保存热词');assert.ok(r.state.confirmation);
});
scenario('literal case-insensitive name or ID search preserves original fifteen-row pagination without extra reads',async mount=>{
 const r=await mount({rows:Array.from({length:31},(_,i)=>row(i+1,{name:i?'热词'+i:'VIP%_'}))});assert.equal(css(r,'hotword-row').length,15);await click(r,'下一页');assert.equal(css(r,'hotword-row').length,15);await click(r,'下一页');assert.equal(css(r,'hotword-row').length,1);await update(r,'热词搜索','vip%_');await click(r,'查询');assert.equal(css(r,'hotword-row').length,1);await update(r,'热词搜索','31');await click(r,'查询');assert.match(text(r.tree),/热词30/);await click(r,'重置');assert.equal(css(r,'hotword-row').length,15);assert.equal(r.reads().length,1);
});
scenario('show action confirms only is_show and retains historical advanced flag without normalization',async mount=>{
 const r=await mount({rows:[row(1,{is_show:7,is_search:-3})]});await click(r,'显示');assert.deepEqual(r.state.confirmation.payload,{is_show:1});assert.equal(r.writes().length,0);await click(r,'确认提交');assert.equal(r.writes()[0].body.operation,'show');assert.deepEqual(r.writes()[0].body.payload,{is_show:1});assert.equal(r.server.rows[0].is_search,-3);
});
scenario('soft-delete author action has empty payload and no product/history requests while last page clamps',async mount=>{
 const r=await mount({rows:Array.from({length:16},(_,i)=>row(i+1))});await click(r,'下一页');await click(r,'删除');assert.match(text(r.tree),/不会删除商品/);assert.equal(r.writes().length,0);await click(r,'确认提交');assert.deepEqual(r.writes()[0].body.payload,{});assert.equal(r.writes()[0].body.operation,'delete');assert.equal(r.state.filters.page,1);assert.ok(r.io.every(c=>c.url.startsWith(base+'/')));
});
scenario('real HTTP409 exposes bounded service msg while original Axios error and unknown journal remain intact',async mount=>{
 const msg='热词目录已变化，请先读取原回执',r=await mount({send(c,next){return c.url===base+'/commit'?{httpStatus:409,status:409,msg,data:null}:next();}}),errors=rejectedResponses(r);await prepare(r);await click(r,'确认提交');assert.equal(errors.length,1);assert.equal(errors[0].message,'Request failed with status code 409');assert.equal(errors[0].code,'ERR_BAD_REQUEST');assert.equal(r.state.error,'提交结果尚未确认。'+msg);assert.equal(journal(r).length,1);assert.equal(buttons(r,'原样重试').length,0);await click(r,'读取原回执');assert.match(r.state.error,/仍未知/);await click(r,'核对并封存原请求');assert.equal(journal(r).length,0);assert.equal(r.changes.length,0);
});
scenario('HTTP missing or invalid msg uses real Axios fallback without clearing unknown command',async mount=>{
 for(const msg of [undefined,null,'','  ',7,{}]){const r=await mount({send(c,next){return c.url===base+'/commit'?{httpStatus:409,status:409,...(msg===undefined?{}:{msg}),data:null}:next();}});await prepare(r);await click(r,'确认提交');assert.equal(r.state.error,'提交结果尚未确认。Request failed with status code 409');assert.equal(journal(r).length,1);assert.equal(r.changes.length,0);await r.finish();}
});
scenario('network failure preserves exact Axios object and original journal',async mount=>{
 const error=new axios.AxiosError('Network Error','ERR_NETWORK'),r=await mount({send(c,next){if(c.url===base+'/commit')throw error;return next();}}),errors=rejectedResponses(r);await prepare(r);await click(r,'确认提交');assert.strictEqual(errors[0],error);assert.equal(r.state.error,'提交结果尚未确认。Network Error');assert.equal(journal(r).length,1);
});
scenario('lost committed response recovers exact UUID without duplicate POST or preview persistence',async mount=>{
 let lost=true;const r=await mount({send(c,next){const out=next();if(c.url===base+'/commit'&&lost){lost=false;throw new axios.AxiosError('lost','ERR_NETWORK');}return out;}});await prepare(r);await click(r,'确认提交');assert.deepEqual(JSON.parse(journal(r)[0][1]),r.writes()[0].body);await click(r,'读取原回执');assert.equal(journal(r).length,0);assert.equal(r.writes().length,1);assert.equal(r.changes.length,1);
});
scenario('receipt404 never invents success and explicit retry uses original command',async mount=>{
 let n=0;const r=await mount({send(c,next){if(c.url===base+'/commit'&&n++===0)throw new axios.AxiosError('lost','ERR_NETWORK');return next();}});await prepare(r);await click(r,'确认提交');assert.equal(buttons(r,'原样重试').length,0);await click(r,'读取原回执');await click(r,'原样重试');assert.deepEqual(r.writes()[0].body,r.writes()[1].body);assert.equal(journal(r).length,0);
});
scenario('double issued confirmation persists before transport and dispatches once',async mount=>{
 const wait=deferred(),r=await mount({send(c,next){if(c.url===base+'/commit'){assert.equal(journal(r).length,1);return wait.promise.then(next);}return next();}});await prepare(r);const confirm=handler(r,'确认提交');replay(confirm);replay(confirm);await tick();assert.equal(r.writes().length,1);wait.resolve();await tick();assert.equal(journal(r).length,0);
});
scenario('storage failure prevents any dispatch and leaves confirmation recoverable',async mount=>{
 const r=await mount({persist(k){if(k.startsWith('cinashop_hotword_pending'))throw Error('storage failed');}});await prepare(r);await click(r,'确认提交');assert.equal(r.writes().length,0);assert.ok(r.state.confirmation);assert.match(text(r.tree),/storage failed/);
});
scenario('multiple owner UUID journals restore sequentially and never clear another command',async mount=>{
 const r=await mount(),a=await action(r),b=await action(r,2,'delete','22222222-2222-4222-8222-222222222222');for(const v of [b,a])r.storage.set(`cinashop_hotword_pending_v1_7_${v.operation_id}`,JSON.stringify(v));r.sync();await tick();assert.equal(r.state.pending.operation_id,a.operation_id);await click(r,'核对并封存原请求');assert.equal(journal(r).length,1);assert.equal(r.state.pending.operation_id,b.operation_id);await click(r,'核对并封存原请求');assert.equal(journal(r).length,0);
});
scenario('withdrawn view and manage still permit live original owner receipt and resolve',async mount=>{
 const r=await mount({send(c,next){if(c.url===base+'/commit')throw Error('lost');return next();}});await prepare(r);await click(r,'确认提交');r.sync({userInfo:{id:7,level:1},uniqueAuth:[]});await tick();assert.equal(buttons(r,'添加热词').length,0);await click(r,'读取原回执');assert.equal(buttons(r,'原样重试').length,0);await click(r,'核对并封存原请求');assert.equal(journal(r).length,0);
});
for(const mode of ['route','actor','same-login','storage','role','active','unmount'])scenario('issued editor row status delete confirm and refresh retire through '+mode,async mount=>{
 const r=await mount(),edit=handler(r,'编辑'),remove=handler(r,'删除'),status=handler(r,'隐藏'),refresh=handler(r,'刷新');await click(r,'编辑');const input=byLabel(r,'编辑热词名称').props.onInput,save=handler(r,'保存热词');await click(r,'取消');await click(r,'删除');const confirm=handler(r,'确认提交');
 if(mode==='route'){r.route.fullPath='/product/hotwords?x';r.route.fullPath='/product/hotwords';}if(mode==='actor')r.sync({token:'B',userInfo:{id:8,level:0}});if(mode==='same-login')r.fireAction('login');if(mode==='storage')r.sync({},'storage');if(mode==='role'){r.actor.uniqueAuth=['product.view'];r.actor.uniqueAuth=[];}if(mode==='active'){r.props.active=false;await tick();r.props.active=true;}if(mode==='unmount')r.unmount();await tick();const count=r.io.length;for(const fn of [edit,remove,status,refresh,save,confirm])replay(fn);replay(input,{target:{value:'stale'}});await tick();assert.equal(r.io.length,count);assert.equal(r.state.editor,null);assert.equal(r.state.confirmation,null);assert.equal(r.writes().length,0);
});
scenario('late committed response after hide cannot erase journal or emit changed for a new view',async mount=>{
 const wait=deferred(),r=await mount({send(c,next){return c.url===base+'/commit'?wait.promise.then(next):next();}});await prepare(r);await click(r,'确认提交');const old=r.writes()[0];r.props.active=false;await tick();assert.equal(old.signal.aborted,true);wait.resolve();await tick();assert.equal(journal(r).length,1);assert.equal(r.changes.length,0);r.props.active=true;await tick();await click(r,'读取原回执');assert.equal(journal(r).length,0);assert.equal(r.writes().length,1);
});
scenario('out-of-order catalog failure and finally do not clear a newer snapshot',async mount=>{
 const wait=deferred();let n=0;const r=await mount({send(c,next){if(c.url===base+'/catalog'&&++n===2)return wait.promise;return next();}});await click(r,'刷新');const old=r.reads().at(-1);await click(r,'刷新');assert.equal(old.signal.aborted,true);wait.reject(Error('old'));await tick();assert.equal(r.state.snapshot.count,2);assert.equal(r.state.error,'');assert.equal(r.state.loading,false);
});
scenario('same-object mutation and same-ID replacement retire row edit status and delete callbacks',async mount=>{
 const r=await mount(),edit=handler(r,'编辑'),status=handler(r,'隐藏'),remove=handler(r,'删除');r.state.snapshot.list[0].name='changed';for(const fn of [edit,status,remove])replay(fn);await tick();assert.equal(r.state.editor,null);assert.equal(r.state.confirmation,null);const fresh=handler(r,'编辑');r.state.snapshot.list[0]={...r.state.snapshot.list[0]};replay(fresh);await tick();assert.equal(r.state.editor,null);await click(r,'编辑');assert.equal(r.state.editor.draft.name,'changed');
});
scenario('gallery re-open, query ABA and replaced option invalidate captured choices and error callbacks',async mount=>{
 const r=await mount();await click(r,'编辑');await click(r,'选择图标');const oldChoose=handler(r,'选择此图'),oldImage=all(r.tree,n=>n.tag==='img'&&n.props.alt==='第一图标')[0],before=r.state.editor.draft.icon;await update(r,'图库名称','x');await update(r,'图库名称','');await click(r,'查询图片');replay(oldChoose);replay(oldImage.props.onError);await tick();assert.equal(r.state.editor.draft.icon,before);assert.ok(r.state.gallery);assert.ok(r.state.gallery.list[0].preview);const second=handler(r,'选择此图',1);await click(r,'关闭图库');await click(r,'选择图标');replay(second);await tick();assert.ok(r.state.gallery);await click(r,'选择此图',1);assert.equal(r.state.editor.draft.icon,'/api/assets/502');
});
for(const mode of ['cancel','actor','route','active','unmount'])scenario('late gallery categories cannot initiate options or edit across '+mode,async mount=>{
 const wait=deferred();const r=await mount({send(c,next){return c.url===base+'/attachments/categories'?wait.promise.then(next):next();}});await click(r,'编辑');await click(r,'选择图标');const request=r.io.at(-1);if(mode==='cancel')await click(r,'关闭图库');if(mode==='actor')r.sync({token:'B',userInfo:{id:8,level:0}});if(mode==='route')r.route.fullPath='/product/hotwords?new';if(mode==='active')r.props.active=false;if(mode==='unmount')r.unmount();await tick();assert.equal(request.signal.aborted,true);wait.resolve();await tick();assert.equal(r.io.filter(c=>c.url===base+'/attachments/options').length,0);assert.equal(r.state.gallery,null);
});
scenario('gallery previous request aborts on native query input and new results remain authoritative',async mount=>{
 let n=0;const wait=deferred(),r=await mount({send(c,next){if(c.url===base+'/attachments/options'&&++n===1)return wait.promise.then(next);return next();}});await click(r,'编辑');await click(r,'选择图标');const old=r.io.at(-1);await update(r,'图库名称','第二');assert.equal(old.signal.aborted,true);await click(r,'查询图片');assert.equal(r.state.gallery.list.length,1);wait.resolve();await tick();assert.equal(r.state.gallery.list[0].att_id,502);assert.equal(r.state.gallery.loading,false);await click(r,'选择此图');assert.equal(r.state.editor.draft.icon,'/api/assets/502');
});
scenario('gallery 81-character input stays visible and causes explicit error without more I/O',async mount=>{
 const r=await mount();await click(r,'编辑');await click(r,'选择图标');await update(r,'图库名称','😀'.repeat(81));const count=r.io.length;await click(r,'查询图片');assert.equal(r.io.length,count);assert.equal(byLabel(r,'图库名称').props.value,'😀'.repeat(81));assert.match(text(r.tree),/80个字符/);
});
scenario('editor current image error hides only its preview; old error cannot clear newly picked source',async mount=>{
 const r=await mount();await click(r,'编辑');const image=all(r.tree,n=>n.tag==='img'&&n.props.alt==='热词图标预览')[0],old=image.props.onError;await click(r,'选择图标');await click(r,'选择此图',1);replay(old);await tick();const current=all(r.tree,n=>n.tag==='img'&&n.props.alt==='热词图标预览')[0];assert.match(current.props.src,/502/);replay(current.props.onError);await tick();assert.equal(all(r.tree,n=>n.tag==='img'&&n.props.alt==='热词图标预览').length,0);assert.equal(r.state.editor.draft.icon,'/api/assets/502');
});
for(const bad of ['count','duplicate','foreign','extra','row-extra','name','sort','preview','can-create'])scenario('whole catalog fails closed without dropping its malformed tail '+bad,async mount=>{
 const r=await mount({send(c,next){const out=next();if(c.url===base+'/catalog'){const x=out.data;if(bad==='count')x.count++;if(bad==='duplicate')x.list[1]={...x.list[0]};if(bad==='foreign')x.list[1].relation_id=7;if(bad==='extra')x.extra=true;if(bad==='row-extra')x.list[1].unknown=true;if(bad==='name')x.list[1].name='😀'.repeat(129);if(bad==='sort')x.list[1].sort=32768;if(bad==='preview')x.list[1].preview.icon='javascript:x';if(bad==='can-create')x.can_create=1;}return out;}});assert.equal(r.state.snapshot,null);assert.ok(r.state.error);assert.equal(r.writes().length,0);
});
for(const bad of ['pid','count','duplicate','reference','ticket','preview','preview-ref','extra'])scenario('gallery rejects malformed complete options '+bad,async mount=>{
 const r=await mount({send(c,next){const out=next();if(c.url===base+'/attachments/options'){const x=out.data;if(bad==='pid')x.list[1].pid=9;if(bad==='count')x.count++;if(bad==='duplicate')x.list[1]={...x.list[0]};if(bad==='reference')x.list[1].reference='/api/assets/999';if(bad==='ticket')x.list[1].reference+='?ticket=not-stable';if(bad==='preview')x.list[1].preview='javascript:x';if(bad==='preview-ref')x.list[1].preview=signed(501);if(bad==='extra')x.list[1].scope='admin';}return out;}});await click(r,'编辑');await click(r,'选择图标');assert.ok(r.state.gallery.error);assert.equal(r.state.gallery.list.length,0);assert.equal(r.writes().length,0);
});
scenario('capacity disables create only; view-only cannot author or read gallery',async mount=>{
 const full=await mount({canCreate:false});assert.equal(buttons(full,'添加热词')[0].props.disabled,true);replay(handler(full,'添加热词'));await tick();assert.equal(full.state.editor,null);await click(full,'编辑');await update(full,'编辑热词排序','5');await click(full,'保存热词');await click(full,'确认提交');assert.equal(full.writes().length,1);const viewer=await mount({actor:{userInfo:{id:7,level:1},uniqueAuth:['product.view']}});assert.equal(buttons(viewer,'添加热词').length,0);assert.equal(buttons(viewer,'编辑').length,0);assert.equal(viewer.io.length,1);
});
scenario('actual parent retains lazy four accepted authors and starts dedicated hotword reader only on words activation',async mount=>{
 const r=await mount({page:'pages/product/ProductMetadata.vue'});assert.deepEqual(r.io.map(c=>c.url),['/product/unit/author/catalog']);assert.equal(css(r,'hotword-author').length,0);await click(r,'搜索热词');assert.equal(r.reads().length,1);assert.equal(css(r,'hotword-row').length,2);await click(r,'编辑');const old=byLabel(r,'编辑热词名称').props.onInput,save=handler(r,'保存热词');await click(r,'商品单位');await click(r,'搜索热词');const count=r.io.length;replay(old,{target:{value:'retired'}});replay(save);await tick();assert.equal(r.io.length,count);assert.equal(r.state.editor,null);assert.equal(r.io.filter(c=>c.url==='/product/words').length,0);await click(r,'编辑');assert.equal(r.state.editor.draft.name,'热词1');
});

scenario('old advanced native and picker callbacks retire when the conditional editor branch closes and reopens',async mount=>{
 const r=await mount();await click(r,'编辑');const input=byLabel(r,'字体颜色').props.onInput,icon=byLabel(r,'热词图标原始地址').props.onInput,picker=all(r.tree,n=>n.props?.['data-element']==='el-color-picker')[0].props['onUpdate:modelValue'];await update(r,'热词高级设置','0');await update(r,'热词高级设置','1');const before=JSON.parse(JSON.stringify(r.state.editor.draft));replay(input,{target:{value:'#abcdef'}});replay(icon,{target:{value:'https://old.example/x.png'}});replay(picker,'#abcdef');await tick();assert.deepEqual(r.state.editor.draft,before);await update(r,'字体颜色','#123456');assert.equal(r.state.editor.draft.color,'#123456');
});
scenario('gallery twenty-plus-one pagination preserves full count and chooses the last canonical icon',async mount=>{
 const images=Array.from({length:21},(_,i)=>({att_id:501+i,pid:0,real_name:'图标'+i,reference:'/api/assets/'+(501+i),preview:signed(501+i)})),r=await mount({images});await click(r,'编辑');await click(r,'选择图标');assert.equal(r.state.gallery.count,21);assert.equal(r.state.gallery.list.length,20);await click(r,'图库下一页');assert.equal(r.state.gallery.list.length,1);assert.equal(r.state.gallery.page,2);await click(r,'图库上一页');assert.equal(r.state.gallery.list.length,20);await click(r,'图库下一页');await click(r,'选择此图');assert.equal(r.state.editor.draft.icon,'/api/assets/521');await click(r,'保存热词');await click(r,'确认提交');assert.equal(r.writes()[0].body.payload.icon,'/api/assets/521');assert.equal(JSON.stringify(r.writes()[0].body).includes('signature'),false);
});
scenario('modern single zero name remains a valid explicit new hotword',async mount=>{
 const r=await mount();await click(r,'添加热词');await update(r,'编辑热词名称','0');await click(r,'保存热词');await click(r,'确认提交');assert.equal(r.server.rows.at(-1).name,'0');assert.equal(r.writes()[0].body.payload.name,'0');
});
scenario('full raw eight-field budget is checked before confirmation without hashing a normalized substitute',async mount=>{
 const r=await mount();await click(r,'编辑');await update(r,'编辑热词名称',' '.repeat(4095)+'A');for(const label of ['字体颜色','背景颜色','边框颜色'])await update(r,label,'#abc'+' '.repeat(4092));await update(r,'热词图标原始地址','/static/a.png'+' '.repeat(4083));await click(r,'保存热词');assert.equal(r.state.confirmation,null);assert.match(r.state.error,/16KiB/);assert.equal(r.writes().length,0);assert.equal(journal(r).length,0);
});
