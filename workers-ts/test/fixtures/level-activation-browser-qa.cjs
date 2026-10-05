const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const dist = path.resolve(__dirname, '../../../view/admin-ts/dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) throw Error('Built Admin dist required');
const keys = ['member_func_status', 'level_activate_status', 'level_extend_info', 'level_integral_status',
  'level_give_integral', 'level_money_status', 'level_give_money', 'level_coupon_status', 'level_give_coupon'];
const profileA = 'a'.repeat(64), profileB = 'b'.repeat(64), couponVersion = 'c'.repeat(64);
const definition = (info, tip, format, label, param, singlearr, sort) =>
  ({ info, tip, format, label, param, single: '', singlearr, use: 0, user_show: 0, sort });
const profileOptions = [
  { field_key: profileA, source: 'default', definition: definition('姓名', '请填写姓名', 'text', '文本', 'real_name', [], 1), selectable: true, issues: [], raw: null },
  { field_key: profileB, source: 'base', definition: definition('餐食', '请选择餐食', 'radio', '单选项', '', ['标准', '素食'], 2), selectable: true, issues: [], raw: null },
];
const coupon = (id, title, discount_type, coupon_price, effective_pay_percent) => ({ id, title, discount_type,
  coupon_price, use_min_price: '20.00', effective_pay_percent, scope_type: 0, category: 0, app_type: 0,
  status: 1, deleted: false, is_permanent: 0, remain_count: 5, receive_type: 3,
  start_time: null, end_time: null, use_start_time: null, use_end_time: null,
  valid_days: 7, revision: couponVersion, selectable: true, issues: [] });
const coupons = [coupon(1, '会员激活满减券', 1, '5.00', null), coupon(2, '会员激活折扣券', 2, '85.99', 85)];
let settings = { member_func_status: 1, level_activate_status: 1,
  level_extend_info: [{ field_key: profileA, required: 1 }], level_integral_status: 1,
  level_give_integral: 7, level_money_status: 1, level_give_money: '3', level_coupon_status: 1, level_give_coupon: [1] };
let serial = 0, writes = 0, reads = 0, optionReads = 0;
const revision = () => crypto.createHash('sha256').update('level-activation-browser-' + serial).digest('hex');
const envelope = (res, status, data, msg = 'ok') => json(res, { status, msg, data });
function json(res, body, code = 200) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'private, no-store', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(body)); }
function current() {
  return { settings, revision: revision(), missing_keys: [], issues: [],
    raw_values: Object.fromEntries(keys.map(key => [key, JSON.stringify(settings[key])])),
    effective: { member_enabled: !!settings.member_func_status, activation_required: !!settings.level_activate_status,
      integral_enabled: !!settings.level_integral_status, integral: settings.level_give_integral,
      money_enabled: !!settings.level_money_status, money_units: settings.level_give_money,
      coupon_enabled: !!settings.level_coupon_status, coupon_ids: settings.level_give_coupon,
      gift_active: !!(settings.member_func_status && settings.level_activate_status && settings.level_coupon_status) },
    profile_options: profileOptions, selected_coupons: settings.level_give_coupon.map(id => coupons.find(row => row.id === id)),
    limits: { fields: 64, coupons: 100, config_value_characters: 5000, template_characters: 200,
      integral_max: 2147483647, money_max: '9999999999' } };
}
const bootstrap = `<!doctype html><html><meta charset="utf-8"><title>Local activation QA</title><body><h1>普通等级卡激活 本机合成夹具</h1><button id="manager" onclick="enter('manager')">管理员进入</button><button id="reader" onclick="enter('reader')">只读进入</button><script>
function enter(role){const session={userInfo:{id:role==='manager'?1:2,account:role,head_pic:'',real_name:'本机合成',level:1,roles:''},menus:[{id:1,pid:0,path:'/config',name:'系统配置',icon:'',sort:1,type:1,children:[]}],uniqueAuth:role==='manager'?['config.view','config.manage']:['config.view']};localStorage.setItem('admin_token','synthetic-'+role);localStorage.setItem('admin_session',JSON.stringify(session));location.href='/config/level-activation';}
</script></body></html>`;
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/bootstrap') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(bootstrap); return; }
  if (url.pathname === '/__qa/health') return json(res, { writes, reads, optionReads, revision: revision(), settings });
  if (url.pathname === '/adminapi/config/level-activation' && req.method === 'GET') { reads++; return envelope(res, 200, current()); }
  if (url.pathname === '/adminapi/config/level-activation/coupons' && req.method === 'GET') {
    optionReads++; const page = Number(url.searchParams.get('page') || 1), limit = Number(url.searchParams.get('limit') || 10);
    const keyword = String(url.searchParams.get('keyword') || '').trim(); const list = keyword
      ? coupons.filter(row => row.title.includes(keyword) || String(row.id) === keyword) : coupons;
    return envelope(res, 200, { list: list.slice((page - 1) * limit, page * limit), count: list.length, page, limit });
  }
  if (url.pathname === '/adminapi/config/level-activation' && req.method === 'POST') {
    const parts = []; for await (const chunk of req) parts.push(chunk);
    let input; try { input = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { return envelope(res, 400, null, 'JSON无效'); }
    if (req.headers['authori-zation'] !== 'Bearer synthetic-manager') return envelope(res, 400011, null, '没有权限');
    if (input.revision !== revision()) return envelope(res, 400, null, '版本已变化');
    if (keys.some(key => !Object.hasOwn(input, key))) return envelope(res, 400, null, '九键不完整');
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
