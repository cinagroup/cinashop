import { expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage } from 'node:http';
import { fork } from 'node:child_process';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { createApp } from '../../src/app';
import type { Container } from '../../src/lib/di';
import { adminRefundEvidenceFixture } from '../helpers/adminRefundEvidenceFixture';
import { validateFinanceFixtureUrl } from '../helpers/financePostgres';
import { adminRefundOperation, systemAdmin, systemRole, storeOrder, storeOrderCartInfo,
  storeOrderRefund, storeOrderRefundPayment, userBrokerage, adminRefundCreation, systemConfig } from '../../src/models/schema';
import { WechatPayService } from '../../src/services/wechat/WechatPayService';
import { AlipayRefundService } from '../../src/services/payment/AlipayRefundService';
import { ADMIN_REFUND_OPERATION_SQL } from '../../src/migrations/adminRefundOperation';
import { ADMIN_REFUND_CREATION_SQL } from '../../src/migrations/adminRefundCreation';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('../../src/lib/di', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/lib/di')>();
  return { ...original, createAdminDatabaseSession: () => {
    if (!wiring.container) throw Error('Missing owned acceptance connection');
    return { container: wiring.container, close: async () => {} };
  }, createContainer: () => {
    if (!wiring.container) throw Error('Owned browser SQL fixture unavailable');
    return wiring.container;
  } };
});
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid acceptance message');
  return value as Record<string, unknown>;
}
async function boundedBody(request: IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length; if (size > 8192) throw Error('Acceptance bridge body limit');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

it('joins the rendered Admin, real authenticated HTTP app and native SQL for lost-response recovery', async () => {
  validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL ?? ''); // Never PGlite/production fallback.
  const output = process.env.TEST_BROWSER_OUTPUT_DIR, packageJson = process.env.TEST_BROWSER_PACKAGE_JSON, executable = process.env.TEST_BROWSER_EXECUTABLE;
  if (!output || !packageJson || !executable) throw Error('Explicit browser tooling/output is required');
  const f = await adminRefundEvidenceFixture(undefined, [userBrokerage]);
  wiring.container = f.container;
  const report = (line: string) => { process.stdout.write(line + '\n'); };
  const unexpected: string[] = [], operations: Array<{ path: string; key: string | null; body: string; status?: number }> = [];
  let delayed: Request | undefined, delayedOutcome: unknown, connectionFailures = 0;
  let delayedCreation: Request | undefined, delayedCreationOutcome: unknown;
  const forbid = async () => { throw Error('Unexpected external provider I/O'); };
  vi.spyOn(globalThis, 'fetch').mockImplementation(forbid);
  vi.spyOn(WechatPayService.prototype, 'requestRefund').mockRejectedValue(new Error('synthetic provider response lost'));
  vi.spyOn(WechatPayService.prototype, 'queryRefund').mockResolvedValue({ status: 'SUCCESS', providerRefundId: 'joined-local-29' });
  vi.spyOn(AlipayRefundService.prototype, 'requestRefund').mockImplementation(forbid);
  vi.spyOn(AlipayRefundService.prototype, 'queryRefund').mockImplementation(forbid);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const app = createApp();
  const server = createServer((request, response) => {
    void (async () => {
      if (request.socket.remoteAddress !== '127.0.0.1') throw Error('Non-loopback acceptance request');
      const path = request.url ?? '';
      if (request.method === 'GET' && ['/api/site_config','/adminapi/new_push'].includes(path)) {
        const data = path === '/api/site_config' ? { site_name:'CinaShop SQL acceptance' }
          : { ordernum:0,inventory:0,commentnum:0,reflectnum:0,msgcount:0,sampled_at:1700000000 };
        response.setHeader('Content-Type','application/json'); response.end(JSON.stringify({status:200,msg:'synthetic shell only',data})); return;
      }
      if (!/^\/adminapi\/refund\/(?:list(?:\?.*)?|detail\/[1-9]\d*|creation\/(?:quote|create|execute|receipt|abandon)|operations\/(?:receipt|(?:execute|abandon)\/[1-9]\d*))$/.test(path)) {
        unexpected.push(path.split('?')[0]); response.writeHead(404); response.end(); return;
      }
      const headers = new Headers();
      for (let i = 0; i < request.rawHeaders.length; i += 2) headers.append(request.rawHeaders[i], request.rawHeaders[i + 1]);
      const body = await boundedBody(request);
      const input = new Request('http://127.0.0.1' + path, { method:request.method,headers,...(body ? {body} : {}) });
      const creationOrder = path.startsWith('/adminapi/refund/creation/') && body && 'review' in object(JSON.parse(body))
        ? object(object(JSON.parse(body)).review).id : undefined;
      if(path==='/adminapi/refund/creation/execute' && creationOrder===2 && !delayedCreation) {
        delayedCreation=input;
        response.writeHead(503,{'Content-Type':'application/json'});response.end(JSON.stringify({status:503,msg:'synthetic creation admission delayed',data:null}));return;
      }
      const observation = {path,key:headers.get('Idempotency-Key'),body,status:undefined as number | undefined};
      if (path.includes('/operations/')) operations.push(observation);
      if (path === '/adminapi/refund/operations/execute/35' && !delayed) {
        // Hold the original request before app admission, while reporting an
        // unknown result. Execute this captured packet only after a real fence.
        delayed = input; observation.status = 503;
        response.writeHead(503, {'Content-Type':'application/json'}); response.end(JSON.stringify({status:503,msg:'synthetic transport unavailable',data:null})); return;
      }
      const result = await app.fetch(input, f.env);
      observation.status = result.status;
      if (path === '/adminapi/refund/operations/abandon/35' && delayed) {
        delayedOutcome = await (await app.fetch(delayed.clone(), f.env)).json();
      }
      if(path==='/adminapi/refund/creation/abandon' && creationOrder===2 && delayedCreation)delayedCreationOutcome=await (await app.fetch(delayedCreation.clone(),f.env)).json();
      response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(await result.text());
    })().catch(() => { connectionFailures++; if (!response.headersSent) response.writeHead(500); response.end('Acceptance bridge failure'); });
  });
  let child: ReturnType<typeof fork> | undefined;
  try {
    // Use canonical PK/CHECK/index DDL for the receipt, not the generic fixture's
    // column-only projection. The guarded public installer is tested separately.
    await f.exec(ADMIN_REFUND_OPERATION_SQL);
    await f.exec(ADMIN_REFUND_CREATION_SQL);
    await f.db.insert(systemConfig).values({menuName:'refund_time_available',value:'0'});
    await f.db.update(storeOrderCartInfo).set({skuUnique:'qared001'}).where(eq(storeOrderCartInfo.id,1));
    await f.db.update(storeOrderCartInfo).set({skuUnique:'qared001'}).where(eq(storeOrderCartInfo.id,3));
    await f.db.update(storeOrder).set({payType:'weixin'}).where(eq(storeOrder.id,3));
    await f.db.insert(systemRole).values({id:2,type:1,roleName:'Local refund manager',rules:'refund.view,refund.manage'});
    await f.db.update(systemAdmin).set({level:1,roles:'2'}).where(eq(systemAdmin.id,100));
    for (const id of [28,29]) {
      await f.db.update(storeOrder).set({payType:id===28?'yue':'weixin',status:0}).where(eq(storeOrder.id,id));
      await f.db.update(storeOrderRefund).set({applyType:1,refundType:0}).where(eq(storeOrderRefund.id,id));
      await f.db.update(storeOrderCartInfo).set({skuUnique:'qared001'}).where(eq(storeOrderCartInfo.id,id));
    }
    const before = await f.snapshot();
    await new Promise<void>((done,fail) => { server.once('error',fail); server.listen(0,'127.0.0.1',done); });
    const address = server.address(); if (!address || typeof address === 'string') throw Error('No bridge port');
    const checkpoint = async (name: string) => {
      const rows = await f.db.select().from(adminRefundOperation), financial = await f.snapshot();
      if (name === 'balance-lost') {
        expect(rows).toMatchObject([{refundId:28,outcome:'balance-settled'}]);
        expect(financial.users.find(row=>row.uid===11)?.nowMoney).toBe('5.00');
        expect(financial.bills.filter(row=>row.type==='pay_product_refund')).toHaveLength(1);
        expect(financial.products.find(row=>row.id===70)?.stock).toBe(before.products.find(row=>row.id===70)!.stock+1);
        expect(financial.skus[0].stock).toBe(before.skus[0].stock+1);
        // Durable evidence remains recoverable without its mutable business row.
        await f.exec('DELETE FROM store_order_refund WHERE id=28; DELETE FROM store_order WHERE id=28');
      } else if (name === 'provider-admitted') {
        expect(WechatPayService.prototype.requestRefund).toHaveBeenCalledTimes(1);
        expect(WechatPayService.prototype.queryRefund).not.toHaveBeenCalled();
        expect(await f.db.select().from(storeOrderRefundPayment)).toMatchObject([{refundId:29,providerStatus:'UNKNOWN',attemptCount:1}]);
      } else if (name === 'provider-completed') {
        expect(WechatPayService.prototype.requestRefund).toHaveBeenCalledTimes(1);
        expect(WechatPayService.prototype.queryRefund).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({outRefundNo:'CNSR29',refundAmount:500}));
        expect((await f.applications()).find(row=>row.id===29)?.refundType).toBe(6);
        expect(financial.products.find(row=>row.id===70)?.stock).toBe(before.products.find(row=>row.id===70)!.stock+2);
      } else if (name === 'fenced') {
        expect(delayedOutcome).toMatchObject({status:200,data:{replayed:true,execution:null,receipt:{refundId:35,outcome:'abandoned'}}});
        expect((await f.applications()).find(row=>row.id===35)?.refundType).toBe(0);
        expect((await f.statuses()).filter(row=>row.oid===35)).toHaveLength(0);
      } else if (name === 'done') {
        expect(rows.map(row=>row.outcome).sort()).toEqual(['abandoned','balance-settled','provider-admitted','return-approved']);
        expect((await f.statuses()).filter(row=>row.oid===35)).toHaveLength(1);
        expect(financial.users.find(row=>row.uid===11)?.nowMoney).toBe('5.00');
        expect(financial.bills.filter(row=>row.type==='pay_product_refund')).toHaveLength(1);
      } else if(name==='creation-balance-lost') {
        const creation=await f.db.select().from(adminRefundCreation);
        expect(creation).toMatchObject([{orderId:1,outcome:'created'}]);
        expect(financial.users.find(row=>row.uid===11)?.nowMoney).toBe('8.00');
        expect(financial.bills.filter(row=>row.type==='pay_product_refund')).toHaveLength(2);
        await f.exec(`DELETE FROM store_order_refund WHERE id=${creation[0].refundId}; DELETE FROM store_order WHERE id=1`);
      } else if(name==='creation-fenced') {
        expect(delayedCreationOutcome).toMatchObject({status:200,data:{creation:{receipt:{orderId:2,outcome:'abandoned'},replayed:true},operation:null}});
        expect((await f.applications()).filter(row=>row.storeOrderId===2)).toHaveLength(0);
      } else if(name==='creation-provider') {
        expect(WechatPayService.prototype.requestRefund).toHaveBeenCalledTimes(2);
        expect(WechatPayService.prototype.queryRefund).toHaveBeenCalledTimes(1);
        const [creation]=await f.db.select().from(adminRefundCreation).where(eq(adminRefundCreation.orderId,3));
        expect((await f.db.select().from(storeOrderRefundPayment)).find(row=>row.refundId===creation.refundId)?.providerStatus).toBe('UNKNOWN');
      } else if(name==='creation-done') {
        const creations=await f.db.select().from(adminRefundCreation);
        expect(creations.map(row=>row.outcome).sort()).toEqual(['abandoned','created','created','created']);
        expect(WechatPayService.prototype.requestRefund).toHaveBeenCalledTimes(2);
        expect(WechatPayService.prototype.queryRefund).toHaveBeenCalledTimes(2);
        const sqlOnly=creations.find(row=>row.orderId===4)!;
        expect(rows.filter(row=>row.refundId===sqlOnly.refundId)).toHaveLength(0);
        expect((await f.applications()).find(row=>row.id===sqlOnly.refundId)?.refundType).toBe(0);
        expect(financial.users.find(row=>row.uid===11)?.nowMoney).toBe('8.00');
        expect(financial.bills.filter(row=>row.type==='pay_product_refund')).toHaveLength(2);
      } else throw Error('Unknown browser checkpoint');
      report('JOINED_REFUND_SQL '+JSON.stringify({checkpoint:name,receipts:rows.length}));
    };
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (!['systemroot','windir','path','temp','tmp','localappdata','userprofile'].includes(key.toLowerCase())) delete env[key];
    }
    child = fork(resolve(import.meta.dirname,'admin-refund-operation.driver.mjs'), [], {env,stdio:['ignore','pipe','pipe','ipc']});
    const running = child;
    let result: unknown, failure: Error | undefined;
    running.stdout?.on('data', data => report(String(data).trim()));
    running.stderr?.on('data', () => { failure ??= Error('Browser driver emitted stderr'); });
    running.on('message', value => {
      void (async () => {
        const message = object(value);
        if (message.type === 'checkpoint' && typeof message.name === 'string') {
          try { await checkpoint(message.name); running.send({type:'checkpoint-done',name:message.name}); }
          catch (error) { failure = error instanceof Error ? error : Error('SQL checkpoint failed'); running.send({type:'checkpoint-failed',name:message.name}); }
        } else if (message.type === 'result') result = message;
        else if (message.type === 'failure') failure = Error(typeof message.message === 'string' ? message.message : 'Browser acceptance failed');
        else throw Error('Unknown driver message');
      })().catch(error => { failure = error instanceof Error ? error : Error('Driver IPC failed'); });
    });
    running.send({type:'start',baseUrl:`http://127.0.0.1:${address.port}`,adminRoot:resolve(import.meta.dirname,'../../../view/admin-ts'),
      output,packageJson,executable,token:f.tokens.get(100)});
    const exit = await new Promise<number|null>((done,fail) => { running.once('error',fail); running.once('exit',done); });
    if (failure) throw failure;
    expect(exit).toBe(0); expect(object(result).passed).toBe(true);
    expect(connectionFailures).toBe(0); expect(unexpected).toEqual([]); expect(fetch).not.toHaveBeenCalled();
    expect(AlipayRefundService.prototype.requestRefund).not.toHaveBeenCalled();
    expect(AlipayRefundService.prototype.queryRefund).not.toHaveBeenCalled();
    const balance = operations.filter(row=>row.path.endsWith('/28'));
    expect(balance).toHaveLength(1); // No monetary replay needed: receipt alone resolves.
    const provider = operations.filter(row=>row.path.endsWith('/29'));
    expect(new Set(provider.map(row=>row.key)).size).toBe(1);
    expect(provider[0].body).toBe(provider.at(-1)?.body);
    report('JOINED_REFUND_ACCEPTANCE '+JSON.stringify({passed:true,operations:operations.map(({path,status})=>({path,status})),providerRequests:2,providerQueries:2,output}));
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.send({type:'stop'});
      await new Promise<void>(done => { child!.once('exit',()=>done()); setTimeout(()=>{child!.kill();done();},8000).unref(); });
    }
    server.closeAllConnections(); await new Promise<void>(done=>server.close(()=>done()));
    wiring.container = undefined; vi.restoreAllMocks(); await f.close();
  }
});
