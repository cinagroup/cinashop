const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {runtime,tick,row,css,byLabel,text,buttons,replay,click,update,deferred,all,axios,sourceRepository}=require('./helpers/ensure-author-runtime.cjs');
const base='/product/ensure/author';
function scenario(name,fn){test(name,async()=>{const runs=[];const mount=async options=>{const r=runtime(options);runs.push(r);await tick();return r;};try{await fn(mount);}finally{for(const r of runs)await r.finish();}});}
const journal=r=>[...r.storage].filter(([key])=>key.startsWith('cinashop_ensure_pending_v1_'));
const handler=(r,label,index=0)=>buttons(r,label)[index].props.onClick;
const common=r=>r.load(path.join(sourceRepository,'view/common/ensureAuthor.ts'));
function rejectedResponses(r){const errors=[];r.load(path.join(sourceRepository,'view/admin-ts/src/utils/request.ts')).default.interceptors.response.use(undefined,error=>{errors.push(error);return Promise.reject(error);});return errors;}
async function prepare(r,name='编辑后的保障'){await click(r,'编辑');await update(r,'编辑保障条款',name);await click(r,'保存');}
async function action(r,id=1,operation='update',operation_id='11111111-1111-4111-8111-111111111111'){
 const a={operation_id,actor_id:7,operation,target_id:operation==='create'?0:id,revision:'a'.repeat(64),payload:operation==='delete'?{}:operation==='status'?{status:0}:{name:'原操作',image:'/api/assets/501',desc:'完整说明',sort:0},payload_hash:''};a.payload_hash=await common(r).ensurePayloadHash(a);return a;
}
scenario('actual four-field editor, nine columns and disabled or unknown statuses are read without normalization',async mount=>{
 const r=await mount({rows:[row(1,{status:0}),row(2,{status:-7})]});assert.equal(r.reads().length,1);assert.equal(css(r,'ensure-row').length,2);for(const label of ['ID','服务条款','图标','内容描述','使用商品','是否显示','排序','创建时间','操作'])assert.ok(text(r.tree).includes(label));await click(r,'编辑');assert.deepEqual(Object.keys(r.state.editor.draft),['name','image','desc','sort']);assert.equal(byLabel(r,'编辑保障条款').props.maxlength,undefined);const imageProps=byLabel(r,'保障图标原始地址').props;assert.ok(Object.hasOwn(imageProps,'readonly')&&imageProps.readonly!==false&&imageProps.readonly!=null);assert.equal(r.state.snapshot.list[1].status,-7);assert.equal(r.writes().length,0);
});
scenario('gallery uses canonical raw image while preview ticket never enters four-field payload',async mount=>{
 const r=await mount();await click(r,'添加保障服务');await update(r,'编辑保障条款','  新保障  ');await update(r,'编辑保障描述','  完整描述  ');await click(r,'选择图标');assert.equal(r.io.filter(c=>c.url===base+'/attachments/categories').length,1);assert.equal(r.io.filter(c=>c.url===base+'/attachments/options').length,1);await click(r,'选择此图',1);assert.equal(r.state.editor.draft.image,'/api/assets/502');assert.match(r.state.editor.imagePreview,/ticket/);await click(r,'保存');assert.equal(r.writes().length,0);await click(r,'确认提交');const a=r.writes()[0].body;assert.deepEqual(a.payload,{name:'  新保障  ',image:'/api/assets/502',desc:'  完整描述  ',sort:0});assert.ok(!JSON.stringify(a).includes('ticket'));assert.equal(a.payload_hash,await common(r).ensurePayloadHash(a));assert.equal(r.changes.length,1);assert.equal(r.server.rows.at(-1).name,'新保障');
});
scenario('multiline textarea keeps newline CR and tab in raw canonical command',async mount=>{
 const r=await mount();await click(r,'编辑');const desc='  第一行\n第二行\t说明\r\n第三行  ';await update(r,'编辑保障描述',desc);await click(r,'保存');await click(r,'确认提交');assert.equal(r.writes()[0].body.payload.desc,desc);assert.equal(r.server.rows[0].desc,desc.trim());assert.equal(common(r).ensureDescription(desc),desc.trim());
});
for(const image of ['http://legacy.example/icon.png','https://legacy.example/icon.png','javascript:old','/api/assets/999?ticket=old',''])scenario('unchanged historical image stays raw and unavailable preview does not prevent cosmetic save '+image,async mount=>{
 const r=await mount({rows:[row(1,{image,image_preview:'',name:'😀'.repeat(255),desc:'',sort:-2147483648,status:7})]});await click(r,'编辑');assert.equal(byLabel(r,'保障图标原始地址').props.value,image);await update(r,'编辑保障排序','3');await click(r,'保存');await click(r,'确认提交');assert.equal(r.writes()[0].body.payload.image,image);assert.equal(r.writes()[0].body.payload.desc,'');assert.equal(r.writes()[0].body.payload.name,'😀'.repeat(255));assert.equal(r.server.rows[0].status,7);
});
for(const name of ['','  ','😀'.repeat(101),'x\u0085y','x\ud800'])scenario('new invalid name blocks real confirmation '+JSON.stringify(name.slice(0,8)),async mount=>{
 const r=await mount();await click(r,'添加保障服务');await update(r,'编辑保障条款',name);await update(r,'编辑保障描述','说明');await click(r,'保存');assert.equal(r.state.confirmation,null);assert.ok(r.state.error);assert.equal(r.writes().length,0);
});
scenario('100 Unicode name remains full without UTF16 maxlength and raw whitespace is hashed',async mount=>{
 const r=await mount();await click(r,'编辑');const name=' '.repeat(10)+'🧭'.repeat(100)+' ';await update(r,'编辑保障条款',name);await click(r,'保存');await click(r,'确认提交');assert.equal(r.writes()[0].body.payload.name,name);assert.equal(r.server.rows[0].name,'🧭'.repeat(100));
});
for(const desc of ['','  ','x'.repeat(256),'坏\u0000值','坏\u0085值','坏\udc00值'])scenario('invalid changed description is explicit and never dispatches '+JSON.stringify(desc.slice(0,8)),async mount=>{
 const r=await mount();await click(r,'编辑');await update(r,'编辑保障描述',desc);await click(r,'保存');assert.equal(r.state.confirmation,null);assert.ok(r.state.error);assert.equal(r.writes().length,0);
});
for(const value of ['','-','-0','01','1e2','1.5','2147483648','-2147483649','-1'])scenario('new raw sort stays visible without normalizing or writing '+JSON.stringify(value),async mount=>{
 const r=await mount();await click(r,'添加保障服务');await update(r,'编辑保障条款','新条款');await update(r,'编辑保障描述','新说明');await click(r,'选择图标');await click(r,'选择此图');await update(r,'编辑保障排序',value);assert.equal(byLabel(r,'编辑保障排序').props.value,value);await click(r,'保存');assert.equal(r.state.confirmation,null);assert.ok(r.state.error);assert.equal(r.writes().length,0);
});
scenario('name and sort native nodes accept fast typing but old save and enter reject draft ABA',async mount=>{
 const r=await mount();await click(r,'编辑');const n=byLabel(r,'编辑保障条款'),s=byLabel(r,'编辑保障排序'),save=handler(r,'保存'),enter=s.props.onKeyup;replay(n.props.onInput,{target:{value:'A'}});replay(n.props.onInput,{target:{value:'AB'}});replay(s.props.onInput,{target:{value:'1'}});replay(s.props.onInput,{target:{value:'12'}});await tick();assert.equal(byLabel(r,'编辑保障条款'),n);assert.equal(byLabel(r,'编辑保障排序'),s);assert.equal(n.props.value,'AB');assert.equal(s.props.value,'12');await update(r,'编辑保障条款','保障1');await update(r,'编辑保障排序','0');replay(save);replay(enter,{key:'Enter'});await tick();assert.equal(r.state.confirmation,null);await click(r,'保存');assert.ok(r.state.confirmation);
});
scenario('name or ID search is literal case insensitive with original fifteen-row pagination',async mount=>{
 const r=await mount({rows:Array.from({length:31},(_,i)=>row(i+1,{name:i?'条款'+i:'VIP%_'}))});assert.equal(css(r,'ensure-row').length,15);await click(r,'下一页');assert.equal(css(r,'ensure-row').length,15);await click(r,'下一页');assert.equal(css(r,'ensure-row').length,1);await update(r,'保障搜索','vip%_');await click(r,'查询');assert.equal(css(r,'ensure-row').length,1);await update(r,'保障搜索','31');await click(r,'查询');assert.equal(css(r,'ensure-row').length,1);assert.match(text(r.tree),/条款30/);await click(r,'重置');assert.equal(css(r,'ensure-row').length,15);assert.equal(r.reads().length,1);
});
scenario('status is explicit confirmation with only status payload and unknown original is not repaired on mount',async mount=>{
 const r=await mount({rows:[row(1,{status:7})]});assert.equal(r.server.rows[0].status,7);await click(r,'显示');assert.equal(r.writes().length,0);assert.deepEqual(r.state.confirmation.payload,{status:1});await click(r,'确认提交');assert.equal(r.writes()[0].body.operation,'status');assert.deepEqual(r.writes()[0].body.payload,{status:1});assert.equal(r.server.rows[0].status,1);
});
scenario('physical delete is explicit, leaves no recycled row, and clamps last page',async mount=>{
 const r=await mount({rows:Array.from({length:16},(_,i)=>row(i+1))});await click(r,'下一页');await click(r,'删除');assert.match(text(r.tree),/永久删除保障记录/);assert.equal(r.writes().length,0);await click(r,'确认提交');assert.equal(r.writes()[0].body.operation,'delete');assert.deepEqual(r.writes()[0].body.payload,{});assert.equal(r.server.rows.length,15);assert.equal(r.state.filters.page,1);
});
scenario('occupied delete remains unknown until explicit original receipt or not-applied resolve',async mount=>{
 const r=await mount({send(c,next){return c.url===base+'/commit'?{httpStatus:409,status:409,msg:'任何商品仍引用该保障',data:null}:next();}});await click(r,'删除');await click(r,'确认提交');assert.equal(journal(r).length,1);assert.equal(r.state.error,'提交结果尚未确认。任何商品仍引用该保障');assert.equal(r.server.rows.length,2);await click(r,'读取原回执');assert.match(text(r.tree),/结果仍未知/);await click(r,'核对并封存原请求');assert.equal(journal(r).length,0);assert.equal(r.changes.length,0);
});
for(const serviceMessage of ['商品保障目录已变化，请先核对原回执','商品保障或关联商品正在变化，请先读取原回执'])scenario('real HTTP409 retains original Axios identity while showing service message '+serviceMessage,async mount=>{
 const r=await mount({send(c,next){return c.url===base+'/commit'?{httpStatus:409,status:409,msg:serviceMessage,data:null}:next();}}),errors=rejectedResponses(r);
 await prepare(r);await click(r,'确认提交');assert.equal(errors.length,1);const error=errors[0];assert.equal(axios.isAxiosError(error),true);assert.equal(error.message,'Request failed with status code 409');assert.equal(error.code,'ERR_BAD_REQUEST');assert.equal(error.response.status,409);assert.equal(error.response.data.msg,serviceMessage);
 assert.equal(r.state.error,'提交结果尚未确认。'+serviceMessage);assert.ok(text(r.tree).includes(serviceMessage));assert.equal(journal(r).length,1);assert.deepEqual(JSON.parse(journal(r)[0][1]),r.writes()[0].body);assert.equal(r.state.pending.operation_id,r.writes()[0].body.operation_id);assert.equal(buttons(r,'原样重试').length,0);assert.equal(r.changes.length,0);assert.equal(r.server.rows[0].name,'保障1');
});
scenario('real HTTP503 gallery error displays service message without rewriting Axios error or authored image',async mount=>{
 const serviceMessage='商品保障写入能力未就绪或操作超时',r=await mount({send(c,next){return c.url===base+'/attachments/categories'?{httpStatus:503,status:503,msg:serviceMessage,data:null}:next();}}),errors=rejectedResponses(r);
 await click(r,'编辑');const original=r.state.editor.draft.image;await click(r,'选择图标');assert.equal(errors.length,1);assert.equal(errors[0].message,'Request failed with status code 503');assert.equal(errors[0].code,'ERR_BAD_RESPONSE');assert.equal(errors[0].response.data.msg,serviceMessage);assert.equal(r.state.gallery.error,serviceMessage);assert.ok(text(r.tree).includes(serviceMessage));assert.equal(r.state.gallery.loading,false);assert.equal(r.state.gallery.list.length,0);assert.equal(r.io.filter(c=>c.url===base+'/attachments/options').length,0);assert.equal(r.state.editor.draft.image,original);assert.equal(r.writes().length,0);assert.equal(journal(r).length,0);
});
scenario('missing empty whitespace and nonstring HTTP message preserve the real Axios fallback and unknown journal',async mount=>{
 for(const invalid of [{},{msg:null},{msg:''},{msg:' \n\t '},{msg:7},{msg:['不能使用数组']},{msg:{detail:'不能使用对象'}}]){
  const r=await mount({send(c,next){return c.url===base+'/commit'?{httpStatus:409,status:409,...invalid,data:null}:next();}}),errors=rejectedResponses(r);
  await prepare(r);await click(r,'确认提交');assert.equal(errors.length,1);assert.equal(errors[0].message,'Request failed with status code 409');assert.equal(errors[0].code,'ERR_BAD_REQUEST');if(Object.hasOwn(invalid,'msg'))assert.deepEqual(errors[0].response.data.msg,invalid.msg);else assert.equal(Object.hasOwn(errors[0].response.data,'msg'),false);
  assert.equal(r.state.error,'提交结果尚未确认。Request failed with status code 409');assert.equal(journal(r).length,1);assert.deepEqual(JSON.parse(journal(r)[0][1]),r.writes()[0].body);assert.equal(r.changes.length,0);assert.equal(buttons(r,'原样重试').length,0);await r.finish();
 }
});
scenario('network failure keeps the exact original error and message with no response while preserving original command',async mount=>{
 const network=new axios.AxiosError('Network Error','ERR_NETWORK'),r=await mount({send(c,next){if(c.url===base+'/commit')throw network;return next();}}),errors=rejectedResponses(r);
 await prepare(r);await click(r,'确认提交');assert.equal(errors.length,1);assert.equal(errors[0],network);assert.equal(network.message,'Network Error');assert.equal(network.code,'ERR_NETWORK');assert.equal(network.response,undefined);assert.equal(r.state.error,'提交结果尚未确认。Network Error');assert.equal(journal(r).length,1);assert.deepEqual(JSON.parse(journal(r)[0][1]),r.writes()[0].body);assert.equal(r.changes.length,0);assert.equal(r.writes().length,1);
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
 const r=await mount({persist(k){if(k.startsWith('cinashop_ensure_pending'))throw Error('storage failed');}});await prepare(r);await click(r,'确认提交');assert.equal(r.writes().length,0);assert.ok(r.state.confirmation);assert.match(text(r.tree),/storage failed/);
});
scenario('multiple owner UUID journals restore sequentially and never clear another command',async mount=>{
 const r=await mount(),a=await action(r),b=await action(r,2,'delete','22222222-2222-4222-8222-222222222222');for(const v of [b,a])r.storage.set(`cinashop_ensure_pending_v1_7_${v.operation_id}`,JSON.stringify(v));r.sync();await tick();assert.equal(r.state.pending.operation_id,a.operation_id);await click(r,'核对并封存原请求');assert.equal(journal(r).length,1);assert.equal(r.state.pending.operation_id,b.operation_id);await click(r,'核对并封存原请求');assert.equal(journal(r).length,0);
});
scenario('withdrawn view and manage still permit live original owner receipt and resolve',async mount=>{
 const r=await mount({send(c,next){if(c.url===base+'/commit')throw Error('lost');return next();}});await prepare(r);await click(r,'确认提交');r.sync({userInfo:{id:7,level:1},uniqueAuth:[]});await tick();assert.equal(buttons(r,'添加保障服务').length,0);await click(r,'读取原回执');assert.equal(buttons(r,'原样重试').length,0);await click(r,'核对并封存原请求');assert.equal(journal(r).length,0);
});
for(const mode of ['route','actor','same-login','storage','role','active','unmount'])scenario('issued editor row status delete confirm and refresh retire through '+mode,async mount=>{
 const r=await mount(),edit=handler(r,'编辑'),remove=handler(r,'删除'),status=handler(r,'隐藏'),refresh=handler(r,'刷新');await click(r,'编辑');const input=byLabel(r,'编辑保障条款').props.onInput,save=handler(r,'保存');await click(r,'取消');await click(r,'删除');const confirm=handler(r,'确认提交');
 if(mode==='route'){r.route.fullPath='/product/ensures?x';r.route.fullPath='/product/ensures';}if(mode==='actor')r.sync({token:'B',userInfo:{id:8,level:0}});if(mode==='same-login')r.fireAction('login');if(mode==='storage')r.sync({},'storage');if(mode==='role'){r.actor.uniqueAuth=['product.view'];r.actor.uniqueAuth=[];}if(mode==='active'){r.props.active=false;await tick();r.props.active=true;}if(mode==='unmount')r.unmount();await tick();const count=r.io.length;for(const fn of [edit,remove,status,refresh,save,confirm])replay(fn);replay(input,{target:{value:'stale'}});await tick();assert.equal(r.io.length,count);assert.equal(r.state.editor,null);assert.equal(r.state.confirmation,null);assert.equal(r.writes().length,0);
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
 const r=await mount();await click(r,'编辑');await click(r,'选择图标');const oldChoose=handler(r,'选择此图'),oldImage=all(r.tree,n=>n.tag==='img'&&n.props.alt==='第一图标')[0],before=r.state.editor.draft.image;await update(r,'图库名称','x');await update(r,'图库名称','');await click(r,'查询图片');replay(oldChoose);replay(oldImage.props.onError);await tick();assert.equal(r.state.editor.draft.image,before);assert.ok(r.state.gallery);assert.ok(r.state.gallery.list[0].preview);const second=handler(r,'选择此图',1);await click(r,'关闭图库');await click(r,'选择图标');replay(second);await tick();assert.ok(r.state.gallery);await click(r,'选择此图',1);assert.equal(r.state.editor.draft.image,'/api/assets/502');
});
for(const mode of ['cancel','actor','route','active','unmount'])scenario('late gallery categories cannot initiate options or edit across '+mode,async mount=>{
 const wait=deferred();const r=await mount({send(c,next){return c.url===base+'/attachments/categories'?wait.promise.then(next):next();}});await click(r,'编辑');await click(r,'选择图标');const request=r.io.at(-1);if(mode==='cancel')await click(r,'关闭图库');if(mode==='actor')r.sync({token:'B',userInfo:{id:8,level:0}});if(mode==='route')r.route.fullPath='/product/ensures?new';if(mode==='active')r.props.active=false;if(mode==='unmount')r.unmount();await tick();assert.equal(request.signal.aborted,true);wait.resolve();await tick();assert.equal(r.io.filter(c=>c.url===base+'/attachments/options').length,0);assert.equal(r.state.gallery,null);
});
scenario('gallery previous request aborts on native query input and new results remain authoritative',async mount=>{
 let n=0;const wait=deferred(),r=await mount({send(c,next){if(c.url===base+'/attachments/options'&&++n===1)return wait.promise.then(next);return next();}});await click(r,'编辑');await click(r,'选择图标');const old=r.io.at(-1);await update(r,'图库名称','第二');assert.equal(old.signal.aborted,true);await click(r,'查询图片');assert.equal(r.state.gallery.list.length,1);wait.resolve();await tick();assert.equal(r.state.gallery.list[0].att_id,502);assert.equal(r.state.gallery.loading,false);await click(r,'选择此图');assert.equal(r.state.editor.draft.image,'/api/assets/502');
});
scenario('gallery 81-character input stays visible and causes explicit error without more I/O',async mount=>{
 const r=await mount();await click(r,'编辑');await click(r,'选择图标');await update(r,'图库名称','😀'.repeat(81));const count=r.io.length;await click(r,'查询图片');assert.equal(r.io.length,count);assert.equal(byLabel(r,'图库名称').props.value,'😀'.repeat(81));assert.match(text(r.tree),/80个字符/);
});
scenario('editor current image error hides only its preview; old error cannot clear newly picked source',async mount=>{
 const r=await mount();await click(r,'编辑');const image=all(r.tree,n=>n.tag==='img'&&n.props.alt==='保障图标预览')[0],old=image.props.onError;await click(r,'选择图标');await click(r,'选择此图',1);replay(old);await tick();const current=all(r.tree,n=>n.tag==='img'&&n.props.alt==='保障图标预览')[0];assert.match(current.props.src,/502/);replay(current.props.onError);await tick();assert.equal(all(r.tree,n=>n.tag==='img'&&n.props.alt==='保障图标预览').length,0);assert.equal(r.state.editor.draft.image,'/api/assets/502');
});
for(const bad of ['count','duplicate','foreign','extra','row-extra','name','sort','preview','can-create'])scenario('whole catalog fails closed without dropping its malformed tail '+bad,async mount=>{
 const r=await mount({send(c,next){const out=next();if(c.url===base+'/catalog'){const x=out.data;if(bad==='count')x.count++;if(bad==='duplicate')x.list[1]={...x.list[0]};if(bad==='foreign')x.list[1].relation_id=7;if(bad==='extra')x.extra=true;if(bad==='row-extra')x.list[1].is_del=0;if(bad==='name')x.list[1].name='😀'.repeat(256);if(bad==='sort')x.list[1].sort=2147483648;if(bad==='preview')x.list[1].image_preview='javascript:x';if(bad==='can-create')x.can_create=1;}return out;}});assert.equal(r.state.snapshot,null);assert.ok(r.state.error);assert.equal(r.writes().length,0);
});
for(const bad of ['pid','count','duplicate','reference','ticket','preview','extra'])scenario('gallery rejects malformed complete options '+bad,async mount=>{
 const r=await mount({send(c,next){const out=next();if(c.url===base+'/attachments/options'){const x=out.data;if(bad==='pid')x.list[1].pid=9;if(bad==='count')x.count++;if(bad==='duplicate')x.list[1]={...x.list[0]};if(bad==='reference')x.list[1].reference='/api/assets/999';if(bad==='ticket')x.list[1].reference+='?ticket=not-stable';if(bad==='preview')x.list[1].preview='javascript:x';if(bad==='extra')x.list[1].scope='admin';}return out;}});await click(r,'编辑');await click(r,'选择图标');assert.ok(r.state.gallery.error);assert.equal(r.state.gallery.list.length,0);assert.equal(r.writes().length,0);
});
scenario('capacity disables create only; view-only cannot author or read gallery',async mount=>{
 const full=await mount({canCreate:false});assert.equal(buttons(full,'添加保障服务')[0].props.disabled,true);replay(handler(full,'添加保障服务'));await tick();assert.equal(full.state.editor,null);await click(full,'编辑');await update(full,'编辑保障排序','5');await click(full,'保存');await click(full,'确认提交');assert.equal(full.writes().length,1);const viewer=await mount({actor:{userInfo:{id:7,level:1},uniqueAuth:['product.view']}});assert.equal(buttons(viewer,'添加保障服务').length,0);assert.equal(buttons(viewer,'编辑').length,0);assert.equal(viewer.io.length,1);
});
scenario('actual parent has independent lazy unit and assurance readers and no dead legacy assurance read',async mount=>{
 const r=await mount({page:'pages/product/ProductMetadata.vue'});assert.deepEqual(r.io.map(c=>c.url),['/product/unit/author/catalog']);assert.equal(css(r,'ensure-author').length,0);await click(r,'保障服务');assert.equal(r.reads().length,1);assert.equal(css(r,'ensure-row').length,2);await click(r,'编辑');const old=byLabel(r,'编辑保障条款').props.onInput,save=handler(r,'保存');await click(r,'商品单位');await click(r,'保障服务');const count=r.io.length;replay(old,{target:{value:'retired'}});replay(save);await tick();assert.equal(r.io.length,count);assert.equal(r.state.editor,null);assert.equal(r.io.filter(c=>c.url==='/ensure').length,0);await click(r,'编辑');assert.equal(r.state.editor.draft.name,'保障1');
});
