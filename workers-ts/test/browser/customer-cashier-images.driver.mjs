import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// This opt-in child receives a newly issued local fixture JWT, never a DSN,
// database password or APP_KEY. Every business response comes from real HTTP.
let browser, context, page, configuration, expect, closing;
let originalCreation, originalPayment, originalSession, originalImage, previewProof;
let rejectedImage, rejectedUpload, invalidatedDocument;
const consoleErrors = [], warnings = [], pageErrors = [], failed = [], external = [], calls = [], screenshots = [];
const close = () => closing ??= (async () => { await browser?.close(); })();
const stages = ['complete-upload', 'complete-quote', 'complete-created', 'complete-paid', 'lost-upload', 'lost-recover', 'cancel-choose', 'cancel-dismiss', 'cancel-confirm', 'revoked-upload', 'revoked-home', 'revoked-recover', 'revoked-cancel', 'invalidated-upload', 'invalidated-rejected', 'invalidated-recover', 'invalidated-cancel'];
let position = 0;
const activationTrace = [], warningDetails = [];
let lostUploadPath = '';

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
  await fresh();
  return { ready: true, browser: browser.version(), playwright: metadata.version };
}


async function fresh() {
  await context?.close(); const config=configuration;
  context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(({ token, uid }) => {
    // Native uni-app H5 storage uses this wrapper. Login UI is outside scope.
    if (!localStorage.getItem('uni_token')) {
      localStorage.setItem('uni_token', JSON.stringify({ type: 'string', data: token }));
      localStorage.setItem('uni_uid', JSON.stringify({ type: 'number', data: uid }));
    }
  }, { token: config.token, uid: config.uid });
  await context.addInitScript(() => {
    const report = (kind, detail = {}) => console.info('CASHIER_PICKER_ACTIVATION_18 ' + JSON.stringify({
      kind, isActive: navigator.userActivation?.isActive ?? null,
      hasBeenActive: navigator.userActivation?.hasBeenActive ?? null, ...detail,
    }));
    document.addEventListener('click', event => {
      const button = event.target instanceof Element ? event.target.closest('uni-button,button') : null;
      if (button?.textContent?.trim() === '上传图片') report('upload-button-click', { trusted: event.isTrusted });
    }, true);
    const nativeClick = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function (...args) {
      if (this.type !== 'file') return Reflect.apply(nativeClick, this, args);
      report('file-input-click-before', { stack: new Error('picker diagnostic').stack });
      try { return Reflect.apply(nativeClick, this, args); }
      finally { report('file-input-click-after'); }
    };
  });
  page = await context.newPage(); page.setDefaultTimeout(8_000);
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push({ text: message.text(), url: message.location().url, stage: stages[position] });
    if (message.type() === 'warning') { warnings.push(message.text()); warningDetails.push({ text: message.text(), location: message.location(), stage: stages[position] }); }
    if (message.type() === 'info' && message.text().startsWith('CASHIER_PICKER_ACTIVATION_18 '))
      activationTrace.push({ stage: stages[position], ...JSON.parse(message.text().slice('CASHIER_PICKER_ACTIVATION_18 '.length)) });
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
  originalCreation=null; originalPayment=null; originalSession=null; originalImage=null; previewProof=null;
  rejectedImage=null; rejectedUpload=null; invalidatedDocument=null;
}

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNoSHD4DwAEpAIg90VMdgAAAABJRU5ErkJggg==';
const PNG = Buffer.from(PNG_BASE64, 'base64');
const PNG_SHA = '6cb56a59fda4e0f66d71373c8bccbd042ec5507efd06c9a9415fb2b29b5bda50';
assert.equal(PNG.length, 70); assert.equal(createHash('sha256').update(PNG).digest('hex'), PNG_SHA);
const imagesStored = () => page.evaluate(() => {
  const raw = localStorage.getItem('customer_cashier_image_pending_v1'); if (!raw) return [];
  const value = JSON.parse(raw); return value && value.type === 'object' ? value.data : value;
});
const imageRow = key => page.locator('[data-cashier-image-pending="' + key + '"]');
const cancelButton = () => buttons('取消已核对的创建前图片准备');
const posts = () => calls.filter(value => value.method === 'POST');
const cancelPaths = () => calls.filter(value => value.method === 'POST' && /\/form-sessions\/[^/]+\/cancel$/u.test(value.path));
const checkImage = async key => { await imageRow(key).locator('uni-button,button').filter({ hasText: /^查询原图片编号$/u }).click(); };
const documentIdentity = () => page.evaluate(() => ({ href: location.href, timeOrigin: performance.timeOrigin,
  token: localStorage.getItem('uni_token'), uid: localStorage.getItem('uni_uid') }));
async function invalidatedRows() {
  // Inspect the current rendered recovery list before using any original key.
  // Saved intents cannot make this pass if invalidation emptied the live list.
  const recovery = page.locator('[data-cashier-image-recovery]'); await expect(recovery).toBeVisible();
  const rows = recovery.locator('[data-cashier-image-pending]'); await expect(rows).toHaveCount(3);
  const keys = await rows.evaluateAll(elements => elements.map(element => element.getAttribute('data-cashier-image-pending')));
  const durable = await imagesStored(); assert.equal(durable.length, 3);
  assert.ok(durable.every(value => value.actor_uid === configuration.uid));
  assert.deepEqual([...keys].sort(), durable.map(value => value.request_key).sort());
  assert.deepEqual([...keys].sort(), [originalSession.request_key, originalImage.request_key, rejectedImage.request_key].sort());
  assert.deepEqual(durable.find(value => value.request_key === originalSession.request_key), originalSession);
  assert.deepEqual(durable.find(value => value.request_key === originalImage.request_key), originalImage);
  assert.deepEqual(durable.find(value => value.request_key === rejectedImage.request_key), rejectedImage);
  for (const key of keys) {
    await expect(imageRow(key)).toBeVisible();
    await expect(imageRow(key).locator('uni-button,button').filter({ hasText: /^查询原图片编号$/u })).toBeEnabled();
  }
  await expect(buttons('上传图片')).toHaveCount(0); await expect(buttons('核对选品并取得报价')).toHaveCount(0);
  await expect(page.locator('.image-preview img')).toHaveCount(0);
  await expect(page.locator('input[aria-label="联系人姓名"],uni-input[aria-label="联系人姓名"] input')).toHaveCount(0);
  await expect(page.locator('input[aria-label="联系电话"],uni-input[aria-label="联系电话"] input')).toHaveCount(0);
  const text = await page.locator('body').innerText();
  assert.doesNotMatch(text, /本机图片联系购买人|本机图片补充答案|00000000000/u);
  assert.deepEqual(await documentIdentity(), invalidatedDocument);
  assertDurable(durable);
  return { keys, pending: durable, live_visible_owner_rows: 3, same_document_and_JWT: true,
    author_controls_hidden: true, form_PII_and_previews_cleared: true };
}
async function selected() {
  await fresh();
  await page.goto(configuration.baseUrl + '/#/pages/customer-work/index');
  await expect(buttons('进入次卡现金收银')).toBeVisible(); await buttons('进入次卡现金收银').click();
  await expect(page.locator('[data-cashier-product="70"]')).toBeVisible(); await page.locator('[data-cashier-product="70"]').click();
  await page.locator('[data-cashier-sku="qared001"]').click(); await buttons('查询会员').click();
  await expect(page.locator('[data-cashier-buyer="11"]')).toBeVisible(); await page.locator('[data-cashier-buyer="11"]').click();
  await page.locator('input[aria-label="联系人姓名"],uni-input[aria-label="联系人姓名"] input').fill('本机图片联系购买人');
  await page.locator('input[aria-label="联系电话"],uni-input[aria-label="联系电话"] input').fill('00000000000');
  await page.locator('.system-form .form-item').filter({ hasText: '购买人' }).locator('input,textarea').fill('本机图片补充答案');
}
async function choose(cancel = false) {
  // beforeChooseImages performs the real session POST before opening chooser.
  const choice = page.waitForEvent('filechooser'); await buttons('上传图片').click();
  const chooser = await choice;
  await chooser.setFiles(cancel ? [] : { name: 'owned-image.png', mimeType: 'image/png', buffer: PNG });
  await expect.poll(async () => (await imagesStored()).some(value => value.kind === 'session')).toBe(true);
  originalSession = (await imagesStored()).find(value => value.kind === 'session');
  assert.equal(originalSession.actor_uid, configuration.uid);
  if (cancel) {
    await expect(cancelButton()).toBeVisible(); await expect(buttons('上传图片')).toBeEnabled();
    assert.equal((await imagesStored()).filter(value => value.kind === 'image').length, 0); return;
  }
  await expect.poll(async () => (await imagesStored()).some(value => value.kind === 'image')).toBe(true);
  originalImage = (await imagesStored()).find(value => value.kind === 'image');
  assert.equal(originalImage.body.session_key, originalSession.request_key);
  assert.notEqual(originalImage.request_key, originalSession.request_key);
  assert.equal(originalImage.body.sha256, PNG_SHA); assert.equal(originalImage.body.size, PNG.length);
  assert.equal(originalImage.body.field_id, 'id:"photo"');
}
async function preview() {
  const image = page.locator('.image-preview img').first(); await expect(image).toBeVisible();
  const value = await image.evaluate(async element => {
    await element.decode(); const src = element.currentSrc || element.src;
    const response = await fetch(src, { cache: 'no-store' }); const bytes = await response.arrayBuffer();
    return { src, width: element.naturalWidth, height: element.naturalHeight, status: response.status,
      type: response.headers.get('Content-Type'), cache: response.headers.get('Cache-Control'), bytes: bytes.byteLength,
      sha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(value => value.toString(16).padStart(2, '0')).join('') };
  });
  assert.deepEqual([value.width, value.height, value.status, value.bytes, value.sha256], [1, 1, 200, PNG.length, PNG_SHA]);
  assert.match(value.type, /^image\/png/u); assert.equal(value.cache, 'private, no-store');
  const url = new URL(value.src); assert.equal(url.origin, configuration.baseUrl); assert.match(url.pathname, /^\/api\/assets\/[1-9]\d*$/u);
  assert.deepEqual([...url.searchParams.keys()].sort(), ['expires', 'signature']);
  const now = Math.floor(Date.now() / 1000); assert.ok(Number(url.searchParams.get('expires')) > now && Number(url.searchParams.get('expires')) <= now + 3600);
  assert.match(url.searchParams.get('signature'), /^[A-Za-z0-9_-]{43}$/u);
  return { ...value, reference: url.pathname };
}
function assertDurable(value) { assert.doesNotMatch(JSON.stringify(value), /blob:|\?expires=|signature=|owned-image\.png/u); }
async function finish(name, extra = {}) { const result = { surface: await surface(), ...extra }; await screenshot(name); position++; return result; }
function health() {
  assert.deepEqual(pageErrors, []);
  const decorative = 'https://cdn.dcloud.net.cn/img/shadow-grey.png';
  assert.deepEqual(external.filter(url => url !== decorative), []);
  const intentional = failed.filter(value => value.stage === 'lost-upload'
    && value.path === lostUploadPath && new URL(value.url).origin === configuration.baseUrl && !new URL(value.url).search
    && ['net::ERR_EMPTY_RESPONSE', 'net::ERR_FAILED', 'net::ERR_CONTENT_LENGTH_MISMATCH'].includes(value.error));
  assert.equal(intentional.length, 1, 'Only one stored upload response is deliberately lost');
  assert.deepEqual(failed.filter(value => !intentional.includes(value) && !(value.url === decorative && value.error === 'net::ERR_FAILED')), []);
  const unexplained = consoleErrors.filter(value => {
    if (value.url === decorative && value.text === 'Failed to load resource: net::ERR_FAILED') return false;
    try {
      const url = new URL(value.url);
      if (value.stage === 'lost-upload' && url.origin === configuration.baseUrl
        && url.pathname === lostUploadPath && !url.search
        && ['Failed to load resource: net::ERR_EMPTY_RESPONSE', 'Failed to load resource: net::ERR_FAILED', 'Failed to load resource: net::ERR_CONTENT_LENGTH_MISMATCH'].includes(value.text)) return false;
      if (['revoked-home', 'revoked-recover'].includes(value.stage) && url.origin === configuration.baseUrl
        && url.pathname === '/api/mobile/work/context' && !url.search
        && value.text === 'Failed to load resource: the server responded with a status of 403 (Forbidden)') return false;
      if (value.stage === 'invalidated-rejected' && rejectedUpload?.http === 403
        && rejectedUpload.request_key === rejectedImage?.request_key
        && rejectedUpload.path === '/api/mobile/work/cashier/second-card/form-sessions/' + originalSession.request_key + '/images'
        && url.origin === configuration.baseUrl && url.pathname === rejectedUpload.path && !url.search
        && value.text === 'Failed to load resource: the server responded with a status of 403 (Forbidden)') return false;
    } catch { /* Every other message remains an error. */ }
    return true;
  });
  assert.deepEqual(unexplained, []);
  assert.deepEqual(warnings, warningDetails.map(value => value.text));
  const rejectedErrors = consoleErrors.filter(value => value.stage === 'invalidated-rejected'
    && value.url === configuration.baseUrl + rejectedUpload?.path
    && value.text === 'Failed to load resource: the server responded with a status of 403 (Forbidden)');
  assert.equal(rejectedErrors.length, 1, 'One source-bound second multipart403 must explain the invalidation error');
  const pickerStages = ['complete-upload', 'lost-upload', 'cancel-choose', 'revoked-upload', 'invalidated-upload', 'invalidated-rejected'];
  assert.deepEqual(activationTrace.map(({ stage, kind, isActive, hasBeenActive, trusted }) => ({ stage, kind, isActive, hasBeenActive, trusted })),
    pickerStages.flatMap(stage => [
      { stage, kind: 'upload-button-click', isActive: true, hasBeenActive: true, trusted: true },
      { stage, kind: 'file-input-click-before', isActive: true, hasBeenActive: true, trusted: undefined },
      { stage, kind: 'file-input-click-after', isActive: false, hasBeenActive: true, trusted: undefined },
    ]));
  const pickerWarning = 'File chooser dialog can only be shown with a user activation';
  const pickerWarnings = warningDetails.filter(value => value.text === pickerWarning);
  assert.deepEqual(pickerWarnings.map(value => value.stage), pickerStages);
  const site = configuration.pickerWarningSite;
  assert.deepEqual(site, { path: 'assets/index-Db0CkJqG.js', bytes: 571435,
    sha256: '59acdfb979de1b9864f0df6036edeec2c638e4a5558e4bdbb1afee4147e4196c', lineNumber: 24, columnNumber: 210882 });
  for (const { location } of pickerWarnings) {
    assert.equal(location.url, configuration.baseUrl + '/' + site.path);
    assert.equal(location.lineNumber, site.lineNumber); assert.equal(location.columnNumber, site.columnNumber);
    if (Object.hasOwn(location, 'line')) assert.equal(location.line, site.lineNumber);
    if (Object.hasOwn(location, 'column')) assert.equal(location.column, site.columnNumber);
  }
  assert.deepEqual(warnings.filter(value => value !== pickerWarning
    && value !== "[vue-router]: importing from 'vue-router/dist/vue-router.esm-bundler.js' is deprecated. Use 'vue-router' directly."), []);
  return { consoleErrors, warnings, pageErrors, failed, external, calls, screenshots, activationTrace, warningDetails,
    explained: { decorative, picker_warning: { site, count: pickerWarnings.length,
      reason: 'Reviewed uni-h5 task counter warning despite trusted active native input clicks; exact eighteen observations and six source-bound warnings required' },
      lost_reply: 'one actual stored multipart response destroyed by owned bridge after verified SQL commit',
      qualification: 'actual current-context HTTP403 plus one exact same-page second multipart403 bound to the rejected client UUID; JWT remains valid',
      rejected_upload: rejectedUpload } };
}

async function perform(name) {
  assert.equal(name, stages[position]);
  if (['complete-upload', 'lost-upload', 'revoked-upload', 'invalidated-upload'].includes(name)) {
    await selected(); await choose();
    if (name === 'lost-upload') {
      lostUploadPath = '/api/mobile/work/cashier/second-card/form-sessions/' + originalSession.request_key + '/images';
      await expect.poll(() => failed.some(value => value.stage === name && value.path === lostUploadPath
        && new URL(value.url).origin === configuration.baseUrl && !new URL(value.url).search)).toBe(true);
      await expect(buttons('上传图片')).toBeEnabled();
      await expect(imageRow(originalImage.request_key)).toContainText('原上传结果尚未确认');
      assertDurable(await imagesStored());
      return finish(name, { session: originalSession, image: originalImage, pending: await imagesStored() });
    }
    await expect(imageRow(originalImage.request_key)).toContainText('原图片保存已核对'); previewProof = await preview();
    if (name === 'invalidated-upload') invalidatedDocument = await documentIdentity();
    assertDurable(await imagesStored());
    return finish(name, { session: originalSession, image: originalImage, preview: previewProof, pending: await imagesStored() });
  }
  if (name === 'complete-quote') {
    await buttons('核对选品并取得报价').click(); await confirm('核对次卡收银选品');
    await expect(page.locator('[data-cashier-quote]')).toBeVisible(); originalCreation = (await stored()).find(value => value.kind === 'creation');
    assert.equal(originalCreation.request_key, originalSession.request_key);
    const photo = originalCreation.body.custom_form.find(value => value.name === 'uploadPicture'); assert.deepEqual(photo.value, [previewProof.reference]);
    assertDurable(await stored()); await expect(cancelButton()).toHaveCount(0);
    return finish(name, { creation: originalCreation, session: originalSession, image: originalImage, preview: previewProof });
  }
  if (name === 'complete-created') {
    await buttons('核对报价并创建订单').click(); await confirm('确认创建次卡订单');
    await expect(page.locator('[data-cashier-created]')).toBeVisible(); await checkImage(originalSession.request_key);
    await expect(page.locator('[data-cashier-consumed-session]')).toBeVisible(); await expect(cancelButton()).toHaveCount(0);
    assert.deepEqual(await imagesStored(), []); assertDurable(await stored());
    return finish(name, { creation: originalCreation, image_stages_released_after_actual_consumed_GET: true });
  }
  if (name === 'complete-paid') {
    await buttons('核对现金已收款并记录付款').click(); await confirm('确认现金已收款');
    await expect(page.locator('[data-cashier-recovery]')).toContainText('原现金付款已核对');
    originalPayment = (await stored()).find(value => value.kind === 'payment');
    assert.notEqual(originalPayment.request_key, originalCreation.request_key); assert.notEqual(originalPayment.request_key, originalImage.request_key);
    assertDurable(await stored());
    return finish(name, { creation: originalCreation, payment: originalPayment, session: originalSession, image: originalImage });
  }
  if (name === 'lost-recover') {
    const before = posts().filter(value => value.path.endsWith('/images')).length;
    await page.reload(); await expect(imageRow(originalSession.request_key)).toBeVisible(); await checkImage(originalSession.request_key);
    await expect(imageRow(originalImage.request_key)).toContainText('原图片保存已核对'); previewProof = await preview();
    assert.equal(posts().filter(value => value.path.endsWith('/images')).length, before);
    assert.deepEqual((await imagesStored()).find(value => value.kind === 'image'), originalImage);
    assert.deepEqual((await imagesStored()).find(value => value.kind === 'session'), originalSession); assertDurable(await imagesStored());
    return finish(name, { session: originalSession, image: originalImage, preview: previewProof, original_UUID_only: true });
  }
  if (name === 'cancel-choose') {
    await selected(); await choose(true);
    return finish(name, { session: originalSession, pending: await imagesStored(), chooser_empty_selection: true });
  }
  if (name === 'cancel-dismiss' || name === 'cancel-confirm' || name === 'revoked-cancel' || name === 'invalidated-cancel') {
    if (name === 'invalidated-cancel') await invalidatedRows();
    const before = cancelPaths().length; await cancelButton().click(); await expect(page.locator('.uni-modal__title')).toHaveText('取消创建前图片准备');
    await page.locator(name === 'cancel-dismiss' ? '.uni-modal__btn_default' : '.uni-modal__btn_primary').click();
    await expect(page.locator('.uni-modal')).toBeHidden();
    if (name === 'cancel-dismiss') { await expect(cancelButton()).toBeEnabled(); assert.equal(cancelPaths().length, before); }
    else { await expect.poll(async () => (await imagesStored()).length).toBe(0); assert.equal(cancelPaths().length, before + 1); }
    if (name === 'invalidated-cancel') {
      await expect(page.locator('[data-cashier-image-pending]')).toHaveCount(0);
      assert.deepEqual(await documentIdentity(), invalidatedDocument);
      const result = await finish(name, { session: originalSession, image: originalImage, rejected_image: rejectedImage,
        owner_cancel_after_same_page_403: true, all_three_durable_stages_released: true });
      result.health = health();
      writeFileSync(join(configuration.output, 'images-browser-driver-result.json'), JSON.stringify({ passed: true, result, screenshots,
        scope: 'local native H5 images and Map private R2 adapter only', provider_storage_acceptance: false, production_acceptance: false }, null, 2) + '\n', { flag: 'wx' }); return result;
    }
    if (name === 'revoked-cancel') return finish(name, { session: originalSession, owner_cancel_after_qualification_loss: true });
    return finish(name, { session: originalSession, dismissed: name === 'cancel-dismiss' });
  }
  if (name === 'invalidated-rejected') {
    const beforePosts = posts().length, beforeUploads = posts().filter(value => value.path.endsWith('/images')).length;
    assert.deepEqual(await documentIdentity(), invalidatedDocument);
    await expect(buttons('上传图片')).toBeEnabled();
    const path = '/api/mobile/work/cashier/second-card/form-sessions/' + originalSession.request_key + '/images';
    const responsePromise = page.waitForResponse(response => response.request().method() === 'POST'
      && response.url() === configuration.baseUrl + path);
    const choice = page.waitForEvent('filechooser'); await buttons('上传图片').click();
    await (await choice).setFiles({ name: 'owned-image.png', mimeType: 'image/png', buffer: PNG });
    const response = await responsePromise; assert.equal(response.status(), 403);
    await expect.poll(async () => (await imagesStored()).filter(value => value.kind === 'image').length).toBe(2);
    const durable = await imagesStored();
    rejectedImage = durable.find(value => value.kind === 'image' && value.request_key !== originalImage.request_key);
    assert.ok(rejectedImage); assert.equal(rejectedImage.actor_uid, configuration.uid);
    assert.deepEqual(rejectedImage.body, originalImage.body);
    assert.notEqual(rejectedImage.request_key, originalSession.request_key);
    assert.notEqual(rejectedImage.request_key, originalImage.request_key);
    const headers = await response.request().allHeaders();
    assert.equal(headers['idempotency-key'], rejectedImage.request_key);
    assert.equal(headers['authori-zation'], 'Bearer ' + configuration.token);
    rejectedUpload = { path, http: response.status(), request_key: headers['idempotency-key'], same_owner_JWT: true };
    const live = await invalidatedRows();
    await expect(imageRow(originalSession.request_key)).toContainText('原准备结果尚未确认');
    await expect(imageRow(originalImage.request_key)).toContainText('原上传结果尚未确认');
    await expect(imageRow(rejectedImage.request_key)).toContainText('原上传结果尚未确认');
    assert.equal(posts().length, beforePosts + 1);
    assert.equal(posts().filter(value => value.path.endsWith('/images')).length, beforeUploads + 1);
    return finish(name, { session: originalSession, image: originalImage, rejected_image: rejectedImage,
      rejected_upload: rejectedUpload, ...live });
  }
  if (name === 'invalidated-recover') {
    const before = posts().length; const live = await invalidatedRows();
    // The keys used below are read from verified current DOM rows, not a saved
    // intent passed directly into the component's check function.
    const sessionKey = live.keys.find(key => key === originalSession.request_key);
    const storedKey = live.keys.find(key => key === originalImage.request_key);
    const rejectedKey = live.keys.find(key => key === rejectedImage.request_key);
    assert.ok(sessionKey && storedKey && rejectedKey);
    await checkImage(sessionKey); await expect(imageRow(sessionKey)).toContainText('原创建前准备已核对');
    await expect(imageRow(storedKey)).toContainText('原图片保存已核对');
    await checkImage(storedKey); await expect(imageRow(storedKey)).toContainText('原图片保存已核对');
    await checkImage(rejectedKey); await expect(imageRow(rejectedKey)).toContainText('原上传结果尚未确认');
    await expect(cancelButton()).toBeVisible(); await expect(cancelButton()).toBeEnabled();
    assert.equal(posts().length, before); await invalidatedRows();
    assert.deepEqual((await imagesStored()).find(value => value.request_key === originalImage.request_key), originalImage);
    return finish(name, { session: originalSession, image: originalImage, rejected_image: rejectedImage,
      ...live, live_row_queries_only: true, no_new_author_POST: true });
  }
  if (name === 'revoked-home') {
    await page.goto(configuration.baseUrl + '/#/pages/customer-work/index');
    await expect(page.locator('[data-customer-work="error"]')).toContainText('手机订单管理权限');
    await expect(buttons('核对原收银编号')).toBeVisible(); await expect(buttons('进入次卡现金收银')).toHaveCount(0);
    return finish(name, { pending: await imagesStored() });
  }
  if (name === 'revoked-recover') {
    const before = posts().length; await buttons('核对原收银编号').click();
    await expect(imageRow(originalSession.request_key)).toBeVisible(); await checkImage(originalSession.request_key);
    await expect(imageRow(originalImage.request_key)).toContainText('原图片保存已核对');
    await checkImage(originalImage.request_key); await expect(cancelButton()).toBeVisible();
    await expect(buttons('上传图片')).toHaveCount(0); await expect(buttons('核对选品并取得报价')).toHaveCount(0);
    const text = await page.locator('body').innerText(); assert.doesNotMatch(text, /本机图片联系购买人|本机图片补充答案|00000000000/u);
    await expect(page.locator('input[aria-label="联系人姓名"],uni-input[aria-label="联系人姓名"] input')).toHaveCount(0);
    assert.equal(posts().length, before); assert.deepEqual((await imagesStored()).find(value => value.kind === 'image'), originalImage);
    return finish(name, { session: originalSession, image: originalImage, no_author_posts_or_revealed_form_PII: true });
  }
  throw Error('Unknown Cashier images Browser stage');
}

let sequence = Promise.resolve();
process.on('message', message => {
  if (message?.type === 'stop') { void close().finally(() => process.exit(0)); return; }
  sequence = sequence.then(async () => {
    if (message?.type === 'start') { process.send({ type: 'ready', ...await initialize(message) }); return; }
    if (message?.type === 'close-context') {
      await context?.close(); context=null; page=null;
      process.send({ type: 'stage-result', name: '__close-context', data: { closed: true } }); return;
    }
    if (message?.type === 'stage' && typeof message.name === 'string') {
      process.send({ type: 'stage-result', name: message.name, data: await perform(message.name) }); return;
    }
    throw Error('Unknown Cashier images Browser IPC');
  }).catch(async error => {
    // Preserve real rendered state before closing this owned Browser. This is
    // diagnostic evidence only; the original failure still rejects the stage.
    let diagnosticFailure = null;
    if (configuration?.output) {
      try {
        const evidence = { stage: stages[position], message: String(error?.stack ?? error),
          url: page?.url(), title: page ? await page.title() : null,
          text: page ? await page.locator('body').innerText() : null,
          consoleErrors, warnings, pageErrors, failed, external, calls, activationTrace, warningDetails };
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
