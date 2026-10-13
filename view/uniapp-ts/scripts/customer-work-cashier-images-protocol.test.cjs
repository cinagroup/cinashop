const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),crypto=require('node:crypto');
const {runtime}=require('./user-center-runtime.cjs');
const root=path.resolve(__dirname,'..'),clone=v=>JSON.parse(JSON.stringify(v));
const key='12345678-1234-4123-8123-123456789abc',uploadKey='22345678-1234-4123-8123-123456789abc';
function fixture(send=()=>{throw Error('Unexpected network request');}){
  const r=runtime({component:'pages/customer-work/cashierRecords.vue',send}),u=r.load(path.join(root,'src/utils/customerWorkCashierImages.ts')),
    finance=r.load(path.join(root,'src/utils/customerWorkCashier.ts'));
  const body={version:'customer-cashier-form-session-v1',scope_key:'a'.repeat(64),buyer_uid:21,tourist_key:'',product_id:70,sku_unique:'qared001',quantity:2};
  const intent={version:'customer-cashier-image-pending-v1',kind:'session',actor_uid:11,service_id:1,request_key:key,request_hash:finance.cashierIntentHash(body),created_at:1791075600,body};
  const session={actor_uid:11,service_id:1,scope_key:body.scope_key,request_key:key,request_hash:intent.request_hash,intent:clone(body),system_form:{id:10,name:'原资料',value:[{id:'picture',name:'uploadPicture',required:true,titleConfig:{value:'照片'},value:[]}]},scope_digest:'S'.repeat(43),state:'active',created_at:'2026-10-11T05:00:00.123456Z',cancelled_at:null,frozen_request_hash:null,order_id:null,order_no:null};
  const metadata={version:'customer-cashier-form-image-v1',scope_key:body.scope_key,session_key:key,field_id:'id:"picture"',sha256:'b'.repeat(64),size:68};
  const imageIntent={...intent,kind:'image',request_key:uploadKey,body:metadata,request_hash:finance.cashierIntentHash(metadata)};
  const image={actor_uid:11,service_id:1,session_key:key,request_key:uploadKey,request_hash:imageIntent.request_hash,intent:clone(metadata),field_id:metadata.field_id,sha256:metadata.sha256,size:68,mime:'image/png',scope_digest:session.scope_digest,state:'stored',attachment_id:51,reference:'/api/assets/51',created_at:session.created_at,stored_at:session.created_at};
  const sessionReceipt={version:body.version,actor_uid:11,request_key:key,receipt:session},imageReceipt={version:metadata.version,actor_uid:11,request_key:uploadKey,receipt:image};
  return{r,u,finance,intent,session,imageIntent,image,sessionReceipt,imageReceipt};
}
test('binary file hash matches Node across SHA padding boundaries, nonzero subviews and the actual 10 MiB limit',()=>{
  const f=fixture();try{const hashes=f.r.load(path.resolve(root,'../common/customerWorkIntent.ts'));
    for(const size of [0,1,55,56,63,64,65,119,120,127,128,129,4097,10*1024*1024]){
      const buffer=new Uint8Array(size+18);for(let i=0;i<buffer.length;i++)buffer[i]=(i*37+size)%256;
      const bytes=buffer.subarray(9,size+9),before=Buffer.from(buffer);
      assert.equal(hashes.customerWorkSha256Bytes(bytes),crypto.createHash('sha256').update(bytes).digest('hex'),`size ${size}`);
      assert.deepEqual(Buffer.from(buffer),before);
    }
    for(const value of ['', '会员😀', '\u0000\u007f\u0080\u07ff\u0800\uffff𐀀', 'abc'.repeat(250)])assert.equal(hashes.customerWorkSha256(value),crypto.createHash('sha256').update(value,'utf8').digest('hex'));
    assert.equal(f.r.calls.length,0);
  }finally{f.r.stop();}
});
test('image intents use exact context, separate member/guest and byte digest with a bounded field identity',()=>{
  const f=fixture();try{assert.equal(f.u.isCustomerCashierImageStage(f.intent),true);assert.equal(f.u.isCustomerCashierImageStage(f.imageIntent),true);
    for(const change of [v=>v.buyer_uid=0,v=>v.tourist_key='other',v=>v.scope_key='short',v=>v.quantity=32768,v=>v.product_id='70',v=>v.admin_id=11]){const b=clone(f.intent.body);change(b);assert.equal(f.u.isCustomerCashierFormContext(b),false);}
    assert.equal(f.u.isCustomerCashierFormContext({...f.intent.body,buyer_uid:0,tourist_key:'guest_1'}),true);
    for(const change of [v=>v.sha256='x'.repeat(64),v=>v.size=0,v=>v.size=10*1024*1024+1,v=>v.size=1.5,v=>v.field_id='f'.repeat(256),v=>v.scope_key='wrong',v=>v.session_key='not-a-uuid',v=>v.filePath='private-path']){const b=clone(f.imageIntent.body);change(b);assert.equal(f.u.isCustomerCashierImageMetadata(b),false);}
    assert.equal(f.u.customerCashierImageFieldId({name:'uploadPicture',id:'a'},0),'id:"a"');assert.equal(f.u.customerCashierImageFieldId({name:'uploadPicture',id:7},0),'id:7');assert.equal(f.u.customerCashierImageFieldId({name:'uploadPicture',id:null},3),'index:3');
    for(const ref of ['https://cdn/a.png','/api/assets/01','/api/assets/0','/api/assets/2147483648','/api/assets/51?signature=bad'])assert.equal(f.u.customerCashierImageId(ref),null);
    const mutated=clone(f.imageIntent);mutated.body.size++;assert.equal(f.u.isCustomerCashierImageStage(mutated),false);
  }finally{f.r.stop();}
});
test('session receipts bind actor, scope, parent creation and all legal original state transitions',()=>{
  const f=fixture();try{assert.equal(f.u.parseCustomerCashierSessionReceipt(f.sessionReceipt,f.intent).receipt.state,'active');
    for(const change of [v=>v.actor_uid=12,v=>v.receipt.service_id=2,v=>v.receipt.scope_key='c'.repeat(64),v=>v.receipt.request_hash='c'.repeat(64),v=>v.receipt.intent.quantity=3,v=>v.receipt.scope_digest='short',v=>v.receipt.state='complete',v=>v.receipt.order_id=7,v=>v.receipt.cancelled_at=f.session.created_at,v=>v.receipt.extra=true]){const b=clone(f.sessionReceipt);change(b);assert.throws(()=>f.u.parseCustomerCashierSessionReceipt(b,f.intent));}
    for(const state of ['cancelled','frozen','consumed']){const b=clone(f.sessionReceipt);b.receipt.state=state;if(state==='cancelled')b.receipt.cancelled_at=f.session.created_at;else b.receipt.frozen_request_hash='c'.repeat(64);if(state==='consumed'){b.receipt.order_id=7;b.receipt.order_no='CASHIER_7';}assert.equal(f.u.parseCustomerCashierSessionReceipt(b,f.intent).receipt.state,state);}
    assert.equal(f.u.parseCustomerCashierSessionReceipt({...f.sessionReceipt,receipt:null},f.intent).receipt,null);
  }finally{f.r.stop();}
});
test('stored upload facts bind actual bytes, field and parent; reservation never substitutes for durable metadata',()=>{
  const f=fixture();try{assert.equal(f.u.parseCustomerCashierImageReceipt(f.imageReceipt,f.imageIntent,f.session).receipt.reference,'/api/assets/51');
    for(const change of [v=>v.actor_uid=12,v=>v.receipt.actor_uid=12,v=>v.receipt.service_id=2,v=>v.receipt.session_key=uploadKey,v=>v.receipt.field_id='index:0',v=>v.receipt.sha256='c'.repeat(64),v=>v.receipt.size=69,v=>v.receipt.mime='text/html',v=>v.receipt.scope_digest='D'.repeat(43),v=>v.receipt.attachment_id=52,v=>v.receipt.reference='https://other/51',v=>v.receipt.stored_at=null,v=>v.receipt.object_key='private']){const b=clone(f.imageReceipt);change(b);assert.throws(()=>f.u.parseCustomerCashierImageReceipt(b,f.imageIntent,f.session));}
    const reserved=clone(f.imageReceipt);Object.assign(reserved.receipt,{state:'reserved',attachment_id:null,reference:null,stored_at:null});assert.equal(f.u.parseCustomerCashierImageReceipt(reserved,f.imageIntent,f.session).receipt.state,'reserved');reserved.receipt.reference='/api/assets/51';assert.throws(()=>f.u.parseCustomerCashierImageReceipt(reserved,f.imageIntent,f.session));
    assert.equal(f.u.parseCustomerCashierImageReceipt({...f.imageReceipt,receipt:null},f.imageIntent,f.session).receipt,null);
  }finally{f.r.stop();}
});
test('private signed previews are memory projections and cannot change stored canonical references or point to another asset',()=>{
  const f=fixture();try{const expires=Math.floor(Date.now()/1000)+600,url=`/api/assets/51?expires=${expires}&signature=${'A'.repeat(43)}`;
    const value={version:'customer-cashier-form-preview-v1',actor_uid:11,session_key:key,previews:[{reference:'/api/assets/51',url}]};
    assert.ok(f.u.parseCustomerCashierPreviews(value,11,key,['/api/assets/51'])['/api/assets/51'].endsWith(url));
    for(const change of [v=>v.actor_uid=12,v=>v.session_key=uploadKey,v=>v.previews[0].reference='/api/assets/52',v=>v.previews[0].url=url.replace('/51?','/52?'),v=>v.previews[0].url='https://other'+url,v=>v.previews[0].url=url.replace(String(expires),'1'),v=>v.previews[0].url+='&x=1']){const b=clone(value);change(b);assert.throws(()=>f.u.parseCustomerCashierPreviews(b,11,key,['/api/assets/51']));}
    assert.throws(()=>f.u.parseCustomerCashierPreviews(value,11,key,['/api/assets/51','/api/assets/51']));
  }finally{f.r.stop();}
});
test('durable parent and upload UUIDs cannot be rebound; silent persistence and duplicate original records fail closed',()=>{
  const f=fixture();try{f.u.retainCustomerCashierImageStage(f.intent);f.u.retainCustomerCashierImageStage(f.imageIntent);f.u.retainCustomerCashierImageStage(clone(f.imageIntent));
    const changed=clone(f.imageIntent);changed.body.size++;changed.request_hash=f.finance.cashierIntentHash(changed.body);assert.throws(()=>f.u.retainCustomerCashierImageStage(changed),/不能绑定/);
    const detached=f.u.customerCashierImagePending();detached[0].body.quantity=9;assert.equal(f.u.customerCashierImagePending()[0].body.quantity,2);
    const original=f.r.uni.setStorageSync;f.r.uni.setStorageSync=()=>{};assert.throws(()=>f.u.releaseCustomerCashierImageStages([uploadKey]),/关闭失败/);f.r.uni.setStorageSync=original;
    f.r.uni.setStorageSync(f.u.CUSTOMER_CASHIER_IMAGE_STORAGE,[f.intent,f.intent]);assert.throws(()=>f.u.customerCashierImagePending(),/损坏/);
    f.r.uni.setStorageSync(f.u.CUSTOMER_CASHIER_IMAGE_STORAGE,[]);f.r.uni.setStorageSync=()=>{};assert.throws(()=>f.u.retainCustomerCashierImageStage(f.intent),/持久保存/);assert.equal(f.r.calls.length,0);
  }finally{f.r.stop();}
});
test('image API isolates shopper JWT and exact endpoints; invalid bytes metadata never starts upload',async()=>{
  const f=fixture(()=>({data:{ok:true}}));try{const api=f.r.load(path.join(root,'src/api/customerWorkCashierImages.ts')),base=api.CUSTOMER_CASHIER_IMAGES_BASE,uploads=[];
    f.r.uni.uploadFile=call=>{uploads.push(call);queueMicrotask(()=>call.success({statusCode:200,data:JSON.stringify({status:200,data:{ok:true}})}));return{abort(){}};};
    const requests=api.createCustomerCashierImageRequests(()=>true);
    await requests.request(`${base}/form-sessions`,'POST',f.intent.body,key);const posted=f.r.calls[0];assert.equal(posted.header['Authori-zation'],'Bearer synthetic-local-token');assert.equal(posted.header['Idempotency-Key'],key);assert.equal(posted.method,'POST');assert.ok(!JSON.stringify(posted).includes('Admin'));
    await requests.upload(`${base}/form-sessions/${key}/images`,'temporary-native-file',f.imageIntent.body,uploadKey);assert.equal(uploads.length,1);assert.equal(uploads[0].header['Idempotency-Key'],uploadKey);assert.equal(uploads[0].name,'file');assert.deepEqual(JSON.parse(uploads[0].formData.metadata),f.imageIntent.body);
    await requests.request(`${base}/form-sessions/${key}/previews`,'POST',{references:['/api/assets/51']});assert.equal(f.r.calls[1].header['Idempotency-Key'],undefined);
    for(const p of ['/api/upload/image',`${base}/form-sessions/${key}/images`,`${base}/form-sessions/${key}/cancel?x=1`])await assert.rejects(requests.request(p,'POST',{},key));
    await assert.rejects(requests.upload(`${base}/form-sessions/${key}/images`,'file',{...f.imageIntent.body,size:0},uploadKey));assert.equal(uploads.length,1);
    f.r.auth.setLogin('new-customer-token',12);await assert.rejects(requests.request(`${base}/form-sessions/${key}`));assert.equal(f.r.calls.length,2);requests.abort();
  }finally{f.r.stop();}
});
test('aborted, timed out and account-switched upload replies cannot update or clear the newer shopper session',async()=>{
  const f=fixture();try{const api=f.r.load(path.join(root,'src/api/customerWorkCashierImages.ts')),base=api.CUSTOMER_CASHIER_IMAGES_BASE;let call,aborts=0;
    f.r.uni.uploadFile=v=>{call=v;return{abort(){aborts++;}};};
    let requests=api.createCustomerCashierImageRequests(()=>true,10),pending=requests.upload(`${base}/form-sessions/${key}/images`,'file',f.imageIntent.body,uploadKey);await assert.rejects(pending,/超时/);assert.equal(aborts,1);call.success({statusCode:200,data:JSON.stringify({status:200,data:{late:true}})});
    requests=api.createCustomerCashierImageRequests(()=>true);pending=requests.upload(`${base}/form-sessions/${key}/images`,'file',f.imageIntent.body,uploadKey);const old=call;f.r.auth.setLogin('new-token',12);old.success({statusCode:403,data:JSON.stringify({status:410000})});await assert.rejects(pending,/页面或账号/);assert.equal(f.r.auth.uid,12);assert.equal(f.r.auth.token,'new-token');requests.abort();
    requests=api.createCustomerCashierImageRequests(()=>true);pending=requests.upload(`${base}/form-sessions/${key}/images`,'file',f.imageIntent.body,uploadKey);requests.abort();await assert.rejects(pending,/页面或账号/);
  }finally{f.r.stop();}
});
test('original creation with image answers requires a matching consumed form and tolerates added optional fields',()=>{
  const f=fixture();try{const body={version:'customer-cashier-second-card-v1',...f.intent.body,real_name:'会员',user_phone:'13900000000',mark:'',custom_form:[{id:'picture',name:'uploadPicture',value:['/api/assets/51']}],coupon_id:0,use_integral:false};body.version='customer-cashier-second-card-v1';
    const intent={...f.intent,version:'customer-cashier-pending-v1',kind:'creation',body,request_hash:f.finance.cashierIntentHash(body)};
    const form={session_key:key,system_form_id:10,components:[{...f.session.system_form.value[0],value:['/api/assets/51']},{id:'optional',name:'texts',value:''}],previews:[{reference:'/api/assets/51',url:`/api/assets/51?expires=${Math.floor(Date.now()/1000)+600}&signature=${'A'.repeat(43)}`}]};
    const d={scope:'own-second-card-creations',record:{id:7,order_no:'CASHIER_7',buyer_uid:21,creator_uid:11,real_name:'会员',user_phone:'13900000000',amount:'12.60',quantity:2,paid:0,pay_type:'',pay_time:0,created_at:1791075600,status:0,refund_status:0,root_retired:false,origin_hash:'c'.repeat(64)},creation:{request_key:key,request_hash:intent.request_hash,origin_hash:'c'.repeat(64),service_id:1,created_at:f.session.created_at},items:[{product_id:70,sku_unique:'qared001',quantity:2,write_times:6,name:'次卡',sku:'红'}],payment:null,form};
    f.finance.verifyCustomerCashierDetail(d,intent);
    const stringIntent=clone(intent);stringIntent.body.custom_form=JSON.stringify(stringIntent.body.custom_form);stringIntent.request_hash=f.finance.cashierIntentHash(stringIntent.body);const stringDetail={...d,creation:{...d.creation,request_hash:stringIntent.request_hash}};f.finance.verifyCustomerCashierDetail(stringDetail,stringIntent);assert.throws(()=>f.finance.verifyCustomerCashierDetail({...stringDetail,form:null},stringIntent));
    for(const change of [v=>v.form=null,v=>v.form.session_key=uploadKey,v=>v.form.components[0].id='other',v=>v.form.components[0].value=[],v=>{v.form.components[0].value=['/api/assets/52'];v.form.previews[0]={reference:'/api/assets/52',url:v.form.previews[0].url.replace('/51?','/52?')};}]){const mutated=clone(d);change(mutated);assert.throws(()=>f.finance.verifyCustomerCashierDetail(mutated,intent));}
  }finally{f.r.stop();}
});

