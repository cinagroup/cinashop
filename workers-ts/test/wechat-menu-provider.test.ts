import { afterEach, describe, expect, it, vi } from 'vitest';
import { OfficialAccountMenuProvider, officialAccountMenuReason } from '@/services/wechat/OfficialAccountMenuProvider';
import { ValidateException } from '@/utils/errors';

const config = { appId: 'wx-owned-menu', secret: 'owned-secret+&query=value' };
const accessToken = 'owned-token+&scope=value';
const button = [{ type: 'click', name: '服务', key: 'owned-service' }];
const token = () => Response.json({ access_token: accessToken, expires_in: 7200 });
const ack = (code = 0, status = 200) => Response.json({ errcode: code, errmsg: 'raw-provider-detail' }, { status });
type Seen = { url: URL; init: RequestInit | undefined };
type Reply = Response | Error | ((request: Seen) => Response | Promise<Response>);

function transport(...replies: Reply[]) {
  const seen: Seen[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = { url: new URL(String(input)), init }; seen.push(request);
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    if (typeof reply === 'function') return reply(request);
    if (!reply) throw new Error('unexpected controlled request');
    return reply;
  };
  return { seen, fetcher, provider: new OfficialAccountMenuProvider(fetcher) };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function streamed(bytes: Uint8Array, canceled: () => void = () => undefined, length?: string) {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(bytes); }, cancel: canceled,
  }), length === undefined ? undefined : { headers: { 'content-length': length } });
}

describe('official-account menu isolated provider transport', () => {
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it('gets a private token then waits for the dispatch hook before one fixed menu POST', async () => {
    const hookEntered = deferred<void>(), permit = deferred<void>();
    const runtime = transport(token(), ack());
    const hook = vi.fn(async () => { hookEntered.resolve(); await permit.promise; });
    const pending = runtime.provider.create(config, button, hook);
    await hookEntered.promise;
    expect(runtime.seen).toHaveLength(1);
    expect(runtime.seen[0].url.origin).toBe('https://api.weixin.qq.com');
    expect(runtime.seen[0].url.pathname).toBe('/cgi-bin/token');
    expect([...runtime.seen[0].url.searchParams]).toEqual([
      ['grant_type', 'client_credential'], ['appid', config.appId], ['secret', config.secret],
    ]);
    permit.resolve();
    await expect(pending).resolves.toEqual({ outcome: 'accepted' });
    expect(hook).toHaveBeenCalledTimes(1);
    expect(runtime.seen).toHaveLength(2);
    const sent = runtime.seen[1];
    expect(sent.url.origin).toBe('https://api.weixin.qq.com');
    expect(sent.url.pathname).toBe('/cgi-bin/menu/create');
    expect([...sent.url.searchParams]).toEqual([['access_token', accessToken]]);
    expect(sent.init?.method).toBe('POST');
    expect(JSON.parse(String(sent.init?.body))).toEqual({ button });
    expect(String(sent.init?.body)).not.toContain(config.secret);
    expect(String(sent.init?.body)).not.toContain(accessToken);
    for (const request of runtime.seen) {
      expect(request.init?.redirect).toBe('error');
      expect(request.init?.signal).toBeDefined();
    }
  });

  it('snapshots the exact draft before token I/O and does not send a later mutation', async () => {
    const tokenReply = deferred<Response>();
    const runtime = transport(() => tokenReply.promise, ack());
    const draft = [{ type: 'click', name: '原稿', key: 'before' }];
    const pending = runtime.provider.create(config, draft, async () => { draft[0].name = 'hook-change'; });
    draft[0].key = 'later-change';
    tokenReply.resolve(token());
    await expect(pending).resolves.toEqual({ outcome: 'accepted' });
    expect(JSON.parse(String(runtime.seen[1].init?.body))).toEqual({ button: [{ type: 'click', name: '原稿', key: 'before' }] });
  });

  it('requests a fresh private token for each create/read and never retries a publish', async () => {
    const runtime = transport(token(), ack(40014), token(), Response.json({ menu: { button } }));
    await expect(runtime.provider.create(config, button, async () => undefined)).resolves.toEqual({ outcome: 'rejected', code: 40014 });
    await expect(runtime.provider.read(config, async () => undefined)).resolves.toEqual({ outcome: 'read', button });
    expect(runtime.seen.map(request => request.url.pathname)).toEqual([
      '/cgi-bin/token', '/cgi-bin/menu/create', '/cgi-bin/token', '/cgi-bin/menu/get',
    ]);
    expect(runtime.seen.filter(request => request.init?.method === 'POST')).toHaveLength(1);
  });

  it('keeps a failed caller authority/dispatch hook identity and sends no POST', async () => {
    const failure = new Error('owned stale actor');
    const runtime = transport(token());
    await expect(runtime.provider.create(config, button, async () => { throw failure; })).rejects.toBe(failure);
    expect(runtime.seen).toHaveLength(1);
  });

  it('does not publish when a dispatch hook resolves after the total deadline', async () => {
    vi.useFakeTimers();
    const entered = deferred<void>(), permit = deferred<void>();
    const runtime = transport(token(), ack());
    const pending = runtime.provider.create(config, button, async () => { entered.resolve(); await permit.promise; });
    const rejected = expect(pending).rejects.toBeInstanceOf(ValidateException);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(10_000); await rejected;
    permit.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(runtime.seen).toHaveLength(1);
  });

  it('rejects invalid credentials, an empty menu, a circular draft and an oversized body before any I/O', async () => {
    const runtime = transport();
    const circular: unknown[] = []; circular.push(circular);
    for (const credentials of [{ appId: '', secret: 'x' }, { appId: 'x', secret: '\nsecret' }]) {
      await expect(runtime.provider.create(credentials, button, async () => undefined)).rejects.toBeInstanceOf(ValidateException);
    }
    for (const draft of [[], circular, [{ name: 'x'.repeat(64 * 1024) }]]) {
      await expect(runtime.provider.create(config, draft, async () => undefined)).rejects.toBeInstanceOf(ValidateException);
    }
    expect(runtime.seen).toHaveLength(0);
  });

  it('does not dispatch after a token rejection and never returns raw provider error text', async () => {
    const raw = `secret=${config.secret};token=${accessToken}`;
    const runtime = transport(Response.json({ errcode: 40125, errmsg: raw }));
    const hook = vi.fn(async () => undefined);
    const failure = await runtime.provider.create(config, button, hook).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ValidateException);
    expect(String(failure)).toContain('凭据');
    expect(String(failure)).not.toContain(raw);
    expect(hook).not.toHaveBeenCalled(); expect(runtime.seen).toHaveLength(1);
  });

  it('does not accept a token response from a non-2xx HTTP response', async () => {
    const runtime = transport(Response.json({ access_token: accessToken, expires_in: 7200 }, { status: 503 }));
    await expect(runtime.provider.create(config, button, async () => undefined)).rejects.toBeInstanceOf(ValidateException);
    expect(runtime.seen).toHaveLength(1);
  });

  it.each([
    { access_token: '', expires_in: 7200 },
    { access_token: accessToken },
    { access_token: accessToken, expires_in: 0 },
    { access_token: accessToken, expires_in: 7201 },
    { access_token: accessToken, expires_in: '7200' },
    { access_token: accessToken, expires_in: 7200, errcode: '0' },
  ])('requires a complete typed token response before dispatch: %j', async response => {
    const runtime = transport(Response.json(response));
    const hook = vi.fn(async () => undefined);
    await expect(runtime.provider.create(config, button, hook)).rejects.toBeInstanceOf(ValidateException);
    expect(hook).not.toHaveBeenCalled(); expect(runtime.seen).toHaveLength(1);
  });

  it('sanitizes a token transport exception without logging its URL or credentials', async () => {
    const log = vi.spyOn(console, 'log'), warn = vi.spyOn(console, 'warn'), error = vi.spyOn(console, 'error');
    const raw = `https://api.weixin.qq.com/cgi-bin/token?secret=${config.secret}`;
    const runtime = transport(new Error(raw));
    const failure = await runtime.provider.create(config, button, async () => undefined).catch((value: unknown) => value);
    expect(failure).toBeInstanceOf(ValidateException);
    expect(String(failure)).not.toContain(config.secret); expect(String(failure)).not.toContain(raw);
    expect(log).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
  });

  it('rejects malformed UTF-8 in token JSON before the dispatch hook', async () => {
    const bytes = new Uint8Array([...new TextEncoder().encode('{"access_token":"'), 0xc3, 0x28,
      ...new TextEncoder().encode('","expires_in":7200}')]);
    const runtime = transport(new Response(bytes));
    await expect(runtime.provider.create(config, button, async () => undefined)).rejects.toBeInstanceOf(ValidateException);
    expect(runtime.seen).toHaveLength(1);
  });

  it('times out a token fetch that ignores abort and cancels its late response', async () => {
    vi.useFakeTimers();
    const arrived = deferred<Response>(), canceled = deferred<void>();
    let signal: AbortSignal | null | undefined;
    const runtime = transport(request => { signal = request.init?.signal; return arrived.promise; });
    const pending = runtime.provider.create(config, button, async () => undefined);
    const rejected = expect(pending).rejects.toThrow('超时');
    await vi.advanceTimersByTimeAsync(10_000); await rejected;
    expect(signal?.aborted).toBe(true);
    arrived.resolve(new Response(new ReadableStream<Uint8Array>({ cancel() { canceled.resolve(); } })));
    await canceled.promise; expect(runtime.seen).toHaveLength(1);
  });

  it.each([
    { errcode: '0' }, { errcode: null }, {}, { errcode: 0.5 }, { errcode: false },
  ])('keeps an untyped or missing publish ACK unknown: %j', async response => {
    const runtime = transport(token(), Response.json(response));
    await expect(runtime.provider.create(config, button, async () => undefined)).resolves.toEqual({ outcome: 'unknown' });
    expect(runtime.seen).toHaveLength(2);
  });

  it.each([-1, 40014, 42001, 45009])('returns an explicit numeric publish rejection %i without a token or publish retry', async code => {
    const runtime = transport(token(), ack(code));
    await expect(runtime.provider.create(config, button, async () => undefined)).resolves.toEqual({ outcome: 'rejected', code });
    expect(runtime.seen).toHaveLength(2);
  });

  it('keeps non-2xx publish responses unknown even if their JSON claims success or rejection', async () => {
    for (const response of [ack(0, 503), ack(40014, 500), ack(0, 302)]) {
      const runtime = transport(token(), response);
      await expect(runtime.provider.create(config, button, async () => undefined)).resolves.toEqual({ outcome: 'unknown' });
      expect(runtime.seen).toHaveLength(2);
    }
  });

  it('keeps a lost publish ACK unknown and never exposes its transport error', async () => {
    const runtime = transport(token(), new Error(`connection lost ${accessToken} ${config.secret}`));
    await expect(runtime.provider.create(config, button, async () => undefined)).resolves.toEqual({ outcome: 'unknown' });
    expect(runtime.seen).toHaveLength(2);
  });

  it('keeps malformed JSON and malformed UTF-8 after POST unknown', async () => {
    for (const response of [new Response('{"errcode":'), new Response(new Uint8Array([0xff, 0xfe])), Response.json([])]) {
      const runtime = transport(token(), response);
      await expect(runtime.provider.create(config, button, async () => undefined)).resolves.toEqual({ outcome: 'unknown' });
    }
  });

  it('cancels an oversized streamed ACK and does not treat its valid JSON prefix as an ACK', async () => {
    const canceled = vi.fn();
    const runtime = transport(token(), streamed(new TextEncoder().encode('{"errcode":0}' + ' '.repeat(64 * 1024)), canceled));
    await expect(runtime.provider.create(config, button, async () => undefined)).resolves.toEqual({ outcome: 'unknown' });
    expect(canceled).toHaveBeenCalledTimes(1);
  });

  it('cancels an unread body when its declared length exceeds the same response budget', async () => {
    const canceled = vi.fn();
    const runtime = transport(token(), new Response(new ReadableStream<Uint8Array>({ cancel: canceled }), {
      headers: { 'content-length': String(64 * 1024 + 1) },
    }));
    await expect(runtime.provider.create(config, button, async () => undefined)).resolves.toEqual({ outcome: 'unknown' });
    expect(canceled).toHaveBeenCalledTimes(1);
  });

  it('accepts a complete ACK at the exact 64 KiB streamed-byte boundary', async () => {
    const prefix = '{"errcode":0,"padding":"', suffix = '"}';
    const body = prefix + 'x'.repeat(64 * 1024 - prefix.length - suffix.length) + suffix;
    expect(new TextEncoder().encode(body)).toHaveLength(64 * 1024);
    const runtime = transport(token(), new Response(body));
    await expect(runtime.provider.create(config, button, async () => undefined)).resolves.toEqual({ outcome: 'accepted' });
  });

  it('cancels a stalled post body at the entire-call deadline', async () => {
    vi.useFakeTimers();
    const entered = deferred<void>(), canceled = vi.fn();
    const runtime = transport(token(), () => {
      entered.resolve(); return new Response(new ReadableStream<Uint8Array>({ cancel: canceled }));
    });
    const pending = runtime.provider.create(config, button, async () => undefined);
    await entered.promise; await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toEqual({ outcome: 'unknown' });
    expect(canceled).toHaveBeenCalledTimes(1); expect(runtime.seen).toHaveLength(2);
  });

  it('does not reset the total deadline after a slow token response', async () => {
    vi.useFakeTimers();
    const menuResponse = deferred<Response>(), canceled = deferred<void>();
    const runtime = transport(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 8000)); return token();
    }, () => menuResponse.promise);
    const pending = runtime.provider.create(config, button, async () => undefined);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toEqual({ outcome: 'unknown' });
    expect(runtime.seen).toHaveLength(2);
    menuResponse.resolve(new Response(new ReadableStream<Uint8Array>({ cancel() { canceled.resolve(); } })));
    await canceled.promise;
  });

  it('reads only the whole default button array and retains unknown fields without merging conditional menus', async () => {
    const full = [{ type: 'media_id', name: '历史', media_id: 'owned-media', sub_button: [], unknown: { raw: true } }];
    const runtime = transport(token(), Response.json({ menu: { button: full, menuid: 99 },
      conditionalmenu: [{ button: [{ type: 'click', name: '条件', key: 'conditional' }], matchrule: { tag_id: '2' } }] }));
    await expect(runtime.provider.read(config, async () => undefined)).resolves.toEqual({ outcome: 'read', button: full });
    expect(runtime.seen[1].url.pathname).toBe('/cgi-bin/menu/get');
    expect(runtime.seen[1].init?.method).toBe('GET'); expect(runtime.seen[1].init?.body).toBeUndefined();
    expect([...runtime.seen[1].url.searchParams]).toEqual([['access_token', accessToken]]);
  });

  it('also accepts errcode zero with a complete default menu and an explicitly returned empty array', async () => {
    const runtime = transport(token(), Response.json({ errcode: 0, menu: { button: [] } }));
    await expect(runtime.provider.read(config, async () => undefined)).resolves.toEqual({ outcome: 'read', button: [] });
  });

  it('does not infer an empty default menu from code 46003 or a provider rejection', async () => {
    for (const code of [46003, 40014]) {
      const runtime = transport(token(), ack(code));
      await expect(runtime.provider.read(config, async () => undefined)).resolves.toEqual({ outcome: 'rejected', code });
      expect(runtime.seen).toHaveLength(2);
    }
  });

  it('never accepts a read success body on non-2xx HTTP', async () => {
    const runtime = transport(token(), Response.json({ errcode: 0, menu: { button } }, { status: 502 }));
    await expect(runtime.provider.read(config, async () => undefined)).resolves.toEqual({ outcome: 'rejected' });
  });

  it('does not use a conditional menu or a safe subset when the default menu shape is missing or malformed', async () => {
    for (const value of [
      { conditionalmenu: [{ button }] }, { menu: null }, { menu: { button: {} } },
      { errcode: '0', menu: { button } }, { menu: [] },
    ]) {
      const runtime = transport(token(), Response.json(value));
      await expect(runtime.provider.read(config, async () => undefined)).rejects.toBeInstanceOf(ValidateException);
      expect(runtime.seen).toHaveLength(2);
    }
  });

  it('preserves split multibyte UTF-8 without replacement decoding or a partial read', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ menu: { button: [{ name: '🧭服务', key: 'a' }] } }));
    const index = bytes.findIndex(value => value === 0xf0) + 1;
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(bytes.slice(0, index)); controller.enqueue(bytes.slice(index)); controller.close();
    } });
    const runtime = transport(token(), new Response(body));
    await expect(runtime.provider.read(config, async () => undefined)).resolves.toEqual({ outcome: 'read', button: [{ name: '🧭服务', key: 'a' }] });
  });

  it('throws a sanitized read error for malformed UTF-8 and does not return an empty match', async () => {
    const runtime = transport(token(), new Response(new Uint8Array([0xc3, 0x28])));
    await expect(runtime.provider.read(config, async () => undefined)).rejects.toBeInstanceOf(ValidateException);
  });

  it('sanitizes a read transport error while preserving a caller read-authority hook error identity', async () => {
    const runtime = transport(token(), new Error(`${config.secret} ${accessToken}`));
    const failure = await runtime.provider.read(config, async () => undefined).catch((value: unknown) => value);
    expect(failure).toBeInstanceOf(ValidateException);
    expect(String(failure)).not.toContain(config.secret); expect(String(failure)).not.toContain(accessToken);
    const denied = new Error('owned read authority expired'), other = transport(token());
    await expect(other.provider.read(config, async () => { throw denied; })).rejects.toBe(denied);
    expect(other.seen).toHaveLength(1);
  });

  it('bounds a read whose response headers arrive after timeout and cancels that late body', async () => {
    vi.useFakeTimers();
    const entered = deferred<void>(), arrived = deferred<Response>(), canceled = deferred<void>();
    const runtime = transport(token(), () => { entered.resolve(); return arrived.promise; });
    const pending = runtime.provider.read(config, async () => undefined);
    const failure = expect(pending).rejects.toThrow('超时');
    await entered.promise; await vi.advanceTimersByTimeAsync(10_000); await failure;
    arrived.resolve(new Response(new ReadableStream<Uint8Array>({ cancel() { canceled.resolve(); } })));
    await canceled.promise; expect(runtime.seen).toHaveLength(2);
  });

  it('returns only fixed local error reasons even for an unknown provider code', () => {
    expect(officialAccountMenuReason(40014)).toContain('凭据');
    expect(officialAccountMenuReason(40125)).toContain('配置');
    expect(officialAccountMenuReason(48001)).toContain('权限');
    expect(officialAccountMenuReason(987654)).toBe(officialAccountMenuReason());
    expect(officialAccountMenuReason()).not.toContain(config.secret);
  });
});
