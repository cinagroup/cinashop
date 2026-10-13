import { ServiceUnavailableException } from '@/utils/errors';
export interface ErpCipherEnv {ERP_CONFIG_KEY?:string}
const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:false});
const unavailable=()=>new ServiceUnavailableException('ERP 凭据密钥尚未就绪');
function decode(value:string):Uint8Array {
  if(!/^[A-Za-z0-9_-]+$/.test(value))throw unavailable();const bytes=new Uint8Array(Buffer.from(value,'base64url'));
  if(Buffer.from(bytes).toString('base64url')!==value)throw unavailable();return bytes;
}
export function erpCipherReady(env:ErpCipherEnv):boolean {try{return typeof env.ERP_CONFIG_KEY==='string' && env.ERP_CONFIG_KEY.length===43 && decode(env.ERP_CONFIG_KEY).length===32;}catch{return false;}}
export class ErpSecretCodec {
  private readonly material:Uint8Array;
  constructor(env:ErpCipherEnv){if(!erpCipherReady(env))throw unavailable();this.material=decode(env.ERP_CONFIG_KEY!);}
  private async key(purpose:'seal'|'digest'):Promise<CryptoKey> {
    const seed=await crypto.subtle.importKey('raw',this.material,'HKDF',false,['deriveKey']);
    return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:encoder.encode('cinashop-erp-v1'),info:encoder.encode(purpose)},seed,
      purpose==='seal'?{name:'AES-GCM',length:256}:{name:'HMAC',hash:'SHA-256',length:256},false,purpose==='seal'?['encrypt','decrypt']:['sign']);
  }
  async digest(value:string):Promise<string>{return Buffer.from(await crypto.subtle.sign('HMAC',await this.key('digest'),encoder.encode(value))).toString('hex');}
  async seal(value:string,aad:string):Promise<string>{
    const bytes=encoder.encode(value);if(!bytes.length||bytes.length>4096)throw unavailable();const iv=crypto.getRandomValues(new Uint8Array(12));
    const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(aad),tagLength:128},await this.key('seal'),bytes);
    return `erp:v1:${Buffer.from(iv).toString('base64url')}:${Buffer.from(ciphertext).toString('base64url')}`;
  }
  async open(value:string,aad:string):Promise<string>{
    try {
      if(value.length>6000||!value.startsWith('erp:v1:'))throw unavailable();const pieces=value.slice(7).split(':');if(pieces.length!==2)throw unavailable();
      const iv=decode(pieces[0]),ciphertext=decode(pieces[1]);if(iv.length!==12||ciphertext.length<17||ciphertext.length>4112)throw unavailable();
      return decoder.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:encoder.encode(aad),tagLength:128},await this.key('seal'),ciphertext));
    } catch {throw unavailable();}
  }
}
