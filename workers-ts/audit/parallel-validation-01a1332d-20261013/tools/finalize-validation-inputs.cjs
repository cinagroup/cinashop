const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const source=String.raw`\\tsclient\I\cinagroup\cinashop`,target=path.join(__dirname,'cinashop-migration-20261013-HUPOBq');
const digest=x=>crypto.createHash('sha256').update(x).digest('hex');
const manifest=JSON.parse(fs.readFileSync(path.join(target,'input-manifest.json'),'utf8'));
const baseVerification=JSON.parse(fs.readFileSync(path.join(target,'input-verification.json'),'utf8'));
const coordination=JSON.parse(fs.readFileSync(path.join(source,'workers-ts/audit/parallel-validation-01a1332d-20261013/coordination-freeze.json'),'utf8'));
const active=new Map(coordination.files.map(file=>['workers-ts/'+file.path,file.sha256]));
for(const file of baseVerification.mismatches)active.set(file.path,null);
for(const file of manifest.files)if(file.path.includes('/functions/'))active.set(file.path,null);
active.set('workers-ts/audit/observability-policy.json',null);
const byPath=new Map(manifest.files.map(x=>[x.path,x]));
const finalScope=[];
for(const [relative,expected]of active){
  const original=fs.readFileSync(path.join(source,relative)),sourceSha256=digest(original);
  if(expected&&sourceSha256!==expected)throw Error('Source drift after coordination freeze: '+relative);
  const out=path.join(target,relative);
  // Source was frozen for tests; refresh only documentary snapshots/policy.
  if(relative.includes('/docs/')||relative.endsWith('/observability-policy.json')){fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,original);}
  const copySha256=digest(fs.readFileSync(out));
  if(sourceSha256!==copySha256)throw Error('Final input mismatch: '+relative);
  byPath.set(relative,{path:relative,sha256:sourceSha256});
  finalScope.push({path:relative,sourceSha256,copySha256});
}
for(const file of byPath.values()){
  const copied=digest(fs.readFileSync(path.join(target,file.path)));
  if(copied!==file.sha256)throw Error('Local input changed outside resolved final scope: '+file.path);
}
manifest.files=[...byPath.values()].sort((a,b)=>a.path.localeCompare(b.path,'en'));manifest.fileCount=manifest.files.length;manifest.manifestSha256=digest(JSON.stringify(manifest.files));
fs.writeFileSync(path.join(target,'input-manifest-final.json'),JSON.stringify(manifest,null,2));
const record={verifiedAt:new Date().toISOString(),source,target,baseInputCount:baseVerification.fileCount,baseVerification:'input-verification.json',baseMismatches:baseVerification.mismatchCount,resolvedFinalScopeCount:finalScope.length,currentMismatchCount:0,finalInputCount:manifest.fileCount,manifestSha256:manifest.manifestSha256,finalScope};
fs.writeFileSync(path.join(target,'input-verification-final.json'),JSON.stringify(record,null,2));
console.log(JSON.stringify({finalInputCount:manifest.fileCount,resolvedFinalScopeCount:finalScope.length,currentMismatchCount:0,manifestSha256:manifest.manifestSha256}));
