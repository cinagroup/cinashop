import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Permanent opt-in driver. The parent owns HTTP/SQL and supplies short-lived
// fixture JWTs; this process never receives a database URL or host credential.
let browser, closing;
const pending = new Map();
const close = () => closing ??= (async () => { await browser?.close(); })();
const checkpoint = name => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(Error('SQL checkpoint timeout: ' + name)), 20000);
  pending.set(name, { resolve: data => { clearTimeout(timeout); pending.delete(name); resolve(data); },
    reject: () => { clearTimeout(timeout); pending.delete(name); reject(Error('SQL checkpoint failed: ' + name)); } });
  process.send({ type: 'checkpoint', name });
});
process.on('message', message => {
  if (message?.type === 'stop') void close().finally(() => process.exit(1));
  if (message?.type === 'checkpoint-done') pending.get(message.name)?.resolve(message.data);
  if (message?.type === 'checkpoint-failed') pending.get(message.name)?.reject();
});
process.on('disconnect', () => { void close(); });

async function run(config) {
  assert.equal(config.type, 'start'); assert.match(config.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  for (const key of ['TEST_FINANCE_POSTGRES_URL', 'DATABASE_URL', 'APP_KEY', 'UPSTASH_REDIS_TOKEN', 'CLOUDFLARE_API_TOKEN']) {
    assert.equal(Object.hasOwn(process.env, key), false, 'Browser environment must not contain ' + key);
  }
  assert.ok(['pc', 'mobile'].includes(config.kind));
  const metadata = JSON.parse(readFileSync(config.packageJson, 'utf8')); assert.equal(metadata.name, 'playwright');
  const { chromium, expect } = createRequire(config.packageJson)('playwright/test');
  const pc = config.kind === 'pc', viewport = pc ? { width: 1440, height: 1000 } : { width: 390, height: 844 };
  browser = await chromium.launch({ executablePath: config.executable, headless: true });
  const context = await browser.newContext({ viewport });
  await context.addInitScript(({ pc, token }) => {
    if (pc) { sessionStorage.setItem('pc_token', token); sessionStorage.setItem('pc_uid', '11'); }
    else { localStorage.setItem('uni_token', JSON.stringify({ type: 'string', data: token })); localStorage.setItem('uni_uid', JSON.stringify({ type: 'number', data: 11 })); }
  }, { pc, token: config.token });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  const errors = [], warnings = [], pageErrors = [], failed = [], external = [], writes = [], screenshots = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); if (message.type() === 'warning') warnings.push(message.text()); });
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('requestfailed', request => failed.push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText }));
  let dropped = false;
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== config.baseUrl) { external.push(url.origin + url.pathname); return route.abort(); }
    if (url.pathname === '/api/order/del') {
      const body = request.postDataJSON(); writes.push(body);
      if (body.order_id === config.unpaid && !dropped) {
        dropped = true; const response = await route.fetch();
        assert.equal((await response.json()).status, 200); assert.match(response.headers()['cache-control'], /no-store/);
        // The real transaction has committed. Only its browser response is lost.
        return route.abort('failed');
      }
    }
    return route.continue();
  });
  const listUrl = config.baseUrl + (pc ? '/order' : '/#/pages/order/list');
  const card = id => page.locator('.order-card').filter({ hasText: id });
  const button = (scope, name) => pc ? scope.getByRole('button', { name, exact: true }) : scope.getByText(name, { exact: true });
  const dialog = () => page.locator(pc ? '.el-message-box' : '.uni-modal');
  const screenshot = async name => {
    const path = join(config.output, config.kind + '-joined-' + name + '.png');
    await page.screenshot({ path, fullPage: false, animations: 'disabled' }); screenshots.push(path);
  };
  const open = async id => { await button(card(id), '删除订单').click(); await expect(dialog()).toBeVisible();
    if (!pc) await expect(page.locator('uni-modal')).not.toHaveClass(/uni-fade-enter/); };
  const post = async token => {
    const response = await context.request.post(config.baseUrl + '/api/order/del', { data: { order_id: config.unpaid },
      headers: token ? { 'Authori-zation': 'Bearer ' + token } : {} });
    assert.match(response.headers()['cache-control'], /no-store/); return response.json();
  };
  try {
    await page.goto(listUrl); await expect(page.getByText('已加载 1 笔订单', { exact: true })).toBeVisible();
    assert.equal(page.url(), listUrl); assert.match(await page.title(), pc ? /CinaShop SQL/ : /订单/);
    await expect(page.locator('vite-error-overlay')).toHaveCount(0); await expect(card(config.unpaid)).toBeVisible();
    // Real HTTP/JWT/DB negatives, without replacing the page's current identity.
    assert.notEqual((await post()).status, 200); assert.notEqual((await post(config.foreignToken)).status, 200);
    assert.notEqual((await post('invalid-local-token')).status, 200);
    await open(config.unpaid); await expect(dialog()).toContainText('取消并删除未付款订单');
    await screenshot('confirm'); await button(dialog(), '保留订单').click(); await expect(dialog()).toBeHidden();
    assert.equal(writes.length, 0); await checkpoint('unpaid-kept');
    await open(config.unpaid); await button(dialog(), '确认删除').click();
    await expect(page.locator('.list-error')).toContainText('删除结果尚未确认'); await expect(card(config.unpaid)).toBeVisible();
    if (pc) await expect(button(card(config.unpaid), '删除订单')).toBeDisabled();
    else { await expect(card(config.unpaid).locator('uni-button.delete-btn')).toHaveAttribute('disabled', 'true'); await card(config.unpaid).locator('uni-button.delete-btn').dispatchEvent('click'); }
    assert.equal(writes.length, 1); await checkpoint('unpaid-deleted'); await screenshot('unknown');
    await button(page, '刷新列表核对').click(); await expect(page.getByText('暂无订单', { exact: true })).toBeVisible();
    assert.notEqual((await post(config.token)).status, 200); assert.equal(writes.length, 1);
    const refunded = await checkpoint('unpaid-recovered');
    await button(page, '刷新列表').click(); await expect(page.getByText('已加载 2 笔订单', { exact: true })).toBeVisible();
    await expect(button(card(refunded.selected), '删除订单')).toBeVisible(); await expect(button(card(refunded.remainder), '删除订单')).toHaveCount(0);
    await open(refunded.selected); await expect(dialog()).toContainText('不会发起退款'); await expect(dialog()).toContainText('售后退款记录仍会保留');
    await button(dialog(), '保留订单').click(); await expect(dialog()).toBeHidden(); await checkpoint('refund-kept');
    await open(refunded.selected); await button(dialog(), '确认删除').click(); await expect(card(refunded.selected)).toHaveCount(0);
    await expect(card(refunded.remainder)).toBeVisible(); assert.equal(writes.length, 2); await checkpoint('refunded-deleted');
    await page.reload(); await expect(page.getByText('已加载 1 笔订单', { exact: true })).toBeVisible(); await expect(card(refunded.selected)).toHaveCount(0);
    await page.goto(config.baseUrl + (pc ? '/user/refunds' : '/#/pages/order/refundList'));
    await expect(page.getByText('已加载 1 笔记录', { exact: true })).toBeVisible(); await button(page, '查看详情').click();
    await expect(page.getByText('退款商品', { exact: true })).toBeVisible();
    await expect(page.getByText('完整报价隔离样本', { exact: true })).toBeVisible();
    await expect(page.locator(pc ? '.record-item' : '.item-row')).toContainText('本次申请数量：1');
    await screenshot('retained-history'); await checkpoint('history-read');
    await page.goto(listUrl); await expect(page.getByText('已加载 1 笔订单', { exact: true })).toBeVisible();
    await open(refunded.remainder); await button(dialog(), '确认删除').click();
    await expect(page.locator('.list-error')).toContainText('退款处理中'); await expect(card(refunded.remainder)).toBeVisible();
    assert.equal(writes.length, 3); await checkpoint('pending-rejected'); await screenshot('pending-refund');
    assert.deepEqual(pageErrors, []); assert.deepEqual(external, []);
    assert.deepEqual(failed, [{ path: '/api/order/del', error: 'net::ERR_FAILED' }]);
    assert.equal(errors.length, 1); assert.match(errors[0], /ERR_FAILED/);
    if (pc) assert.deepEqual(warnings, []);
    else assert.ok(warnings.every(value => value === "[vue-router]: importing from 'vue-router/dist/vue-router.esm-bundler.js' is deprecated. Use 'vue-router' directly."));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1); assert.equal(overflow, false);
    const evidence = { kind: config.kind, passed: true, url: listUrl, title: await page.title(), viewport,
      browser: browser.version(), playwright: metadata.version, writes, screenshots, errors, warnings, pageErrors, failed, external, overflow };
    writeFileSync(join(config.output, config.kind + '-joined-result.json'), JSON.stringify(evidence, null, 2));
    console.log('CUSTOMER_JOINED_BROWSER ' + JSON.stringify(evidence)); process.send({ type: 'result', passed: true });
  } catch (error) {
    console.log('CUSTOMER_JOINED_FAILURE ' + JSON.stringify({ message: error.message, url: page.url(), body: (await page.locator('body').innerText()).slice(-4000), errors, warnings, pageErrors, failed, external }));
    await screenshot('failure'); throw error;
  }
}
process.once('message', message => {
  void run(message).catch(error => { process.exitCode = 1; process.send({ type: 'failure', message: error.message }); })
    .finally(async () => { await close(); console.log('CUSTOMER_JOINED_CLOSED'); process.disconnect(); });
});
