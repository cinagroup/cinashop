import { ValidateException } from '@/utils/errors';
const JSON_LIMIT=64*1024,IMAGE_LIMIT=1024*1024;
/** New product-sharing requests have a fixed provider, deadline and streamed
 * byte budget. Other WeChat consumers retain their existing service contract. */
export function boundedProductShareFetch(fetcher:typeof fetch):typeof fetch {
  return async(input,init)=>{
    const url=new URL(input instanceof Request?input.url:String(input));
    if(url.origin!=='https://api.weixin.qq.com'||!['/cgi-bin/token','/cgi-bin/qrcode/create','/wxa/getwxacodeunlimit'].includes(url.pathname))throw new ValidateException('商品分享接口地址无效');
    const response=await fetcher(input,{...init,signal:AbortSignal.timeout(10000),redirect:'error'});
    const type=response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()??'';
    const image=['image/png','image/jpeg'].includes(type),limit=image?IMAGE_LIMIT:JSON_LIMIT;
    const size=Number(response.headers.get('Content-Length')??0);
    if(size>limit||!response.body)throw new ValidateException('商品分享接口返回数据无效');
    const reader=response.body.getReader(),chunks:Uint8Array[]=[];let count=0;
    try{while(true){const{done,value}=await reader.read();if(done)break;count+=value.byteLength;if(count>limit){await reader.cancel();throw new ValidateException('商品分享接口返回数据过大');}chunks.push(value);}}
    finally{reader.releaseLock();}
    const bytes=new Uint8Array(count);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    if(image){const valid=type==='image/png'?bytes.length>=8&&[137,80,78,71,13,10,26,10].every((value,index)=>bytes[index]===value):bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255;if(!valid)throw new ValidateException('商品分享接口返回图片无效');}
    else if(type!=='application/json'&&type!=='text/plain')throw new ValidateException('商品分享接口返回格式无效');
    return new Response(bytes,{status:response.status,statusText:response.statusText,headers:response.headers});
  };
}
