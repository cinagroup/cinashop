const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const vue=require('vue'),{runtime,tick,deferred}=require('./uni-store-runtime.cjs');
function setup(options={}){
 const props=vue.reactive({template:'/template.png',avatar:'/avatar.png',nickname:'本人海报',siteName:'原版商城',code:'data:image/png;base64,iVBORw0KGgo=',active:true,ownerUid:11,ownerVersion:1,selected:true,canvasId:'owned-poster',...options.props});
 const events=[],draws=[],texts=[],exports=[],previews=[],saves=[],operations=[];
 const r=runtime({component:'components/SpreadPoster.vue',props,platform:options.platform||'H5',emit:(name,value)=>events.push({name,value})});
 r.uni.getImageInfo=o=>o.success({path:o.src});
 r.uni.createCanvasContext=()=>({setFillStyle:v=>operations.push(['fill',v]),fillRect:(...v)=>operations.push(['rect',...v]),setFontSize:v=>operations.push(['font',v]),fillText:(...v)=>texts.push(v),drawImage:(...v)=>draws.push(v),save:()=>operations.push(['save']),restore:()=>operations.push(['restore']),beginPath:()=>operations.push(['begin']),arc:(...v)=>operations.push(['arc',...v]),clip:()=>operations.push(['clip']),draw(_flag,done){done?.();}});
 r.uni.canvasToTempFilePath=o=>{exports.push(o);if(!options.holdExport)o.success({tempFilePath:'data:image/png;base64,generated-'+exports.length});};
 r.uni.previewImage=o=>previews.push(o);r.uni.saveImageToPhotosAlbum=o=>saves.push(o);
 return{r,p:props,c:r.checkout,events,draws,texts,exports,previews,saves,operations};
}
test('PHP whole-template composition preserves QR/identity/footer geometry and round-avatar clip',async()=>{
 const s=setup();try{await s.c.draw();assert.equal(s.c.ready.value,true);assert.deepEqual(s.draws[0],['/template.png',0,0,305,473]);assert.deepEqual(s.draws[1],[s.p.code,219,386,70,70]);assert.deepEqual(s.draws[2],['/avatar.png',16,396,24,24]);assert.deepEqual(s.texts[0],['本人海报',45,414]);assert.deepEqual(s.texts[1],['邀请您加入原版商城',16,440]);assert.ok(s.operations.some(v=>v[0]==='arc'&&v[1]===28&&v[2]===408&&v[3]===12));assert.equal(s.exports[0].canvasId,'owned-poster');assert.equal(s.exports[0].destWidth,610);assert.equal(s.exports[0].destHeight,946);assert.equal(s.events.at(-1).value,s.c.poster.value);}finally{s.r.stop();}
});
test('empty real avatar draws no substitute identity',async()=>{const s=setup({props:{avatar:''}});try{await s.c.draw();assert.equal(s.draws.length,2);assert.equal(s.c.ready.value,true);}finally{s.r.stop();}});
test('completed raster is previewed/saved directly, no second canvas export or unrequested provider',async()=>{
 const previous=global.window;global.window={};const s=setup();try{await s.c.draw();s.c.save();assert.equal(s.previews.length,1);assert.equal(s.previews[0].current,s.c.poster.value);assert.equal(s.exports.length,1);assert.equal(s.saves.length,0);}finally{s.r.stop();global.window=previous;}
 const n=setup({platform:'MP-WEIXIN'});try{await n.c.draw();n.c.save();assert.equal(n.saves.length,1);assert.equal(n.saves[0].filePath,n.c.poster.value);n.saves[0].fail();assert.match(n.c.error.value,/相册/);assert.equal(n.c.saving.value,false);}finally{n.r.stop();}
});
test('adjacent PHP carousel templates generate lazily, current image cached while selected save is bounded',async()=>{
 const s=setup();try{await s.c.draw();const image=s.c.poster.value;s.p.selected=false;assert.equal(s.c.ready.value,false);s.c.save();assert.equal(s.saves.length,0);s.p.selected=true;await tick();assert.equal(s.c.poster.value,image);assert.equal(s.exports.length,1);assert.equal(s.c.ready.value,true);}finally{s.r.stop();}
});
for(const mode of ['hide','logout','replace','same-owner-new-session','persisted-storage','template','unmount'])test('late canvas export cannot publish across '+mode,async()=>{
 const s=setup({holdExport:true});let stopped=false;try{const pending=s.c.draw();await tick();assert.equal(s.exports.length,1);const old=s.exports[0];
 if(mode==='hide')s.p.active=false;else if(mode==='logout')s.r.auth.clear();else if(mode==='replace')s.r.auth.setLogin('replacement',22);else if(mode==='same-owner-new-session')s.r.auth.setLogin(s.r.auth.token,11);else if(mode==='persisted-storage'){s.r.storage.set('uni_uid',22);s.r.storage.set('uni_token','replacement');}else if(mode==='template')s.p.template='/new-template.png';else{s.r.stop();stopped=true;}
 old.success({tempFilePath:'must-not-publish-old'});await pending;await tick();assert.notEqual(s.c.poster.value,'must-not-publish-old');assert.equal(s.events.some(v=>v.value==='must-not-publish-old'),false);s.c.save();assert.equal(s.saves.length,0);
 }finally{for(const o of s.exports)o.success({tempFilePath:'cleanup'});if(!stopped)s.r.stop();}
});
test('export failure is explicit, retryable and never leaves a ready image',async()=>{
 const s=setup({holdExport:true});try{const p=s.c.draw();await tick();s.exports[0].fail();await p;assert.equal(s.c.ready.value,false);assert.match(s.c.error.value,/导出失败/);const second=s.c.draw();await tick();s.exports[1].success({tempFilePath:'recovered'});await second;assert.equal(s.c.ready.value,true);assert.equal(s.c.error.value,'');}finally{s.r.stop();}
});
test('old exported-image error callback cannot clear a replacement image',async()=>{
 const s=setup();try{await s.c.draw();const old=s.c.preview.value;await s.c.draw();old.fail();assert.equal(s.c.ready.value,true);s.c.preview.value.fail();assert.equal(s.c.ready.value,false);assert.equal(s.c.poster.value,'');assert.match(s.c.error.value,/无法显示/);}finally{s.r.stop();}
});
test('generated raster cannot save after source signature deadline even before timer runs',async()=>{
 const now=Date.now,deadline=Math.floor(now()/1000)+60,s=setup({props:{template:'/api/assets/41?expires='+deadline+'&signature='+('s'.repeat(43))}});
 try{await s.c.draw();assert.equal(s.c.ready.value,true);Date.now=()=>deadline*1000;s.c.save();assert.equal(s.saves.length,0);await s.c.draw();assert.equal(s.c.ready.value,false);assert.match(s.c.error.value,/过期/);}finally{Date.now=now;s.r.stop();}
});
test('native share helpers wrap PHP invitation and parse signed source deadlines without URL globals',()=>{
 const r=runtime({send:()=>({data:null})});try{const u=r.load(path.join(__dirname,'../src/utils/spreadPoster.ts')),oldURL=global.URL,oldQuery=global.URLSearchParams;global.URL=undefined;global.URLSearchParams=undefined;try{
 assert.deepEqual(u.spreadInvitation('商城'),['邀请您加入商城']);assert.ok(u.spreadInvitation('超'.repeat(50)).length===2);assert.ok(u.spreadInvitation('超'.repeat(50))[1].endsWith('...'));
 const code='/api/share/code/image/'+('a'.repeat(24))+'/routine?expires=1800000000&signature='+('s'.repeat(43));assert.equal(u.spreadPosterDeadline([code,'https://api.example/api/assets/7?expires=1799999999&signature=x']),1799999999000);assert.equal(u.spreadSharePath(code),'/pages/share/landing?q='+('a'.repeat(24)));assert.equal(u.spreadSharePath('https://evil.example/private.png'),'');assert.equal(u.spreadPosterDeadline(['https://cdn.example/a.png','data:image/png;base64,x']),null);
 }finally{global.URL=oldURL;global.URLSearchParams=oldQuery;}}finally{r.stop();}
});
test('poster read rejects expired sources and persistence replacement before publishing DTO',async()=>{
 const uri='/api/share/code/image/'+('a'.repeat(24))+'/routine?expires=1800000000&signature='+('s'.repeat(43)),dto={routineUrl:uri,wechatUrl:uri,site_name:'商城',nickname:'本人'},poster={spread:[{pic:'/template.png'}],avatar:'',site_name:'商城',nickname:'本人'};
 const gate=deferred(),r=runtime({feature:'useSpreadPoster',send:call=>call.url.includes('spread_info')?gate.promise:{data:dto}});
 try{r.hooks.onShow();await tick();r.storage.set('uni_uid',22);r.storage.set('uni_token','replacement');gate.resolve({data:poster});await tick();assert.equal(r.checkout.data.value,null);assert.equal(r.checkout.code.value,'');assert.equal(r.auth.uid,22);}finally{gate.resolve({data:poster});r.stop();}
 const expired={...poster,spread:[{pic:'/api/assets/7?expires=1700000000&signature='+('s'.repeat(43))}]},e=runtime({feature:'useSpreadPoster',send:call=>({data:call.url.includes('spread_info')?expired:dto})});try{await e.start({});assert.equal(e.checkout.data.value,null);assert.match(e.checkout.error.value,/过期/);}finally{e.stop();}
});

test('reset acknowledges an already manually closed H5 preview without an unhandled rejection',async()=>{
 const previous=global.window;global.window={};const s=setup(),closes=[];s.r.uni.closePreviewImage=o=>{closes.push(o);assert.equal(typeof o.fail,'function');o.fail({errMsg:'closePreviewImage:fail not opened'});};
 try{await s.c.draw();s.c.save();await s.c.draw();assert.equal(closes.length,1);assert.equal(s.c.ready.value,true);assert.equal(s.c.error.value,'');}finally{s.r.stop();global.window=previous;}
});
