import type { SystemConfigService } from '@/services/system/SystemConfigService';
import { ValidateException } from '@/utils/errors';

const GEOCODER_URL = 'https://apis.map.qq.com/ws/geocoder/v1/';
const MAX_RESPONSE_BYTES = 32 * 1024;
const REQUEST_TIMEOUT_MS = 5000;
const PROVIDER_FAILURE = '获取位置信息失败，请稍后重试';
type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid geocoder object');
  return value as JsonRecord;
}

/** PHP uses location=latitude,longitude. Do not accept extra provider parameters. */
export function parseGeocodingLocation(value: unknown): string {
  if (typeof value !== 'string' || value.length > 80) throw new ValidateException('经纬度参数错误');
  const parts = value.split(',').map((part) => part.trim());
  if (parts.length !== 2 || parts.some((part) => !/^[+-]?\d{1,3}(?:\.\d{1,15})?$/.test(part))) {
    throw new ValidateException('经纬度参数错误');
  }
  const latitude = Number(parts[0]);
  const longitude = Number(parts[1]);
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180) {
    throw new ValidateException('经纬度参数错误');
  }
  return `${latitude},${longitude}`;
}

function textFields(source: JsonRecord, fields: string[]): JsonRecord {
  const projected: JsonRecord = {};
  for (const field of fields) {
    if (source[field] === undefined) continue;
    if (typeof source[field] !== 'string' || (source[field] as string).length > 2048 || /[\u0000-\u001f\u007f]/u.test(source[field] as string)) {
      throw new Error('Invalid geocoder text');
    }
    projected[field] = source[field];
  }
  return projected;
}

function coordinates(value: unknown): { lat: number; lng: number } {
  const source = record(value);
  if (typeof source.lat !== 'number' || !Number.isFinite(source.lat) || Math.abs(source.lat) > 90 ||
      typeof source.lng !== 'number' || !Number.isFinite(source.lng) || Math.abs(source.lng) > 180) {
    throw new Error('Invalid geocoder coordinates');
  }
  return { lat: source.lat, lng: source.lng };
}

function place(value: unknown): JsonRecord {
  const source = record(value);
  const projected = textFields(source, ['id', 'title', 'address', 'category', '_dir_desc']);
  if (source.location !== undefined) projected.location = coordinates(source.location);
  if (source._distance !== undefined) {
    if (typeof source._distance !== 'number' || !Number.isFinite(source._distance) || source._distance < 0) {
      throw new Error('Invalid geocoder distance');
    }
    projected._distance = source._distance;
  }
  return projected;
}

/** Preserve the documented PHP result fields, never the provider envelope or arbitrary fields. */
function projectResult(value: unknown): JsonRecord {
  const source = record(value);
  const projected = textFields(source, ['address']);
  if (!projected.address) throw new Error('Missing geocoder address');
  if (source.location !== undefined) projected.location = coordinates(source.location);
  if (source.formatted_addresses !== undefined) {
    projected.formatted_addresses = textFields(record(source.formatted_addresses), ['recommend', 'rough']);
  }
  if (source.address_component !== undefined) {
    projected.address_component = textFields(record(source.address_component), ['nation', 'province', 'city', 'district', 'street', 'street_number']);
  }
  if (source.ad_info !== undefined) {
    const info = record(source.ad_info);
    const adInfo = textFields(info, ['nation_code', 'name', 'nation', 'province', 'city', 'district']);
    if (info.adcode !== undefined) {
      if ((typeof info.adcode !== 'string' || !/^\d{1,12}$/.test(info.adcode)) &&
          (typeof info.adcode !== 'number' || !Number.isSafeInteger(info.adcode) || info.adcode < 0)) {
        throw new Error('Invalid geocoder administrative code');
      }
      adInfo.adcode = info.adcode;
    }
    if (info.location !== undefined) adInfo.location = coordinates(info.location);
    projected.ad_info = adInfo;
  }
  if (source.address_reference !== undefined) {
    const references = record(source.address_reference);
    const projectedReferences: JsonRecord = {};
    for (const field of ['famous_area', 'town', 'landmark_l1', 'landmark_l2', 'street', 'street_number', 'crossroad', 'water']) {
      if (references[field] !== undefined) projectedReferences[field] = place(references[field]);
    }
    projected.address_reference = projectedReferences;
  }
  if (source.poi_count !== undefined) {
    if (typeof source.poi_count !== 'number' || !Number.isSafeInteger(source.poi_count) || source.poi_count < 0) {
      throw new Error('Invalid geocoder POI count');
    }
    projected.poi_count = source.poi_count;
  }
  if (source.pois !== undefined) {
    if (!Array.isArray(source.pois) || source.pois.length > 20) throw new Error('Invalid geocoder POIs');
    projected.pois = source.pois.map(place);
  }
  return projected;
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_RESPONSE_BYTES)) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error('Geocoder response exceeds limit');
  }
  if (!response.body) throw new Error('Empty geocoder response');
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw new Error('Geocoder deadline exceeded');
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        cancel();
        throw new Error('Geocoder response exceeds limit');
      }
      chunks.push(value);
    }
    if (signal.aborted) throw new Error('Geocoder deadline exceeded');
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

export class PublicGeocodingService {
  constructor(
    private readonly config: Pick<SystemConfigService, 'get'>,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async reverse(locationValue: unknown): Promise<JsonRecord> {
    const location = parseGeocodingLocation(locationValue);
    const key = (await this.config.get('tengxun_map_key')).trim();
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw new ValidateException('地图服务尚未配置');
    const url = new URL(GEOCODER_URL);
    url.searchParams.set('location', location);
    url.searchParams.set('key', key);
    url.searchParams.set('output', 'json');
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { abort.abort(); reject(new Error('Geocoder deadline exceeded')); }, REQUEST_TIMEOUT_MS);
    });
    try {
      return await Promise.race([deadline, (async () => {
        const response = await this.fetcher(url.toString(), {
          method: 'GET', redirect: 'error', signal: abort.signal,
          headers: { Accept: 'application/json' },
        });
        if (abort.signal.aborted || !response.ok || response.redirected) {
          void response.body?.cancel().catch(() => undefined);
          throw new Error('Geocoder HTTP failure');
        }
        if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
          void response.body?.cancel().catch(() => undefined);
          throw new Error('Invalid geocoder content type');
        }
        const data = record(await boundedJson(response, abort.signal));
        if (data.status !== 0 || data.error) throw new Error('Geocoder rejected request');
        return projectResult(data.result);
      })()]);
    } catch {
      // Provider/network errors may contain its request URL and key. Never rethrow them.
      throw new ValidateException(PROVIDER_FAILURE);
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
  }
}
