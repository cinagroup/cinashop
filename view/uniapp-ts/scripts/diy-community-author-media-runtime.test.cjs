const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {setup,answer,root}=require('./diy-commerce-fixture.cjs');
const now=Date.UTC(2026,9,25,4),signature='s'.repeat(43),asset=(expires=now+900000,id=7)=>`/api/assets/${id}?expires=${Math.floor(expires/1000)}&signature=${signature}`;
const block=(url=asset())=>({name:'community',timestamp:17,isHide:true,imgConfig:{url,link:asset(),extra:{empty:[]}},posts:[{image:asset(),author_image:asset(),sliderImage:[asset()]}],selectConfig:{activeValue:'999',list:[{image:asset()}]},opaque:{imgConfig:{url:asset()}}});
function run(fn){const r=setup('coupon',answer,{props:{active:false}}),m=r.load(path.join(root,'src/utils/diyEditorialMediaLease.ts')),old=Date.now;Date.now=()=>now;try{fn(r,m);}finally{Date.now=old;r.stop();}}
test('community actual dormant title-image lease defines earliest deadline without mutation',()=>run((r,m)=>{
 const page={value:[block()]},before=JSON.stringify(page);assert.equal(m.diyEditorialMediaDeadline(page,now,now),now+840000);assert.equal(m.diyEditorialMediaCacheUsable(page,now,now),true);
 page.value[0].imgConfig.url=asset(now+100000);assert.equal(m.diyEditorialMediaDeadline(page,now,now),now+40000);page.value[0].imgConfig.url=asset(now-1);assert.equal(m.diyEditorialMediaCacheUsable(page,now,now),false);page.value[0].imgConfig.url=asset();assert.equal(JSON.stringify(page),before);assert.deepEqual(r.calls,[]);
}));
test('renewal alone preserves authored fingerprint; title image identity and all opaque fields remain exact',()=>run((r,m)=>{
 const initial=block(),fp=m.diyAuthoredPageFingerprint([initial]),renewed=structuredClone(initial);renewed.imgConfig.url=asset(now+800000);assert.equal(m.diyAuthoredPageFingerprint([renewed]),fp);
 for(const mutate of [b=>b.imgConfig.url=asset(now+800000,8),b=>b.posts[0].image=asset(now+800000),b=>b.posts[0].author_image=asset(now+800000),b=>b.posts[0].sliderImage[0]=asset(now+800000),b=>b.imgConfig.link=asset(now+800000),b=>b.selectConfig.list[0].image=asset(now+800000),b=>b.opaque.imgConfig.url=asset(now+800000)]){const next=structuredClone(renewed);mutate(next);assert.notEqual(m.diyAuthoredPageFingerprint([next]),fp);}assert.deepEqual(r.calls,[]);
}));
test('unsigned, malformed, duplicate and expired actual-slot tickets refuse cache reuse',()=>run((r,m)=>{
 for(const url of ['/api/assets/7',asset(now-1),asset(now+60000),asset().replace('&signature='+signature,''),asset()+'&expires=1',asset()+'&%65xpires=1',asset()+'&signature='+signature,asset()+'&%73ignature='+signature]){const page={value:[block(url)]},before=JSON.stringify(page);assert.equal(m.diyEditorialMediaCacheUsable(page,now,now),false,url);assert.equal(JSON.stringify(page),before);}assert.deepEqual(r.calls,[]);
}));
test('public API rows, arbitrary snapshots, case variants and malformed holders confer no lease',()=>run((r,m)=>{
 const rows=[{name:'Community',imgConfig:{url:asset(now-1)}},{name:'community',imgConfig:[{url:asset(now-1)}],posts:[{image:asset(now-1),author_image:asset(now-1),sliderImage:[asset(now-1)]}],opaque:{imgConfig:{url:asset(now-1)}}},{name:'unknown',child:block(asset(now-1))}],before=JSON.stringify(rows);assert.equal(m.diyEditorialMediaDeadline({value:rows},now,now),Infinity);assert.equal(JSON.stringify(rows),before);assert.deepEqual(r.calls,[]);
}));
