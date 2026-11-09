const test=require('node:test');
const {runtime,environment,clone,deferred,tick,until,quote,view,hash,envelope,uuid,version,elements,text,buttons,replay,click,gift,assert}=require('./helpers/recharge-refund-runtime.cjs');
const writes=r=>r.calls.filter(c=>c.url.includes('/execute/'));
const key='admin-recharge-refund-v1:9:81';
function scenario(name,work){test(name,{concurrency:false,timeout:5000},async()=>{const mounted=[];const mount=async options=>{const r=runtime(options);mounted.push(r);if(!options?.pendingMount)await until(()=>!r.state.busy);return r;};try{await work(mount);}finally{for(const r of mounted.reverse())await r.finish();}});}
async function prepare(r){await click(r,'核对全额退款');assert.match(text(r.tree),/确认原路退回全部本金/);}

scenario('actual SFC defaults to gift recovery, verifies the entire principal and persists before one explicit submit',async mount=>{
 const r=await mount({send(call,next){if(call.url.includes('/execute/')){const saved=JSON.parse(r.storage.get(key));assert.equal(saved.key,call.headers['Idempotency-Key']);assert.deepEqual(saved.body,call.body);assert.equal(saved.requestHash,hash(9,call.body));}return next();}});
 assert.equal(r.calls.length,1);assert.equal(r.state.recoverGift,true);assert.match(text(r.tree),/钱包需扣除 ¥11.50，退款后余额 ¥0.00/);await prepare(r);assert.equal(writes(r).length,0);await click(r,'确认提交');assert.equal(writes(r).length,1);
 const call=writes(r)[0];assert.deepEqual(Object.keys(call.body),['version','rechargeId','quoteFingerprint','recoverGift']);assert.equal(call.body.recoverGift,true);assert.equal(call.body.rechargeId,81);assert.equal(call.headers['X-Recharge-Refund-Scope'],'v1:admin:9');assert.equal(call.headers['Authori-zation'],'Bearer A');assert.equal(call.redirect,'manual');assert.equal(call.cache,'no-store');assert.match(text(r.tree),/退款成功/);assert.equal(JSON.parse(r.storage.get(key)).view.execution.phase,'succeeded');
});
scenario('preserving the gift changes wallet debit only, with full principal still fixed',async mount=>{
 const r=await mount();await gift(r,false);assert.equal(r.state.recoverGift,false);assert.match(text(r.tree),/钱包需扣除 ¥10.00，退款后余额 ¥1.50/);await prepare(r);await click(r,'确认提交');assert.equal(writes(r)[0].body.recoverGift,false);assert.equal(r.state.intent.view.receipt.principal,'10.00');assert.equal(r.state.intent.view.receipt.postBalance,'1.50');
});
scenario('insufficient selected balance blocks submit and an available alternate option remains usable',async mount=>{
 const env=environment();env.available='10.00';const r=await mount({env});assert.ok(buttons(r,'核对全额退款')[0].props.disabled);assert.match(text(r.tree),/余额不足/);assert.equal(writes(r).length,0);await gift(r,false);assert.ok(!buttons(r,'核对全额退款')[0].props.disabled);await prepare(r);await click(r,'确认提交');assert.equal(writes(r).length,1);
});
scenario('double confirmation sends one key and a retired confirmation cannot approve its replacement',async mount=>{
 const wait=deferred(),r=await mount({send:async(c,next)=>{if(c.url.includes('/execute/'))await wait.promise;return next();}});await prepare(r);const old=buttons(r,'确认提交')[0].props.onClick;await click(r,'返回核对');await gift(r,false);await prepare(r);replay(old);await tick();assert.equal(writes(r).length,0);const current=buttons(r,'确认提交')[0].props.onClick;replay(current);replay(current);await until(()=>writes(r).length===1);assert.equal(writes(r).length,1);wait.resolve();await until(()=>!r.state.busy);assert.equal(writes(r)[0].body.recoverGift,false);
});
scenario('lost commit response preserves the full original intent and reload recovers with a read only',async mount=>{
 const env=environment();let lost=true;const r=await mount({env,send(c,next){const result=next();if(c.url.includes('/execute/')&&lost){lost=false;throw Error('local transport lost response');}return result;}});await prepare(r);await click(r,'确认提交');assert.match(text(r.tree),/local transport lost response/);const saved=JSON.parse(r.storage.get(key));assert.equal(saved.view,null);assert.ok(saved.body);assert.equal(writes(r).length,1);r.unmount();
 const next=await mount({env});assert.equal(next.state.intent.key,saved.key);assert.match(text(next.tree),/退款成功/);assert.equal(writes(next).length,1);assert.equal(next.calls.at(-1).url,'/adminapi/finance/recharge-refunds/execution');assert.equal(next.calls.at(-1).headers['Idempotency-Key'],saved.key);assert.deepEqual(next.calls.at(-1).body,{version});
});
scenario('same-tab identity ABA aborts old work and never paints its later receipt',async mount=>{
 const wait=deferred(),r=await mount({send:async(c,next)=>{if(c.url.includes('/execute/'))await wait.promise;return next();}});await prepare(r);replay(buttons(r,'确认提交')[0].props.onClick);await until(()=>writes(r).length===1);const saved=JSON.parse(r.storage.get(key)),request=writes(r)[0];r.setSession('B',22);r.setSession('A',9);wait.resolve();await until(()=>!r.state.busy);assert.equal(request.signal.aborted,true);assert.equal(r.state.invalidated,true);assert.equal(r.state.intent,null);assert.equal(JSON.parse(r.storage.get(key)).key,saved.key);assert.equal(JSON.parse(r.storage.get(key)).view,null);assert.equal(writes(r).length,1);
});
scenario('a late 401 for the retired actor does not clear its replacement session',async mount=>{
 const wait=deferred(),r=await mount({send:async(c,next)=>{if(c.url.includes('/execute/')){await wait.promise;return envelope(null,410000,401);}return next();}});await prepare(r);replay(buttons(r,'确认提交')[0].props.onClick);await until(()=>writes(r).length===1);r.setSession('B',22);wait.resolve();await until(()=>!r.state.busy);assert.equal(r.storage.get('admin_token'),'B');assert.equal(r.state.invalidated,true);assert.equal(writes(r).length,1);
});
scenario('storage failure before dispatch prevents every financial request',async mount=>{
 const r=await mount({storageFailure:k=>k.startsWith('admin-recharge-refund')});await prepare(r);await click(r,'确认提交');assert.equal(writes(r).length,0);assert.equal(r.storage.get(key),undefined);assert.match(text(r.tree),/storage quota/);
});
scenario('corrupt retained data is never erased, replaced or used to get a new quote',async mount=>{
 const env=environment();env.storage.set(key,'{damaged');const r=await mount({env});assert.equal(r.calls.length,0);assert.equal(r.state.localBroken,true);assert.equal(r.storage.get(key),'{damaged');assert.equal(buttons(r,'核对全额退款').length,0);
});
scenario('two tabs share an entity lock and stale null snapshots cannot dispatch a second request',async mount=>{
 const env=environment(),wait=deferred(),first=await mount({env,send:async(c,next)=>{if(c.url.includes('/execute/'))await wait.promise;return next();}}),other=await mount({env});await prepare(first);await prepare(other);const stale=buttons(other,'确认提交')[0].props.onClick;replay(buttons(first,'确认提交')[0].props.onClick);await until(()=>writes(first).length===1);replay(stale);await tick();assert.equal(writes(first).length,1);assert.equal(other.state.externalChange,true);wait.resolve();await until(()=>!first.state.busy);await click(other,'重新读取本机申请');assert.equal(other.state.intent.view.execution.phase,'succeeded');assert.equal(writes(first).length,1);
});
scenario('recovery by original key cannot reconstruct a first POST or invent its body',async mount=>{
 const env=environment(),body={version,rechargeId:81,quoteFingerprint:'b'.repeat(64),recoverGift:true};env.requests.set(uuid(17),view(9,body,'not_requested'));const r=await mount({env});r.state.recoveryKey=uuid(17);await click(r,'读取原申请');assert.equal(r.state.intent.body,null);assert.equal(r.state.intent.key,uuid(17));assert.match(text(r.tree),/原方案不在本机/);assert.equal(buttons(r,'继续原退款申请').length,0);assert.equal(writes(r).length,0);await click(r,'撤销未派发申请');await click(r,'确认提交');assert.equal(r.state.intent.view.execution.phase,'cancelled');assert.equal(writes(r).length,0);
});
scenario('a stale quote failure preserves its body/key, and sealing is explicit before a new application',async mount=>{
 let reject=true;const r=await mount({send(c,next){if(c.url.includes('/execute/')&&reject){reject=false;return envelope(null,409);}return next();}});await prepare(r);await click(r,'确认提交');const first=JSON.parse(r.storage.get(key));assert.equal(first.view,null);await click(r,'读取原申请状态');await click(r,'封存未受理申请');await click(r,'确认提交');assert.equal(r.state.intent.view.execution.phase,'abandoned');await click(r,'重新申请退款');await prepare(r);await click(r,'确认提交');assert.equal(writes(r).length,2);assert.notEqual(writes(r)[0].headers['Idempotency-Key'],writes(r)[1].headers['Idempotency-Key']);assert.ok(r.storage.has(key+':'+first.key));assert.equal(r.state.intent.view.execution.phase,'succeeded');
});
scenario('an abandonment race never relabels an existing accepted operation',async mount=>{
 const r=await mount({send(c,next){if(c.url.includes('/execute/')){next();throw Error('lost');}return next();}});await prepare(r);await click(r,'确认提交');const saved=JSON.parse(r.storage.get(key));r.env.requests.set(saved.key,view(9,saved.body,'not_requested'));await click(r,'读取原申请状态');assert.equal(r.state.intent.view.execution.phase,'not_requested');assert.equal(buttons(r,'封存未受理申请').length,0);await click(r,'继续原退款申请');await click(r,'确认提交');assert.equal(writes(r).length,2);assert.equal(writes(r)[0].headers['Idempotency-Key'],writes(r)[1].headers['Idempotency-Key']);
});
for(const mutation of ['hash','subject','amount','wallet'])scenario('malformed '+mutation+' receipt cannot resolve the persisted request',async mount=>{
 const r=await mount({send(c,next){if(!c.url.includes('/execute/'))return next();const p=JSON.parse(JSON.stringify(view(9,c.body)));if(mutation==='hash')p.receipt.requestHash='f'.repeat(64);if(mutation==='subject')p.receipt.rechargeId=82;if(mutation==='amount')p.receipt.principal='9.00';if(mutation==='wallet')p.execution.wallet='released';return envelope({...p,replayed:false});}});await prepare(r);await click(r,'确认提交');assert.ok(r.state.error);assert.equal(r.state.intent.view,null);assert.equal(JSON.parse(r.storage.get(key)).view,null);assert.equal(writes(r).length,1);
});
scenario('permission/session invalidation and unmount retire native callbacks without clearing saved recovery data',async mount=>{
 const r=await mount();await prepare(r);const handler=buttons(r,'确认提交')[0].props.onClick;r.props.actorId=22;await tick();replay(handler);await tick();assert.equal(r.state.invalidated,true);assert.equal(writes(r).length,0);assert.equal(r.state.quote,null);
});
scenario('parser and WebCrypto hash agree with the normalized server request vector',async mount=>{
 const r=await mount(),m=r.load('utils/rechargeRefund.ts'),q=quote(),i=await m.makeRechargeRefundIntent(9,q,true);assert.equal(i.requestHash,hash(9,i.body));assert.equal(await m.rechargeRefundHash(9,i.body),hash(9,i.body));assert.deepEqual(i.body,{version,rechargeId:81,quoteFingerprint:'b'.repeat(64),recoverGift:true});
 for(const patch of [{version:'other'},{rechargeId:82},{recoverGift:1},{quoteFingerprint:'B'.repeat(64)},{extra:true}])assert.throws(()=>m.parseRechargeRefundIntent({...i,body:{...i.body,...patch}},9,81));
 const terminal=m.applyRechargeRefundView(i,view(9,i.body));assert.throws(()=>m.applyRechargeRefundView(terminal,null));assert.throws(()=>m.applyRechargeRefundView(terminal,view(9,i.body,'awaiting_provider')));
 let reads=0;const getter={...q};Object.defineProperty(getter,'buyerUid',{enumerable:true,get(){reads++;return 11;}});assert.throws(()=>m.parseRechargeRefundQuote(getter,81));assert.equal(reads,0);
});
scenario('a redirected or excessive HTTP response never resolves an operation or triggers a fallback',async mount=>{
 for(const mode of ['redirect','large']){const r=await mount({send(c,next){if(c.url.includes('/execute/'))return mode==='redirect'?new Response('redirect',{status:302,headers:{Location:'https://unplanned.example'}}):new Response('x'.repeat(65537));return next();}});await prepare(r);await click(r,'确认提交');assert.ok(r.state.error);assert.equal(r.state.intent.view,null);assert.equal(writes(r).length,1);}
});

scenario('cached success stays explicitly unconfirmed while lookup is pending or unavailable',async mount=>{
 const env=environment(),first=await mount({env});await prepare(first);await click(first,'确认提交');first.unmount();
 const wait=deferred(),r=await mount({env,pendingMount:true,send:async(c,next)=>{if(c.url.endsWith('/execution')){await wait.promise;return envelope(null,503);}return next();}});
 await until(()=>!!r.state.intent);assert.equal(r.state.confirmed,false);assert.match(text(r.tree),/上次记录：退款成功（待服务端核对）/);wait.resolve();await until(()=>!r.state.busy);assert.equal(r.state.confirmed,false);assert.match(text(r.tree),/待服务端核对/);assert.ok(r.state.error);assert.equal(writes(r).length,1);
});
