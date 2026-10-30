const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const {runtime,tick,deferred}=require('./uni-store-runtime.cjs');
const hash='a'.repeat(64),vhash='b'.repeat(64);
const field=(info,format,param='',extra={})=>({info,format,param,label:info,tip:'请填写'+info,single:'',singlearr:format==='radio'?['男','女','保密']:[],required:0,use:1,user_show:1,sort:1,value:'',...extra});
function profile(extra={}){return{actor_uid:11,revision:hash,version:vhash,profile:{uid:11,account:'owner',nickname:'原昵称',avatar:'/static/logo.png',avatar_preview:'/static/logo.png',phone:'13800138000',extend_info:[{info:'隐藏资料',value:'秘密'}],register_extend_info:[field('姓名','text','real_name',{value:'原姓名'}),field('数值','num','',{value:'12.5'}),field('邮箱','mail'),field('生日','date','birthday',{value:'1990-07-01'}),field('身份证','id','card_id'),field('手机','phone'),field('性别','radio','sex',{value:'1'}),field('地址','address','address',{value:'原地址'})]},...extra};}
const signed=(id=101,expires=Math.floor(Date.now()/1000)+900)=>'/api/assets/'+id+'?expires='+expires+'&signature='+'a'.repeat(43);
async function start(options={}){
 const traces=[],uploads=[],r=runtime({feature:'useCustomerProfile',platform:options.platform??'H5',component:options.component,authenticated:options.authenticated??true,
 send:c=>{const t={url:c.url,method:c.method,data:structuredClone(c.data),auth:c.header['Authori-zation']};traces.push(t);const base=['MP-WEIXIN','APP-PLUS'].includes(options.platform)?'https://cinashop-api.cinagroup.workers.dev':'';assert.ok([base+'/api/user/info',base+'/api/user/edit'].includes(c.url));assert.deepEqual(c.method==='GET'?c.data.profile:1,1);const result=options.send?.(c);if(result!==undefined)return result;return{data:c.method==='GET'?(options.data??profile()):null};}});
 r.uni.chooseImage=c=>c.success({tempFilePaths:['/local/avatar.png'],tempFiles:[{path:'/local/avatar.png',size:100}]});
 r.uni.getImageInfo=c=>c.success({path:c.src,width:100,height:100});
 r.uni.getFileInfo=c=>c.success({size:100});
 r.uni.uploadFile=c=>{uploads.push(c);const custom=options.upload?.(c);if(custom!==undefined)return custom;queueMicrotask(()=>c.success({statusCode:200,data:JSON.stringify({status:200,data:{url:'/api/assets/101',src:signed()}})}));return{abort(){}};};
 options.configure?.(r);await r.start();return{...r,traces,uploads};
}
const change=(s,name,value)=>s.setField(name,{detail:{value}}),nickname=(s,value)=>s.setNickname({detail:{value}});
test('actual Vue/Pinia profile loads all8 formats and saves exact full visible values with stable media, followed by a real read',async()=>{
 let data=profile();const r=await start({send:c=>{if(c.method==='POST'){assert.deepEqual(Object.keys(c.data).sort(),['avatar','extend_info','nickname','profile','revision','version']);assert.equal(c.data.nickname,'新昵称');assert.equal(c.data.avatar,'/static/logo.png');assert.equal(c.data.extend_info.length,8);assert.deepEqual(c.data.extend_info.find(v=>v.info==='性别'),{info:'性别',value:'0'});assert.ok(!JSON.stringify(c.data).includes('秘密'));data=profile({version:'c'.repeat(64)});data.profile.nickname=c.data.nickname;return{data:null};}return{data};}}),s=r.checkout;
 assert.equal(s.snapshot.value.actor_uid,11);assert.equal(s.fields.value.length,8);assert.equal(s.avatar.value,'/static/logo.png');nickname(s,' 新昵称 ');change(s,'性别',0);await s.save();assert.equal(s.snapshot.value.version,'c'.repeat(64));assert.equal(s.draft.value.nickname,'新昵称');assert.match(s.notice.value,/已保存并重新读取/);assert.deepEqual(r.traces.map(t=>t.method),['GET','POST','GET']);assert.deepEqual(r.modals,[]);r.stop();
});
test('choosing and uploading uses actual native transport tuple but never writes user profile until Save',async()=>{
 const r=await start(),s=r.checkout;await s.chooseAvatar();assert.equal(r.uploads.length,1);const u=r.uploads[0];assert.equal(u.url,'/api/upload/image');assert.equal(u.name,'file');assert.equal(u.filePath,'/local/avatar.png');assert.deepEqual(u.formData,{pid:'0'});assert.equal(u.header['Authori-zation'],'Bearer synthetic-local-token');assert.equal(u.header['Form-type'],'h5');assert.equal(s.draft.value.avatar,'/api/assets/101');assert.equal(s.avatar.value,signed());assert.deepEqual(r.traces.map(t=>t.method),['GET']);assert.match(s.notice.value,/保存修改后生效/);r.stop();
});
for(const fault of ['transport','malformed','foreign-preview','bare-preview','extra-query','oversize'])test('uncertain upload '+fault+' keeps old draft, prevents save and offers explicit original-avatar recovery',async()=>{
 const r=await start({upload:c=>{queueMicrotask(()=>{if(fault==='transport')return c.fail({errMsg:'response lost'});const src=fault==='foreign-preview'?signed(102):fault==='bare-preview'?'/api/assets/101':fault==='extra-query'?signed()+'&x=1':signed();c.success({statusCode:200,data:fault==='malformed'?'broken':fault==='oversize'?'x'.repeat(16385):JSON.stringify({status:200,data:{url:'/api/assets/101',src}})});});return{abort(){}};}}),s=r.checkout;nickname(s,'保留草稿');await s.chooseAvatar();assert.equal(s.uploadReview.value,true);assert.equal(s.editable.value,false);assert.equal(s.draft.value.avatar,'/static/logo.png');assert.equal(s.draft.value.nickname,'保留草稿');await s.save();assert.equal(r.traces.length,1);s.keepAvatar();assert.equal(s.uploadReview.value,false);assert.equal(s.editable.value,true);assert.equal(s.draft.value.nickname,'保留草稿');assert.deepEqual(r.modals,[]);r.stop();
});
test('cancelled or oversized file selection never uploads and remains editable',async()=>{for(const mode of ['cancel','large','empty']){const r=await start({configure:r=>{r.uni.chooseImage=c=>mode==='cancel'?c.fail({errMsg:'chooseImage:fail cancel'}):c.success({tempFilePaths:['x'],tempFiles:[{size:mode==='large'?10485761:0}]});}});await r.checkout.chooseAvatar();assert.equal(r.uploads.length,0);assert.equal(r.checkout.editable.value,true);assert.equal(r.checkout.uploadReview.value,false);r.stop();}});
for(const event of ['onHide','onUnload','logout','owner','renew'])test('late upload is discarded after '+event+' without old-owner profile writes',async()=>{
 let callback;const r=await start({upload:c=>{callback=c;return{abort(){}};}}),s=r.checkout,pending=s.chooseAvatar();await tick();assert.equal(s.busy.value,'upload');if(event==='logout')r.auth.clear();else if(event==='owner')r.auth.setLogin('other',22);else if(event==='renew')r.auth.setLogin(r.auth.token,11);else r.hooks[event]();callback.success({statusCode:200,data:JSON.stringify({status:200,data:{url:'/api/assets/101',src:signed()}})});await pending;await tick();assert.notEqual(s.draft.value.avatar,'/api/assets/101');assert.equal(r.traces.filter(t=>t.method==='POST').length,0);assert.deepEqual(r.modals,[]);r.stop();
});
test('transport-lost Save retains draft and blocks duplicate write until explicit real read; original can be restored',async()=>{
 let writes=0;const r=await start({send:c=>c.method==='POST'?(writes++,{transport:'lost response'}):undefined}),s=r.checkout;nickname(s,'待核对');change(s,'地址','待核对地址');await s.save();assert.equal(s.needsReview.value,true);assert.equal(s.editable.value,false);assert.equal(s.draft.value.nickname,'待核对');await s.save();r.hooks.onHide();r.hooks.onShow();await tick();assert.equal(writes,1);assert.equal(s.needsReview.value,true);assert.equal(s.backup.value,null); // Page leave erases private draft.
 await s.load();assert.equal(s.needsReview.value,false);nickname(s,'新草稿');await s.save();assert.equal(writes,2);await s.load();assert.equal(s.backup.value.draft.nickname,'新草稿');assert.equal(s.draft.value.nickname,'原昵称');s.restore();assert.equal(s.draft.value.nickname,'新草稿');assert.equal(s.backup.value,null);assert.deepEqual(r.modals,[]);r.stop();
});
for(const status of [400,403,404,409,422])test('known business '+status+' preserves draft; only conflict requires reread',async()=>{const r=await start({send:c=>c.method==='POST'?{status,msg:'服务端校验',data:null}:undefined}),s=r.checkout;nickname(s,'草稿');await s.save();assert.equal(s.draft.value.nickname,'草稿');assert.equal(s.needsReview.value,status===409);assert.equal(s.editable.value,status!==409);assert.equal(s.error.value,'服务端校验');assert.equal(r.traces.length,2);r.stop();});
test('a confirmed Save with failed follow-up read is locked until explicit read, with no automatic replay',async()=>{let count=0;const r=await start({send:c=>c.method==='GET'&&++count>1?{transport:'read unavailable'}:undefined}),s=r.checkout;nickname(s,'已提交');await s.save();assert.equal(s.needsReview.value,true);assert.equal(s.draft.value.nickname,'已提交');await s.save();assert.equal(r.traces.filter(t=>t.method==='POST').length,1);r.stop();});
for(const event of ['onHide','logout','owner','renew'])test('late save completion cannot overwrite active identity or chain old read after '+event,async()=>{const d=deferred(),r=await start({send:c=>c.method==='POST'?d.promise:undefined}),s=r.checkout;nickname(s,'旧会话');const pending=s.save();await tick();if(event==='logout')r.auth.clear();else if(event==='owner')r.auth.setLogin('other',22);else if(event==='renew')r.auth.setLogin(r.auth.token,11);else r.hooks.onHide();d.resolve({data:null});await pending;await tick();assert.notEqual(s.draft.value.nickname,'旧会话');assert.equal(r.traces.filter(t=>t.method==='GET'&&t.auth==='Bearer synthetic-local-token').length,event==='renew'?2:1);assert.deepEqual(r.modals,[]);r.stop();});
test('cross-window persisted account replacement fences handlers immediately and focus adopts it without overwriting storage',async()=>{
 const listeners=new Map(),old=global.window;global.window={navigator:{userAgent:'Browser'},addEventListener:(key,fn)=>listeners.set(key,fn),removeEventListener:key=>listeners.delete(key)};let r;
 try{r=await start({send:c=>{const value=profile();if(c.header['Authori-zation']==='Bearer other'){value.actor_uid=value.profile.uid=22;value.profile.nickname='账户22';}return{data:value};}});const s=r.checkout;nickname(s,'旧草稿');r.storage.set('uni_token','other');r.storage.set('uni_uid',22);nickname(s,'越权草稿');await s.save();assert.equal(r.traces.filter(t=>t.method==='POST').length,0);listeners.get('focus')();await tick();assert.equal(r.auth.uid,22);assert.equal(s.draft.value.nickname,'账户22');assert.equal(r.storage.get('uni_token'),'other');assert.equal(r.storage.get('uni_uid'),22);assert.equal(s.backup.value,null);r.hooks.onHide();assert.equal(listeners.size,0);}finally{r?.stop();global.window=old;}
});
test('guest entry has no requests or modal; login, phone and password navigate only on explicit visible action',async()=>{const guest=await start({authenticated:false});await guest.checkout.load();await guest.checkout.save();guest.checkout.login();guest.hooks.onHide();guest.checkout.login();assert.deepEqual(guest.navigations,['/pages/auth/login']);assert.deepEqual(guest.traces,[]);guest.stop();const r=await start();r.checkout.phone();r.checkout.password();r.hooks.onHide();r.checkout.phone();assert.deepEqual(r.navigations,['/pages/user/phone','/pages/user/changePassword']);r.stop();});
test('template change retains a readable draft backup but cannot restore stale field definitions',async()=>{let data=profile();const r=await start({send:()=>({data})}),s=r.checkout;nickname(s,'旧草稿');data=profile({revision:'c'.repeat(64)});data.profile.register_extend_info.pop();await s.load();assert.equal(s.backup.value.draft.nickname,'旧草稿');assert.equal(s.canRestore.value,false);s.restore();assert.equal(s.draft.value.nickname,'原昵称');s.discardBackup();assert.equal(s.backup.value,null);r.stop();});
test('signed avatar renewal reads only and preserves dirty values; concurrent version drift forces explicit review',async()=>{
 const native=global.setTimeout,timers=[];global.setTimeout=(fn,ms,...args)=>ms>12000?(timers.push({fn,ms}),{ticket:true}):native(fn,ms,...args);let r,data=profile();data.profile.avatar='/api/assets/101';data.profile.avatar_preview=signed();
 try{r=await start({send:()=>({data})});const s=r.checkout;assert.equal(timers.length,1);nickname(s,'草稿');timers[0].fn();await tick();assert.equal(s.draft.value.nickname,'草稿');assert.equal(s.needsReview.value,false);data=profile({version:'c'.repeat(64)});data.profile.avatar='/api/assets/101';data.profile.avatar_preview=signed();timers.at(-1).fn();await tick();assert.equal(s.needsReview.value,true);assert.equal(s.draft.value.nickname,'草稿');assert.equal(r.traces.filter(t=>t.method==='POST').length,0);assert.match(s.error.value,/发生变化/);}finally{r?.stop();global.setTimeout=native;}
});
test('expired/malformed ticket never renders bare canonical URL, and failed image remains local neutral placeholder',async()=>{const data=profile();data.profile.avatar='/api/assets/101';data.profile.avatar_preview=signed(101,1);const r=await start({data});assert.equal(r.checkout.avatar.value,'');assert.equal(r.traces.length,1);const api=r.load(path.resolve(__dirname,'../src/api/customerProfile.ts'));for(const bad of [signed(102),signed()+'&x=1',signed()+'#x','https://evil.invalid'+signed(),'/api/assets/101',signed()+'&expires=1'])assert.equal(api.profileAvatarPreview('/api/assets/101',bad),'');r.stop();const stable=await start();stable.checkout.avatarView.value.error();assert.equal(stable.checkout.avatar.value,'');assert.equal(stable.traces.length,1);stable.stop();});
for(const variant of ['owner','hash','duplicate','hidden','format','param','options','missing-value'])test('strict actual read adapter rejects '+variant,async()=>{const data=profile();if(variant==='owner')data.actor_uid=22;if(variant==='hash')data.version='x';if(variant==='duplicate')data.profile.register_extend_info.push(data.profile.register_extend_info[0]);if(variant==='hidden')data.profile.register_extend_info[0].user_show=0;if(variant==='format')data.profile.register_extend_info[0].format='evil';if(variant==='param')data.profile.register_extend_info[0].param='uid';if(variant==='options')data.profile.register_extend_info[6].singlearr=['a','a'];if(variant==='missing-value')delete data.profile.register_extend_info[0].value;const r=await start({data});assert.equal(r.checkout.snapshot.value,null);assert.match(r.checkout.error.value,/不完整/);r.stop();});
test('invalid nickname/required field/radio/date/number is rejected before network, and Unicode16 is codepoint based',async()=>{const r=await start(),s=r.checkout;for(const value of ['','x'.repeat(17)]){nickname(s,value);await s.save();}nickname(s,'有效');for(const [key,value]of [['性别','99'],['生日','2026-02-31'],['数值','0'],['数值','Infinity']]){const before=s.draft.value.fields[key];change(s,key,value);await s.save();change(s,key,before);}assert.equal(r.traces.length,1);const api=r.load(path.resolve(__dirname,'../src/api/customerProfile.ts'));const draft=api.profileDraft(profile());draft.nickname='𠮷'.repeat(16);assert.equal(api.encodeProfileSave(profile(),draft).nickname.length,32);r.stop();});
test('actual page setup and template compile, using PHP list fields and existing links, with platform password guard',async()=>{
 const r=await start({component:'pages/user/profile.vue'});assert.equal(r.checkout.s.fields.length,8);r.stop();const {parse,compileTemplate}=require('@vue/compiler-sfc'),file=path.resolve(__dirname,'../src/pages/user/profile.vue'),source=fs.readFileSync(file,'utf8'),descriptor=parse(source).descriptor;assert.deepEqual(compileTemplate({source:descriptor.template.content,filename:file,id:'profile'}).errors,[]);for(const token of ['保存修改','s.chooseAvatar','s.setNickname','s.setField','field.format===\'radio\'','field.format===\'date\'','96rpx','24rpx'])assert.ok(source.includes(token),token);assert.doesNotMatch(source,/showModal|now_money|brokerage_price|as any/);
 const original=global.window;try{global.window={navigator:{userAgent:'MicroMessenger'},addEventListener(){},removeEventListener(){}};const wechat=await start();assert.equal(wechat.checkout.passwordAvailable,false);wechat.stop();global.window.navigator.userAgent='Chrome';const h5=await start();assert.equal(h5.checkout.passwordAvailable,true);h5.stop();const mp=await start({platform:'MP-WEIXIN'});assert.equal(mp.checkout.passwordAvailable,false);mp.stop();const app=await start({platform:'APP-PLUS'});assert.equal(app.checkout.passwordAvailable,true);app.stop();}finally{global.window=original;}
});

test('an old image error cannot hide a newly uploaded source or a fresh signed ticket',async()=>{
 const r=await start(),s=r.checkout,old=s.avatarView.value.error;await s.chooseAvatar();const src=s.avatar.value;old();assert.equal(s.avatar.value,src);s.avatarView.value.error();assert.equal(s.avatar.value,'');r.stop();
});
test('unchanged historical long and noncanonical numeric fields may be preserved while truly changed values keep their bounds',async()=>{
 const data=profile();data.profile.register_extend_info[0].value='x'.repeat(2000);data.profile.register_extend_info[1].value='0012.50';const r=await start({data}),api=r.load(path.resolve(__dirname,'../src/api/customerProfile.ts')),draft=api.profileDraft(data);draft.nickname='只改昵称';assert.equal(api.encodeProfileSave(data,draft).extend_info[0].value.length,2000);draft.fields['姓名']='y'.repeat(1025);assert.throws(()=>api.encodeProfileSave(data,draft),/1024/);r.stop();
});
test('real request deadline locks an unknown save result and late success cannot chain an unrequested read',async()=>{
 const native=global.setTimeout,timers=[];global.setTimeout=(fn,ms,...args)=>ms===12000?(timers.push(fn),{deadline:true}):native(fn,ms,...args);let r;const d=deferred();try{r=await start({send:c=>c.method==='POST'?d.promise:undefined});nickname(r.checkout,'超时草稿');const pending=r.checkout.save();await tick();timers.at(-1)();await pending;assert.equal(r.checkout.needsReview.value,true);assert.equal(r.checkout.draft.value.nickname,'超时草稿');d.resolve({data:null});await tick();assert.equal(r.traces.length,2);assert.deepEqual(r.modals,[]);}finally{r?.stop();global.setTimeout=native;}
});

test('historical whitespace and long nicknames are preserved exactly while changed names are trimmed and limited to16',async()=>{
 for(const name of [' 旧昵称 ','旧'.repeat(20)]){const data=profile();data.profile.nickname=name;const r=await start({data}),api=r.load(path.resolve(__dirname,'../src/api/customerProfile.ts')),draft=api.profileDraft(data);assert.equal(api.encodeProfileSave(data,draft).nickname,name);draft.fields['数值']='0012.50';assert.equal(api.encodeProfileSave(data,draft).extend_info.find(v=>v.info==='数值').value,'0012.50');draft.nickname=' 新昵称 ';assert.equal(api.encodeProfileSave(data,draft).nickname,'新昵称');draft.nickname='新'.repeat(17);assert.throws(()=>api.encodeProfileSave(data,draft),/16/);r.stop();}
});

// Exercise actual preparation and the composable together; only native I/O is
// replaced, so owner fences, draft adoption and the existing uploader all run.
function imageIo(r,{bytes=2097153,width=1600,height=1200,output='/local/prepared.jpg',outputBytes=140000}={}){
 const calls={choose:[],info:[],canvas:[],export:[],file:[]};
 r.uni.chooseImage=c=>{calls.choose.push(c);c.success({tempFilePaths:['/local/large.png'],tempFiles:[{size:bytes}]});};
 r.uni.getImageInfo=c=>{calls.info.push(c);c.success({path:'/local/decoded.png',width,height});};
 r.uni.createCanvasContext=id=>({clearRect(...args){calls.canvas.push(['clear',id,...args]);},drawImage(...args){calls.canvas.push(['draw',...args]);},draw(reserve,done){calls.canvas.push(['flush',reserve]);done();}});
 r.uni.canvasToTempFilePath=c=>{calls.export.push(c);c.success({tempFilePath:output});};
 r.uni.getFileInfo=c=>{calls.file.push(c);c.success({size:outputBytes});};
 return calls;
}
for(const bytes of [2097151,2097152,2097153])test('PHP ordinary avatar threshold uses actual chooser bytes '+bytes+' and waits for explicit Save',async()=>{
 let io;const r=await start({configure:r=>{io=imageIo(r,{bytes});}}),s=r.checkout;await s.chooseAvatar();
 assert.equal(r.uploads.length,1);assert.equal(r.uploads[0].filePath,bytes<=2097152?'/local/decoded.png':'/local/prepared.jpg');
 assert.equal(io.info.length,1);assert.equal(io.export.length,bytes<=2097152?0:1);assert.deepEqual(io.choose[0].sizeType,['compressed']);
 assert.deepEqual(r.traces.map(t=>t.method),['GET']);assert.equal(s.draft.value.avatar,'/api/assets/101');assert.equal(s.avatarCanvas.value.width,1);r.stop();
});
for(const [width,height,w,h]of [[1600,1200,750,562.5],[600,1200,600,1200],[3000,1000,750,250]])test('large ordinary avatar retains aspect ratio and only caps width '+width+'x'+height,async()=>{
 let io;const r=await start({configure:r=>{io=imageIo(r,{width,height});}});await r.checkout.chooseAvatar();
 assert.deepEqual(io.canvas,[['clear','customer-profile-avatar-canvas',0,0,w,h],['draw','/local/decoded.png',0,0,w,h],['flush',false]]);
 const e=io.export[0];assert.deepEqual([e.x,e.y,e.width,e.height,e.destWidth,e.destHeight,e.fileType,e.quality],[0,0,w,h,w,h,'jpg',0.7]);
 assert.equal(io.file[0].filePath,'/local/prepared.jpg');assert.equal(r.uploads.length,1);r.stop();
});
test('canvas export starts only after the real draw completion and accepts the H5 JPEG data URL',async()=>{
 let drawDone,io;const data='data:image/jpeg;base64,'+'a'.repeat(20000);const r=await start({configure:r=>{
  io=imageIo(r,{output:data});r.uni.createCanvasContext=()=>({clearRect(){},drawImage(){},draw(reserve,done){drawDone=done;}});
 }}),pending=r.checkout.chooseAvatar();await tick();assert.equal(r.checkout.busy.value,'prepare');assert.equal(io.export.length,0);assert.equal(r.uploads.length,0);
 r.checkout.cancelAvatarChoice();assert.equal(r.checkout.busy.value,'prepare');drawDone();await pending;assert.equal(io.export.length,1);assert.equal(r.uploads[0].filePath,data);assert.equal(r.checkout.uploadReview.value,false);r.stop();
});
for(const fault of ['info','dimensions','canvas','export','output-size','file-info'])test('avatar preparation failure '+fault+' never uploads or adopts a draft',async()=>{
 const r=await start({configure:r=>{
  imageIo(r);if(fault==='info')r.uni.getImageInfo=c=>c.fail({});
  if(fault==='dimensions')r.uni.getImageInfo=c=>c.success({path:'x',width:0,height:1200});
  if(fault==='canvas')r.uni.createCanvasContext=()=>{throw Error('canvas unavailable');};
  if(fault==='export')r.uni.canvasToTempFilePath=c=>c.fail({});
  if(fault==='output-size')r.uni.getFileInfo=c=>c.success({size:10485761});
  if(fault==='file-info')r.uni.getFileInfo=c=>c.fail({});
 }});nickname(r.checkout,'保留昵称');await r.checkout.chooseAvatar();assert.equal(r.uploads.length,0);assert.equal(r.checkout.draft.value.avatar,'/static/logo.png');assert.equal(r.checkout.draft.value.nickname,'保留昵称');assert.equal(r.checkout.uploadReview.value,false);assert.equal(r.checkout.editable.value,true);assert.ok(r.checkout.error.value);r.stop();
});
for(const stage of ['choose','info','draw','export','file'])for(const event of ['onHide','onUnload','owner','renew'])test('late '+stage+' preparation callback after '+event+' cannot export, upload or overwrite a fresh owner',async()=>{
 let callback,io;const r=await start({configure:r=>{
  io=imageIo(r);if(stage==='choose')r.uni.chooseImage=c=>{callback=()=>c.success({tempFilePaths:['/local/large.png'],tempFiles:[{size:2097153}]});};
  if(stage==='info')r.uni.getImageInfo=c=>{callback=()=>c.success({path:'old-owner',width:1600,height:1200});};
  if(stage==='draw')r.uni.createCanvasContext=()=>({clearRect(){},drawImage(){},draw(reserve,done){callback=done;}});
  if(stage==='export')r.uni.canvasToTempFilePath=c=>{callback=()=>c.success({tempFilePath:'old-owner'});};
  if(stage==='file')r.uni.getFileInfo=c=>{callback=()=>c.success({size:100});};
 }}),s=r.checkout,pending=s.chooseAvatar();await tick();assert.equal(typeof callback,'function');const exported=io.export.length;
 if(event==='owner')r.auth.setLogin('other-owner',22);else if(event==='renew')r.auth.setLogin(r.auth.token,11);else r.hooks[event]();
 await pending;callback();await tick();assert.equal(r.uploads.length,0);assert.equal(io.export.length,exported);assert.notEqual(s.draft.value.avatar,'/api/assets/101');assert.deepEqual(s.avatarCanvas.value,{width:1,height:1});assert.equal(r.traces.filter(t=>t.method==='POST').length,0);r.stop();
});
test('an expired preparation callback is ignored after the 60 second deadline without entering unknown-upload state',async()=>{
 const native=global.setTimeout,timers=[];global.setTimeout=(fn,ms,...args)=>ms===60000?(timers.push(fn),{preparationDeadline:true}):native(fn,ms,...args);let r,callback;
 try{r=await start({configure:r=>{imageIo(r);r.uni.getImageInfo=c=>{callback=c;};}});const pending=r.checkout.chooseAvatar();await tick();timers.at(-1)();await pending;
  assert.match(r.checkout.error.value,/超时/);assert.equal(r.checkout.uploadReview.value,false);assert.equal(r.checkout.editable.value,true);callback.success({path:'late',width:1600,height:1200});await tick();assert.equal(r.uploads.length,0);
 }finally{r?.stop();global.setTimeout=native;}
});
test('MP chooseAvatar capability and event use native temporary avatar directly, once, without canvas or automatic profile write',async()=>{
 let io;const r=await start({platform:'MP-WEIXIN',configure:r=>{io=imageIo(r);r.uni.canIUse=schema=>{assert.equal(schema,'button.open-type.chooseAvatar');return true;};}}),s=r.checkout;
 assert.equal(s.nativeAvatarAvailable.value,true);assert.equal(s.busy.value,''); // cancellation/no event changes no state
 const choose=s.nativeAvatarButton.value.choose;const pending=choose({detail:{avatarUrl:'wxfile://tmp/avatar.png'}});await choose({detail:{avatarUrl:'duplicate'}});await pending;
 assert.equal(io.choose.length,0);assert.equal(io.info.length,0);assert.equal(io.canvas.length,0);assert.equal(r.uploads.length,1);assert.equal(r.uploads[0].filePath,'wxfile://tmp/avatar.png');assert.equal(r.uploads[0].header['Form-type'],'routine');assert.deepEqual(r.traces.map(t=>t.method),['GET']);
 await choose({detail:{avatarUrl:'late-duplicate'}});assert.equal(r.uploads.length,1);assert.notEqual(s.nativeAvatarButton.value.choose,choose);r.stop();
});
for(const event of ['onHide','onUnload','owner','renew','reload'])test('old native chooser handler after '+event+' cannot read or upload a temporary image',async()=>{
 let io;const r=await start({platform:'MP-WEIXIN',configure:r=>{io=imageIo(r);r.uni.canIUse=()=>true;}}),s=r.checkout,choose=s.nativeAvatarButton.value.choose;
 if(event==='owner')r.auth.setLogin('other-owner',22);else if(event==='renew')r.auth.setLogin(r.auth.token,11);else if(event==='reload')await s.load();else r.hooks[event]();
 await choose({detail:{avatarUrl:'wxfile://tmp/old-owner'}});assert.equal(io.file.length,0);assert.equal(r.uploads.length,0);r.stop();
});
for(const event of [undefined,{}, {detail:{}},{detail:{avatarUrl:''}},{detail:{avatarUrl:123}}])test('malformed MP avatar event never falls back to another chooser or uploads '+JSON.stringify(event),async()=>{
 let io;const r=await start({platform:'MP-WEIXIN',configure:r=>{io=imageIo(r);r.uni.canIUse=()=>true;}});await r.checkout.nativeAvatarButton.value.choose(event);
 assert.equal(io.choose.length,0);assert.equal(io.file.length,0);assert.equal(r.uploads.length,0);assert.equal(r.checkout.editable.value,true);assert.equal(r.checkout.uploadReview.value,false);r.stop();
});
test('native avatar file metadata failure/oversize keeps the old avatar, and unsupported MP uses the ordinary chooser',async()=>{
 for(const result of ['fail','large']){const r=await start({platform:'MP-WEIXIN',configure:r=>{imageIo(r);r.uni.canIUse=()=>true;r.uni.getFileInfo=c=>result==='fail'?c.fail({}):c.success({size:10485761});}});
  await r.checkout.nativeAvatarButton.value.choose({detail:{avatarUrl:'wxfile://tmp/avatar'}});assert.equal(r.uploads.length,0);assert.equal(r.checkout.draft.value.avatar,'/static/logo.png');assert.equal(r.checkout.editable.value,true);r.stop();}
 for(const platform of ['H5','APP-PLUS','MP-WEIXIN']){let io;const r=await start({platform,configure:r=>{io=imageIo(r);r.uni.canIUse=()=>platform!=='MP-WEIXIN';}});assert.equal(r.checkout.nativeAvatarAvailable.value,false);await r.checkout.chooseAvatar();assert.equal(io.choose.length,1);assert.equal(r.uploads.length,1);r.stop();}
});
test('real page platform preprocessing retains only the MP native button and preserves the offscreen sized canvas',()=>{
 const {parse,compileTemplate}=require('@vue/compiler-sfc'),file=path.resolve(__dirname,'../src/pages/user/profile.vue'),source=fs.readFileSync(file,'utf8');
 for(const platform of ['H5','APP-PLUS','MP-WEIXIN']){let keep=true;const selected=source.split('\n').filter(line=>{if(line.includes('<!-- #ifdef MP-WEIXIN -->')){keep=platform==='MP-WEIXIN';return false;}if(line.includes('<!-- #endif -->')){keep=true;return false;}return keep;}).join('\n');
  assert.equal(selected.includes('open-type="chooseAvatar"'),platform==='MP-WEIXIN');assert.equal(selected.includes('@chooseavatar="s.nativeAvatarButton.choose"'),platform==='MP-WEIXIN');assert.deepEqual(compileTemplate({source:parse(selected).descriptor.template.content,filename:file,id:'avatar-'+platform}).errors,[]);assert.ok(selected.includes(':canvas-id="s.avatarCanvasId"'));assert.match(selected,/avatar-canvas\{position:fixed;left:-100000px/);
 }
});

test('user image selection remains pending after61 seconds and can then complete normally',async()=>{
 const originalSet=global.setTimeout,originalClear=global.clearTimeout,originalNow=Date.now,timers=[];let now=originalNow(),r,selected;
 global.setTimeout=(fn,ms,...args)=>{if(ms!==60000)return originalSet(fn,ms,...args);const timer={fn,at:now+ms,cancelled:false};timers.push(timer);return timer;};
 global.clearTimeout=handle=>{const timer=timers.find(t=>t===handle);if(timer)timer.cancelled=true;else originalClear(handle);};Date.now=()=>now;
 try{
  r=await start({configure:r=>{r.uni.chooseImage=c=>{selected=c;};}});const s=r.checkout,pending=s.chooseAvatar();await tick();const started=now;now+=61001;
  for(const timer of [...timers])if(!timer.cancelled&&timer.at<=now)timer.fn();await tick();
  assert.ok(now-started>60000);assert.equal(s.busy.value,'choose');assert.equal(s.error.value,'');assert.equal(s.uploadReview.value,false);assert.equal(r.uploads.length,0);
  selected.success({tempFilePaths:['/local/slow-choice.png'],tempFiles:[{size:100}]});await pending;
  assert.equal(r.uploads.length,1);assert.equal(r.uploads[0].filePath,'/local/slow-choice.png');assert.equal(s.draft.value.avatar,'/api/assets/101');assert.equal(s.busy.value,'');assert.deepEqual(r.traces.map(t=>t.method),['GET']);
 }finally{r?.stop();global.setTimeout=originalSet;global.clearTimeout=originalClear;Date.now=originalNow;}
});
test('explicit chooser cancellation preserves the draft and ignores a late native selection without upload',async()=>{
 let selected;const r=await start({configure:r=>{r.uni.chooseImage=c=>{selected=c;};}}),s=r.checkout;nickname(s,'取消时保留的昵称');const before={nickname:s.draft.value.nickname,avatar:s.draft.value.avatar,fields:{...s.draft.value.fields}};
 const pending=s.chooseAvatar();await tick();assert.equal(s.busy.value,'choose');s.cancelAvatarChoice();await pending;
 assert.equal(s.busy.value,'');assert.equal(s.editable.value,true);assert.equal(s.uploadReview.value,false);assert.equal(s.needsReview.value,false);assert.deepEqual(s.draft.value,before);assert.match(s.notice.value,/已取消/);
 selected.success({tempFilePaths:['/local/late.png'],tempFiles:[{size:100}]});await tick();assert.equal(r.uploads.length,0);assert.deepEqual(s.draft.value,before);assert.deepEqual(r.traces.map(t=>t.method),['GET']);
 const source=fs.readFileSync(path.resolve(__dirname,'../src/pages/user/profile.vue'),'utf8');assert.match(source,/<button v-if="s\.busy==='choose'"[^>]*@tap="s\.cancelAvatarChoice"/);r.stop();
});
test('a new selection works after explicit cancellation while the old callback and finally cannot clear it',async()=>{
 const choices=[];const r=await start({configure:r=>{r.uni.chooseImage=c=>{choices.push(c);};}}),s=r.checkout;nickname(s,'继续选择的草稿');const first=s.chooseAvatar();await tick();s.cancelAvatarChoice();
 const second=s.chooseAvatar();await tick();await first;assert.equal(choices.length,2);assert.equal(s.busy.value,'choose');
 choices[0].success({tempFilePaths:['/local/stale.png'],tempFiles:[{size:100}]});choices[0].fail({errMsg:'chooseImage:fail cancel'});await tick();assert.equal(s.busy.value,'choose');assert.equal(r.uploads.length,0);
 choices[1].success({tempFilePaths:['/local/current.png'],tempFiles:[{size:100}]});await second;
 assert.equal(r.uploads.length,1);assert.equal(r.uploads[0].filePath,'/local/current.png');assert.equal(s.draft.value.avatar,'/api/assets/101');assert.equal(s.draft.value.nickname,'继续选择的草稿');assert.equal(s.busy.value,'');assert.equal(s.uploadReview.value,false);assert.equal(s.editable.value,true);assert.deepEqual(r.traces.map(t=>t.method),['GET']);r.stop();
});
