import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Permanent opt-in regression driver. Actual order/auth responses come from
// the parent's HTTP app + independent SQL login, never from route fixtures.
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
  assert.ok(['desktop', 'mobile'].includes(config.kind));
  for (const key of ['TEST_FINANCE_POSTGRES_URL', 'DATABASE_URL', 'APP_KEY', 'UPSTASH_REDIS_TOKEN', 'CLOUDFLARE_API_TOKEN']) {
    assert.equal(Object.hasOwn(process.env, key), false, 'Driver must not receive ' + key);
  }
  const metadata = JSON.parse(readFileSync(config.packageJson, 'utf8')); assert.equal(metadata.name, 'playwright');
  const { chromium, expect } = createRequire(config.packageJson)('playwright/test');
  const viewport = config.kind === 'desktop' ? { width: 1440, height: 1000 } : { width: 390, height: 844 };
  browser = await chromium.launch({ executablePath: config.executable, headless: true });
  const context = await browser.newContext({ viewport });
  await context.addInitScript(token => {
    localStorage.setItem('admin_token', token);
    localStorage.setItem('admin_session', JSON.stringify({ userInfo: { id: 990, account: 'local-order-reader', level: 1, roles: '990' },
      uniqueAuth: ['order.view'], menus: [{ id: 1, pid: 0, path: '/order', name: '订单管理', children: [] }] }));
  }, config.token);
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  const errors = [], warnings = [], pageErrors = [], external = [], failed = [], screenshots = [], screens = [], faults = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); if (message.type() === 'warning') warnings.push(message.text()); });
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('requestfailed', request => failed.push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText }));
  let holdRemaining = false, releaseRemaining, heldDone, heldSeen;
  const heldStarted = new Promise(done => { heldSeen = done; });
  const heldFinished = new Promise(done => { heldDone = done; });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== config.baseUrl) { external.push(url.origin + url.pathname); return route.abort(); }
    if (holdRemaining && url.pathname === '/adminapi/order/detail/' + config.remaining) {
      holdRemaining = false;
      const response = await route.fetch(), body = await response.json();
      assert.equal(body.status, 200); assert.equal(body.data.payPrice, '42.20'); assert.equal(body.data.cartInfo.length, 2);
      assert.match(response.headers()['cache-control'], /no-store/); heldSeen();
      await new Promise(done => { releaseRemaining = done; });
      // Original successful response is delayed, not replaced. It belongs to an
      // already-aborted page generation by the time the user returns to this ID.
      try { await route.fulfill({ response }); } finally { heldDone(); }
      return;
    }
    return route.continue();
  });
  const rootUrl = config.baseUrl + '/order/' + config.root;
  const child = number => page.getByRole('link', { name: number, exact: true });
  const detailError = () => page.locator('.order-detail-page .el-alert--error');
  const refresh = () => page.getByRole('button', { name: '刷新', exact: true }).click();
  const snapshot = async label => {
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    await expect(page.locator('.main')).not.toBeEmpty();
    const geometry = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth, main: document.querySelector('.main').getBoundingClientRect().right }));
    assert.ok(geometry.document <= geometry.width + 1); assert.ok(geometry.main <= geometry.width + 1);
    const path = join(config.output, config.kind + '-admin-order-' + label + '.png');
    await page.screenshot({ path, fullPage: false, animations: 'disabled' }); screenshots.push(path);
    screens.push({ label, url: page.url(), title: await page.title(), geometry });
  };
  const request = async (path, token = config.token, method = 'GET') => {
    const response = await context.request.fetch(config.baseUrl + path, { method, headers: token ? { 'Authori-zation': 'Bearer ' + token } : {},
      ...(method === 'POST' ? { data: { code: '123456789012' } } : {}) });
    assert.match(response.headers()['cache-control'], /no-store/); return response.json();
  };
  const faultRefresh = async () => {
    const pendingResponse = page.waitForResponse(r => r.url() === config.baseUrl + '/adminapi/order/detail/' + config.root);
    await refresh(); const response = await pendingResponse;
    assert.match(response.headers()['cache-control'], /no-store/); assert.notEqual((await response.json()).status, 200);
    await expect(detailError()).toBeVisible();
    await expect(child(config.remaining)).toHaveCount(0);
  };
  try {
    await page.goto(config.baseUrl + '/order'); await expect(page).toHaveTitle('订单管理 - CinaShop 管理后台');
    await expect(page.locator('.el-pagination__total')).toContainText('21'); await expect(page.locator('.el-table__row')).toHaveCount(10);
    await expect(page.getByRole('button', { name: '打印', exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: '发货', exact: true })).toHaveCount(0);
    await snapshot('list');
    await page.getByRole('listitem', { name: 'page 3', exact: true }).click(); await expect(page.locator('.el-table__row')).toHaveCount(1);
    await expect(page.locator('.el-pagination__total')).toContainText('21');
    for (const base of ['/adminapi', '/api/admin']) {
      for (const path of ['/order/list', '/order/detail/' + config.root]) {
        assert.equal((await request(base + path, '')).status, 410000);
        assert.equal((await request(base + path, 'invalid-local-token')).status, 410001);
        assert.equal((await request(base + path, config.deniedToken)).status, 400011);
        assert.equal((await request(base + path, config.supplierToken)).status, 410002);
        assert.equal((await request(base + path, config.customerToken)).status, 410002);
        assert.equal((await request(base + path)).status, 200);
      }
      assert.equal((await request(base + '/order/writeoff', config.token, 'POST')).status, 400011);
    }
    await page.getByRole('textbox', { name: '订单号', exact: true }).fill(config.root);
    await page.getByRole('button', { name: '搜索', exact: true }).click(); await expect(page.locator('.el-table__row')).toHaveCount(2);
    await expect(page.locator('.el-pagination__total')).toContainText('2');
    await page.getByRole('button', { name: '查看此单详情', exact: true }).click(); await expect(page).toHaveURL(rootUrl);
    await expect(page).toHaveTitle('订单详情 - CinaShop 管理后台'); await expect(child(config.selected)).toBeVisible(); await expect(child(config.remaining)).toBeVisible();
    await expect(page.getByText('原支付单商品历史', { exact: true })).toBeVisible(); await expect(page.locator('.pay-price')).toHaveText('¥55.00');
    await expect(page.getByText('本地省 测试甲市 测试甲区 隔离样本一号', { exact: true })).toBeVisible();
    await expect(page.locator('.deduction-price')).toHaveText('¥1.00'); await expect(page.locator('.used-integral')).toHaveText('100.00');
    await expect(page.locator('.el-table__row')).toHaveCount(2); await snapshot('root');
    await child(config.selected).click(); await expect(page.locator('.el-tag').filter({ hasText: '已退款' })).toBeVisible();
    await expect(page.locator('.pay-price')).toHaveText('¥12.80'); await expect(page.getByText('红色,大号', { exact: true })).toBeVisible();
    await expect(page.locator('.el-table__row')).toHaveCount(1);
    await page.getByRole('button', { name: '返回', exact: true }).click(); await expect(child(config.remaining)).toBeVisible();
    await checkpoint('initial-read');
    holdRemaining = true; await child(config.remaining).click(); await heldStarted;
    await expect(page.locator('.pay-price')).toHaveCount(0);
    await page.getByRole('button', { name: '返回', exact: true }).click(); await expect(child(config.remaining)).toBeVisible();
    const next = await checkpoint('refund-again'); await refresh(); await expect(child(next.nextSelected)).toBeVisible();
    await expect(page.locator('.split-orders li')).toHaveCount(3); await expect(page.locator('.pay-price')).toHaveText('¥55.00');
    await child(config.remaining).click(); await expect(page.locator('.pay-price')).toHaveText('¥29.40'); await expect(page.locator('.el-table__row')).toHaveCount(1);
    releaseRemaining(); await heldFinished;
    await expect(page.locator('.pay-price')).toHaveText('¥29.40'); await expect(page.getByText('Local runtime remainder', { exact: true })).toBeVisible();
    await expect(page.locator('.deduction-price')).toHaveText('¥0.60'); await expect(page.locator('.used-integral')).toHaveText('60.00');
    await expect(page.getByText('完整报价隔离样本', { exact: true })).toHaveCount(0);
    await snapshot('current-remainder'); await checkpoint('current-read');
    await page.getByRole('button', { name: '返回', exact: true }).click(); await expect(child(next.nextSelected)).toBeVisible();
    await checkpoint('deny-role'); await faultRefresh(); faults.push('revoked-order.view');
    await checkpoint('restore-role'); await refresh(); await expect(child(next.nextSelected)).toBeVisible();
    await checkpoint('deny-sql'); await faultRefresh(); faults.push('revoked-cart-select'); await snapshot('sql-denied');
    await checkpoint('restore-sql'); await refresh(); await expect(child(next.nextSelected)).toBeVisible();
    await checkpoint('expire-token'); await refresh(); await expect(page).toHaveURL(config.baseUrl + '/login');
    await expect(page.getByPlaceholder('账号', { exact: true })).toBeVisible();
    await expect(page.locator('.order-detail-page')).toHaveCount(0); assert.equal(await page.evaluate(() => localStorage.getItem('admin_token')), null);
    await checkpoint('complete');
    assert.deepEqual(pageErrors, []); assert.deepEqual(external, []); assert.deepEqual(warnings, []);
    // These real business errors retain HTTP 200 envelopes. Exactly the held
    // old-generation detail is aborted; other network/console faults must fail.
    assert.deepEqual(errors, []);
    assert.deepEqual(failed, [{ path: '/adminapi/order/detail/' + config.remaining, error: 'net::ERR_ABORTED' }]);
    const evidence = { kind: config.kind, passed: true, viewport, browser: browser.version(), playwright: metadata.version,
      screens, screenshots, faults, errors, warnings, pageErrors, failed, external };
    writeFileSync(join(config.output, config.kind + '-admin-order-result.json'), JSON.stringify(evidence, null, 2));
    console.log('ADMIN_ORDER_JOINED_BROWSER ' + JSON.stringify(evidence)); process.send({ type: 'result', passed: true });
  } catch (error) {
    console.log('ADMIN_ORDER_JOINED_FAILURE ' + JSON.stringify({ message: error.message, url: page.url(), body: (await page.locator('body').innerText()).slice(-4500), errors, warnings, pageErrors, failed, external }));
    await page.screenshot({ path: join(config.output, config.kind + '-admin-order-failure.png'), fullPage: false }); throw error;
  }
}
process.once('message', message => {
  void run(message).catch(error => { process.exitCode = 1; process.send({ type: 'failure', message: error.message }); })
    .finally(async () => { await close(); console.log('ADMIN_ORDER_JOINED_CLOSED'); process.disconnect(); });
});
