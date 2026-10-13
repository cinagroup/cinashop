const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const source = String.raw`\\tsclient\I\cinagroup\cinashop`;
const temp = __dirname;
if (!path.isAbsolute(temp) || temp.startsWith('\\\\')) throw Error('Absolute local validation directory required');
const rootFile = path.join(__dirname, 'validation-root.json');
let target;
if (process.argv.includes('--refresh')) target = JSON.parse(fs.readFileSync(rootFile, 'utf8')).target;
else {
  target = fs.mkdtempSync(path.join(temp, 'cinashop-migration-20261013-'));
  fs.writeFileSync(rootFile, JSON.stringify({source, target}, null, 2));
}
if (!path.resolve(target).startsWith(path.resolve(temp) + path.sep)) throw Error('Target outside fixed TEMP');
const files = [];
const excluded = new Set(['node_modules', '.git', '.cache', '.wrangler', 'dist', 'coverage', 'test-results', 'playwright-report']);
const secret = name => /^\.env(?:\.|$)|^\.dev\.vars(?:\.|$)/.test(name);
const add = file => {
  const rel = path.relative(source, file);
  const destination = path.join(target, rel);
  const content = fs.readFileSync(file);
  fs.mkdirSync(path.dirname(destination), {recursive:true});
  fs.writeFileSync(destination, content);
  const digest = b => crypto.createHash('sha256').update(b).digest('hex');
  const hash = digest(content);
  if (digest(fs.readFileSync(destination)) !== hash) throw Error('Copied input mismatch: ' + rel);
  files.push({path:rel.replaceAll('\\','/'), sha256:hash});
};
const walk = directory => {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, {withFileTypes:true})) {
    if (excluded.has(entry.name) || secret(entry.name)) continue;
    const file = path.join(directory,entry.name);
    if (entry.isSymbolicLink()) throw Error('Source symbolic link needs review: ' + file);
    if (entry.isDirectory()) walk(file);
    else if (entry.isFile()) add(file);
  }
};
for (const dir of ['workers-ts/src','workers-ts/test','workers-ts/scripts','workers-ts/migrations','workers-ts/vendor','workers-ts/docs']) walk(path.join(source,dir));
for (const dir of ['workers-ts', 'view/admin-ts', 'view/supplier-ts', 'view/uniapp-ts', 'view/pc-ts', 'view/kefu-ts']) {
  const packageRoot = path.join(source,dir);
  if (!fs.existsSync(packageRoot)) continue;
  for (const entry of fs.readdirSync(packageRoot,{withFileTypes:true})) {
    if (entry.isFile() && !secret(entry.name) && /\.(?:[cm]?[jt]s|jsonc?|toml|md)$/.test(entry.name)) add(path.join(packageRoot,entry.name));
  }
  if (dir.startsWith('view/')) for (const child of ['src','scripts','test','vendor','public','functions']) walk(path.join(packageRoot,child));
}
for (const dir of ['view/common','view/shared']) walk(path.join(source,dir));
for (const rel of ['workers-ts/audit/legacy-route-decisions.json','workers-ts/audit/legacy-route-authority.json']) add(path.join(source,rel));
files.sort((a,b)=>a.path.localeCompare(b.path,'en'));
const manifest = {source,target,fileCount:files.length,manifestSha256:crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex'),files};
fs.writeFileSync(path.join(target,'input-manifest.json'),JSON.stringify(manifest,null,2));
fs.writeFileSync(path.join(__dirname,'validation-input-manifest.json'),JSON.stringify(manifest,null,2));
console.log(JSON.stringify({target,fileCount:files.length,manifestSha256:manifest.manifestSha256}));
