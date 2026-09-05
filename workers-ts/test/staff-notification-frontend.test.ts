import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindNoticeLifecycle, parseNoticeFrame, StaffNoticeClient, type NoticeSocket } from '../../view/common/staff-notifications';
import { createAdminTodoLoader, type AdminPendingCounts } from '../../view/admin-ts/src/utils/admin-todos';

class Socket implements NoticeSocket {
  readyState = 1;
  sent: string[] = [];
  private target = new EventTarget();
  addEventListener<K extends 'open' | 'message' | 'close' | 'error'>(type: K, listener: (event: { open: Event; message: MessageEvent; close: CloseEvent; error: Event }[K]) => void) {
    this.target.addEventListener(type, listener as EventListener);
  }
  send(value: string) { this.sent.push(value); }
  close(code = 1000) { this.readyState = 3; this.target.dispatchEvent(Object.assign(new Event('close'), { code })); }
  frame(data: unknown) { this.target.dispatchEvent(Object.assign(new Event('message'), { data })); }
  ready(revision = 0) { this.frame(JSON.stringify({ type: 'staff_notification_ready', revision, refresh: true })); }
  changed(revision: number) { this.frame(JSON.stringify({ type: 'staff_notification_changed', revision })); }
}
function setup() {
  const sockets: Socket[] = [], refresh = vi.fn(), state = vi.fn(), denied = vi.fn();
  const connect = vi.fn(() => { const socket = new Socket(); sockets.push(socket); return socket; });
  const client = new StaffNoticeClient({ url: () => 'wss://shop.example/adminapi/extract/notifications/socket', onRefresh: refresh, onState: state, onDenied: denied, connect, random: () => 0 });
  client.setSession('test-token');
  return { client, sockets, refresh, state, denied, connect };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
describe('staff notification browser client', () => {
  it('accepts only bounded invalidations, never financial payloads or commands', () => {
    expect(parseNoticeFrame('{"type":"staff_notification_ready","revision":0,"refresh":true}')).toEqual({ type: 'ready', revision: 0 });
    for (const data of [null, '{}', '[]', '{', 'x'.repeat(257), '{"type":"staff_notification_changed","revision":0}', '{"type":"staff_notification_changed","revision":2,"amount":1}', '{"type":"staff_notification_changed","revision":1.5}']) expect(parseNoticeFrame(data)).toBeNull();
  });
  it('keeps tokens out of URLs and deduplicates revisions within a connection', () => {
    const s = setup(); expect(s.connect).toHaveBeenCalledWith('wss://shop.example/adminapi/extract/notifications/socket', ['cinashop', 'cinashop-auth.test-token']);
    s.sockets[0].ready(4); s.sockets[0].changed(5); s.sockets[0].changed(5); s.sockets[0].changed(3);
    expect(s.refresh).toHaveBeenCalledTimes(2); expect(s.state).toHaveBeenLastCalledWith('open'); s.client.dispose();
  });
  it('reconnects with bounded backoff and catches up even if ready revision regresses', async () => {
    const s = setup(); s.sockets[0].ready(9); s.sockets[0].close(1013);
    expect(s.denied).not.toHaveBeenCalled(); expect(s.state).toHaveBeenLastCalledWith('retrying');
    await vi.advanceTimersByTimeAsync(750); expect(s.sockets).toHaveLength(2); s.sockets[1].ready(0);
    expect(s.refresh).toHaveBeenCalledTimes(3); s.client.dispose();
  });
  it('fences late frames and close events from a replaced session or hidden page', async () => {
    const s = setup(); const old = s.sockets[0]; s.client.setSession('replacement');
    old.ready(); old.changed(99); old.close(4001); expect(s.refresh).not.toHaveBeenCalled(); expect(s.denied).not.toHaveBeenCalled();
    s.client.setActive(false); await vi.advanceTimersByTimeAsync(90_000); expect(s.sockets).toHaveLength(2);
    s.client.setActive(true); s.sockets[2].ready(); expect(s.refresh).toHaveBeenCalledTimes(1);
    s.client.setSession(''); await vi.advanceTimersByTimeAsync(90_000); expect(s.sockets).toHaveLength(3); s.client.dispose();
  });
  it('clears revoked views and stops retries until an explicit retry or new session', async () => {
    const s = setup(); s.sockets[0].ready(); s.sockets[0].close(4001);
    expect(s.denied).toHaveBeenCalledTimes(1); expect(s.state).toHaveBeenLastCalledWith('denied');
    s.client.setActive(false); s.client.setActive(true); await vi.advanceTimersByTimeAsync(90_000); expect(s.sockets).toHaveLength(1);
    s.client.retry(); expect(s.sockets).toHaveLength(2); s.client.dispose();
  });
  it('times out stalled handshakes and silent connections and sends only plain ping', async () => {
    const s = setup(); await vi.advanceTimersByTimeAsync(12_750); expect(s.sockets).toHaveLength(2);
    s.sockets[1].ready(); await vi.advanceTimersByTimeAsync(20_000); expect(s.sockets[1].sent).toEqual(['ping']);
    s.sockets[1].frame('pong'); await vi.advanceTimersByTimeAsync(20_000); expect(s.sockets[1].sent).toEqual(['ping', 'ping']);
    await vi.advanceTimersByTimeAsync(10_750); expect(s.sockets).toHaveLength(3); s.client.dispose();
  });
  it('releases bfcache/offline connections and reconnects on visible online return without leaking listeners', () => {
    const s = setup(), page = new EventTarget(), visibility = Object.assign(new EventTarget(), { hidden: false });
    let online = true;
    const release = bindNoticeLifecycle(s.client, page, visibility, () => online);
    page.dispatchEvent(new Event('pagehide')); expect(s.sockets[0].readyState).toBe(3);
    page.dispatchEvent(new Event('pageshow')); expect(s.sockets).toHaveLength(2);
    online = false; page.dispatchEvent(new Event('offline')); expect(s.sockets[1].readyState).toBe(3);
    visibility.hidden = true; online = true; page.dispatchEvent(new Event('online')); expect(s.sockets).toHaveLength(2);
    visibility.hidden = false; visibility.dispatchEvent(new Event('visibilitychange')); expect(s.sockets).toHaveLength(3);
    release(); page.dispatchEvent(new Event('pageshow')); expect(s.sockets).toHaveLength(3);
  });
});

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const counts: AdminPendingCounts = { ordernum: 0, inventory: 0, commentnum: 0, reflectnum: 1, msgcount: 1, sampled_at: 1 };
describe('pending-work invalidation races', () => {
  it('runs a trailing authoritative read for an invalidation received during HTTP', async () => {
    const gate = deferred<AdminPendingCounts>(), publish = vi.fn();
    const load = vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue({ ...counts, reflectnum: 2, msgcount: 2 });
    const loader = createAdminTodoLoader(load, publish); const pending = loader.refresh(); await Promise.resolve();
    loader.refresh(true); loader.refresh(true); gate.resolve(counts); await pending;
    expect(load).toHaveBeenCalledTimes(2); expect(publish).toHaveBeenLastCalledWith({ snapshot: { ...counts, reflectnum: 2, msgcount: 2 }, loading: false, error: false });
  });
  it('cannot publish or clear a replacement session with a late result or error', async () => {
    for (const reject of [false, true]) {
      const gate = deferred<AdminPendingCounts>(), publish = vi.fn();
      const load = vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue({ ...counts, sampled_at: 2 });
      const loader = createAdminTodoLoader(load, publish); const old = loader.refresh(); await Promise.resolve();
      loader.invalidate(); await loader.refresh();
      if (reject) gate.reject(new Error('old session')); else gate.resolve(counts);
      await old; expect(publish).toHaveBeenLastCalledWith({ snapshot: { ...counts, sampled_at: 2 }, loading: false, error: false });
    }
  });
});
