const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const source=String.raw`\\tsclient\I\cinagroup\cinashop`;
const target=path.join(__dirname,'cinashop-migration-20261013-HUPOBq');
const manifest=JSON.parse(fs.readFileSync(path.join(target,'input-manifest.json'),'utf8'));
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
const mismatches=[],changed=[];
for(const file of manifest.files){
  const originalHash=hash(fs.readFileSync(path.join(source,file.path)));
  const copiedHash=hash(fs.readFileSync(path.join(target,file.path)));
  if(originalHash!==copiedHash)mismatches.push({path:file.path,sourceSha256:originalHash,copySha256:copiedHash});
  else {if(file.sha256!==originalHash)changed.push(file.path);file.sha256=originalHash;}
}
manifest.manifestSha256=hash(JSON.stringify(manifest.files));
const record={verifiedAt:new Date().toISOString(),source,target,fileCount:manifest.files.length,mismatchCount:mismatches.length,updatedEntries:changed,mismatches,manifestSha256:manifest.manifestSha256};
if(!mismatches.length){
  fs.writeFileSync(path.join(target,'input-manifest.json'),JSON.stringify(manifest,null,2));
  fs.writeFileSync(path.join(__dirname,'validation-input-manifest.json'),JSON.stringify(manifest,null,2));
}
fs.writeFileSync(path.join(target,'input-verification.json'),JSON.stringify(record,null,2));
console.log(JSON.stringify(record));
process.exitCode=mismatches.length?1:0;
