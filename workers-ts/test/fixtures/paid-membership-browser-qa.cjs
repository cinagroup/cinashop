const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const dist = path.resolve(__dirname, '../../../view/admin-ts/dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) throw Error('Built Admin dist required');
const keys = ['member_card_status', 'svip_price_status'];
let settings = { member_card_status: 1, svip_price_status: 1 };
let serial = 0, writes = 0, reads = 0;
const revision = () => crypto.createHash('sha256').update('paid-membership-browser-' + serial).digest('hex');
function json(res, body) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' });
  res.end(JSON.stringify(body));
}
const envelope = (res, status, data, msg = 'ok') => json(res, { status, msg, data });
const bootstrap = `<!doctype html><html><meta charset="utf-8"><title>Local paid membership QA</title><body><h1>付费会员功能 本机合成夹具</h1><button id="manager" onclick="enter('manager')">管理员进入</button><button id="reader" onclick="enter('reader')">只读进入</button><script>
function enter(role){const session={userInfo:{id:role==='manager'?1:2,account:role,head_pic:'',real_name:'本机合成',level:1,roles:''},menus:[{id:1,pid:0,path:'/config',name:'系统配置',icon:'',sort:1,type:1,children:[]}],uniqueAuth:role==='manager'?['config.view','config.manage']:['config.view']};localStorage.setItem('admin_token','synthetic-'+role);localStorage.setItem('admin_session',JSON.stringify(session));location.href='/config/paid-membership';}
</script></body></html>`;
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/bootstrap') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(bootstrap); return; }
  if (url.pathname === '/__qa/health') return json(res, { writes, reads, revision: revision(), settings });
  if (url.pathname === '/adminapi/config/paid-membership' && req.method === 'GET') {
    reads++;
    return envelope(res, 200, { settings, raw_values: Object.fromEntries(keys.map(key => [key, String(settings[key])])),
      missing_keys: [], issues: [], revision: revision() });
  }
  if (url.pathname === '/adminapi/config/paid-membership' && req.method === 'POST') {
    const parts = []; for await (const chunk of req) parts.push(chunk);
    let input; try { input = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { return envelope(res, 400, null, 'JSON无效'); }
    if (req.headers['authori-zation'] !== 'Bearer synthetic-manager') return envelope(res, 400011, null, '没有权限');
    if (input.revision !== revision()) return envelope(res, 409, null, '版本已变化');
    if (keys.some(key => input[key] !== 0 && input[key] !== 1)) return envelope(res, 400, null, '开关无效');
    settings = Object.fromEntries(keys.map(key => [key, input[key]])); serial++; writes++;
    return envelope(res, 200, { committed: true, revision: revision(), request_id: input.request_id, cache_status: 'cleared' });
  }
  if (url.pathname.startsWith('/adminapi/')) return envelope(res, 200, []);
  const candidate = path.resolve(dist, '.' + decodeURIComponent(url.pathname));
  const file = candidate.startsWith(path.resolve(dist) + path.sep) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
    ? candidate : path.join(dist, 'index.html');
  res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: server.address().port, dist })));
