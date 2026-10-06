/** Portable SHA-256 and canonical JSON. No browser-only crypto or URL dependency. */
export function merchantCanonicalJson(value:unknown):string{
  if(value===null||typeof value==='boolean'||typeof value==='string')return JSON.stringify(value);
  if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
  if(Array.isArray(value))return `[${value.map(merchantCanonicalJson).join(',')}]`;
  if(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype)return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${merchantCanonicalJson((value as Record<string,unknown>)[key])}`).join(',')}}`;
  throw Error('原操作内容无法规范化，尚未提交');
}
export function merchantSha256(text:string):string{
  const bytes:number[]=[];for(const character of text){const code=character.codePointAt(0)!;if(code<128)bytes.push(code);else if(code<2048)bytes.push(192|code>>>6,128|code&63);else if(code<65536)bytes.push(224|code>>>12,128|code>>>6&63,128|code&63);else bytes.push(240|code>>>18,128|code>>>12&63,128|code>>>6&63,128|code&63);}
  const size=bytes.length;bytes.push(128);while(bytes.length%64!==56)bytes.push(0);const bitSize=size*8;for(let shift=7;shift>=0;shift--)bytes.push(shift>=4?0:Math.floor(bitSize/2**(shift*8))&255);
  const constants=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const result=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19],rotate=(value:number,bits:number)=>(value>>>bits)|(value<<(32-bits));
  for(let offset=0;offset<bytes.length;offset+=64){const words:number[]=[];for(let i=0;i<16;i++)words[i]=((bytes[offset+i*4]!<<24)|(bytes[offset+i*4+1]!<<16)|(bytes[offset+i*4+2]!<<8)|bytes[offset+i*4+3]!)>>>0;
    for(let i=16;i<64;i++){const a=words[i-15]!,b=words[i-2]!,s0=rotate(a,7)^rotate(a,18)^(a>>>3),s1=rotate(b,17)^rotate(b,19)^(b>>>10);words[i]=(words[i-16]!+s0+words[i-7]!+s1)>>>0;}
    let [a,b,c,d,e,f,g,h]=result as [number,number,number,number,number,number,number,number];for(let i=0;i<64;i++){const s1=rotate(e,6)^rotate(e,11)^rotate(e,25),choose=(e&f)^(~e&g),first=(h+s1+choose+constants[i]!+words[i]!)>>>0,s0=rotate(a,2)^rotate(a,13)^rotate(a,22),majority=(a&b)^(a&c)^(b&c),second=(s0+majority)>>>0;h=g;g=f;f=e;e=(d+first)>>>0;d=c;c=b;b=a;a=(first+second)>>>0;}
    for(const [index,value] of [a,b,c,d,e,f,g,h].entries())result[index]=(result[index]!+value)>>>0;
  }return result.map(value=>value.toString(16).padStart(8,'0')).join('');
}
export function merchantIntentHash(actor_uid:number,kind:string,input:Record<string,unknown>){return merchantSha256(merchantCanonicalJson({version:'merchant-order-operation-v1',actor_uid,kind,input}));}
