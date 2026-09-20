import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Permanent opt-in driver; no browser/runtime dependency installation. The
// parent supplies only a freshly issued fixture JWT, never host credentials.
let browser, vite, closing;
const pending = new Map();
const close = () => closing ??= (async () => { await browser?.close(); await vite?.close(); })();
process.on('message', message => {
  if (message?.type === 'stop') void close().finally(() => process.exit(1));
  if (message?.type === 'checkpoint-done') pending.get(message.name)?.resolve();
  if (message?.type === 'checkpoint-failed') pending.get(message.name)?.reject(Error('SQL checkpoint failed: ' + message.name));
});
process.on('disconnect', () => { void close(); });
const checkpoint = name => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(Error('SQL checkpoint timeout: ' + name)), 15000);
  pending.set(name, { resolve: () => { clearTimeout(timeout); pending.delete(name); resolve(); },
    reject: error => { clearTimeout(timeout); pending.delete(name); reject(error); } });
  process.send({type:'checkpoint',name});
});

async function run(config) {
  assert.equal(config.type,'start');
  assert.match(config.baseUrl,/^http:\/\/127\.0\.0\.1:\d+$/);
  const metadata = JSON.parse(readFileSync(config.packageJson,'utf8'));
  assert.equal(metadata.name,'playwright');
  const require = createRequire(config.packageJson), {chromium,expect} = require('playwright/test');
  const {createServer} = await import(pathToFileURL(join(config.adminRoot,'node_modules/vite/dist/node/index.js')).href);
  const {default:vue} = await import(pathToFileURL(join(config.adminRoot,'node_modules/@vitejs/plugin-vue/dist/index.mjs')).href);
  vite = await createServer({root:config.adminRoot,configFile:false,plugins:[vue()],logLevel:'error',
    resolve:{alias:{'@':join(config.adminRoot,'src')}},
    server:{host:'127.0.0.1',port:0,strictPort:true,proxy:{'/adminapi':{target:config.baseUrl,changeOrigin:true},'/api':{target:config.baseUrl,changeOrigin:true}}}});
  await vite.listen();
  const address = vite.httpServer.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/refund`;
  browser = await chromium.launch({executablePath:config.executable,headless:true});
  const context = await browser.newContext({viewport:{width:1440,height:1000}});
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  const errors=[],warnings=[],failed=[],unexpected=[],operations=[],creations=[];
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());if(message.type()==='warning')warnings.push(message.text());});
  page.on('pageerror',error=>unexpected.push('pageerror: '+error.message));
  page.on('requestfailed',request=>failed.push({path:new URL(request.url()).pathname,error:request.failure()?.errorText}));
  page.on('request',request=>{if(request.url().includes('/refund/operations/'))operations.push({path:new URL(request.url()).pathname,key:request.headers()['idempotency-key'],body:request.postData()});});
  page.on('request',request=>{if(request.url().includes('/refund/creation/'))creations.push({path:new URL(request.url()).pathname,key:request.headers()['idempotency-key'],body:request.postData()});});
  await context.addInitScript(({token})=>{
    if(!localStorage.getItem('admin_token')){
      localStorage.setItem('admin_token',token);
      localStorage.setItem('admin_session',JSON.stringify({userInfo:{id:100,level:1,account:'SQL 隔离验收管理员',head_pic:'',real_name:'测试',roles:'2'},
        menus:[{id:1,pid:0,path:'/refund',name:'退款审核',icon:'',sort:1,type:1,children:[]}],uniqueAuth:['refund.view','refund.manage']}));
    }
  },{token:config.token});
  let dropped = false,creationDropped=false;
  await context.route('**/*',async route=>{
    const target = new URL(route.request().url());
    if(target.origin!==new URL(url).origin){unexpected.push(target.origin+target.pathname);return route.abort();}
    if(target.pathname==='/adminapi/refund/operations/execute/28'&&!dropped){
      dropped=true;
      const response=await route.fetch();
      assert.equal((await response.json()).data.receipt.outcome,'balance-settled');
      // Actual HTTP and SQL already completed; the page never receives this body.
      return route.abort('failed');
    }
    if(target.pathname==='/adminapi/refund/creation/execute' && JSON.parse(route.request().postData()).review.id===1 && !creationDropped) {
      creationDropped=true;const response=await route.fetch();assert.equal((await response.json()).data.operation.receipt.outcome,'balance-settled');
      return route.abort('failed');
    }
    return route.continue();
  });
  const dialog=page.locator('.el-dialog');
  const openId=async id=>{
    if(await dialog.isVisible()) {await dialog.getByRole('button',{name:'Close this dialog'}).click();await expect(dialog).toBeHidden();}
    await page.getByRole('textbox',{name:'恢复原操作的退款单 ID'}).fill(String(id));
    await page.getByRole('button',{name:'打开原操作',exact:true}).click();await expect(dialog).toBeVisible();
  };
  const confirm=async()=>{const box=page.locator('.el-message-box');await expect(box).toBeVisible();await box.getByRole('button',{name:'OK',exact:true}).click();await expect(box).toBeHidden();};
  const action=async name=>{await page.getByRole('button',{name,exact:true}).click();await confirm();};
  const ready=()=>expect(page.getByRole('button',{name:'查询原操作回执',exact:true})).toBeEnabled();
  const stored=id=>page.evaluate(id=>JSON.parse(localStorage.getItem('admin-refund-intent-v3:100:'+id)),id);
  const screenshot=async name=>{await expect(page.locator('.el-message:visible')).toHaveCount(0);const path=join(config.output,name+'.png');await page.screenshot({path,fullPage:false});console.log('JOINED_SCREENSHOT '+path);};
  try {
    await page.goto(url);await page.getByRole('button',{name:'打开原操作',exact:true}).waitFor();
    assert.equal(await page.title(),'退款审核 - CinaShop 管理后台');await expect(page.getByRole('button',{name:'详情',exact:true}).first()).toBeVisible();
    await openId(28);await action('执行退款 ¥5.00');await ready();assert.equal((await stored(28)).phase,'pending');
    await checkpoint('balance-lost');
    await page.reload();await openId(28);await ready();
    await page.getByRole('button',{name:'查询原操作回执',exact:true}).click();
    await expect(dialog.getByText('原操作回执已确认：退款已完成（余额或零现金结算）',{exact:true})).toBeVisible();
    assert.equal((await stored(28)).phase,'resolved');assert.equal(operations.filter(row=>row.path.endsWith('/execute/28')).length,1);
    await screenshot('joined-balance-missing-detail');
    await openId(29);await action('执行退款 ¥5.00');await ready();
    await page.getByRole('button',{name:'查询原操作回执',exact:true}).click();await ready();
    await action('放弃未受理的原操作');await ready();assert.equal((await stored(29)).phase,'pending');
    await checkpoint('provider-admitted');await screenshot('joined-provider-admitted');
    await action('重试原操作');await expect(dialog.getByText('原操作渠道结算已确认完成',{exact:true})).toBeVisible();await checkpoint('provider-completed');
    await openId(35);await action('同意退货');await ready();
    await page.getByRole('button',{name:'查询原操作回执',exact:true}).click();await ready();
    await expect(dialog.getByText('暂未查到原操作回执；迟到请求仍可能受理，不可据此新建操作',{exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'同意退货',exact:true})).toBeDisabled();
    await action('放弃未受理的原操作');await expect(page.getByRole('button',{name:'同意退货',exact:true})).toBeEnabled();
    const fenced=await stored(35);assert.equal(fenced.receipt.outcome,'abandoned');await checkpoint('fenced');
    await action('同意退货');await expect(dialog.getByText('原操作回执已确认：已同意退货，等待用户寄回',{exact:true})).toBeVisible();
    assert.notEqual((await stored(35)).nonce,fenced.nonce);await checkpoint('done');
    await page.setViewportSize({width:390,height:844});await dialog.getByText('原操作回执已确认：已同意退货，等待用户寄回',{exact:true}).scrollIntoViewIfNeeded();await screenshot('joined-mobile-return');
    const count=operations.length;await page.getByRole('button',{name:'拒绝退款',exact:true}).click();await page.locator('.el-message-box').getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.locator('.el-message-box')).toBeHidden();assert.equal(operations.length,count);await screenshot('joined-mobile-actions');
    await dialog.getByRole('button',{name:'Close this dialog'}).click();await expect(dialog).toBeHidden();
    await page.setViewportSize({width:1440,height:1000});
    const panel=page.locator('.creation'), creationStored=id=>page.evaluate(id=>JSON.parse(localStorage.getItem('admin-refund-creation-v1:100:'+id)),id);
    const openCreation=async id=>{await page.getByRole('textbox',{name:'主动退款订单 ID',exact:true}).fill(String(id));await page.getByRole('button',{name:'打开主动退款',exact:true}).click();await expect(panel.getByText('当前订单 ID '+id,{exact:false})).toBeVisible();};
    const creationConfirm=async name=>{await panel.getByRole('button',{name,exact:true}).click();const box=page.locator('.el-message-box');await expect(box).toBeVisible();await box.getByRole('button',{name:'确认',exact:true}).click();await expect(box).toBeHidden();};
    const creationReady=()=>expect(panel.getByRole('button',{name:'查询创建回执',exact:true})).toBeEnabled();
    const prepareCreation=async id=>{await openCreation(id);await panel.getByRole('button',{name:'读取全部剩余商品报价',exact:true}).click();await expect(panel.getByText('本次报价核对',{exact:true})).toBeVisible();await panel.getByRole('textbox',{name:'主动退款原因',exact:true}).fill('隔离浏览器主动退款');};
    await prepareCreation(1);
    await panel.getByRole('spinbutton',{name:'商品项 501 数量',exact:true}).fill('1');await panel.getByRole('textbox',{name:'主动退款订单 ID',exact:true}).focus();
    await expect(panel.getByText('本次报价核对',{exact:true})).toHaveCount(0);
    await panel.getByRole('button',{name:'重新报价所选商品',exact:true}).click();await expect(panel.getByText('本次 1 件，上限 ¥5.00。指定商品及件数',{exact:false})).toBeVisible();
    await panel.getByRole('textbox',{name:'本次退款金额',exact:true}).fill('3.00');
    await creationConfirm('创建并执行退款');await creationReady();const original=await creationStored(1);assert.equal(original.phase,'pending');
    await checkpoint('creation-balance-lost');await page.reload();await openCreation(1);await creationReady();
    await panel.getByRole('button',{name:'查询创建回执',exact:true}).click();await expect(panel.getByRole('button',{name:'查询资金回执',exact:true})).toBeEnabled();
    assert.equal((await creationStored(1)).phase,'pending');await panel.getByRole('button',{name:'查询资金回执',exact:true}).click();
    await expect(panel.getByText('原操作回执已确认：退款已完成（余额或零现金结算）',{exact:true})).toBeVisible();assert.equal((await creationStored(1)).phase,'resolved');
    assert.equal(creations.filter(row=>row.path.endsWith('/execute')&&JSON.parse(row.body).review.id===1).length,1);await screenshot('joined-creation-recovered');
    await prepareCreation(2);await creationConfirm('创建并执行退款');await creationReady();
    await panel.getByRole('button',{name:'查询创建回执',exact:true}).click();await creationReady();assert.equal((await creationStored(2)).receipt,null);
    await expect(panel.getByRole('button',{name:'读取全部剩余商品报价',exact:true})).toBeDisabled();
    await creationConfirm('放弃未创建的原请求');await expect(panel.getByRole('button',{name:'读取全部剩余商品报价',exact:true})).toBeEnabled();await checkpoint('creation-fenced');
    await prepareCreation(3);await creationConfirm('创建并执行退款');await creationReady();
    await panel.getByRole('button',{name:'查询创建回执',exact:true}).click();await creationReady();
    await panel.getByRole('button',{name:'查询资金回执',exact:true}).click();await creationReady();await checkpoint('creation-provider');
    await creationConfirm('恢复原主动退款');await expect(panel.getByText('原操作渠道结算已确认完成',{exact:true})).toBeVisible();
    const providerCreations=creations.filter(row=>row.path.endsWith('/execute')&&JSON.parse(row.body).review.id===3);assert.equal(providerCreations.length,2);assert.equal(providerCreations[0].key,providerCreations[1].key);assert.equal(providerCreations[0].body,providerCreations[1].body);
    await prepareCreation(4);await creationConfirm('仅创建申请');await creationReady();assert.equal((await creationStored(4)).phase,'pending');
    await panel.getByRole('button',{name:'查询资金回执',exact:true}).click();await creationReady();assert.equal((await creationStored(4)).operation.receipt,null);
    await page.reload();await openCreation(4);await creationReady();assert.equal((await creationStored(4)).receipt.outcome,'created');await checkpoint('creation-done');
    await page.setViewportSize({width:390,height:844});await panel.getByRole('button',{name:'查询创建回执',exact:true}).scrollIntoViewIfNeeded();await screenshot('joined-creation-mobile');
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);assert.deepEqual(warnings,[]);assert.deepEqual(unexpected,[]);
    assert.deepEqual(failed,[{path:'/adminapi/refund/operations/execute/28',error:'net::ERR_FAILED'},{path:'/adminapi/refund/creation/execute',error:'net::ERR_FAILED'}]);
    // The only resource errors must be the two deliberate transport failures.
    assert.equal(errors.length,4);assert.ok(errors.every(error=>error.includes('net::ERR_FAILED')||error.includes('503')));
    const evidence={passed:true,url,title:await page.title(),browser:browser.version(),playwright:metadata.version,
      viewports:['1440x1000','390x844'],operationRequests:operations.length,creationRequests:creations.length,expectedFaultConsoleErrors:errors.length,unexpectedErrors:0,warnings:0};
    writeFileSync(join(config.output,'joined-browser-result.json'),JSON.stringify(evidence,null,2)+'\n');
    console.log('JOINED_BROWSER '+JSON.stringify(evidence));
    process.send({type:'result',passed:true});
  } catch(error) {
    console.log('JOINED_BROWSER_FAILURE '+JSON.stringify({message:error.message,url:page.url(),body:(await page.locator('body').innerText()).slice(-5000),errors,warnings,failed,unexpected}));
    await page.screenshot({path:join(config.output,'joined-failure.png'),fullPage:false});throw error;
  }
}
process.once('message', message=>{
  void run(message).catch(error=>{process.exitCode=1;process.send({type:'failure',message:error.message});})
    .finally(async()=>{await close();console.log('JOINED_BROWSER_CLOSED');process.disconnect();});
});
