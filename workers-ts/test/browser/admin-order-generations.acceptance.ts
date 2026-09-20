import { expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage } from 'node:http';
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '../../src/app';
import { createContainerFromDb, type Container } from '../../src/lib/di';
import { createToken, md5 } from '../../src/utils/jwt';
import { refundRuntimeFixture } from '../helpers/refundRuntimeFixture';
import { validateSequenceRunnerTestUrl } from '../helpers/kefuSequenceRunnerDatabase';
import { storeOrder, storeProduct, storeProductAttrValue, systemAdmin, systemRole } from '../../src/models/schema';

// Only environment/DB binding wiring is replaced. Browser requests use the real
// app routes, JWT/password checks, permission service, controller and SQL reads.
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('../../src/lib/di', async original => ({ ...await original<typeof import('../../src/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Missing owned read connection'); return wiring.container; } }));
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Expected acceptance object');
  return value as Record<string, unknown>;
}
async function bodyOf(request: IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += part.length; if (size > 8192) throw Error('Acceptance body too large'); chunks.push(part); }
  return Buffer.concat(chunks).toString('utf8');
}
it.each(['desktop', 'mobile'] as const)('joins %s Admin reads, real HTTP/auth and SELECT-only PostgreSQL across successive refunds', async kind => {
  validateSequenceRunnerTestUrl(process.env.TEST_FINANCE_POSTGRES_URL ?? '');
  const output = process.env.TEST_BROWSER_OUTPUT_DIR, packageJson = process.env.TEST_BROWSER_PACKAGE_JSON, executable = process.env.TEST_BROWSER_EXECUTABLE;
  if (!output || !packageJson || !executable) throw Error('Explicit external output and existing tooling required');
  const f = await refundRuntimeFixture(), report = (line: string) => process.stdout.write(line + '\n');
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await f.db.insert(systemRole).values({ id: 990, roleName: 'Local order reader', rules: 'order.view', status: 1 });
    await f.db.insert(systemAdmin).values([
      { id: 990, account: 'local-order-reader', pwd: 'synthetic-digest', adminType: 1, level: 1, roles: '990' },
      { id: 991, account: 'local-denied', pwd: 'synthetic-digest', adminType: 1, level: 1 },
      { id: 992, account: 'local-supplier', pwd: 'synthetic-digest', adminType: 4, level: 0 },
    ]);
    // Media is not the subject of this test; only this owned fixture is changed.
    await f.db.update(storeProduct).set({ image: '' }); await f.db.update(storeProductAttrValue).set({ image: '' });
    const env = { ...f.env, APP_KEY: Buffer.from(randomBytes(32)).toString('hex'), NODE_ENV: 'test' };
    const token = (await createToken(990, 'admin', md5('synthetic-digest'), env.APP_KEY)).token;
    const deniedToken = (await createToken(991, 'admin', md5('synthetic-digest'), env.APP_KEY)).token;
    const supplierToken = (await createToken(992, 'admin', md5('synthetic-digest'), env.APP_KEY)).token;
    const customerToken = (await createToken(11, 'api', md5('synthetic-digest'), env.APP_KEY)).token;
    await f.withRuntime(async writer => {
      const source = await writer.createPaid(), application = await writer.apply(source.id); await writer.finish(application.refundId);
      const receipt = await writer.receipt(application.refundId), remainderId = receipt.remainingOrderId!;
      const selected = await writer.order(receipt.selectedOrderId), remaining = await writer.order(remainderId);
      expect(selected.payPrice).toBe('12.80'); expect(remaining.payPrice).toBe('42.20'); expect(source.payPrice).toBe('55.00');
      // Extra list-only rows exercise actual offset/count SQL without inventing
      // more paid checkouts or exhausting the finite fixture inventory.
      await f.db.insert(storeOrder).values(Array.from({ length: 19 }, (_, index) => ({
        orderId: 'local_extra_' + index, unique: 'local-extra-' + index, uid: 11, paid: 0, addTime: index,
        totalNum: 1, totalPrice: '1.00', payPrice: '1.00', realName: '本地分页样本',
      })));
      let baseline = await f.state();
      await f.withRuntimeRole!(async reader => {
        if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(reader.role)) throw Error('Not an owned role');
        // All new_push subqueries require table access, even when the CASE for
        // that domain is false. These explicit reads do not grant business writes.
        await f.exec(`GRANT SELECT ON system_admin,system_role,system_menus,store_order,store_order_cart_info,store_product,store_product_reply,user_extract TO "${reader.role}"`);
        wiring.container = createContainerFromDb(reader.db);
        const [identity] = await reader.db.execute(sql`SELECT current_user AS role,session_user AS session,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,
          has_table_privilege(current_user,'store_order','UPDATE') AS can_write,
          (SELECT count(*)::integer FROM pg_class WHERE relnamespace='public'::regnamespace AND relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)) AS owned
          FROM pg_roles WHERE rolname=current_user`);
        expect(identity).toEqual({ role: reader.role, session: reader.role, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false, can_write: false, owned: 0 });
        expect(reader.pid).not.toBe(writer.pid);
        const app = createApp(), root = resolve(import.meta.dirname, '../../../view/admin-ts/dist');
        const checkpoints: string[] = [], unexpected: string[] = [];
        const calls: Array<{ path: string; method: string; status: unknown; httpStatus: number }> = [];
        let bridgeFailures = 0;
        const server = createServer((request, response) => {
          void (async () => {
            if (request.socket.remoteAddress !== '127.0.0.1') throw Error('Non-loopback request');
            const path = request.url ?? '/', pathname = new URL(path, 'http://localhost').pathname;
            response.setHeader('Cache-Control', 'no-store');
            // Login branding is a shell-only stand-in. No order, session,
            // permission, counter or financial response is synthesized here.
            if (request.method === 'GET' && pathname === '/api/site_config') {
              response.setHeader('Content-Type', 'application/json');
              response.end(JSON.stringify({ status: 200, data: { site_name: 'CinaShop SQL 验收', site_logo: '/logo.png',
                site_logo_square: '/logo.png', login_logo: '/logo.png', ico_path: '/favicon.ico', record_No: '', admin_login_slide: [] } })); return;
            }
            if (pathname.startsWith('/adminapi/') || pathname.startsWith('/api/admin/')) {
              const suffix = pathname.replace(/^\/(?:adminapi|api\/admin)/, '');
              const allowed = request.method === 'GET' ? suffix === '/order/list' || suffix === '/new_push' || /^\/order\/detail\/[A-Za-z0-9_-]{1,32}$/.test(suffix)
                : request.method === 'POST' && suffix === '/order/writeoff';
              if (!allowed) { unexpected.push(pathname); response.writeHead(404); response.end(); return; }
              const headers = new Headers();
              for (let i = 0; i < request.rawHeaders.length; i += 2) headers.append(request.rawHeaders[i], request.rawHeaders[i + 1]);
              const body = await bodyOf(request);
              const result = await app.fetch(new Request('http://127.0.0.1' + path, { method: request.method, headers, ...(body ? { body } : {}) }), env);
              expect(result.headers.get('Cache-Control')).toContain('no-store');
              const text = await result.text(), envelope = object(JSON.parse(text));
              calls.push({ path, method: request.method ?? '', status: envelope.status, httpStatus: result.status });
              response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(text); return;
            }
            if (request.method !== 'GET') throw Error('Unexpected static mutation');
            let file = resolve(root, '.' + decodeURIComponent(pathname));
            if (file !== root && !file.startsWith(root + sep)) throw Error('Static path outside build');
            if (file === root || !extname(file)) file = join(root, 'index.html');
            const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
            response.setHeader('Content-Type', mime[extname(file)] ?? 'application/octet-stream'); response.end(await readFile(file));
          })().catch(error => { bridgeFailures++; report('ADMIN_ORDER_BRIDGE_ERROR ' + String(error instanceof Error ? error.message : error)); if (!response.headersSent) response.writeHead(500); response.end('Owned acceptance bridge failure'); });
        });
        const checkpoint = async (name: string): Promise<unknown> => {
          checkpoints.push(name);
          expect(await f.state()).toEqual(baseline); // No business write attributable to a read or denied action.
          if (['initial-read', 'current-read', 'complete'].includes(name)) return null;
          if (name === 'refund-again') {
            const next = await writer.apply(remainderId); expect(await writer.finish(next.refundId)).toBe('completed');
            const second = await writer.receipt(next.refundId);
            expect(second.remainingOrderId).toBe(remainderId); expect((await writer.order(remainderId)).payPrice).toBe('29.40');
            expect((await writer.order(second.selectedOrderId)).payPrice).toBe('12.80');
            expect((await writer.order(source.id)).payPrice).toBe('55.00');
            expect((await writer.carts(remainderId)).map(row => row.productId)).toEqual([71]);
            expect(await writer.finish(next.refundId)).toBe('already-completed');
            baseline = await f.state(); return { nextSelected: (await writer.order(second.selectedOrderId)).orderId };
          }
          if (name === 'deny-role' || name === 'restore-role') { await f.db.update(systemRole).set({ status: name === 'deny-role' ? 0 : 1 }).where(eq(systemRole.id, 990)); return null; }
          if (name === 'deny-sql') { await f.exec(`REVOKE SELECT ON store_order_cart_info FROM "${reader.role}"`); return null; }
          if (name === 'restore-sql') { await f.exec(`GRANT SELECT ON store_order_cart_info TO "${reader.role}"`); return null; }
          if (name === 'expire-token') { await f.db.update(systemAdmin).set({ pwd: 'changed-local-digest' }).where(eq(systemAdmin.id, 990)); return null; }
          throw Error('Unexpected checkpoint: ' + name);
        };
        let child: ReturnType<typeof fork> | undefined, failure: Error | undefined, result: unknown;
        try {
          await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
          const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing owned HTTP port');
          report('ADMIN_ORDER_BROWSER_HTTP ' + JSON.stringify({ kind, port: address.port }));
          const childEnv = { ...process.env };
          for (const name of Object.keys(childEnv)) {
            if (!['systemroot', 'windir', 'path', 'temp', 'tmp', 'localappdata', 'userprofile'].includes(name.toLowerCase())) delete childEnv[name];
          }
          child = fork(resolve(import.meta.dirname, 'admin-order-generations.driver.mjs'), [], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
          const running = child;
          running.stdout?.on('data', data => report(String(data).trim())); running.stderr?.on('data', () => { failure ??= Error('Browser driver emitted stderr'); });
          const exited = new Promise<number | null>((done, fail) => { running.once('error', fail); running.once('exit', done); });
          running.on('message', (raw: unknown) => { void (async () => {
            const message = object(raw);
            if (message.type === 'checkpoint' && typeof message.name === 'string') {
              try { running.send({ type: 'checkpoint-done', name: message.name, data: await checkpoint(message.name) }); }
              catch (error) { failure = error instanceof Error ? error : Error('SQL checkpoint failed'); running.send({ type: 'checkpoint-failed', name: message.name }); }
            } else if (message.type === 'result') result = message;
            else if (message.type === 'failure') failure ??= Error(String(message.message));
            else throw Error('Unknown browser message');
          })().catch(error => { failure = error instanceof Error ? error : Error('IPC failed'); }); });
          running.send({ type: 'start', kind, baseUrl: `http://127.0.0.1:${address.port}`, output, packageJson, executable, token, deniedToken, supplierToken, customerToken,
            root: source.orderId, selected: selected.orderId, remaining: remaining.orderId });
          const exit = await exited; if (failure) throw failure;
          expect(exit).toBe(0); expect(object(result).passed).toBe(true);
          expect(checkpoints).toEqual(['initial-read', 'refund-again', 'current-read', 'deny-role', 'restore-role', 'deny-sql', 'restore-sql', 'expire-token', 'complete']);
          expect(calls.filter(call => call.method === 'POST')).toHaveLength(2);
          expect(calls.filter(call => call.method === 'POST').every(call => call.status === 400011)).toBe(true);
          expect(bridgeFailures).toBe(0); expect(unexpected).toEqual([]); expect(fetch).not.toHaveBeenCalled();
          expect(await f.state()).toEqual(baseline);
          report('ADMIN_ORDER_BROWSER_SQL ' + JSON.stringify({ kind, passed: true, identity, checkpoints, calls, output }));
        } finally {
          if (child && child.exitCode === null && child.signalCode === null) {
            child.send({ type: 'stop' }); await new Promise<void>(done => { child!.once('exit', () => done()); setTimeout(() => { child!.kill(); done(); }, 8000).unref(); });
          }
          server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); wiring.container = undefined;
        }
      });
    });
  } finally { wiring.container = undefined; vi.restoreAllMocks(); await f.close(); }
});
