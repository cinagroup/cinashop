/** Database ciphertext uses a dedicated deployment key, never APP_KEY/JWT. */
export interface CityDeliveryCipherEnv { CITY_DELIVERY_CONFIG_KEY?: string }
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
const PREFIX = 'city:v1:';
function base64url(bytes: Uint8Array): string { return Buffer.from(bytes).toString('base64url'); }
function decode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('city_delivery_cipher_invalid');
  const bytes = new Uint8Array(Buffer.from(value, 'base64url'));
  if (base64url(bytes) !== value) throw new Error('city_delivery_cipher_invalid');
  return bytes;
}
export function cityCipherReady(env: CityDeliveryCipherEnv): boolean {
  const value = env.CITY_DELIVERY_CONFIG_KEY;
  try { return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) && decode(value).byteLength === 32; } catch { return false; }
}
export class CityDeliverySecretCodec {
  private readonly material: Uint8Array;
  constructor(env: CityDeliveryCipherEnv) {
    if (!cityCipherReady(env)) throw new Error('city_delivery_cipher_key_unavailable');
    this.material = decode(env.CITY_DELIVERY_CONFIG_KEY!);
  }
  private async key(purpose: 'seal' | 'digest'): Promise<CryptoKey> {
    const seed = await crypto.subtle.importKey('raw', this.material, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('cinashop-city-delivery-v1'), info: encoder.encode(purpose) }, seed,
      purpose === 'seal' ? { name: 'AES-GCM', length: 256 } : { name: 'HMAC', hash: 'SHA-256', length: 256 }, false,
      purpose === 'seal' ? ['encrypt', 'decrypt'] : ['sign']);
  }
  async digest(value: string): Promise<string> {
    return Buffer.from(await crypto.subtle.sign('HMAC', await this.key('digest'), encoder.encode(value))).toString('hex');
  }
  async seal(value: string, aad: string): Promise<string> {
    const bytes = encoder.encode(value);
    if (bytes.byteLength > 4096) throw new Error('city_delivery_cipher_plaintext_capacity');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(aad), tagLength: 128 }, await this.key('seal'), bytes);
    return `${PREFIX}${base64url(iv)}:${base64url(new Uint8Array(ciphertext))}`;
  }
  async open(value: string, aad: string): Promise<string> {
    if (value.length > 6000 || !value.startsWith(PREFIX)) throw new Error('city_delivery_cipher_invalid');
    const pieces = value.slice(PREFIX.length).split(':');
    if (pieces.length !== 2) throw new Error('city_delivery_cipher_invalid');
    const iv = decode(pieces[0]), ciphertext = decode(pieces[1]);
    if (iv.byteLength !== 12 || ciphertext.byteLength < 16 || ciphertext.byteLength > 4112) throw new Error('city_delivery_cipher_invalid');
    try {
      return decoder.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(aad), tagLength: 128 }, await this.key('seal'), ciphertext));
    } catch { throw new Error('city_delivery_cipher_authentication_failed'); }
  }
}
export const isCitySealedValue = (value: string) => value.startsWith(PREFIX);
