const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const source=String.raw`\\tsclient\I\cinagroup\cinashop`,target=path.join(__dirname,'cinashop-migration-20261013-HUPOBq');
const manifest=JSON.parse(fs.readFileSync(path.join(target,'input-manifest.json'),'utf8'));
const byPath=new Map(manifest.files.map(x=>[x.path,x]));
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
let added=0;
function copy(dir){if(!fs.existsSync(dir))return;for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
  if(/^\.env|^\.dev\.vars/.test(entry.name))continue;
  const file=path.join(dir,entry.name);
  if(entry.isDirectory())copy(file);else if(entry.isFile()){
    const relative=path.relative(source,file).replaceAll('\\','/'),out=path.join(target,relative),data=fs.readFileSync(file);
    fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,data);
    if(hash(fs.readFileSync(out))!==hash(data))throw Error('Copied function mismatch');
    if(!byPath.has(relative))added++;byPath.set(relative,{path:relative,sha256:hash(data)});
  }
}}
for(const name of ['admin-ts','kefu-ts','pc-ts','uniapp-ts','supplier-ts'])copy(path.join(source,'view',name,'functions'));
manifest.files=[...byPath.values()].sort((a,b)=>a.path.localeCompare(b.path,'en'));manifest.fileCount=manifest.files.length;manifest.manifestSha256=hash(JSON.stringify(manifest.files));
fs.writeFileSync(path.join(target,'input-manifest.json'),JSON.stringify(manifest,null,2));
console.log(JSON.stringify({added,fileCount:manifest.fileCount,manifestSha256:manifest.manifestSha256}));
