const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),test=require('node:test'),{createRequire}=require('node:module');
const visual=__dirname,root=path.join(visual,'cinashop-migration-20261013-HUPOBq/view/uniapp-ts'),req=createRequire(path.join(root,'scripts/user-center-runtime.cjs'));
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const inputPaths=['src/pages/delivery/scanning.vue','src/utils/privateShareScan.ts','src/utils/legacyShare.ts','src/utils/shareScanTransfer.ts','src/composables/useDeliveryWorkbench.ts','src/utils/deliveryWorkbench.ts','src/api/deliveryWorkbench.ts','src/api/legacyShare.ts','scripts/user-center-runtime.cjs'].map(name=>path.join(root,name));
inputPaths.push(path.join(visual,'delivery-context-baseline-2-sanitized-envelopes.json'),path.join(visual,'delivery-context-candidate-sanitized-envelopes.json'));
const inputs=inputPaths.map(file=>({file,sha256:sha(file)}));
function preprocess(source){const stack=[true];return source.split(/\r?\n/u).filter(line=>{let m=/^\s*\/\/\s*#(ifdef|ifndef)\s+(.+)$/u.exec(line);if(m){let yes=m[2].split(/\s*\|\|\s*/u).includes('MP-WEIXIN');if(m[1]==='ifndef')yes=!yes;stack.push(stack.at(-1)&&yes);return false;}if(/^\s*\/\/\s*#endif\s*$/u.test(line)){stack.pop();return false;}return stack.at(-1);}).join('\n');}
const moduleData={exports:{}},loader=fs.readFileSync(path.join(root,'scripts/user-center-runtime.cjs'),'utf8');
new Function('require','module','exports','__dirname','preprocess',loader.replace("let source=fs.readFileSync(file,'utf8');","let source=preprocess(fs.readFileSync(file,'utf8'));"))(req,moduleData,moduleData.exports,path.join(root,'scripts'),preprocess);
const native=moduleData.exports;
global.URL=undefined;global.URLSearchParams=undefined;
const rows=[],token='c'.repeat(24),origin='https://share.example';
for(const version of ['baseline-2','candidate']){
 const producer=JSON.parse(fs.readFileSync(path.join(visual,`delivery-context-${version}-sanitized-envelopes.json`),'utf8'));
 assert.equal(producer.fixture_actor_uid,501);assert.equal(producer.financialExecutionPerformed,false);
 for(const report of producer.reports)test(`actual sanitized PG ${version} ${report.selected.kind} scope through actual native scanner and scoped records`,async()=>{
  for(const method of ['info','records']){
   const r=native.runtime({component:'pages/delivery/scanning.vue',send:call=>{
    if(call.url.endsWith('/context'))return{data:report.context};
    if(call.url.includes('/share/scene/'))return{data:{type:91,id:report.info.data.list[0].id,spid:0,h5_origin:origin,namespace:'order',code:report.info.data.list[0].verify_code,viewer_scope:'delivery',path:'/pages/delivery/scanning',order_id:report.info.data.list[0].order_id}};
    if(call.url.endsWith('/writeoff/info'))return{data:report.info};
    if(call.url.endsWith('/writeoff/records'))return{data:report.records};
    throw Error('Unexpected I/O boundary');
   }});
   try{
    r.auth.setLogin('synthetic-local-token',producer.fixture_actor_uid);let scan;r.uni.scanCode=o=>scan=o;r.page.nativeScanAvailable.value=true;
    await r.start({scope_kind:report.selected.kind,store_id:String(report.selected.store_id),delivery_id:String(report.selected.delivery_id)});
    assert.equal(r.page.controller.error.value,'');assert.equal(r.page.controller.context.value.consistency_key,report.context.consistency_key);
    r.page.scan();await scan.success({path:'pages/share/landing?scene=q%3D'+token,scanType:'WX_CODE'});
    assert.equal(r.page.code.value,report.info.data.list[0].verify_code);
    if(method==='info')await r.page.lookup();
    else{const guard=r.load(path.join(root,'src/utils/deliveryWorkbench.ts')).isDeliveryRecords;try{const result=await r.page.controller.read('writeoff/records',guard,{order_id:report.info.data.list[0].id,page:1,limit:15});assert.equal(version,'candidate');assert.deepEqual(result.data,report.records.data);}catch(error){if(version==='candidate')throw error;assert.match(error.message,/订单或权限已变化/u);}}
    if(version==='baseline-2'){
     assert.notEqual(report.context.consistency_key,report[method].consistency_key);assert.equal(r.page.controller.context.value,null);assert.equal(r.page.previews.value.length,0);assert.match(r.page.controller.error.value,/订单或权限已变化/u);
    }else{
     assert.equal(report.context.consistency_key,report[method].consistency_key);assert.equal(r.page.controller.error.value,'');
     if(method==='info'){assert.equal(r.page.previews.value.length,1);assert.equal(r.page.previews.value[0].cart_info.length,1);assert.deepEqual(JSON.parse(JSON.stringify(r.page.previews.value[0])),report.info.data.list[0]);}
    }
    const reads=r.calls.filter(c=>c.url.endsWith('/writeoff/'+method));assert.equal(reads.length,1);assert.equal(reads[0].data.scope_key,report.context.scope_key);assert.equal(reads[0].data.scope_kind,report.selected.kind);assert.equal(Number(reads[0].data.delivery_id),report.selected.delivery_id);assert.equal(Number(reads[0].data.store_id),report.selected.store_id);
    if(method==='info')assert.equal(reads[0].data.code,report.info.data.list[0].verify_code);
    assert.equal(r.calls.filter(c=>/\/(?:execute|writeoff|member_writeoff)$/u.test(c.url)).length,0);assert.equal(r.navigations.length,0);
    rows.push({producer:version,selected:report.selected,method,actualScopeKey:report.context.scope_key,actualContextKey:report.context.consistency_key,actualReadKey:report[method].consistency_key,accepted:version==='candidate',previewOrders:method==='info'?r.page.previews.value.length:0,financialWrites:0,navigations:0,codeInNavigation:false});
   }finally{r.stop();}
  }
 });
}
test.after(()=>{assert.deepEqual(inputPaths.map(file=>({file,sha256:sha(file)})),inputs);fs.writeFileSync(path.join(visual,'private-share-delivery-actual-dto-sfc-proof.json'),JSON.stringify({globalsDisabled:['URL','URLSearchParams'],inputs,rows,sourceUnchanged:true,boundary:'Producer envelopes preserved byte-for-byte; only network/native scan and local auth I/O synthetic. Sanitized fixture code and display fields already supplied by SQL producer, no hash/key/row mutation. Real WeChat hardware not invoked.'},null,2));});
