import {canonicalDiyPresentationReference,diyPresentationHtmlMediaReferences,mapDiyPresentationHtmlMedia,safeDiyPresentationUrl,sanitizeDiyPresentationHtml} from './diyPresentationHtml';
/** Stored references stay separate from short-lived image capabilities. */
export function memberRightResolvedMedia(value:string,now=Date.now()):string {
  const safe=safeDiyPresentationUrl(value);if(!safe)return '';
  if(!value.startsWith('/api/assets/'))return safe;
  try {
    const u=new URL(value,'https://member-right.invalid'),id=/^\/api\/assets\/([1-9]\d*)$/u.exec(u.pathname);
    if(!id||!Number.isSafeInteger(Number(id[1]))||Number(id[1])>2147483647||u.hash||u.origin!=='https://member-right.invalid'
      ||[...u.searchParams.keys()].length!==2||u.searchParams.getAll('signature').length!==1||u.searchParams.getAll('expires').length!==1
      ||!/^[A-Za-z0-9_-]{43}$/u.test(u.searchParams.get('signature')??'')||!/^[1-9]\d{0,11}$/u.test(u.searchParams.get('expires')??'')
      ||Number(u.searchParams.get('expires'))*1000<=now)return '';
    return safe;
  }catch{return '';}
}
export function memberRightImage(reference:string,preview:string,now=Date.now()):string {
  if(!reference||!preview)return '';
  const stable=canonicalDiyPresentationReference(reference);
  if(stable.startsWith('/api/assets/'))return canonicalDiyPresentationReference(preview)===stable?memberRightResolvedMedia(preview,now):'';
  return reference===preview?memberRightResolvedMedia(preview,now):'';
}
export function memberRightPreviewHtml(value:string,now=Date.now()):string {
  const html=sanitizeDiyPresentationHtml(mapDiyPresentationHtmlMedia(value,(ref)=>memberRightResolvedMedia(ref,now)));
  // The grammar has already escaped attribute quotes and angle brackets.
  return html.replace(/<img(?=[\s>])[^>]*>/giu,tag=>/\ssrc="/u.test(tag)?tag:'<span>图片暂不可用</span>');
}
export function memberRightMediaDeadline(images:string[],html:string[]):number|null {
  const refs=[...images,...html.flatMap(value=>diyPresentationHtmlMediaReferences(value).map(v=>v.value))],expires:number[]=[];
  for(const value of refs)if(value.startsWith('/api/assets/')){try{const n=Number(new URL(value,'https://member-right.invalid').searchParams.get('expires'))*1000;if(Number.isFinite(n)&&n>0)expires.push(n);}catch{}}
  return expires.length?Math.min(...expires):null;
}
