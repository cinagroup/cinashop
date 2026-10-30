import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// This opt-in child receives a newly issued local fixture JWT, never a DSN,
// database password or APP_KEY. Every business response comes from real HTTP.
let browser, context, page, configuration, expect, closing;
let originalCreation, originalPayment;
const consoleErrors = [], warnings = [], pageErrors = [], failed = [], external = [], calls = [], screenshots = [];
const close = () => closing ??= (async () => { await browser?.close(); })();
const stages = ['home', 'quote', 'created', 'paid', 'revoked-home', 'owner-recovery'];
let position = 0;

const buttons = (name) => page.locator('uni-button,button').filter({ hasText: new RegExp('^' + name + '$', 'u') });
const confirm = async title => {
  await expect(page.locator('.uni-modal__title')).toHaveText(title);
  await page.locator('.uni-modal__btn_primary').click();
  await expect(page.locator('.uni-modal')).toBeHidden();
};
const stored = () => page.evaluate(() => {
  const raw = localStorage.getItem('customer_cashier_pending_v1');
  if (!raw) return [];
  const value = JSON.parse(raw);
  return value && typeof value === 'object' && value.type === 'object' ? value.data : value;
});
const screenshot = async name => {
  const file = join(configuration.output, name + '.png');
  await page.screenshot({ path: file, fullPage: false });
  screenshots.push({ stage: name, file, viewport: page.viewportSize() });
};
async function surface() {
  assert.match(page.url(), /^http:\/\/127\.0\.0\.1:\d+\/#\/pages\/customer-work\/(index|cashier)$/u);
  const text = await page.locator('body').innerText();
  assert.ok(text.length > 20);
  assert.ok((await page.title()).length > 0, 'Real H5 page must have a title');
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
  assert.doesNotMatch(text, /Internal Server Error|Failed to resolve import|\[plugin:vite/u);
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  assert.ok(dimensions.scroll <= dimensions.width + 1, 'Cashier page must not overflow the viewport');
  return { href: page.url(), title: await page.title(), text, viewport: page.viewportSize(), dimensions };
}

async function initialize(config) {
  assert.match(config.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/u);
  for (const name of ['TEST_FINANCE_POSTGRES_URL', 'DATABASE_URL', 'APP_KEY', 'UPSTASH_REDIS_TOKEN', 'CLOUDFLARE_API_TOKEN'])
    assert.equal(Object.hasOwn(process.env, name), false, 'Browser must not inherit ' + name);
  assert.equal(process.env.NODE_OPTIONS, '--max-old-space-size=2048');
  const metadata = JSON.parse(readFileSync(config.packageJson, 'utf8'));
  assert.equal(metadata.name, 'playwright');
  const runtime = createRequire(config.packageJson)('playwright/test');
  expect = runtime.expect; configuration = config;
  browser = await runtime.chromium.launch({ executablePath: config.executable, headless: true });
  context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(({ token, uid }) => {
    // Native uni-app H5 storage uses this wrapper. Login UI is outside scope.
    if (!localStorage.getItem('uni_token')) {
      localStorage.setItem('uni_token', JSON.stringify({ type: 'string', data: token }));
      localStorage.setItem('uni_uid', JSON.stringify({ type: 'number', data: uid }));
    }
  }, { token: config.token, uid: config.uid });
  page = await context.newPage(); page.setDefaultTimeout(8_000);
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push({ text: message.text(), url: message.location().url, stage: stages[position] });
    if (message.type() === 'warning') warnings.push(message.text());
  });
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('requestfailed', request => failed.push({ url: request.url(), path: new URL(request.url()).pathname, stage: stages[position], error: request.failure()?.errorText }));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/mobile/work/')) calls.push({ path: url.pathname, method: request.method() });
  });
  await context.route('**/*', async route => {
    const target = new URL(route.request().url());
    if (target.origin !== config.baseUrl) { external.push(target.href); return route.abort(); }
    return route.continue();
  });
  return { ready: true, browser: browser.version(), playwright: metadata.version };
}

async function perform(name) {
  assert.equal(name, stages[position], 'Browser stages must execute in order');
  if (name === 'home') {
    await page.goto(configuration.baseUrl + '/#/pages/customer-work/index');
    await expect(buttons('进入次卡现金收银')).toBeVisible();
    await expect(buttons('核对原收银编号')).toBeVisible();
    const mobile = await surface(); await screenshot('home-mobile');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(buttons('进入次卡现金收银')).toBeVisible(); await screenshot('home-desktop');
    const desktop = await surface(); await page.setViewportSize({ width: 390, height: 844 });
    position++; return { mobile, desktop };
  }
  if (name === 'quote') {
    await buttons('进入次卡现金收银').click();
    await expect(page.locator('[data-cashier-product="70"]')).toBeVisible();
    await page.locator('[data-cashier-product="70"]').click();
    await page.locator('[data-cashier-sku="qared001"]').click();
    await buttons('查询会员').click();
    await expect(page.locator('[data-cashier-buyer="11"]')).toBeVisible();
    await page.locator('[data-cashier-buyer="11"]').click();
    await page.locator('input[aria-label="联系人姓名"],uni-input[aria-label="联系人姓名"] input').fill('本机浏览器原购买人');
    await page.locator('input[aria-label="联系电话"],uni-input[aria-label="联系电话"] input').fill('00000000000');
    await buttons('核对选品并取得报价').click(); await confirm('核对次卡收银选品');
    await expect(page.locator('[data-cashier-quote]')).toBeVisible();
    const intents = await stored(); originalCreation = intents.find(value => value.kind === 'creation');
    assert.ok(originalCreation); assert.equal(originalCreation.actor_uid, configuration.uid);
    assert.equal(originalCreation.body.buyer_uid, 11); assert.equal(originalCreation.body.quantity, 1);
    await screenshot('quote'); position++;
    return { surface: await surface(), creation: originalCreation };
  }
  if (name === 'created') {
    await buttons('核对报价并创建订单').click(); await confirm('确认创建次卡订单');
    await expect(page.locator('[data-cashier-created]')).toBeVisible();
    await expect(page.locator('[data-cashier-pending="' + originalCreation.request_key + '"]')).toContainText('原订单创建已核对');
    assert.deepEqual((await stored()).find(value => value.kind === 'creation'), originalCreation);
    await screenshot('created'); position++; return { surface: await surface(), creation: originalCreation };
  }
  if (name === 'paid') {
    await buttons('核对现金已收款并记录付款').click(); await confirm('确认现金已收款');
    // Wait for the actual owner GET to change the pending label, then reread
    // durable storage. The POST response alone is not payment proof.
    await expect(page.locator('[data-cashier-recovery]')).toContainText('原现金付款已核对');
    originalPayment = (await stored()).find(value => value.kind === 'payment');
    assert.ok(originalPayment); assert.notEqual(originalPayment.request_key, originalCreation.request_key);
    assert.equal(originalPayment.actor_uid, configuration.uid); assert.equal(originalPayment.buyer_uid, 11);
    assert.deepEqual((await stored()).find(value => value.kind === 'creation'), originalCreation);
    await screenshot('paid'); position++;
    return { surface: await surface(), creation: originalCreation, payment: originalPayment };
  }
  if (name === 'revoked-home') {
    await page.goto(configuration.baseUrl + '/#/pages/customer-work/index');
    await expect(page.locator('[data-customer-work="error"]')).toContainText('手机订单管理权限');
    await expect(buttons('核对原收银编号')).toBeVisible();
    await expect(buttons('进入次卡现金收银')).toHaveCount(0);
    assert.deepEqual((await stored()).find(value => value.kind === 'creation'), originalCreation);
    assert.deepEqual((await stored()).find(value => value.kind === 'payment'), originalPayment);
    await screenshot('revoked-home'); position++; return { surface: await surface() };
  }
  if (name === 'owner-recovery') {
    const posts = calls.filter(call => call.method === 'POST').length;
    await buttons('核对原收银编号').click();
    const creation = page.locator('[data-cashier-pending="' + originalCreation.request_key + '"]');
    const payment = page.locator('[data-cashier-pending="' + originalPayment.request_key + '"]');
    await expect(creation).toBeVisible(); await expect(payment).toBeVisible();
    await creation.locator('uni-button,button').filter({ hasText: /^查询原编号$/u }).click();
    await expect(creation).toContainText('原订单创建已核对');
    await payment.locator('uni-button,button').filter({ hasText: /^查询原编号$/u }).click();
    await expect(payment).toContainText('原现金付款已核对');
    await expect(buttons('核对选品并取得报价')).toHaveCount(0);
    await expect(buttons('核对报价并创建订单')).toHaveCount(0);
    await expect(buttons('核对现金已收款并记录付款')).toHaveCount(0);
    assert.equal(calls.filter(call => call.method === 'POST').length, posts);
    assert.deepEqual((await stored()).find(value => value.kind === 'creation'), originalCreation);
    assert.deepEqual((await stored()).find(value => value.kind === 'payment'), originalPayment);
    await screenshot('owner-recovered');
    assert.deepEqual(pageErrors, []);
    // Installed uni-h5 preloads one offscreen decorative shadow from its CDN.
    // It remains blocked before network I/O and is retained as explained evidence.
    const decorative = 'https://cdn.dcloud.net.cn/img/shadow-grey.png';
    assert.deepEqual(external.filter(url => url !== decorative), []);
    assert.deepEqual(failed.filter(value => !(value.url === decorative && typeof value.stage === 'string' && stages.includes(value.stage) && value.error === 'net::ERR_FAILED')), []);
    // Browser HTTP403 resources are expected only after the real qualification
    // mutation. Parent matches those precise responses to the SQL checkpoint.
    const unexplained = consoleErrors.filter(value => {
      if (stages.includes(value.stage) && value.url === decorative && value.text === 'Failed to load resource: net::ERR_FAILED') return false;
      if (!['revoked-home', 'owner-recovery'].includes(value.stage)
        || !/^Failed to load resource: the server responded with a status of 403 \(Forbidden\)$/u.test(value.text)) return true;
      try { const url = new URL(value.url); return url.origin !== configuration.baseUrl
        || url.pathname !== '/api/mobile/work/context' || url.search !== ''; } catch { return true; }
    });
    assert.deepEqual(unexplained, []); assert.deepEqual(warnings.filter(value => value !== "[vue-router]: importing from 'vue-router/dist/vue-router.esm-bundler.js' is deprecated. Use 'vue-router' directly."), []);
    const result = { surface: await surface(), calls, consoleErrors, warnings, pageErrors, failed, external, screenshots,
      creation: originalCreation, payment: originalPayment, no_new_ui_author_posts_after_revocation: true,
      explained_vendor_messages: { blocked_decorative_asset: decorative, warning: 'installed uni-h5 deprecated vue-router import; no app pageerror or business request is exempted' },
      browser: browser.version(), login: 'injected freshly signed local fixture AppJWT; full server authentication is real',
      image_browser_acceptance: false, production_acceptance: false };
    writeFileSync(join(configuration.output, 'browser-driver-result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    position++; return result;
  }
  throw Error('Unknown Cashier Browser stage');
}

let sequence = Promise.resolve();
process.on('message', message => {
  if (message?.type === 'stop') { void close().finally(() => process.exit(0)); return; }
  sequence = sequence.then(async () => {
    if (message?.type === 'start') { process.send({ type: 'ready', ...await initialize(message) }); return; }
    if (message?.type === 'stage' && typeof message.name === 'string') {
      process.send({ type: 'stage-result', name: message.name, data: await perform(message.name) }); return;
    }
    throw Error('Unknown Cashier Browser IPC');
  }).catch(async error => {
    // Preserve real rendered state before closing this owned Browser. This is
    // diagnostic evidence only; the original failure still rejects the stage.
    let diagnosticFailure = null;
    if (configuration?.output) {
      try {
        const evidence = { stage: stages[position], message: String(error?.stack ?? error),
          url: page?.url(), title: page ? await page.title() : null,
          text: page ? await page.locator('body').innerText() : null,
          consoleErrors, warnings, pageErrors, failed, external, calls };
        if (page) await page.screenshot({ path: join(configuration.output, 'failure.png'), fullPage: false });
        writeFileSync(join(configuration.output, 'browser-failure.json'), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
      } catch (diagnosticError) { diagnosticFailure = String(diagnosticError); }
    }
    process.send?.({ type: 'failure', message: String(error?.stack ?? error), diagnostic_error: diagnosticFailure });
    await close(); process.exitCode = 1; process.disconnect();
  });
});
process.on('disconnect', () => { void close(); });
process.on('SIGTERM', () => { void close().finally(() => process.exit(1)); });
process.on('SIGINT', () => { void close().finally(() => process.exit(1)); });
