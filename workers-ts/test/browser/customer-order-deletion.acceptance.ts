import { expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage } from 'node:http';
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { eq } from 'drizzle-orm';
import { createApp } from '../../src/app';
import type { Container } from '../../src/lib/di';
import { createToken, md5 } from '../../src/utils/jwt';
import { refundRuntimeFixture } from '../helpers/refundRuntimeFixture';
import { validateSequenceRunnerTestUrl } from '../helpers/kefuSequenceRunnerDatabase';
import { storeOrder, storeOrderStatus, storeProduct, storeProductAttrValue, user } from '../../src/models/schema';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('../../src/lib/di', async original => ({
  ...await original<typeof import('../../src/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Owned runtime unavailable'); return wiring.container; },
}));
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid acceptance message');
  return value as Record<string, unknown>;
}
async function bodyOf(request: IncomingMessage) {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += part.length; if (bytes > 8192) throw Error('Acceptance body limit'); chunks.push(part);
  }
  return Buffer.concat(chunks).toString('utf8');
}

it.each(['pc', 'mobile'] as const)('joins %s deletion, authenticated HTTP and non-owner native PostgreSQL', async kind => {
  validateSequenceRunnerTestUrl(process.env.TEST_FINANCE_POSTGRES_URL ?? '');
  const output = process.env.TEST_BROWSER_OUTPUT_DIR, packageJson = process.env.TEST_BROWSER_PACKAGE_JSON, executable = process.env.TEST_BROWSER_EXECUTABLE;
  if (!output || !packageJson || !executable) throw Error('Explicit existing browser tooling and external output required');
  const f = await refundRuntimeFixture();
  const report = (line: string) => process.stdout.write(line + '\n');
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await f.withRuntime(async runtime => {
      wiring.container = runtime.container;
      const [role] = await runtime.exec(`SELECT current_user AS role,session_user AS session,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls
        FROM pg_roles WHERE rolname=current_user`);
      expect(role).toMatchObject({ role: runtime.role, session: runtime.role, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
      // No host credentials/bindings. Real JWT and DB password/status checks;
      // Redis is deliberately absent in this test environment, not a production acceptance.
      const env = { ...f.env, APP_KEY: Buffer.from(randomBytes(32)).toString('hex'), NODE_ENV: 'test' };
      const [buyer] = await f.db.select().from(user).where(eq(user.uid, 11));
      const [other] = await f.db.select().from(user).where(eq(user.uid, 22));
      const token = (await createToken(11, 'api', md5(buyer.pwd), env.APP_KEY)).token;
      const foreignToken = (await createToken(22, 'api', md5(other.pwd), env.APP_KEY)).token;
      // Media is outside this acceptance; do not load the quote fixture's SVG endpoint.
      await f.db.update(storeProduct).set({ image: '' });
      await f.db.update(storeProductAttrValue).set({ image: '' });
      const baseline = await f.state();
      const unpaid = await runtime.checkout(), [unpaidOrder] = await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, unpaid.orderId));
      const beforeUnpaid = await f.state();
      expect(beforeUnpaid.user).not.toEqual(baseline.user);
      expect(beforeUnpaid.store_product_attr_value).not.toEqual(baseline.store_product_attr_value);
      let afterUnpaid: Awaited<ReturnType<typeof f.state>> | undefined;
      let beforeRefundDelete: Awaited<ReturnType<typeof f.state>> | undefined;
      let pendingState: Awaited<ReturnType<typeof f.state>> | undefined;
      let refundId = 0, selectedId = 0, remainderId = 0, rootId = 0;
      const checkpoints: string[] = [], unexpected: string[] = [];
      const calls: Array<{ path: string; method: string; orderId?: unknown; status: unknown }> = [];
      let bridgeFailures = 0;
      const app = createApp();
      const root = resolve(import.meta.dirname, '../../../view', kind === 'pc' ? 'pc-ts/dist' : 'uniapp-ts/dist/build/h5');
      const server = createServer((request, response) => {
        void (async () => {
          if (request.socket.remoteAddress !== '127.0.0.1') throw Error('Non-loopback request');
          const path = request.url ?? '/', pathname = new URL(path, 'http://localhost').pathname;
          response.setHeader('Cache-Control', 'no-store');
          // Shell-only stand-ins: no fixture order, refund or identity response is synthesized.
          const shell: Record<string, unknown> = {
            '/api/site_config': { site_name: 'CinaShop SQL 验收', site_logo: '/logo.png', record_No: '', ico_path: '/favicon.ico' },
            '/api/share': { title: 'CinaShop SQL 验收', synopsis: '', img: '' },
            '/api/cart/count': { count: 0 }, '/api/cart/list': [], '/api/diy/get_suspended': { is_show: 0, button: [] },
          };
          if (request.method === 'GET' && Object.hasOwn(shell, pathname)) {
            response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ status: 200, msg: 'fixture shell', data: shell[pathname] })); return;
          }
          if (pathname.startsWith('/api/')) {
            const allowed = request.method === 'POST' ? pathname === '/api/order/del'
              : request.method === 'GET' && (pathname === '/api/order/list' || pathname === '/api/order/refund/list' || /^\/api\/order\/refund\/detail\/[1-9]\d*$/.test(pathname));
            if (!allowed) { unexpected.push(pathname); response.writeHead(404); response.end(); return; }
            const headers = new Headers();
            for (let i = 0; i < request.rawHeaders.length; i += 2) headers.append(request.rawHeaders[i], request.rawHeaders[i + 1]);
            const body = await bodyOf(request);
            const result = await app.fetch(new Request('http://127.0.0.1' + path, { method: request.method, headers, ...(body ? { body } : {}) }), env);
            expect(result.headers.get('Cache-Control')).toContain('no-store');
            const text = await result.text(), envelope = object(JSON.parse(text));
            calls.push({ path, method: request.method ?? '', ...(body ? { orderId: object(JSON.parse(body)).order_id } : {}), status: envelope.status });
            response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(text); return;
          }
          if (request.method !== 'GET') throw Error('Unexpected static mutation');
          let file = resolve(root, '.' + decodeURIComponent(pathname));
          if (file !== root && !file.startsWith(root + sep)) throw Error('Static path outside build');
          if (file === root || !extname(file)) file = join(root, 'index.html');
          const type: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
          response.setHeader('Content-Type', type[extname(file)] ?? 'application/octet-stream'); response.end(await readFile(file));
        })().catch(() => { bridgeFailures++; if (!response.headersSent) response.writeHead(500); response.end('Local acceptance bridge failure'); });
      });
      const checkpoint = async (name: string): Promise<unknown> => {
        checkpoints.push(name);
        if (name === 'unpaid-kept') { expect(await f.state()).toEqual(beforeUnpaid); return null; }
        if (name === 'unpaid-deleted') {
          expect(await runtime.order(unpaidOrder.id)).toMatchObject({ paid: 0, status: -2, isDel: 1 });
          afterUnpaid = await f.state();
          for (const table of ['user', 'store_product', 'store_product_attr_value']) expect(afterUnpaid[table], table).toEqual(baseline[table]);
          const audits = await f.db.select().from(storeOrderStatus).where(eq(storeOrderStatus.oid, unpaidOrder.id));
          expect(audits.filter(row => row.changeType === 'cancel')).toHaveLength(1);
          expect(audits.filter(row => row.changeType === 'remove_order')).toHaveLength(1);
          return null;
        }
        if (name === 'unpaid-recovered') {
          expect(await f.state()).toEqual(afterUnpaid);
          const source = await runtime.createPaid({ key: 'joined-paid', orderId: 'joined_paid' }); rootId = source.id;
          const application = await runtime.apply(source.id); refundId = application.refundId; await runtime.finish(refundId);
          const receipt = await runtime.receipt(refundId); selectedId = receipt.selectedOrderId; remainderId = receipt.remainingOrderId!;
          beforeRefundDelete = await f.state();
          return { refundId, selected: (await runtime.order(selectedId)).orderId, remainder: (await runtime.order(remainderId)).orderId };
        }
        if (name === 'refund-kept') { expect(await f.state()).toEqual(beforeRefundDelete); return null; }
        if (name === 'refunded-deleted') {
          expect(await runtime.order(selectedId)).toMatchObject({ isDel: 1, refundStatus: 2 });
          expect((await runtime.order(rootId)).isDel).toBe(0); expect((await runtime.order(remainderId)).isDel).toBe(0);
          const after = await f.state();
          for (const table of Object.keys(beforeRefundDelete!).filter(table => !['store_order', 'store_order_status'].includes(table))) expect(after[table], table).toEqual(beforeRefundDelete![table]);
          expect((await f.db.select().from(storeOrderStatus).where(eq(storeOrderStatus.oid, selectedId))).filter(row => row.changeType === 'remove_order')).toHaveLength(1);
          expect(await runtime.finish(refundId)).toBe('already-completed'); expect(await f.state()).toEqual(after);
          return null;
        }
        if (name === 'history-read') {
          // Real next-generation application, then inject only a stale terminal summary.
          await runtime.apply(remainderId);
          await f.db.update(storeOrder).set({ status: 3, refundStatus: 0 }).where(eq(storeOrder.id, remainderId));
          pendingState = await f.state(); return null;
        }
        if (name === 'pending-rejected') { expect(await f.state()).toEqual(pendingState); return null; }
        throw Error('Unexpected SQL checkpoint: ' + name);
      };
      let child: ReturnType<typeof fork> | undefined, failure: Error | undefined, result: unknown;
      try {
        await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
        const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing local address');
        report('CUSTOMER_BROWSER_HTTP ' + JSON.stringify({ kind, port: address.port }));
        const childEnv = { ...process.env };
        for (const name of Object.keys(childEnv)) {
          if (!['systemroot', 'windir', 'path', 'temp', 'tmp', 'localappdata', 'userprofile'].includes(name.toLowerCase())) delete childEnv[name];
        }
        child = fork(resolve(import.meta.dirname, 'customer-order-deletion.driver.mjs'), [], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        const running = child;
        running.stdout?.on('data', data => report(String(data).trim()));
        running.stderr?.on('data', () => { failure ??= Error('Browser driver emitted stderr'); });
        const exited = new Promise<number | null>((done, fail) => { running.once('error', fail); running.once('exit', done); });
        running.on('message', (raw: unknown) => {
          void (async () => {
            const message = object(raw);
            if (message.type === 'checkpoint' && typeof message.name === 'string') {
              try { running.send({ type: 'checkpoint-done', name: message.name, data: await checkpoint(message.name) }); }
              catch (error) { failure = error instanceof Error ? error : Error('SQL checkpoint failed'); running.send({ type: 'checkpoint-failed', name: message.name }); }
            } else if (message.type === 'result') result = message;
            else if (message.type === 'failure') failure ??= Error(String(message.message));
            else throw Error('Unknown browser message');
          })().catch(error => { failure = error instanceof Error ? error : Error('IPC failed'); });
        });
        running.send({ type: 'start', kind, baseUrl: `http://127.0.0.1:${address.port}`, output, packageJson, executable, token, foreignToken, unpaid: unpaid.orderId });
        const exit = await exited; if (failure) throw failure;
        expect(exit).toBe(0); expect(object(result).passed).toBe(true);
        expect(checkpoints).toEqual(['unpaid-kept', 'unpaid-deleted', 'unpaid-recovered', 'refund-kept', 'refunded-deleted', 'history-read', 'pending-rejected']);
        expect(calls.filter(call => call.method === 'POST' && call.status === 200)).toHaveLength(2);
        expect(calls.filter(call => call.method === 'POST')).toHaveLength(7); // 3 auth negatives + 2 successes + duplicate + active refund.
        expect(bridgeFailures).toBe(0); expect(unexpected).toEqual([]); expect(fetch).not.toHaveBeenCalled();
        report('CUSTOMER_BROWSER_SQL ' + JSON.stringify({ kind, passed: true, checkpoints, requests: calls, output }));
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) {
          child.send({ type: 'stop' });
          await new Promise<void>(done => { child!.once('exit', () => done()); setTimeout(() => { child!.kill(); done(); }, 8000).unref(); });
        }
        server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
        wiring.container = undefined;
      }
    });
  } finally { wiring.container = undefined; vi.restoreAllMocks(); await f.close(); }
});
