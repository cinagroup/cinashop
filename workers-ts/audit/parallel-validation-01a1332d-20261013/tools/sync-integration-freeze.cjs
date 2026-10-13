const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const source=String.raw`\\tsclient\I\cinagroup\cinashop`,local=path.join(__dirname,'cinashop-migration-20261013-HUPOBq');
const evidence=path.join(source,'workers-ts/audit/parallel-validation-01a1332d-20261013');
const original=JSON.parse(fs.readFileSync(path.join(evidence,'coordination-freeze.json'),'utf8'));
const finalHashes=new Map([
 ['src/services/admin/AdminLegacySystemLogService.ts','54a4043ce802e364ef67b2fb4635f5906174793e76c98c15c44d56cf78391a5b'],
 ['test/admin-legacy-system-log.test.ts','d8d1166483d93db86870c6318e7293830a2c1eea298571f39e3e0eb41fb902f1'],
 ['test/admin-legacy-system-log-native.test.ts','ba36cd5de6dc752306d80246759f75904dd00a28d9c4d729d2c3fc0c8252113a'],
]);
const digest=x=>crypto.createHash('sha256').update(x).digest('hex');
const records=[];
for(const file of original.files){
 const sourcePath=path.join(source,'workers-ts',file.path),targetPath=path.join(local,'workers-ts',file.path);
 const data=fs.readFileSync(sourcePath),sourceSha256=digest(data),beforeCopySha256=digest(fs.readFileSync(targetPath));
 const expected=finalHashes.get(file.path)??file.sha256;
 if(sourceSha256!==expected)throw Error('Unexpected source drift: '+file.path);
 if(finalHashes.has(file.path))fs.writeFileSync(targetPath,data);
 const afterCopySha256=digest(fs.readFileSync(targetPath));
 if(afterCopySha256!==expected)throw Error('Final source-copy mismatch: '+file.path);
 if(!finalHashes.has(file.path)&&beforeCopySha256!==file.sha256)throw Error('Other 14 copied shared inputs changed: '+file.path);
 records.push({path:file.path,previousCoordinatedSha256:file.sha256,sha256:expected,sourceSha256,beforeCopySha256,afterCopySha256,updated:finalHashes.has(file.path)});
}
const record={thread:original.thread,observedAt:new Date().toISOString(),sharedSourceEditing:'frozen',coordinationThread:original.coordinationThread,scope:'Final integration root supplied three changed hashes; other fourteen shared source inputs must remain identical before and after copying.',files:records};
fs.writeFileSync(path.join(evidence,'coordination-freeze-final.json'),JSON.stringify(record,null,2));
const manifest=JSON.parse(fs.readFileSync(path.join(local,'input-manifest-final.json'),'utf8'));
for(const file of manifest.files){const expected=finalHashes.get(file.path.replace(/^workers-ts\//,''));if(expected)file.sha256=expected;}
manifest.manifestSha256=digest(JSON.stringify(manifest.files));
fs.writeFileSync(path.join(local,'input-manifest-integration-final.json'),JSON.stringify(manifest,null,2));
console.log(JSON.stringify({copiedFinalFiles:3,otherSharedInputsUnchanged:14,manifestSha256:manifest.manifestSha256}));
