/** Finite declared byte storage at the R2 boundary; no external object service. */
export const buyerReviewPng=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64'));
export function buyerReviewR2(){
  const objects=new Map<string,{bytes:Uint8Array;contentType:string}>(),reads:string[]=[],writes:string[]=[],deletes:string[]=[];
  const object=(key:string,value:{bytes:Uint8Array;contentType:string})=>({key,size:value.bytes.length,etag:'owned-review',httpEtag:'"owned-review"',httpMetadata:{contentType:value.contentType},body:value.bytes.slice(),writeHttpMetadata:(headers:Headers)=>headers.set('Content-Type',value.contentType)});
  const bucket={put:async(key:string,value:BodyInit,options?:{httpMetadata?:{contentType?:string}})=>{const bytes=new Uint8Array(await new Response(value).arrayBuffer());if(bytes.length>10*1024*1024)throw Error('Owned review byte budget exceeded');const row={bytes,contentType:options?.httpMetadata?.contentType??'image/png'};objects.set(key,row);writes.push(key);return object(key,row);},
    get:async(key:string)=>{reads.push(key);const value=objects.get(key);return value?object(key,value):null;},head:async(key:string)=>{const value=objects.get(key);return value?object(key,value):null;},delete:async(key:string)=>{objects.delete(key);deletes.push(key);}} as unknown as R2Bucket;
  return {bucket,objects,reads,writes,deletes};
}
