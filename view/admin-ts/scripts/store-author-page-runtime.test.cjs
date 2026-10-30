const {test}=require('node:test'),assert=require('node:assert/strict'),axios=require('axios'),path=require('node:path');
const {runtime,tick,deferred,row,catalog,all,text,css,byLabel,buttons,replay,click,update,envelope,failure}=require('./helpers/store-author-runtime.cjs');
const base='/merchant/store/author',journals=r=>[...r.storage].filter(([key])=>key.startsWith('cinashop_store_pending_v1_'));
const scenario=(name,fn)=>test(name,async()=>{const mounted=[];try{await fn(async options=>{const r=runtime(options);mounted.push(r);await tick();return r;});}finally{for(const r of mounted)await r.finish();}});
const handler=(r,label)=>{const node=buttons(r,label)[0];assert.ok(node,'actual button '+label);return node.props.onClick;};
const input=(r,label)=>{const node=byLabel(r,label);assert.ok(node,'actual field '+label);return node.tag==='select'?node.props.onChange:node.props.onInput;};
const frame=r=>all(r.tree,n=>n.tag==='iframe')[0];
const location=(lat=31.234,lng=121.456)=>({module:'locationPicker',latlng:{lat,lng},poiname:'不能自动写入的名称',poiaddress:'不能自动覆盖的详细地址'});
const edit=async r=>{await click(r,'编辑提货点');await update(r,'门店名称','修改门店');};
const prepare=async r=>{await edit(r);await click(r,'核对提货点保存');assert.ok(r.state.confirmation);};
const openMap=async r=>{await click(r,'编辑提货点');await click(r,'查找位置');assert.ok(frame(r));};

scenario('actual12-value editor uses real adapter/bearer, one image slot and explicit two-stage commit',async mount=>{
 const r=await mount();assert.equal(css(r,'store-row').length,2);assert.equal(r.io[0].headers['Authori-zation'],'Bearer actor-A');
 await click(r,'编辑提货点');for(const label of ['门店名称','门店简介','联系电话','详细地址','纬度','经度','有效距离（米）','营业状态','允许自提','营业开始时间','营业结束时间'])assert.ok(byLabel(r,label));
 assert.equal(buttons(r,'选择门店图片').length,1);assert.equal(r.io.filter(c=>c.url.endsWith('/map-config')).length,0);
 await update(r,'门店名称','真实编辑');await click(r,'选择门店图片');assert.equal(css(r,'store-image-option').length,20);replay(css(r,'store-image-option')[0].props.onClick);await tick();
 await click(r,'核对提货点保存');assert.equal(r.writes().length,0);await click(r,'确认提货点提交');
 const a=r.writes()[0].body;assert.equal(Object.keys(a.payload).length,12);assert.equal(a.payload.image,'/api/assets/1');assert.equal(a.payload.day_time,'08:00 - 20:00');assert.ok(!JSON.stringify(a).includes('signature'));assert.equal(journals(r).length,0);assert.equal(r.changed,1);
});
scenario('read-only role can list but cannot author; unrelated role performs no requests; inactive tab does no I/O',async mount=>{
 const r=await mount({actor:{userInfo:{id:7,level:1},uniqueAuth:['store.view']}});assert.equal(css(r,'store-row').length,2);assert.equal(buttons(r,'新增提货点').length,0);assert.equal(buttons(r,'编辑提货点').length,0);
 const no=await mount({actor:{userInfo:{id:7,level:1},uniqueAuth:['attachment.manage']}});assert.equal(no.io.length,0);
 const hidden=await mount({active:false});assert.equal(hidden.io.length,0);assert.equal(all(hidden.tree,n=>n.tag==='main').length,0);hidden.props.active=true;await tick();assert.equal(hidden.reads().length,1);
});
scenario('missing write capability and a full5000 catalogue explicitly disable creation without disabling existing editing',async mount=>{
 const missing=await mount({writeReady:false});assert.equal(buttons(missing,'新增提货点')[0].props.disabled,true);assert.match(text(missing.tree),/尚未安装/);
 const full=await mount({rows:Array.from({length:5000},(_,i)=>row(i+1))});const old=handler(full,'新增提货点');assert.equal(buttons(full,'新增提货点')[0].props.disabled,true);replay(old);await tick();assert.equal(full.state.editor,null);await click(full,'编辑提货点');assert.ok(full.state.editor);
});
scenario('rapid typing retains the actual input host while draft ABA invalidates captured submit',async mount=>{
 const r=await mount();await click(r,'编辑提货点');const node=byLabel(r,'门店名称'),set=input(r,'门店名称'),submit=handler(r,'核对提货点保存');
 for(const value of ['A','AB','ABC'])replay(set,{target:{value}});await tick();assert.equal(byLabel(r,'门店名称'),node);assert.equal(node.props.value,'ABC');await update(r,'门店名称','提货点1');replay(submit);await tick();assert.equal(r.state.confirmation,null);await click(r,'核对提货点保存');assert.ok(r.state.confirmation);
});
for(const transition of ['cancel','refresh','route','login','actor','active','unmount'])scenario('captured editor/set/save are inert after '+transition,async mount=>{
 const r=await mount();await edit(r);const set=input(r,'门店名称'),save=handler(r,'核对提货点保存');
 if(transition==='cancel'){await click(r,'取消编辑提货点');await click(r,'编辑提货点');}
 if(transition==='refresh')await click(r,'重新读取提货点');if(transition==='route'){r.route.fullPath='/operations/store?next=1';await tick();}
 if(transition==='login'){r.fireAction('login');await tick();}if(transition==='actor'){r.sync({token:'actor-B',userInfo:{id:8,level:0}});await tick();}
 if(transition==='active'){r.props.active=false;await tick();r.props.active=true;await tick();}if(transition==='unmount')r.unmount();
 replay(set,{target:{value:'旧控件'}});replay(save);await tick();assert.equal(r.state.confirmation,null);assert.equal(r.writes().length,0);if(r.state.editor)assert.notEqual(r.state.editor.draft.name,'旧控件');
});
scenario('full-catalog filters/paging include recycle and invalidate captured row/filter refresh after ABA',async mount=>{
 const r=await mount({rows:Array.from({length:25},(_,i)=>row(i+1,{is_show:i%2,is_del:i===24?1:0}))});
 const editOld=handler(r,'编辑提货点'),refresh=handler(r,'重新读取提货点');await click(r,'下一页提货点');assert.equal(css(r,'store-row').length,4);await update(r,'提货点范围','-1');assert.equal(css(r,'store-row').length,12);
 await update(r,'提货点范围','2');assert.equal(css(r,'store-row').length,1);await update(r,'提货点范围','');replay(editOld);const reads=r.reads().length;replay(refresh);await tick();assert.equal(r.state.editor,null);assert.equal(r.reads().length,reads);
 await update(r,'提货点关键词','提货点2');assert.equal(css(r,'store-row').length,6);await click(r,'重置查询');assert.equal(css(r,'store-row').length,20);
});
scenario('unchanged historical raw address/time/coordinates/image/flags are never normalized on mount or cosmetic save',async mount=>{
 const history=row(1,{address:'旧区域无匹配',day_time:'奇怪旧时段',latitude:'1e-3',longitude:' 1.00',image:'javascript:old',image_preview:'',is_show:7,is_store:3,valid_range:-9});
 const r=await mount({rows:[history]});await edit(r);assert.equal(byLabel(r,'营业开始时间').props.value,'');assert.equal(byLabel(r,'营业状态').props.value,7);await click(r,'核对提货点保存');await click(r,'确认提货点提交');
 const p=r.writes()[0].body.payload;for(const k of ['address','day_time','latitude','longitude','image','is_show','is_store','valid_range'])assert.equal(p[k],history[k]);
});
scenario('time controls explicitly canonicalize seconds without Date/TZ and reject an incomplete new time',async mount=>{
 const r=await mount();await click(r,'编辑提货点');const node=byLabel(r,'营业开始时间');await update(r,'营业开始时间','10:02');assert.equal(r.state.editor.draft.day_time,'10:02:00 - 20:00:00');assert.equal(byLabel(r,'营业开始时间'),node);
 await update(r,'营业结束时间','23:59:58');assert.equal(r.state.editor.draft.day_time,'10:02:00 - 23:59:58');await update(r,'营业开始时间','');await click(r,'核对提货点保存');assert.equal(r.state.confirmation,null);assert.match(text(r.tree),/完整填写/);assert.equal(r.writes().length,0);
});
scenario('new entity requires explicit complete controls, including a selected leaf and stable image',async mount=>{
 const r=await mount();await click(r,'新增提货点');await click(r,'核对提货点保存');assert.equal(r.state.confirmation,null);
 for(const [label,value]of [['门店名称','新门店'],['联系电话','13900139000'],['详细地址','新街2号'],['纬度','0'],['经度','0']])await update(r,label,value);
 await click(r,'选择省市区');await update(r,'选择省级','20');await click(r,'确认区域');await click(r,'选择门店图片');replay(css(r,'store-image-option')[0].props.onClick);await tick();await click(r,'核对提货点保存');await click(r,'确认提货点提交');
 assert.equal(r.writes()[0].body.operation,'create');assert.equal(r.writes()[0].body.payload.address,'香港');assert.equal(r.writes()[0].body.payload.latitude,'0');assert.equal(r.changed,1);
});
scenario('region selection reads the full flat directory and confirms only a real complete name path',async mount=>{
 const r=await mount();await click(r,'编辑提货点');const original=r.state.editor.draft.address;await click(r,'选择省市区');assert.equal(r.state.editor.draft.address,original);assert.equal(buttons(r,'确认区域')[0].props.disabled,true);
 await update(r,'选择省级','1');const oldCity=input(r,'选择市级');await update(r,'选择市级','2');await update(r,'选择区级','3');assert.equal(r.state.editor.draft.address,original);
 const confirm=handler(r,'确认区域');await update(r,'选择省级','20');await update(r,'选择省级','1');replay(oldCity,{target:{value:'2'}});replay(confirm);await tick();assert.ok(r.state.region);assert.deepEqual(r.state.region.path,[1]);
 await update(r,'选择市级','2');await update(r,'选择区级','3');await click(r,'确认区域');assert.equal(r.state.editor.draft.address,'甲省,乙市,丙区');
});
for(const pathIds of [[20],[21,22]])scenario('natural shallow region leaf remains selectable '+pathIds.join('/'),async mount=>{
 const r=await mount();await click(r,'编辑提货点');await click(r,'选择省市区');await update(r,'选择省级',String(pathIds[0]));if(pathIds[1])await update(r,'选择市级',String(pathIds[1]));await click(r,'确认区域');assert.equal(r.state.editor.draft.address,pathIds.length===1?'香港':'浅省,浅市');
});
for(const bad of ['count','orphan','duplicate','ambiguous','extra'])scenario('bad complete region DTO fails closed: '+bad,async mount=>{
 const r=await mount({send(call,next){const answer=next();if(call.url!==base+'/regions')return answer;if(bad==='count')answer.data.count++;if(bad==='orphan')answer.data.list[1].pid=999;if(bad==='duplicate'){answer.data.list.push({...answer.data.list[0]});answer.data.count++;}if(bad==='ambiguous'){answer.data.list.push({id:99,pid:0,level:1,name:'甲省'});answer.data.count++;}if(bad==='extra')answer.data.extra='ignored?';return answer;}});
 await click(r,'编辑提货点');await click(r,'选择省市区');assert.ok(r.state.region.error);assert.equal(buttons(r,'确认区域')[0].props.disabled,true);assert.equal(r.state.editor.draft.address,'甲省,乙市,丙区');
});
scenario('late region result after cancel/reopen cannot replace new options or write the original editor',async mount=>{
 const wait=deferred();let first=true;const r=await mount({send(call,next){if(call.url===base+'/regions'&&first){first=false;return wait.promise.then(next);}return next();}});await click(r,'编辑提货点');await click(r,'选择省市区');const c=r.io.at(-1);await click(r,'取消区域选择');await click(r,'选择省市区');await update(r,'选择省级','20');wait.resolve();await tick();assert.equal(c.signal.aborted,true);assert.deepEqual(r.state.region.path,[20]);
});
scenario('image picker has exact pagination/query and stores no returned preview metadata in author action',async mount=>{
 const r=await mount();await click(r,'编辑提货点');await click(r,'选择门店图片');await click(r,'下一页门店图片');assert.equal(css(r,'store-image-option').length,4);assert.deepEqual(r.io.at(-1).params,{page:2,limit:20,pid:0,name:''});replay(css(r,'store-image-option')[0].props.onClick);await tick();await click(r,'核对提货点保存');await click(r,'确认提货点提交');assert.equal(r.writes()[0].body.payload.image,'/api/assets/21');assert.ok(!JSON.stringify(r.writes()[0].body).includes('preview'));
});
scenario('old image choice and old native preview error cannot clear or select a new editor image',async mount=>{
 const r=await mount();await click(r,'编辑提货点');const oldError=css(r,'editor-image')[0].props.onError;await click(r,'选择门店图片');const choose=css(r,'store-image-option')[0].props.onClick;await click(r,'返回提货点编辑');await click(r,'选择门店图片');replay(choose);await tick();assert.ok(r.state.picker);replay(css(r,'store-image-option')[1].props.onClick);await tick();replay(oldError);await tick();assert.equal(r.state.editor.preview,'/static/preview-2.png');assert.equal(r.state.editor.draft.image,'/api/assets/2');replay(css(r,'editor-image')[0].props.onError);await tick();assert.equal(r.state.editor.preview,'');assert.equal(r.state.editor.draft.image,'/api/assets/2');
});
scenario('changing an unsent image query aborts old I/O and invalidates original item callback',async mount=>{
 const wait=deferred();let delay=false;const r=await mount({send(call,next){return call.url===base+'/attachment-options'&&delay?wait.promise.then(next):next();}});await click(r,'编辑提货点');await click(r,'选择门店图片');const choose=css(r,'store-image-option')[0].props.onClick;delay=true;await click(r,'查询门店图片');const pending=r.io.at(-1);await update(r,'门店图片名称','图片2');wait.resolve();await tick();replay(choose);assert.equal(pending.signal.aborted,true);assert.equal(r.state.editor.draft.image,'/static/store.png');assert.equal(css(r,'store-image-option').length,0);
});
for(const mode of ['mismatch','duplicate','unsafe','ticket','foreign-pid','short'])scenario('strict image DTO rejects '+mode,async mount=>{
 const r=await mount({send(call,next){if(call.url!==base+'/attachment-options')return next();const item={att_id:1,pid:mode==='foreign-pid'?2:0,real_name:'one',reference:mode==='ticket'?'/api/assets/1?signature=bad':'/api/assets/1',preview:mode==='unsafe'?'javascript:bad':'/static/a.png'};return envelope({list:mode==='duplicate'?[item,item]:[item],count:mode==='duplicate'?2:mode==='short'?30:1,page:mode==='mismatch'?2:1,limit:20});}});
 await click(r,'编辑提货点');await click(r,'选择门店图片');assert.ok(r.state.picker.error);assert.equal(css(r,'store-image-option').length,0);
});
scenario('map config is fetched only on explicit open; source/origin/module/types all gate a separate confirmation',async mount=>{
 const r=await mount();assert.equal(r.io.filter(c=>c.url===base+'/map-config').length,0);await openMap(r);assert.equal(r.messageListeners,1);const f=frame(r),before={...r.state.editor.draft};
 for(const [data,opts]of [[location(),{origin:'https://evil.example'}],[location(),{source:{}}],[{...location(),module:'other'},{}],[location('31.2',121.4),{}],[location(NaN,121.4),{}],[location(91,121.4),{}],[location(31.2,181),{}],['{"module":"locationPicker"}',{}]])r.message(data,opts);
 await tick();assert.equal(r.state.map.candidate,null);assert.deepEqual(r.state.editor.draft,before);
 r.message(location(),{frame:f});await tick();assert.deepEqual(r.state.map.candidate,{lat:31.234,lng:121.456});assert.deepEqual(r.state.editor.draft,before);await click(r,'确认地图位置');assert.equal(r.state.editor.draft.latitude,'31.234');assert.equal(r.state.editor.draft.longitude,'121.456');assert.equal(r.state.editor.draft.address,before.address);assert.equal(r.state.editor.draft.detailed_address,before.detailed_address);assert.equal(r.messageListeners,0);
});
scenario('map close/reopen destroys the old iframe window and confirmation ABA cannot approve a later candidate',async mount=>{
 const r=await mount();await openMap(r);const oldFrame=frame(r);r.message(location());await tick();const confirm=handler(r,'确认地图位置');await click(r,'关闭地图');assert.equal(r.messageListeners,0);await click(r,'查找位置');assert.notEqual(frame(r).contentWindow,oldFrame.contentWindow);r.message(location(),{frame:oldFrame});replay(confirm);await tick();assert.equal(r.state.map.candidate,null);
 r.message(location(1,2));await tick();const first=handler(r,'确认地图位置');r.message(location(3,4));r.message(location(1,2));await tick();replay(first);await tick();assert.ok(r.state.map);await click(r,'确认地图位置');assert.equal(r.state.editor.draft.latitude,'1');
});
scenario('tiny finite map coordinates become decimal text accepted by the12-place author contract',async mount=>{
 const r=await mount();await openMap(r);r.message(location(0.0000001,-0.0000002));await tick();await click(r,'确认地图位置');assert.equal(r.state.editor.draft.latitude,'0.0000001');assert.equal(r.state.editor.draft.longitude,'-0.0000002');
});
for(const transition of ['active','route','actor','unmount'])scenario('old map source cannot affect context after '+transition,async mount=>{
 const r=await mount();await openMap(r);const old=frame(r);if(transition==='active'){r.props.active=false;await tick();r.props.active=true;}if(transition==='route')r.route.fullPath='/operations/store?changed=1';if(transition==='actor')r.sync({token:'actor-B',userInfo:{id:8,level:0}});if(transition==='unmount')r.unmount();await tick();r.message(location(),{frame:old});await tick();assert.equal(r.state.map,null);assert.equal(r.messageListeners,0);assert.equal(r.writes().length,0);
});
scenario('manual editor callbacks captured before map open cannot write through the modal guard',async mount=>{
 const r=await mount();await click(r,'编辑提货点');const set=input(r,'纬度'),submit=handler(r,'核对提货点保存');await click(r,'查找位置');replay(set,{target:{value:'89'}});replay(submit);await tick();assert.equal(r.state.editor.draft.latitude,'31.20');assert.equal(r.state.confirmation,null);await click(r,'关闭地图');await update(r,'纬度','30');assert.equal(r.state.editor.draft.latitude,'30');
});
for(const config of [{available:false,url:'',origin:'https://apis.map.qq.com'},{available:true,url:'https://evil.example/tools/locpicker',origin:'https://apis.map.qq.com'},{available:true,url:'https://apis.map.qq.com/tools/locpicker?type=1&key=k&referer=myapp&backurl=https://evil.example',origin:'https://apis.map.qq.com'}])scenario('unavailable or unsafe map config never creates an iframe '+config.url,async mount=>{
 const r=await mount({mapConfig:config});await click(r,'编辑提货点');await click(r,'查找位置');assert.equal(frame(r),undefined);assert.ok(r.state.map.error);await click(r,'关闭地图');await update(r,'纬度','30.1');assert.equal(r.state.editor.draft.latitude,'30.1');
});
scenario('late map config from a prior open is aborted and cannot replace the new iframe',async mount=>{
 const wait=deferred();let first=true;const r=await mount({send(call,next){if(call.url===base+'/map-config'&&first){first=false;return wait.promise.then(next);}return next();}});await click(r,'编辑提货点');await click(r,'查找位置');const c=r.io.at(-1);await click(r,'关闭地图');await click(r,'查找位置');const current=frame(r);wait.resolve();await tick();assert.equal(c.signal.aborted,true);assert.equal(frame(r),current);assert.equal(r.messageListeners,1);
});
scenario('confirmation cancel/new editor retires old submit; double confirm uses one durable UUID',async mount=>{
 const wait=deferred();const r=await mount({send(call,next){return call.url===base+'/commit'?wait.promise.then(next):next();}});await prepare(r);const old=handler(r,'确认提货点提交');await click(r,'取消提货点操作');await prepare(r);replay(old);await tick();assert.equal(r.writes().length,0);const current=handler(r,'确认提货点提交');replay(current);replay(current);await tick();assert.equal(r.writes().length,1);assert.equal(journals(r).length,1);wait.resolve();await tick();assert.equal(journals(r).length,0);
});
scenario('committed response loss retains original action; strict receipt clears it and emits changed once',async mount=>{
 let lose=true;const r=await mount({send(call,next){const result=next();if(call.url===base+'/commit'&&lose){lose=false;throw new axios.AxiosError('lost','ERR_NETWORK');}return result;}});await prepare(r);await click(r,'确认提货点提交');assert.equal(r.changed,0);assert.equal(journals(r).length,1);assert.deepEqual(JSON.parse(journals(r)[0][1]),r.writes()[0].body);await click(r,'读取原回执');assert.equal(r.changed,1);assert.equal(r.writes().length,1);assert.equal(journals(r).length,0);
});
scenario('business404 stays unknown; explicit retry repeats the full original UUID/payload',async mount=>{
 let attempts=0;const r=await mount({send(call,next){if(call.url===base+'/commit'&&attempts++===0)throw new axios.AxiosError('not delivered','ERR_NETWORK');return next();}});await prepare(r);await click(r,'确认提货点提交');await click(r,'读取原回执');assert.equal(journals(r).length,1);await click(r,'原样重试');assert.deepEqual(r.writes()[0].body,r.writes()[1].body);assert.equal(journals(r).length,0);assert.equal(r.changed,1);
});
scenario('hidden tab preserves journal; view-revoked original owner can restore and seal without a new commit',async mount=>{
 const r=await mount({send(call,next){if(call.url===base+'/commit')throw new axios.AxiosError('not delivered','ERR_NETWORK');return next();}});await prepare(r);await click(r,'确认提货点提交');const a=r.state.pending;r.props.active=false;await tick();assert.equal(journals(r).length,1);assert.equal(r.state.pending,null);r.props.active=true;await tick();assert.deepEqual(r.state.pending,a);r.sync({userInfo:{id:7,level:1},uniqueAuth:[]});await tick();await click(r,'读取原回执');assert.equal(buttons(r,'原样重试').length,0);await click(r,'核对并封存原请求');assert.equal(journals(r).length,0);assert.equal(r.changed,0);assert.equal(r.writes().length,1);
});
scenario('storage refusal dispatches nothing; partial persistence restores the original command instead of forging a new one',async mount=>{
 const no=await mount({persist(key,value){if(key.startsWith('cinashop_store_pending')&&value)throw Error('storage denied');}});await prepare(no);await click(no,'确认提货点提交');assert.equal(no.writes().length,0);assert.equal(no.state.busy,false);assert.match(text(no.tree),/storage denied/);
 const r=await mount();const set=r.storage.set.bind(r.storage);r.storage.set=(key,value)=>{set(key,value);if(key.startsWith('cinashop_store_pending'))throw Error('storage verify failed');return r.storage;};await prepare(r);await click(r,'确认提货点提交');assert.equal(r.writes().length,0);assert.ok(r.state.pending);await click(r,'核对并封存原请求');assert.equal(r.state.pending,null);
});
for(const bad of [{id:999},{created:1},{updated:0}])scenario('contradictory committed receipt keeps journal '+JSON.stringify(bad),async mount=>{
 const r=await mount({send(call,next){const answer=next();if(call.url===base+'/commit')answer.data.result={...answer.data.result,...bad};return answer;}});await prepare(r);await click(r,'确认提货点提交');assert.ok(r.state.pending);assert.equal(journals(r).length,1);assert.equal(r.changed,0);assert.match(text(r.tree),/矛盾/);
});
scenario('two same-owner journals recover one by one without erasing a different UUID',async mount=>{
 const seed=runtime({active:false});try{const common=seed.load(path.resolve(__dirname,'../../common/storeAuthor.ts'));const make=async()=>{const a={operation_id:crypto.randomUUID(),actor_id:7,operation:'show',target_id:1,revision:'a'.repeat(64),payload:{is_show:0},payload_hash:''};a.payload_hash=await common.storePayloadHash(a);return a;};const actions=[await make(),await make()];
 const r=await mount({storage:actions.map(a=>['cinashop_store_pending_v1_7_'+a.operation_id,JSON.stringify(a)]),send(call,next){if(!call.url.startsWith(base+'/receipt/'))return next();const a=actions.find(a=>a.operation_id===call.url.split('/').at(-1));return envelope({operation_id:a.operation_id,actor_id:a.actor_id,operation:a.operation,target_id:a.target_id,revision:a.revision,payload_hash:a.payload_hash,state:'committed',result:{id:1,created:0,updated:1,count:3,revision:'b'.repeat(64)}});}});await click(r,'读取原回执');assert.equal(journals(r).length,1);assert.ok(r.state.pending);assert.equal(r.state.notice,'');await click(r,'读取原回执');assert.equal(journals(r).length,0);assert.equal(r.changed,2);assert.equal(r.writes().length,0);
 }finally{await seed.finish();}
});
scenario('visibility, recycle and restore disclose linked staff behavior and all require explicit confirmation',async mount=>{
 const r=await mount({rows:[row()]});await click(r,'设为停业');assert.match(text(r.tree),/关联的有效店员/);assert.equal(r.writes().length,0);await click(r,'确认提货点提交');assert.equal(r.writes()[0].body.operation,'show');await click(r,'回收提货点');assert.match(text(r.tree),/待处理订单/);await click(r,'确认提货点提交');assert.equal(r.writes()[1].body.operation,'delete');await update(r,'提货点范围','2');await click(r,'恢复提货点');assert.match(text(r.tree),/恢复关联回收店员/);await click(r,'确认提货点提交');assert.equal(r.writes()[2].body.operation,'restore');
});
scenario('retired read response/finally never clears newer owner loading or data',async mount=>{
 const old=deferred(),fresh=deferred();let n=0;const r=await mount({send(call,next){if(call.url!==base+'/catalog')return next();return (++n===1?old:fresh).promise.then(next);}});assert.equal(r.state.loading,true);const first=r.reads()[0];r.sync({token:'actor-B',userInfo:{id:8,level:0}});await tick();assert.equal(first.signal.aborted,true);old.resolve();await tick();assert.equal(r.state.loading,true);assert.equal(r.state.snapshot,null);fresh.resolve();await tick();assert.equal(r.state.loading,false);assert.equal(r.state.snapshot.count,3);
});
scenario('malformed complete source cannot enable author and performs no support/extra business requests',async mount=>{
 const r=await mount({send(call,next){return call.url===base+'/catalog'?envelope(catalog([row(),row()])):next();}});assert.equal(r.state.snapshot,null);assert.match(text(r.tree),/重复/);assert.equal(buttons(r,'新增提货点')[0].props.disabled,true);assert.equal(r.io.length,1);assert.equal(journals(r).length,0);
});
