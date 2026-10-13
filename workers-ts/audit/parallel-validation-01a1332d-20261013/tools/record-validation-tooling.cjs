const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const target=path.join(__dirname,'cinashop-migration-20261013-HUPOBq'),source=String.raw`\\tsclient\I\cinagroup\cinashop`;
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const packages=[];
for(const relative of ['workers-ts','view/admin-ts','view/uniapp-ts','view/kefu-ts']){
  const lock=read(path.join(target,relative,'package-lock.json'));
  const originalSha256=hash(fs.readFileSync(path.join(source,relative,'package-lock.json'))),copiedSha256=hash(fs.readFileSync(path.join(target,relative,'package-lock.json')));
  if(originalSha256!==copiedSha256)throw Error('Lock mismatch');
  const keys=relative==='workers-ts'?['vitest','vite','typescript','tsx','drizzle-orm','postgres','@electric-sql/pglite','@cloudflare/vitest-plugin','@cloudflare/workers-types','esbuild']:relative==='view/uniapp-ts'?['vue','vue-tsc','typescript','vite']:['vue','@vue/compiler-sfc'];
  const installed=[];
  for(const key of keys){const filename=path.join(target,relative,'node_modules',key,'package.json');if(!fs.existsSync(filename))continue;const actual=read(filename).version,expected=lock.packages['node_modules/'+key]?.version;if(actual!==expected)throw Error('Installed lock version mismatch: '+relative+'/'+key);installed.push({package:key,version:actual,lockedVersion:expected});}
  packages.push({path:relative,originalLockSha256:originalSha256,copiedLockSha256:copiedSha256,installed});
}
const pg='C:/Users/cina/.codex/visualizations/2026/10/11/01a12a82-4fc9-7511-aac5-e8957b4e7f1f/customer-cashier-images-validation/native-tools/pgsql/bin';
const record={recordedAt:new Date().toISOString(),node:process.version,npm:read('C:/Program Files/nodejs/node_modules/npm/package.json').version,dependencyPolicy:'Copied existing installed dependencies from same-lock local snapshots; no installation or lock/dependency edits.',packages,postgresBin:pg,postgresBinaries:['postgres','initdb','pg_ctl','psql'].map(name=>({name:name+'.exe',sha256:hash(fs.readFileSync(path.join(pg,name+'.exe')))}))};
const result=cp.spawnSync(path.join(pg,'postgres.exe'),['--version'],{encoding:'utf8',windowsHide:true,timeout:10000});record.postgresVersionCommand={status:result.status,stdout:result.stdout?.trim(),stderr:result.stderr?.trim(),errorCode:result.error?.code??null};
fs.writeFileSync(path.join(target,'toolchain-locks.json'),JSON.stringify(record,null,2));
console.log(JSON.stringify(record));
