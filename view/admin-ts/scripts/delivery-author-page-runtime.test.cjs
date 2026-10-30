const test=require('node:test'),assert=require('node:assert/strict'),axios=require('axios');
const {runtime,tick,row,css,byLabel,text,buttons,replay,click,update,deferred}=require('./helpers/delivery-author-runtime.cjs');
const base='/order/delivery/author';
function scenario(name,fn){test(name,async()=>{const runs=[];const mount=async options=>{const r=runtime(options);runs.push(r);await tick();return r;};try{await fn(mount);}finally{for(const r of runs)await r.finish();}});}
const journal=r=>[...r.storage].filter(([k])=>k.startsWith('cinashop_delivery_pending'));
const handler=(r,label)=>buttons(r,label)[0].props.onClick;
async function prepare(r){await click(r,'编辑配送员');await update(r,'配送员名称','编辑后的配送员');await click(r,'核对配送员保存');}
scenario('actual catalog uses order authority and defers auxiliary reads',async mount=>{
 const r=await mount();assert.equal(r.reads().length,1);assert.equal(css(r,'delivery-row').length,2);await click(r,'编辑配送员');assert.equal(byLabel(r,'配送员名称').props.value,'配送员1');assert.equal(byLabel(r,'联系电话').props.value,'13800138000');assert.equal(byLabel(r,'配送员状态').props.value,1);assert.equal(buttons(r,'选择商城用户').length,0);assert.match(text(r.tree),/关联用户固定/);assert.equal(r.io.length,1);
});
scenario('create selects a genuine user and sends five values plus selection; image may be overridden',async mount=>{
 const r=await mount();await click(r,'新增配送员');await click(r,'核对配送员保存');assert.equal(r.state.confirmation,null);await click(r,'选择商城用户');replay(css(r,'delivery-user-option')[1].props.onClick);await tick();assert.equal(r.state.editor.draft.uid,1002);assert.equal(r.state.editor.draft.avatar,'/api/assets/102');await click(r,'选择头像图片');replay(css(r,'delivery-image-option')[0].props.onClick);await tick();await click(r,'核对配送员保存');await click(r,'确认配送员提交');const p=r.writes()[0].body.payload;assert.deepEqual(Object.keys(p),['uid','avatar','nickname','phone','status','user_selection']);assert.equal(p.avatar,'/api/assets/1');assert.equal(p.user_selection,'2'.padStart(64,'0'));assert.equal(p.nickname,'');assert.equal(p.phone,'');assert.equal(r.changed,1);
});
scenario('edit preserves historical fields and never exposes a UID writer',async mount=>{
 const h=row(1,{phone:'旧电话',status:7,avatar:'javascript:old',avatar_preview:''}),r=await mount({rows:[h]});await prepare(r);await click(r,'确认配送员提交');const p=r.writes()[0].body.payload;for(const k of ['uid','phone','status','avatar'])assert.equal(p[k],h[k]);assert.equal(p.user_selection,'');assert.equal(r.io.filter(c=>c.url===base+'/users').length,0);
});
scenario('native field nodes remain stable while stale save rejects input ABA',async mount=>{
 const r=await mount();await click(r,'编辑配送员');const n=byLabel(r,'配送员名称'),save=handler(r,'核对配送员保存');replay(n.props.onInput,{target:{value:'A'}});replay(n.props.onInput,{target:{value:'AB'}});await tick();assert.equal(byLabel(r,'配送员名称'),n);await update(r,'配送员名称','配送员1');replay(save);await tick();assert.equal(r.state.confirmation,null);assert.equal(r.writes().length,0);
});
for(const n of [251,256])scenario('raw user avatar '+n+' is never truncated and must be replaced',async mount=>{
 const r=await mount({users:[{uid:22,nickname:'用户',phone:'13800138000',avatar:'x'.repeat(n),preview:'',selection:'c'.repeat(64)}]});await click(r,'新增配送员');await click(r,'选择商城用户');replay(css(r,'delivery-user-option')[0].props.onClick);await tick();assert.equal(r.state.editor.draft.avatar.length,n);await click(r,'核对配送员保存');assert.match(text(r.tree),/超过250/);await update(r,'配送员头像地址','/static/fixed.png');await click(r,'核对配送员保存');await click(r,'确认配送员提交');assert.equal(r.writes()[0].body.payload.avatar,'/static/fixed.png');
});
for(const bad of ['duplicate','short','page','selection','phone','extra'])scenario('user picker rejects malformed complete DTO '+bad,async mount=>{
 const r=await mount({send(c,next){const r=next();if(c.url===base+'/users'){const x=r.data;if(bad==='duplicate')x.list[1]={...x.list[0]};if(bad==='short')x.list.pop();if(bad==='page')x.page=2;if(bad==='selection')x.list[0].selection='fake';if(bad==='phone')x.list[0].phone='x'.repeat(16);if(bad==='extra')x.list[0].secret='bad';}return r;}});await click(r,'新增配送员');await click(r,'选择商城用户');assert.ok(r.state.users.error);assert.equal(css(r,'delivery-user-option').length,0);assert.equal(r.writes().length,0);
});
scenario('user query and choice are retired after keyword ABA',async mount=>{
 const r=await mount();await click(r,'新增配送员');await click(r,'选择商城用户');const choose=css(r,'delivery-user-option')[1].props.onClick;await update(r,'商城用户关键词','a');await update(r,'商城用户关键词','');replay(choose);await tick();assert.equal(r.state.editor.draft.uid,0);await click(r,'查询商城用户');replay(css(r,'delivery-user-option')[1].props.onClick);await tick();assert.equal(r.state.editor.draft.uid,1002);
});
scenario('gallery uses stable references, independent preview and full pagination',async mount=>{
 const r=await mount();await click(r,'编辑配送员');await click(r,'选择头像图片');await click(r,'下一页头像图片');assert.equal(css(r,'delivery-image-option').length,4);replay(css(r,'delivery-image-option')[0].props.onClick);await tick();await click(r,'核对配送员保存');await click(r,'确认配送员提交');assert.equal(r.writes()[0].body.payload.avatar,'/api/assets/21');assert.ok(!JSON.stringify(r.writes()[0].body).includes('preview'));
});
scenario('status and soft delete require explicit confirmation',async mount=>{
 const r=await mount({rows:[row()]});await click(r,'停用配送员');assert.equal(r.writes().length,0);await click(r,'确认配送员提交');await click(r,'删除配送员');assert.match(text(r.tree),/已有订单记录保留/);await click(r,'确认配送员提交');assert.equal(r.writes()[1].body.operation,'delete');assert.equal(css(r,'delivery-row').length,0);
});
scenario('double captured confirmation dispatches a single immutable action',async mount=>{
 const wait=deferred(),r=await mount({send(c,next){return c.url===base+'/commit'?wait.promise.then(next):next();}});await prepare(r);const fn=handler(r,'确认配送员提交');replay(fn);replay(fn);await tick();assert.equal(r.writes().length,1);assert.equal(journal(r).length,1);wait.resolve();await tick();assert.equal(journal(r).length,0);
});
scenario('lost committed response recovers exact original action',async mount=>{
 let lost=true;const r=await mount({send(c,next){const result=next();if(c.url===base+'/commit'&&lost){lost=false;throw new axios.AxiosError('lost','ERR_NETWORK');}return result;}});await prepare(r);await click(r,'确认配送员提交');assert.equal(r.changed,0);assert.deepEqual(JSON.parse(journal(r)[0][1]),r.writes()[0].body);await click(r,'读取原回执');assert.equal(journal(r).length,0);assert.equal(r.changed,1);
});
scenario('unknown404 allows only an explicit exact retry',async mount=>{
 let n=0;const r=await mount({send(c,next){if(c.url===base+'/commit'&&n++===0)throw new axios.AxiosError('lost','ERR_NETWORK');return next();}});await prepare(r);await click(r,'确认配送员提交');await click(r,'读取原回执');assert.equal(journal(r).length,1);await click(r,'原样重试');assert.deepEqual(r.writes()[0].body,r.writes()[1].body);assert.equal(journal(r).length,0);
});
scenario('permission withdrawal preserves owner journal for explicit resolution',async mount=>{
 const r=await mount({send(c,next){if(c.url===base+'/commit')throw new axios.AxiosError('lost','ERR_NETWORK');return next();}});await prepare(r);await click(r,'确认配送员提交');r.sync({userInfo:{id:7,level:1},uniqueAuth:[]});await tick();await click(r,'读取原回执');assert.equal(buttons(r,'原样重试').length,0);await click(r,'核对并封存原请求');assert.equal(journal(r).length,0);assert.equal(r.changed,0);
});
for(const transition of ['active','route','actor','unmount'])scenario('captured edit and user choice retire after '+transition,async mount=>{
 const r=await mount();await click(r,'新增配送员');const input=byLabel(r,'配送员名称').props.onInput;await click(r,'选择商城用户');const choose=css(r,'delivery-user-option')[0].props.onClick;if(transition==='active')r.props.active=false;if(transition==='route')r.route.fullPath='/order/delivery-people?other';if(transition==='actor')r.sync({token:'B',userInfo:{id:8,level:0}});if(transition==='unmount')r.unmount();await tick();replay(input,{target:{value:'retired'}});replay(choose);await tick();assert.equal(r.state.editor,null);assert.equal(r.writes().length,0);
});
for(const permission of ['order.view','store.manage'])scenario('permission '+permission+' cannot create or fetch private options',async mount=>{
 const r=await mount({actor:{userInfo:{id:7,level:1},uniqueAuth:[permission]}});assert.equal(buttons(r,'新增配送员').length,0);assert.equal(r.io.length,permission==='order.view'?1:0);
});
