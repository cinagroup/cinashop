const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=__dirname,local=path.join(root,'cinashop-migration-20261013-HUPOBq'),source=String.raw`\\tsclient\I\cinagroup\cinashop`;
const label=process.argv[2];if(!/^[a-z0-9-]+$/.test(label||''))throw Error('Unique local snapshot label required');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex'),paths=new Set();
function visit(directory){if(!fs.existsSync(directory))return;for(const entry of fs.readdirSync(directory,{withFileTypes:true})){if(['node_modules','dist','.git','.cache','.wrangler','docs','audit'].includes(entry.name))continue;const file=path.join(directory,entry.name);if(entry.isDirectory())visit(file);else paths.add(path.relative(local,file).replaceAll('\\','/'));}}
const worker=path.join(local,'workers-ts');for(const directory of ['src','test','scripts','migrations','vendor'])visit(path.join(worker,directory));visit(path.join(local,'functions'));
for(const entry of fs.readdirSync(worker,{withFileTypes:true}))if(entry.isFile()&&/^(?:package(?:-lock)?\.json|tsconfig.*\.json|vitest.*\.[cm]?ts|vite\.config\.ts|wrangler\.toml|.*\.d\.ts|index\.html)$/.test(entry.name))paths.add('workers-ts/'+entry.name);
for(const row of JSON.parse(fs.readFileSync(path.join(root,'share-worker-types-3-inputs.json'),'utf8')).files)if(!row.path.startsWith('workers-ts/')&&!row.path.startsWith('functions/'))paths.add(row.path);
for(const name of ['router/index.ts','layouts/AdminLayout.vue','pages/content/WechatQrcode.vue','pages/content/WechatContent.vue'])paths.add('view/admin-ts/src/'+name);
const front=JSON.parse(fs.readFileSync(path.join(root,'private-share-raw-barcode-inputs-writeback-20261013.json'),'utf8'));
for(const row of front.rows||[]){const full=path.resolve(local,'view/uniapp-ts',row.path);if(!full.startsWith(local+path.sep))throw Error('Frontend snapshot escaped workspace');paths.add(path.relative(local,full).replaceAll('\\','/'));}
const ts=require(path.join(worker,'node_modules/typescript')),pending=[...paths],seen=new Set(),missing=[];
while(pending.length){const relative=pending.pop();if(seen.has(relative)||!/[.][cm]?[jt]sx?$/.test(relative))continue;seen.add(relative);
 for(const entry of ts.preProcessFile(fs.readFileSync(path.join(local,relative),'utf8'),true,true).importedFiles){if(!entry.fileName.startsWith('.'))continue;
  const target=path.resolve(local,path.dirname(relative),entry.fileName);if(!target.startsWith(local+path.sep)||target.includes(path.sep+'node_modules'+path.sep))continue;
  const alternatives=['','.ts','.tsx','.d.ts','.js','.mjs','.cjs','.json','.vue','/index.ts','/index.js'].map(suffix=>target+suffix);if(target.endsWith('.js'))alternatives.push(target.slice(0,-3)+'.ts',target.slice(0,-3)+'.d.ts');
  const found=alternatives.find(file=>fs.existsSync(file)&&fs.statSync(file).isFile());
  if(!found){missing.push({from:relative,import:entry.fileName});continue;}
  const imported=path.relative(local,found).replaceAll('\\','/');if(!paths.has(imported)){paths.add(imported);pending.push(imported);}
 }}
if(missing.length)throw Error('Unresolved literal relative imports: '+JSON.stringify(missing));
const files=[...paths].sort().map(relative=>({path:relative,sha256:hash(fs.readFileSync(path.join(local,relative)))}));
const owned=new Set(['workers-ts/src/services/store/DeliveryOrderWriteoffService.ts','workers-ts/test/delivery-workbench-writeoff-postgres.test.ts','workers-ts/src/services/customer-work/CustomerWorkWriteoffProtocol.ts','workers-ts/test/customer-work-writeoff-postgres.test.ts','view/common/customerWorkWriteoff.ts','view/uniapp-ts/src/utils/privateShareScan.ts','view/uniapp-ts/scripts/private-share-scanner-runtime.test.cjs']);
const related=JSON.parse(fs.readFileSync(path.join(source,'workers-ts/audit/legacy-share-final-native-01a1332d-20261013/share-native-eight-final-stage-1-before.json'),'utf8')).directCurrentSourceScope;
if(!Array.isArray(related)||related.length!==33)throw Error('Historical actual direct source scope missing');
const matches=[...owned].sort().map(relative=>({path:relative,localSha256:hash(fs.readFileSync(path.join(local,relative))),sourceSha256:hash(fs.readFileSync(path.join(source,relative)))}));
const sourceRelated=related.map(({path:relative})=>({path:relative,localSha256:hash(fs.readFileSync(path.join(local,relative))),sourceSha256:hash(fs.readFileSync(path.join(source,relative)))}));
const record={capturedAt:new Date().toISOString(),scope:'Independent frozen LOCAL complete Worker/Functions, actual local literal relative type closure and current 65 scanner scope. Main new batch source is active; no full current repository parity is claimed.',local,source,files,fileCount:files.length,localManifestSha256:hash(JSON.stringify(files)),literalRelativeClosureScanned:seen.size,directOwnedSource:matches,directSourceMismatches:matches.filter(r=>r.localSha256!==r.sourceSha256),historicalRelatedScopeCurrentComparison:sourceRelated,relatedSourceMismatches:sourceRelated.filter(r=>r.localSha256!==r.sourceSha256)};
fs.writeFileSync(path.join(root,label+'.json'),JSON.stringify(record,null,2));console.log(JSON.stringify({fileCount:files.length,localManifestSha256:record.localManifestSha256,directSourceCount:matches.length,directSourceMismatches:record.directSourceMismatches}));if(record.directSourceMismatches.length)process.exitCode=1;
