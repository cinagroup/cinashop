const fs=require('node:fs'), path=require('node:path'), cp=require('node:child_process'), crypto=require('node:crypto');
const worker=path.join(__dirname,'cinashop-migration-20261013-HUPOBq','workers-ts');
const prefix=process.argv[2];
if(!/^[a-z0-9-]+$/.test(prefix||''))throw Error('Expected a unique evidence prefix');
const digest=data=>crypto.createHash('sha256').update(data).digest('hex');
const lock=JSON.parse(fs.readFileSync(path.join(worker,'package-lock.json'),'utf8'));
const versions=[], missing=[];
for(const [name, metadata] of Object.entries(lock.packages||{})){
  if(!name.startsWith('node_modules/')||metadata.link)continue;
  const file=path.join(worker,name,'package.json');
  if(!fs.existsSync(file)){missing.push({path:name,optional:!!metadata.optional});continue;}
  const actual=JSON.parse(fs.readFileSync(file,'utf8')).version;
  if(actual!==metadata.version)throw Error(`Installed/locked mismatch: ${name}`);
  versions.push({path:name,version:actual});
}
if(missing.some(item=>!item.optional))throw Error('A required locked package is missing');
const result={startedAt:new Date().toISOString(),worker,node:process.version,nodePath:process.execPath,heapMiB:6144,
  lockSha256:digest(fs.readFileSync(path.join(worker,'package-lock.json'))),installedLockedVersions:versions,missingOptionalPackages:missing,commands:[]};
for(const [label,args] of [['unit',['--noEmit']],['runtime',['-p','tsconfig.runtime-test.json','--noEmit']]]){
  const command=['--max-old-space-size=6144','node_modules/typescript/bin/tsc',...args],startedAt=new Date().toISOString();
  const output=cp.spawnSync(process.execPath,command,{cwd:worker,windowsHide:true,encoding:'utf8',timeout:600000,maxBuffer:10*1024*1024});
  const log=path.join(__dirname,`${prefix}-${label}.txt`),exitFile=path.join(__dirname,`${prefix}-${label}-exit.json`);
  fs.writeFileSync(log,(output.stdout||'')+(output.stderr||''));
  const record={label,command,startedAt,finishedAt:new Date().toISOString(),exitCode:output.status,signal:output.signal,error:output.error?{code:output.error.code,message:output.error.message}:null,log,logSha256:digest(fs.readFileSync(log))};
  fs.writeFileSync(exitFile,JSON.stringify(record,null,2));result.commands.push(record);
  console.log(JSON.stringify(record));
  fs.writeFileSync(path.join(__dirname,`${prefix}-result.json`),JSON.stringify(result,null,2));
  if(output.status!==0){process.exitCode=1;break;}
}
