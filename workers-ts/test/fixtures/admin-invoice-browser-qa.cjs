const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Synthetic, local-only Admin fixture. It never connects to production.
const dist = path.resolve(__dirname, '../../../view/admin-ts/dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) throw Error('Built Admin dist required');
let serial = 0, writes = 0, reads = 0, detailReads = 0;
const initial = () => ({ id: 31, order_db_id: 21, order_number: 'qa-order-21', template_id: 14, uid: 7, is_invoice: 0,
  invoice_number: '', invoice_amount: '12.00', expected_amount: '12.00', remark: '', invoice_time: 0, is_pay: 1, is_refund: 0,
  is_del: 0, add_time: 1790535600, header_type: 2, type: 1, name: '本机测试企业', duty_number: '91310000',
  drawer_phone: '13800000000', email: 'test@example.com', tell: '02112345678', address: '上海市', bank: '测试银行',
  card_number: '0123456789', order: { id: 21, order_number: 'qa-order-21', pay_price: '12.00', paid: 1,
    refund_status: 0, status: 0, pid: 0, add_time: 1790535500, real_name: '订单张三', user_phone: '13900000000' }, issues: [], can_process: true });
let normal = initial();
const diagnostic = { ...initial(), id: 32, order_db_id: 404, order_number: null, invoice_amount: '0.00', expected_amount: null,
  order: null, is_invoice: 8, issues: ['关联订单不存在', '历史开票状态异常'], can_process: false };
const revision = () => crypto.createHash('sha256').update(`invoice-qa-${serial}`).digest('hex');
const row = value => ({ ...value, revision: revision() });
function json(res, body) { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' }); res.end(JSON.stringify(body)); }
const envelope = (res, status, data, msg = 'ok') => json(res, { status, msg, data });
const bootstrap = `<!doctype html><html><meta charset="utf-8"><title>Local invoice QA</title><body><h1>发票管理本机合成夹具</h1><button id="manager" onclick="enter('manager')">管理员进入</button><button id="reader" onclick="enter('reader')">只读进入</button><script>
function enter(role){const session={userInfo:{id:role==='manager'?1:2,account:role,head_pic:'',real_name:'本机合成',level:1,roles:''},menus:[{id:1,pid:0,path:'/order/invoice',name:'发票管理',icon:'',sort:1,type:1,children:[]}],uniqueAuth:role==='manager'?['invoice.view','invoice.manage']:['invoice.view']};localStorage.setItem('admin_token','synthetic-'+role);localStorage.setItem('admin_session',JSON.stringify(session));location.href='/order/invoice';}
</script></body></html>`;
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/bootstrap') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(bootstrap); return; }
  if (url.pathname === '/__qa/health') return json(res, { writes, reads, detailReads, revision: revision(), normal });
  if (url.pathname === '/adminapi/order/invoices' && req.method === 'GET') {
    reads++; const page = Number(url.searchParams.get('page') || 1), limit = Number(url.searchParams.get('limit') || 10);
    const keyword = String(url.searchParams.get('keyword') || '').toLowerCase(), status = url.searchParams.get('status') || 'all';
    const matches = [row(normal), row(diagnostic)].filter(item => (!keyword || JSON.stringify(item).toLowerCase().includes(keyword)) &&
      (status === 'all' || (status === 'pending' && item.is_invoice === 0) || (status === 'refunded' && item.is_refund === 1)
        || String(item.is_invoice) === status));
    return envelope(res, 200, { list: page === 1 ? matches.slice(0, limit) : [], count: matches.length, page, limit });
  }
  const detail = /^\/adminapi\/order\/invoices\/(31|32)$/.exec(url.pathname);
  if (detail && req.method === 'GET') { detailReads++; return envelope(res, 200, row(detail[1] === '31' ? normal : diagnostic)); }
  if (url.pathname === '/adminapi/order/invoices/31/process' && req.method === 'POST') {
    const parts = []; for await (const chunk of req) parts.push(chunk);
    let input; try { input = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { return envelope(res, 400, null, 'JSON无效'); }
    if (req.headers['authori-zation'] !== 'Bearer synthetic-manager') return envelope(res, 403, null, '没有权限');
    if (input.revision !== revision()) return envelope(res, 409, null, '版本已变化');
    if (![0, 1, -1].includes(input.is_invoice) || !/^[0-9a-f-]{36}$/.test(input.request_id) ||
      (input.is_invoice === 1 && !/^\d{8,20}$/.test(input.invoice_number)) ||
      (input.is_invoice !== 1 && input.invoice_number !== '') || typeof input.remark !== 'string') return envelope(res, 400, null, '输入无效');
    normal = { ...normal, is_invoice: input.is_invoice, invoice_number: input.invoice_number, remark: input.remark,
      invoice_time: Math.floor(Date.now() / 1000) }; serial++; writes++;
    return envelope(res, 200, { ...row(normal), committed: true, request_id: input.request_id, idempotent: false });
  }
  if (url.pathname.startsWith('/adminapi/')) return envelope(res, 200, []);
  const candidate = path.resolve(dist, '.' + decodeURIComponent(url.pathname));
  const file = candidate.startsWith(path.resolve(dist) + path.sep) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
    ? candidate : path.join(dist, 'index.html');
  res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: server.address().port, dist })));
