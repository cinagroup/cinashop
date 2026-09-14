/** Browser-only durable intent protocol. No tokens, timer retries or server imports. */
export interface CreationIdentity { ownerType: 0 | 2; relationId: number; actorId: number }
export interface CreationReceipt { version: 'shipping-create-v1'; requestKey: string; requestHash: string; id: number }
export interface CreationIntent {
  schema: 1; scope: string; requestKey: string; requestHash: string;
  payload: Record<string, unknown>; receipt: CreationReceipt | null;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const PREFIX = 'cinashop:shipping-create:v1:';
function fail(message: string): never { throw new Error(message); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('创建记录格式无效，禁止重新创建');
  return value as Record<string, unknown>;
}
function integer(value: unknown, min: number, max = 2147483647): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail('创建字段整数无效');
  return value;
}
export function creationScope(identity: CreationIdentity): string {
  const owner = integer(identity.ownerType, 0, 2), relation = integer(identity.relationId, 0), actor = integer(identity.actorId, 1);
  if (owner !== 0 && owner !== 2 || (owner === 0 ? relation !== 0 : relation === 0)) fail('创建身份无效');
  return `${owner}:${relation}:${actor}`;
}
function decimal(value: unknown, digits: number, positive: boolean): string {
  if (typeof value !== 'string' && typeof value !== 'number') fail('费率格式无效');
  const raw = String(value).trim();
  if (!new RegExp(`^\\d{1,${digits}}(?:\\.\\d{1,2})?$`).test(raw)) fail('费率格式无效');
  const [whole, fraction = ''] = raw.split('.');
  const result = `${BigInt(whole)}.${fraction.padEnd(2, '0')}`;
  if (positive && BigInt(result.replace('.', '')) === 0n) fail('计量必须大于零');
  return result;
}
function rules(value: unknown, kind: 'region' | 'free' | 'deny') {
  if (!Array.isArray(value) || value.length > 100) fail('规则数量或格式无效');
  const endpoints = new Set<number>();
  return value.map(raw => {
    const row = record(raw);
    if (!Array.isArray(row.city_ids) || !row.city_ids.length || row.city_ids.length > 1000) fail('地区数量无效');
    const paths = row.city_ids.map((rawPath: unknown) => {
      if (!Array.isArray(rawPath) || !rawPath.length || rawPath.length > 4) fail('地区路径无效');
      const path = rawPath.map(value => integer(value, 0));
      if (new Set(path).size !== path.length || path.includes(0) && (kind !== 'region' || path.length !== 1)) fail('地区路径无效');
      const endpoint = path[path.length - 1];
      if (endpoints.has(endpoint) || endpoints.size >= 1000) fail('地区重复或过多');
      endpoints.add(endpoint);
      return path;
    });
    if (kind === 'region') return { paths, first: decimal(row.first, 10, true), firstPrice: decimal(row.first_price, 10, false),
      continue: decimal(row.continue, 10, true), continuePrice: decimal(row.continue_price, 10, false) };
    if (kind === 'free') return { paths, number: decimal(row.number, 8, true), price: decimal(row.price, 8, false) };
    return { paths };
  });
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const row = record(value);
  return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
}
/** Matches the grouped shipping-create-v1 server contract; parity tests guard drift. */
export async function creationHash(payload: Record<string, unknown>, ownerType: 0 | 2): Promise<string> {
  if (typeof payload.name !== 'string' || !payload.name.trim() || payload.name.trim().length > 255 || payload.name.includes('\0')) fail('模板名称无效');
  if (payload.id !== undefined && payload.id !== 0 || payload.expectedRevision !== undefined) fail('创建不能携带编辑版本');
  const regions = rules(payload.region_info, 'region');
  if (regions.flatMap(row => row.paths).filter(path => path.length === 1 && path[0] === 0).length !== 1) fail('配送规则必须有且仅有一个默认全国');
  const free = rules(payload.appoint_info, 'free'), deny = rules(payload.no_delivery_info, 'deny');
  const freeRules = integer(payload.appoint, 0, 1) ? free : [];
  const noDeliveryRules = integer(payload.no_delivery, 0, 1) ? deny : [];
  const input = { name: payload.name.trim(), billingType: integer(payload.type, 1, 3), appoint: freeRules.length ? 1 : 0,
    noDelivery: noDeliveryRules.length ? 1 : 0, sort: integer(payload.sort, 0), regions, freeRules, noDeliveryRules };
  const status = ownerType === 2 ? 1 : integer(payload.status, 0, 1);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical({ version: 'shipping-create-v1', input, status })));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function receipt(value: unknown, intent: CreationIntent, create: boolean): CreationReceipt {
  const result = record(value), keys = ['version', 'requestKey', 'requestHash', 'id', ...(create ? ['replayed'] : [])];
  if (Object.keys(result).length !== keys.length || keys.some(key => !(key in result))
    || result.version !== 'shipping-create-v1' || result.requestKey !== intent.requestKey || result.requestHash !== intent.requestHash
    || create && typeof result.replayed !== 'boolean') fail('创建回执不匹配，原请求已保留，禁止另建');
  const id = integer(result.id, 1);
  return { version: 'shipping-create-v1', requestKey: intent.requestKey, requestHash: intent.requestHash, id };
}
interface Transport {
  create(payload: Record<string, unknown>, key: string): Promise<unknown>;
  lookup(key: string): Promise<unknown>;
}
export function createShippingCreation(identity: CreationIdentity, isCurrent: () => boolean, transport: Transport) {
  const scope = creationScope(identity), ownerType = identity.ownerType, storageKey = PREFIX + scope;
  const check = () => { if (!isCurrent()) fail('登录身份已变化，请重新进入后恢复原请求'); };
  // A Web Lock coordinates all tabs of this origin. Never fall back to a racy
  // read/set localStorage lock; unsupported or blocked persistence prevents send.
  async function locked<T>(action: () => Promise<T>): Promise<T> {
    check();
    if (!navigator.locks?.request) fail('浏览器不支持安全创建锁，请使用支持 Web Locks 的安全浏览器');
    return navigator.locks.request(storageKey, { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (!lock) fail('另一标签页正在处理此账号的创建请求，请稍后恢复');
      check(); return action();
    });
  }
  async function read(): Promise<CreationIntent | null> {
    check();
    const raw = localStorage.getItem(storageKey);
    if (raw === null) return null;
    if (new TextEncoder().encode(raw).length > 400_000) fail('创建记录过大，禁止重新创建');
    const data = record(JSON.parse(raw));
    if (data.schema !== 1 || data.scope !== scope || typeof data.requestKey !== 'string' || !UUID.test(data.requestKey)
      || typeof data.requestHash !== 'string' || !HASH.test(data.requestHash)) fail('创建记录损坏，禁止重新创建');
    const payload = record(data.payload);
    if (await creationHash(payload, ownerType) !== data.requestHash) fail('创建输入摘要不匹配，禁止重新创建');
    check();
    const intent: CreationIntent = { schema: 1, scope, requestKey: data.requestKey, requestHash: data.requestHash, payload, receipt: null };
    if (data.receipt !== null) intent.receipt = receipt(data.receipt, intent, false);
    return intent;
  }
  function persist(intent: CreationIntent) {
    check();
    const raw = JSON.stringify(intent);
    localStorage.setItem(storageKey, raw);
    if (localStorage.getItem(storageKey) !== raw) fail('创建记录无法持久保存，已阻止发送');
  }
  async function expected(key: string) {
    const intent = await read();
    if (!intent || intent.requestKey !== key) fail('创建意图已在另一标签页改变，请重新打开');
    return intent;
  }
  return {
    load: () => locked(read),
    prepare: (input: Record<string, unknown>) => {
      // Copy BEFORE any await; caller edits may not change a prepared attempt.
      const payload = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
      return locked(async () => {
        const prior = await read();
        if (prior) return prior; // another tab's exact intent wins, never overwrite it
        if (new TextEncoder().encode(JSON.stringify(payload)).length > (ownerType === 0 ? 256 * 1024 : 64 * 1024)) fail('创建输入过大');
        const requestHash = await creationHash(payload, ownerType);
        check();
        const requestKey = crypto.randomUUID();
        const intent: CreationIntent = { schema: 1, scope, requestKey, requestHash, payload, receipt: null };
        persist(intent); return intent;
      });
    },
    send: (key: string) => locked(async () => {
      const intent = await expected(key);
      if (intent.receipt) return intent;
      check();
      const result = await transport.create(JSON.parse(JSON.stringify(intent.payload)), intent.requestKey);
      check();
      intent.receipt = receipt(result, intent, true);
      // Re-read under the same lock before persisting a late response. Never
      // attach an old receipt to a newer attempt or a replacement account.
      await expected(key); persist(intent); return intent;
    }),
    recover: (key: string) => locked(async () => {
      const intent = await expected(key);
      check();
      const result = await transport.lookup(intent.requestKey);
      check();
      if (result === null) {
        if (intent.receipt) fail('服务器未返回已确认回执，请保留原请求并联系管理员');
        return intent; // absence never authorizes a new UUID or a changed payload
      }
      const found = receipt(result, intent, false);
      if (intent.receipt && intent.receipt.id !== found.id) fail('服务器回执ID改变，请联系管理员');
      intent.receipt = found;
      await expected(key); persist(intent); return intent;
    }),
    acknowledge: (key: string) => locked(async () => {
      const intent = await expected(key);
      if (!intent.receipt) fail('结果未确认，不能放弃原请求或开始新建');
      check(); localStorage.removeItem(storageKey);
      if (localStorage.getItem(storageKey) !== null) fail('无法完成创建确认，请重试');
    }),
  };
}
