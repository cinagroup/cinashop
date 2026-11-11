const test=require('node:test'),assert=require('node:assert/strict');
const {runtime,tick,deferred,row,now}=require('./helpers/purchased-label-tasks-runtime.cjs');
function scenario(title,fn){test(title,async()=>{const r=runtime(fn.options??{});try{await tick();await fn(r);}finally{await r.finish();}});}
scenario('real composable and Axios adapter page by canonical task cursor and reset a changed filter',async r=>{
 assert.equal(r.state.items.length,20);await r.api.next();assert.equal(r.state.items.length,1);assert.equal(r.state.history.length,1);await r.api.previous();assert.equal(r.state.items.length,20);
 r.state.status='COMPLETED';await r.api.query();assert.deepEqual(r.state.items,[]);assert.equal(r.state.cursor,undefined);assert.equal(r.state.history.length,0);
});
scenario('malformed UUID filter clears stale rows without a request and no read capability makes no request',async r=>{
 const n=r.calls.length;r.state.taskId='../bad';await r.api.query();assert.equal(r.calls.length,n);assert.match(r.state.error,/UUID/);assert.equal(r.state.items.length,0);
 r.setSession('B',2,[],1);await tick();assert.equal(r.api.canRead.value,false);assert.equal(r.calls.length,n);assert.equal(r.state.taskId,'');
});
scenario('viewer can read but has no writer even when a stale direct click is issued',async r=>{
 r.setSession('B',2,['outbox.view'],1);await tick();assert.equal(r.api.canManage.value,false);r.api.open(r.state.items[0]);assert.equal(r.state.modal,null);assert.equal(r.calls.filter(c=>c.method==='POST').length,0);
});
scenario('reason counts Unicode without clipping and duplicate submit sends one exact original task reference',async r=>{
 r.api.open(r.state.items[0]);r.state.modal.reason='🧭'.repeat(101);await r.api.submit();assert.equal(r.calls.filter(c=>c.method==='POST').length,0);
 r.state.modal.reason='🧭'.repeat(100);const p=r.api.submit();const again=r.api.submit();await Promise.all([p,again]);assert.equal(r.calls.filter(c=>c.method==='POST').length,1);assert.equal(r.state.modal.phase,'observed');
 assert.deepEqual(Object.keys(r.calls.find(c=>c.method==='POST').body),['confirm','reason']);assert.equal(r.calls.find(c=>c.method==='POST').body.reason,'🧭'.repeat(100));
});
test('unknown accepted response survives close and panel unmount; exact read recovers without another POST',async()=>{
 let lost=true;const r=runtime({send(call,next){const result=next();if(call.method==='POST'&&lost){lost=false;throw Error('accepted response lost');}return result;}});
 try{await tick();const original=r.state.items[0];r.api.open(original);r.state.modal.reason='已维护';await r.api.submit();assert.equal(r.state.modal.phase,'uncertain');r.api.close();assert.ok(r.api.recovery.value);r.unmount();r.mount();await tick();assert.ok(r.api.recovery.value);r.api.restore();assert.equal(r.state.modal.phase,'uncertain');await r.api.submit();assert.equal(r.calls.filter(c=>c.method==='POST').length,1);await r.api.lookup();assert.equal(r.state.modal.row.replayCount,1);assert.equal(r.state.modal.phase,'observed');assert.equal(r.calls.filter(c=>c.method==='POST').length,1);assert.ok(r.calls.some(c=>c.params.task_id===original.taskId));r.api.close();assert.equal(r.api.recovery.value,null);}finally{await r.finish();}
});
test('replacement session aborts a queued mutation before actual Axios dispatch and cannot see the old marker',async()=>{
 const r=runtime();try{await tick();r.api.open(r.state.items[0]);r.state.modal.reason='旧账号原因';const pending=r.api.submit();r.setSession('B',2,['outbox.manage'],1);await pending;await tick();assert.equal(r.calls.filter(c=>c.method==='POST').length,0);assert.equal(r.state.modal,null);assert.equal(r.api.recovery.value,null);r.setSession('C',1,['outbox.manage'],0);await tick();assert.ok(r.api.recovery.value);r.api.restore();assert.equal(r.state.modal.reason,'旧账号原因');assert.equal(r.state.modal.phase,'uncertain');}finally{await r.finish();}
});
test('late old-filter response cannot replace the latest query or undo its busy state',async()=>{
 const gate=deferred();let delayed=false;const r=runtime({send(call,next){if(call.method==='GET'&&call.params.status==='DEAD'){delayed=true;return gate.promise;}return next();}});
 try{await tick();r.state.status='DEAD';const old=r.api.query();await tick();assert.ok(delayed);r.state.status='FAILED';await r.api.query();assert.equal(r.state.items.length,20);gate.resolve({items:[],nextAfterId:null,observedAt:now});await old;assert.equal(r.state.items.length,20);assert.equal(r.state.loading,false);}finally{await r.finish();}
});
scenario('unrelated storage events preserve view while auth events retire data, drafts and pending callbacks',async r=>{
 const before=r.state.items[0];const event=new Event('storage');Object.defineProperty(event,'key',{value:'unrelated'});r.window.dispatchEvent(event);assert.strictEqual(r.state.items[0],before);
 r.api.open(before);r.state.modal.reason='draft';r.window.dispatchEvent(new Event('admin-session-changed'));assert.equal(r.state.modal,null);assert.deepEqual(r.state.items,[]);
});
