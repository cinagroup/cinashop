import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppVariables, Env } from '@/env';
import type { Container } from '@/lib/di';
import { errorHandler } from '@/middleware/error';
import { v1Routes } from '@/routes/v1';
import { parseGeocodingLocation, PublicGeocodingService } from '@/services/system/PublicGeocodingService';

const TEST_KEY = 'synthetic-geocoding-key';
const RESULT = {
  location: { lat: 22.5431, lng: 114.0579 },
  address: '广东省深圳市南山区科技园',
  formatted_addresses: { recommend: '科技园', rough: '深圳市南山区' },
  address_component: { nation: '中国', province: '广东省', city: '深圳市', district: '南山区', street: '科技路', street_number: '' },
  ad_info: { nation_code: '156', adcode: '440305', name: '中国,广东省,深圳市,南山区', location: { lat: 22.52, lng: 113.93 }, nation: '中国', province: '广东省', city: '深圳市', district: '南山区' },
  address_reference: { town: { id: 'synthetic-town', title: '粤海街道', location: { lat: 22.54, lng: 114.05 }, _distance: 32, _dir_desc: '南' } },
};

function provider(body: unknown = { status: 0, result: RESULT }, init?: ResponseInit) {
  return Response.json(body, init);
}

function serviceWith(fetcher: typeof fetch, key = TEST_KEY) {
  const get = vi.fn(async () => key);
  return { service: new PublicGeocodingService({ get }, fetcher), get };
}

function harness(options: { stationOpen?: boolean; key?: string; denied?: 'source' | 'global'; limiterFailure?: boolean; missingLimiter?: boolean; limiterDecision?: unknown } = {}) {
  const chain = {
    from: () => chain, where: () => chain, orderBy: () => chain,
    limit: async () => options.stationOpen === false ? [{ value: '0' }] : [],
  };
  const configGet = vi.fn(async () => options.key ?? TEST_KEY);
  const container = { db: { select: () => chain }, systemConfigDao: { getValue: configGet } } as unknown as Container;
  const cache = new Map<string, string>();
  const calls: Array<{ name: string; policies: Array<{ key: string; limit: number }>; seconds: number }> = [];
  const env = {
    APP_KEY: 'synthetic-private-hmac-key',
    CONFIG_KV: {
      get: async (key: string) => cache.get(key) ?? null,
      put: async (key: string, value: string) => { cache.set(key, value); },
    },
    TOKEN_BUCKET: options.missingLimiter ? undefined : {
      getByName: (name: string) => ({ consumeRateLimit: async (policies: Array<{ key: string; limit: number }>, seconds: number) => {
        calls.push({ name, policies, seconds });
        if (options.limiterFailure) throw new Error(`https://invalid.example/${TEST_KEY}`);
        if ('limiterDecision' in options) return options.limiterDecision;
        const global = name.endsWith(':global');
        return { allowed: options.denied !== (global ? 'global' : 'source'), resetAt: Date.now() + 60000, limit: policies[0].limit, remaining: 1 };
      } }),
    },
  } as unknown as Env;
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.use('*', async (c, next) => { c.set('container', container); await next(); });
  app.route('/api', v1Routes);
  app.onError(errorHandler);
  return {
    calls, configGet,
    request: (query = '?location=22.5431,114.0579', headers: Record<string, string> = {}) =>
      app.request(`https://worker.example/api/geoLbscoder${query}`, { headers }, env),
  };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('PHP geoLbscoder read compatibility', () => {
  it('preserves latitude-first ordering and accepts equator/dateline boundaries', () => {
    expect(parseGeocodingLocation(' 22.543100 , +114.057900 ')).toBe('22.5431,114.0579');
    expect(parseGeocodingLocation('0,0')).toBe('0,0');
    expect(parseGeocodingLocation('-90,180')).toBe('-90,180');
    expect(parseGeocodingLocation('90,-180')).toBe('90,-180');
  });

  it.each([undefined, '', '1', '1,2,3', 'NaN,1', 'Infinity,0', '1e1,2', '91,0', '0,-181', '0,180.1', '1,2&key=attacker', 'https://evil.example,0', '1,'.padEnd(81, '0')])(
    'rejects invalid or injected coordinates before configuration or external I/O: %s', async (value) => {
      const fetcher = vi.fn<typeof fetch>();
      const { service, get } = serviceWith(fetcher);
      await expect(service.reverse(value)).rejects.toThrow('经纬度参数错误');
      expect(get).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it('makes one fixed HTTPS GET without caller identity, headers, POI or redirects', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => provider());
    const { service, get } = serviceWith(fetcher);
    await expect(service.reverse('22.5431,114.0579')).resolves.toEqual(RESULT);
    expect(get).toHaveBeenCalledExactlyOnceWith('tengxun_map_key');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [input, init] = fetcher.mock.calls[0];
    const url = new URL(String(input));
    expect(url.origin + url.pathname).toBe('https://apis.map.qq.com/ws/geocoder/v1/');
    expect(Object.fromEntries(url.searchParams)).toEqual({ location: '22.5431,114.0579', key: TEST_KEY, output: 'json' });
    expect(init).toMatchObject({ method: 'GET', redirect: 'error', headers: { Accept: 'application/json' } });
    expect(init?.signal?.aborted).toBe(true);
  });

  it.each(['', ' ', 'https://key.example/', 'key&callback=evil', 'x'.repeat(129)])('fails closed for absent or invalid configuration', async (key) => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(serviceWith(fetcher, key).service.reverse('0,0')).rejects.toThrow('地图服务尚未配置');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('projects the legacy result and omits unknown top-level and nested fields', async () => {
    const payload = { status: 0, message: TEST_KEY, request_id: 'provider-private-id', result: {
      ...RESULT, key: TEST_KEY, url: 'https://private.example',
      location: { ...RESULT.location, key: TEST_KEY },
      address_component: { ...RESULT.address_component, credential: TEST_KEY },
      address_reference: { ...RESULT.address_reference, unknown: { secret: TEST_KEY } },
    } };
    const result = await serviceWith(vi.fn<typeof fetch>(async () => provider(payload))).service.reverse('0,0');
    expect(result).toEqual(RESULT); expect(JSON.stringify(result)).not.toContain(TEST_KEY);
  });

  it('retains documented optional POI and numeric administrative-code fields', async () => {
    const result = { ...RESULT, ad_info: { ...RESULT.ad_info, adcode: 440305 }, poi_count: 1, pois: [{ id: 'synthetic-poi', title: '科技园', address: '广东省深圳市', category: '园区', location: RESULT.location, _distance: 10 }] };
    await expect(serviceWith(vi.fn<typeof fetch>(async () => provider({ status: 0, result }))).service.reverse('0,0')).resolves.toEqual(result);
  });

  it.each([
    { status: 311, message: `Bad key ${TEST_KEY} https://private.example` },
    { status: 0, error: TEST_KEY, result: RESULT },
    { result: RESULT }, { status: 0 }, { status: 0, result: [] },
    { status: 0, result: { address: 'address', location: { lat: 91, lng: 0 } } },
    { status: 0, result: { address: 'address', address_reference: { town: { _distance: -1 } } } },
    { status: 0, result: { address: 'address', pois: Array.from({ length: 21 }, () => ({})) } },
  ])('rejects provider failure or malformed result without leaking provider detail', async (body) => {
    const fetcher = vi.fn<typeof fetch>(async () => provider(body));
    await expect(serviceWith(fetcher).service.reverse('0,0')).rejects.toThrow('获取位置信息失败，请稍后重试');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    () => new Response(TEST_KEY, { status: 500 }),
    () => new Response(TEST_KEY, { status: 302, headers: { Location: 'https://private.example' } }),
    () => new Response(JSON.stringify({ status: 0, result: RESULT }), { headers: { 'Content-Type': 'text/html' } }),
    () => new Response(TEST_KEY, { headers: { 'Content-Type': 'application/json' } }),
    () => new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': '32769' } }),
    () => new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': 'invalid' } }),
  ])('sanitizes HTTP, media-type, parse and declared-length failures', async (response) => {
    await expect(serviceWith(vi.fn<typeof fetch>(async () => response())).service.reverse('0,0')).rejects.toThrow('获取位置信息失败，请稍后重试');
  });

  it('counts actual streamed bytes and cancels oversized provider bodies', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(32769)); }, cancel });
    const fetcher = vi.fn<typeof fetch>(async () => new Response(stream, { headers: { 'Content-Type': 'application/json' } }));
    await expect(serviceWith(fetcher).service.reverse('0,0')).rejects.toThrow('获取位置信息失败，请稍后重试');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('sanitizes thrown network URLs/keys and never retries', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => { throw new Error(`https://provider.example/?key=${TEST_KEY}`); });
    await expect(serviceWith(fetcher).service.reverse('0,0')).rejects.toThrow('获取位置信息失败，请稍后重试');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid UTF-8 instead of replacing malformed provider text', async () => {
    const response = new Response(new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d]), {
      headers: { 'Content-Type': 'application/json' },
    });
    await expect(serviceWith(vi.fn<typeof fetch>(async () => response)).service.reverse('0,0'))
      .rejects.toThrow('获取位置信息失败，请稍后重试');
  });

  it('enforces the five-second deadline even if fetch does not honor abort', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(() => new Promise(() => undefined));
    const pending = serviceWith(fetcher).service.reverse('0,0');
    const assertion = expect(pending).rejects.toThrow('获取位置信息失败，请稍后重试');
    await vi.advanceTimersByTimeAsync(5000); await assertion;
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('includes a stalled streamed body in the same deadline and cancels it', async () => {
    vi.useFakeTimers(); const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const fetcher = vi.fn<typeof fetch>(async () => new Response(stream, { headers: { 'Content-Type': 'application/json' } }));
    const pending = serviceWith(fetcher).service.reverse('0,0');
    const assertion = expect(pending).rejects.toThrow('获取位置信息失败，请稍后重试');
    await vi.advanceTimersByTimeAsync(5000); await assertion;
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('cancels a response arriving after the deadline without reading its body', async () => {
    vi.useFakeTimers();
    let resolveResponse!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => { resolveResponse = resolve; }));
    const pending = serviceWith(fetcher).service.reverse('0,0');
    const assertion = expect(pending).rejects.toThrow('获取位置信息失败，请稍后重试');
    await vi.advanceTimersByTimeAsync(5000); await assertion;
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), {
      headers: { 'Content-Type': 'application/json' },
    });
    resolveResponse(response);
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('registered geoLbscoder HTTP boundary', () => {
  it('serves anonymous callers with the old JSON envelope and private no-store response', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => provider()); vi.stubGlobal('fetch', fetcher);
    const test = harness();
    const response = await test.request('?location=22.5431,114.0579&key=ignored&callback=ignored', {
      'CF-Connecting-IP': '192.0.2.10', Authorization: 'Bearer deliberately-ignored', 'X-Forwarded-For': '198.51.100.9',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 200, msg: 'ok', data: RESULT });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(test.calls).toHaveLength(2);
    expect(test.calls[0]).toMatchObject({ name: expect.stringMatching(/^public-geocoding:[a-f0-9]{64}$/), policies: [{ key: 'reverse', limit: 30 }], seconds: 60 });
    expect(test.calls[1]).toMatchObject({ name: 'public-geocoding:global', policies: [{ key: 'reverse', limit: 300 }], seconds: 60 });
    expect(JSON.stringify(test.calls)).not.toContain('192.0.2.10');
    expect(String(fetcher.mock.calls[0][0])).not.toContain('ignored');
    expect(fetcher.mock.calls[0][1]?.headers).toEqual({ Accept: 'application/json' });
  });

  it('honors StationOpen before quota, key lookup or provider requests', async () => {
    const fetcher = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', fetcher);
    const test = harness({ stationOpen: false });
    const response = await test.request();
    expect(await response.json()).toMatchObject({ status: 410010, data: null });
    expect(test.calls).toHaveLength(0); expect(test.configGet).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['', '?location=1', '?location=1,2&location=3,4', '?location=1,2,3'])('rejects missing, malformed and ambiguous location before provider allocation', async (query) => {
    const fetcher = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', fetcher);
    const test = harness(); const response = await test.request(query);
    expect(await response.json()).toEqual({ status: 400, msg: '经纬度参数错误', data: null });
    expect(test.calls).toHaveLength(0); expect(test.configGet).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['source', 'global'] as const)('stops exhausted %s budgets before key lookup and external I/O', async (denied) => {
    const fetcher = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', fetcher);
    const test = harness({ denied }); const response = await test.request();
    expect(response.status).toBe(429); expect(response.headers.get('Retry-After')).toBe('60');
    expect(await response.json()).toMatchObject({ status: 429, data: null });
    expect(test.configGet).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([{ limiterFailure: true }, { missingLimiter: true }])('fails closed when rate service is unavailable, without exposing detail', async (options) => {
    const fetcher = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', fetcher);
    const test = harness(options); const response = await test.request();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 503, msg: '地图限流服务暂时不可用', data: null });
    expect(test.configGet).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([null, {}, { allowed: 'true', resetAt: 0 }, { allowed: true, resetAt: NaN }, { allowed: true, resetAt: Infinity }])(
    'rejects malformed rate-service decisions before configuration and provider I/O', async (limiterDecision) => {
      const fetcher = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', fetcher);
      const test = harness({ limiterDecision }); const response = await test.request();
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ status: 503, msg: '地图限流服务暂时不可用', data: null });
      expect(test.configGet).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it('retains the failure JSON envelope and omits sensitive provider error contents', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => provider({ status: 311, message: `https://private.example/?key=${TEST_KEY}` }));
    vi.stubGlobal('fetch', fetcher); const response = await harness().request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 400, msg: '获取位置信息失败，请稍后重试', data: null });
    expect(response.headers.get('Cache-Control')).toContain('no-store');
  });
});
