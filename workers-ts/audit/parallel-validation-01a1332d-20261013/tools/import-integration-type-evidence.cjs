const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const source=String.raw`\\tsclient\I\cinagroup\cinashop`,local=path.join(__dirname,'cinashop-migration-20261013-HUPOBq');
const audit=path.join(source,'workers-ts/audit'),out=path.join(audit,'parallel-validation-01a1332d-20261013');
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const read=name=>JSON.parse(fs.readFileSync(path.join(audit,name),'utf8'));
const before=read('parallel-migration-named-zone-before-20261013.json'),after=read('parallel-migration-named-zone-after-20261013.json');
const expectedDigest='70113864d3905ea6e8a009d75c98445a6bf58d4c73095f7f6f3f5f593a923aa4';
if(before.count!==3896||after.count!==3896||before.inputs.length!==3896||after.inputs.length!==3896||before.sourceDigest!==expectedDigest||after.sourceDigest!==expectedDigest||before.mismatches.length||after.mismatches.length||JSON.stringify(before.inputs)!==JSON.stringify(after.inputs))throw Error('Integration before/after scope mismatch');
const own=JSON.parse(fs.readFileSync(path.join(local,'input-manifest-integration-final.json'),'utf8'));
const ownMap=new Map(own.files.map(file=>[file.path,file.sha256]));
const rootMap=new Map(after.inputs.map(file=>[path.posix.normalize('workers-ts/'+file.file.replaceAll('\\','/')),file.sha256]));
const required=new Map([
 ['workers-ts/src/services/admin/AdminLegacySystemLogService.ts','54a4043ce802e364ef67b2fb4635f5906174793e76c98c15c44d56cf78391a5b'],
 ['workers-ts/test/admin-legacy-system-log.test.ts','d8d1166483d93db86870c6318e7293830a2c1eea298571f39e3e0eb41fb902f1'],
 ['workers-ts/test/admin-legacy-system-log-native.test.ts','ba36cd5de6dc752306d80246759f75904dd00a28d9c4d729d2c3fc0c8252113a'],
]);
const freeze=JSON.parse(fs.readFileSync(path.join(out,'coordination-freeze-final.json'),'utf8'));
for(const file of freeze.files)required.set('workers-ts/'+file.path,file.sha256);
for(const relative of ['workers-ts/package-lock.json','workers-ts/tsconfig.json','workers-ts/tsconfig.runtime-test.json','workers-ts/package.json','view/admin-ts/package-lock.json','view/uniapp-ts/package-lock.json','view/kefu-ts/package-lock.json'])required.set(relative,ownMap.get(relative));
const requiredProof=[];
for(const [file,expected]of required){if(!expected||rootMap.get(file)!==expected||ownMap.get(file)!==expected)throw Error('Integration required source/config/lock mismatch: '+file);requiredProof.push({path:file,sha256:expected});}
const commonMismatches=[],documentaryDifferences=[];
let commonInputCount=0;
for(const[file,sha256]of rootMap){if(!ownMap.has(file))continue;commonInputCount++;if(ownMap.get(file)!==sha256){const mismatch={path:file,integrationSha256:sha256,localSnapshotSha256:ownMap.get(file)};if(file.endsWith('.md'))documentaryDifferences.push(mismatch);else commonMismatches.push(mismatch);}}
if(commonMismatches.length)throw Error('Common source/lock input mismatch: '+JSON.stringify(commonMismatches));
const exits=read('parallel-zone-typecheck-exits-20261013.json');
if(exits.unit!==0||exits.runtime!==0)throw Error('Integration typecheck exit failure');
const evidence=[];
fs.mkdirSync(path.join(out,'integrated-types'),{recursive:true});
for(const name of ['parallel-migration-named-zone-before-20261013.json','parallel-migration-named-zone-after-20261013.json','parallel-zone-typecheck-exits-20261013.json','parallel-zone-typecheck-unit-20261013.log','parallel-zone-typecheck-runtime-20261013.log']){
 const data=fs.readFileSync(path.join(audit,name));if(name.endsWith('.log')&&data.length!==0)throw Error('Unexpected nonempty typecheck log');
 fs.writeFileSync(path.join(out,'integrated-types',name),data);evidence.push({path:'integrated-types/'+name,bytes:data.length,sha256:hash(data)});
}
const record={verifiedAt:new Date().toISOString(),source:'Coordinating integration root actual execution evidence; no typecheck rerun in this agent.',validForIntegrationFinalScope:true,unitStatus:0,runtimeStatus:0,beforeCheckedAt:before.checkedAt,afterCheckedAt:after.checkedAt,inputCount:3896,sourceDigest:expectedDigest,mismatchCount:0,commonInputCount,commonSourceLockMismatchCount:0,documentaryDifferences,requiredProof,evidence};
fs.writeFileSync(path.join(out,'types-provenance.json'),JSON.stringify(record,null,2));
console.log(JSON.stringify({unitStatus:0,runtimeStatus:0,inputCount:3896,commonInputCount,commonSourceLockMismatchCount:0,documentaryDifferenceCount:documentaryDifferences.length,sourceDigest:expectedDigest}));
