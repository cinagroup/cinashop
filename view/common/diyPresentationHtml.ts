/** DIY author HTML has its own bounded grammar. Article/activity HTML is unchanged.
 * Editing transforms replace only real img[src]/video[src] attribute values;
 * public rendering rebuilds a safe allowlist and never forwards arbitrary CSS. */
export const DIY_PRESENTATION_HTML_AUTHOR_MAX_BYTES = 2_000_000;
// Fresh signed tickets may expand a valid2MB saved schema. Read transport has a
// separate4MB bound; the existing Admin total JSON limit still enforces2MB.
export const DIY_PRESENTATION_HTML_MAX_BYTES = 4_000_000;
export const DIY_PRESENTATION_HTML_TOKEN_LIMIT = 100_000;
export const DIY_PRESENTATION_HTML_MEDIA_LIMIT = 10_000;
export type DiyPresentationMediaKind = 'image' | 'video';
type Attribute = { name: string; value: string; start: number; end: number };
type Token = { source: string; start: number; name: string; closing: boolean; attrs: Attribute[]; blocked: boolean; suppressedAfter: boolean };
const tags = new Set('a abbr address article aside b bdi bdo big blockquote br caption center cite code col colgroup dd del div dl dt em fieldset font footer h1 h2 h3 h4 h5 h6 header hr i img ins label legend li mark nav ol p pre q rt ruby s section small span strong sub sup table tbody td tfoot th thead tr tt u ul video'.split(' '));
const voids = new Set(['br','col','hr','img']);
const forbidden = new Set('script style iframe object embed svg math template noscript textarea title xmp plaintext'.split(' '));
const rawText = new Set('script style iframe noscript textarea title xmp plaintext'.split(' '));
const attributePattern = /([^\s"'=<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+)))?/gu;
export function decodeDiyPresentationAttribute(value: string): string {
  return value.replace(/&#(?:x([0-9a-f]{1,6})|([0-9]{1,7}));?/giu, (_,hex:string|undefined,decimal:string|undefined) => {
    const n=Number.parseInt(hex??decimal!,hex?16:10);return n>0&&n<=0x10ffff&&!(n>=0xd800&&n<=0xdfff)?String.fromCodePoint(n):'\ufffd';
  }).replace(/&(amp|apos|colon|gt|lt|newline|quot|tab|nbsp);/giu,(_,name:string)=>({amp:'&',apos:"'",colon:':',gt:'>',lt:'<',newline:'\n',quot:'"',tab:'\t',nbsp:'\u00a0'})[name.toLowerCase()]!);
}
const escapeAttribute=(v:string)=>v.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll("'",'&#39;').replaceAll('<','&lt;').replaceAll('>','&gt;');
function tokens(html: string): Token[] {
  if(typeof html!=='string')throw new Error('DIY富文本必须是字符串');
  if(new TextEncoder().encode(html).byteLength>DIY_PRESENTATION_HTML_MAX_BYTES)throw new Error('DIY富文本超过4MB UTF8读取容量');
  const result:Token[]=[], suppressed:string[]=[];
  let cursor=0;
  while(cursor<html.length){
    // Raw text has no child HTML tokens. A quote inside a fake tag in script,
    // CSS or textarea cannot consume the real closing tag and following text.
    const current=suppressed.at(-1);
    let at:number;
    if(current&&rawText.has(current)){
      if(current==='plaintext')break;
      const endTag=new RegExp(`</${current}(?=[\\s/>])`,'giu');endTag.lastIndex=cursor;
      const closing=endTag.exec(html);if(!closing)break;at=closing.index;
    }else at=html.indexOf('<',cursor);
    if(at<0)break;
    let end=-1;
    if(html.startsWith('<!--',at)){const c=html.indexOf('-->',at+4);end=c<0?html.length-1:c+2;}
    else {let quote='';for(let i=at+1;i<html.length;i++){const c=html[i]!;if(quote){if(c===quote)quote='';}else if(c==='"'||c==="'")quote=c;else if(c==='>'){end=i;break;}}}
    if(end<0)break;
    const source=html.slice(at,end+1),match=/^<\s*(\/?)\s*([a-z][a-z0-9]*)(?=[\s/>])([\s\S]*)>$/iu.exec(source);
    const name=match?.[2]?.toLowerCase()??'',closing=match?.[1]==='/',attrs:Attribute[]=[];
    const wasSuppressed=suppressed.length>0;
    if(wasSuppressed){const current=suppressed.at(-1)!;if(closing&&name===current)suppressed.pop();else if(!closing&&(name===current&&!rawText.has(current)||rawText.has(name)))suppressed.push(name);}
    else if(!closing&&forbidden.has(name)&&name!=='embed')suppressed.push(name);
    if(match&&!closing&&!wasSuppressed&&!forbidden.has(name)&&tags.has(name)){
      const prefix=source.indexOf(match[3]!,source.indexOf(match[2]!)+match[2]!.length),seen=new Set<string>();
      const pattern=new RegExp(attributePattern.source,attributePattern.flags);
      for(const attr of match[3]!.matchAll(pattern)){
        const key=attr[1]!.toLowerCase();if(seen.has(key))continue;seen.add(key);
        const raw=attr[2]??attr[3]??attr[4];if(raw===undefined)continue;
        const equals=attr[0].indexOf('='),offset=attr[0].indexOf(raw,equals+1)+(raw===''&&/["']/u.test(attr[0][equals+1]??'')?1:0);
        // The attribute grammar consumes complete quoted/bare values (including '=' in copied tickets).
        const start=at+prefix+attr.index!+offset;attrs.push({name:key,value:decodeDiyPresentationAttribute(raw),start,end:start+raw.length});
      }
    }
    result.push({source,start:at,name,closing,attrs,blocked:wasSuppressed||forbidden.has(name),suppressedAfter:suppressed.length>0});
    if(result.length>DIY_PRESENTATION_HTML_TOKEN_LIMIT)throw new Error('DIY富文本超过完整标签容量');
    cursor=end+1;
  }
  return result;
}
function media(tokens:Token[]) {
  const found:Array<{value:string;kind:DiyPresentationMediaKind;start:number;end:number}>=[];
  for(const token of tokens){if(token.blocked||token.closing||!['img','video'].includes(token.name))continue;const src=token.attrs.find(a=>a.name==='src');if(src)found.push({...src,kind:token.name==='img'?'image':'video'});}
  if(found.length>DIY_PRESENTATION_HTML_MEDIA_LIMIT)throw new Error('DIY富文本超过完整媒体容量');
  return found;
}
export function diyPresentationHtmlMediaReferences(html:string):Array<{value:string;kind:DiyPresentationMediaKind}> {
  return media(tokens(html)).map(({value,kind})=>({value,kind}));
}
export function mapDiyPresentationHtmlMedia(html:string,mapper:(reference:string,kind:DiyPresentationMediaKind,index:number)=>string):string {
  const refs=media(tokens(html)),patches=refs.map((ref,index)=>({...ref,mapped:mapper(ref.value,ref.kind,index)}));
  // Complete every mapper before constructing output, then copy each unchanged
  // author segment once. Full 10000-slot HTML must not copy the whole input for
  // every replacement; all offsets refer to the original immutable string.
  const parts:string[]=[];let cursor=0;
  for(const ref of patches)if(ref.mapped!==ref.value){parts.push(html.slice(cursor,ref.start),escapeAttribute(ref.mapped));cursor=ref.end;}
  return parts.length?(parts.push(html.slice(cursor)),parts.join('')):html;
}
export function canonicalDiyPresentationReference(value:string):string {
  const match=/^\/api\/assets\/([1-9]\d*)(?:[?#][\s\S]*)?$/u.exec(value.trim());return match&&Number.isSafeInteger(Number(match[1]))&&Number(match[1])<=2147483647?`/api/assets/${match[1]}`:value;
}
export const canonicalizeDiyPresentationHtml=(html:string)=>mapDiyPresentationHtmlMedia(html,canonicalDiyPresentationReference);
export function safeDiyPresentationUrl(value:unknown,link=false):string {
  if(typeof value!=='string'||value.length>4096||/[\u0000-\u0020\u007f\\]/u.test(value))return '';
  if(/^\/(?!\/)/u.test(value))return value;
  try{const u=new URL(value);if(/^https:\/\//iu.test(value)&&u.protocol==='https:'&&!u.username&&!u.password)return value;}catch{}
  if(link&&/^tel:\+?[0-9][0-9 -]{2,30}$/u.test(value))return value;
  return '';
}
function color(value:string):boolean{return /^(?:#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|transparent|currentColor|black|white|red|green|blue|gray|grey|yellow|orange|purple|pink|inherit)$/iu.test(value)||/^(?:rgb|rgba|hsl|hsla)\([\d.% ,+-]+\)$/iu.test(value);}
/** No url(), var(), expression(), escapes, selectors, declarations or arbitrary positioning. */
export function safeDiyPresentationHtmlStyle(source:string):string {
  const kept=new Map<string,string>();
  for(const declaration of source.split(';')){const at=declaration.indexOf(':');if(at<0)continue;const key=declaration.slice(0,at).trim().toLowerCase(),value=declaration.slice(at+1).trim();
    if(!value||/[\\<>@!\u0000-\u001f\u007f]/u.test(value))continue;
    let ok=false;
    if(['color','background-color','border-color'].includes(key))ok=color(value);
    else if(['font-size','line-height','text-indent','letter-spacing','width','max-width','height','border-width','padding','padding-top','padding-bottom','padding-left','padding-right','margin-top','margin-bottom'].includes(key))ok=/^(?:0|(?:[0-9]{1,4}(?:\.[0-9]{1,3})?)(?:px|em|rem|%|rpx)?)(?:\s+(?:0|[0-9]{1,4}(?:\.[0-9]{1,3})?(?:px|em|rem|%|rpx)?)){0,3}$/u.test(value);
    else if(key==='text-align')ok=/^(?:left|center|right|justify)$/u.test(value);
    else if(key==='font-weight')ok=/^(?:normal|bold|[1-9]00)$/u.test(value);
    else if(key==='font-style')ok=/^(?:normal|italic|oblique)$/u.test(value);
    else if(key==='text-decoration')ok=/^(?:none|underline|line-through|underline line-through)$/u.test(value);
    else if(key==='font-family')ok=/^[a-zA-Z\u3400-\u9fff '"\-,]{1,100}$/u.test(value);
    else if(key==='border-style')ok=/^(?:none|solid|dashed|dotted|double)$/u.test(value);
    if(ok)kept.set(key,value);
  }
  return [...kept].map(([key,value])=>`${key}:${value}`).join(';');
}
export function sanitizeDiyPresentationHtml(html:string):string {
  const ts=tokens(html);media(ts);let cursor=0,out='',suppressed=false;
  const stack:string[]=[];
  for(const token of ts){
    if(!suppressed)out+=html.slice(cursor,token.start).replaceAll('<','&lt;');cursor=token.start+token.source.length;
    // Blocked raw-text/namespace descendants cannot emit tags or text.
    suppressed=token.suppressedAfter;if(token.blocked)continue;
    if(!tags.has(token.name))continue;
    if(token.closing){const index=stack.lastIndexOf(token.name);if(index>=0){while(stack.length>index)out+=`</${stack.pop()!}>`;}continue;}
    if(stack.length>=64)throw new Error('DIY富文本嵌套超过64层');
    const attrs=new Map<string,string>();
    for(const attr of token.attrs){const {name,value}=attr;let accepted:string|null=null;
      if(name==='style')accepted=safeDiyPresentationHtmlStyle(value);
      else if(name==='src'&&['img','video'].includes(token.name))accepted=safeDiyPresentationUrl(value);
      else if(name==='href'&&token.name==='a')accepted=safeDiyPresentationUrl(value,true);
      else if(['title','alt'].includes(name)&&value.length<=1000&&!/[\u0000-\u001f\u007f]/u.test(value))accepted=value;
      else if(['width','height'].includes(name)&&/^[1-9]\d{0,3}(?:px|%)?$/u.test(value))accepted=value;
      else if(['colspan','rowspan'].includes(name)&&['td','th'].includes(token.name)&&/^[1-9]\d?$/u.test(value))accepted=value;
      else if(name==='start'&&token.name==='ol'&&/^-?\d{1,4}$/u.test(value))accepted=value;
      else if(name==='type'&&token.name==='ol'&&/^[1AaIi]$/u.test(value))accepted=value;
      else if(name==='dir'&&['bdo','div','p'].includes(token.name)&&/^(?:auto|ltr|rtl)$/u.test(value))accepted=value;
      if(accepted)attrs.set(name,accepted);
    }
    const forceStyle=(entries:Array<[string,string]>)=>{const style=new Map((attrs.get('style')??'').split(';').filter(Boolean).map(item=>{const at=item.indexOf(':');return [item.slice(0,at),item.slice(at+1)] as [string,string];}));for(const [k,v] of entries)style.set(k,v);attrs.set('style',[...style].map(([k,v])=>`${k}:${v}`).join(';'));};
    if(token.name==='img'){attrs.delete('height');forceStyle([['max-width','100%'],['height','auto']]);}
    if(token.name==='video'){forceStyle([['width','100%'],['max-width','100%']]);attrs.set('controls','controls');}
    if(token.name==='table')forceStyle([['max-width','100%'],['width','100%']]);
    out+=`<${token.name}${[...attrs].map(([k,v])=>` ${k}="${escapeAttribute(v)}"`).join('')}>`;
    if(!voids.has(token.name))stack.push(token.name);
  }
  if(!suppressed)out+=html.slice(cursor).replaceAll('<','&lt;');while(stack.length)out+=`</${stack.pop()!}>`;return out;
}
export type DiyPresentationHtmlNode = {type:'text';text:string;interactive:false}|{type:'node';name:string;attrs:Record<string,string>;children:DiyPresentationHtmlNode[];interactive:boolean;mediaIndex?:number};
/** Typed tree for native interactive ancestors. Passive subtrees can go through
 * rich-text unchanged; only ancestors of anchors/video need native wrappers. */
export function diyPresentationHtmlTree(source:string):DiyPresentationHtmlNode[]{
  const html=sanitizeDiyPresentationHtml(source),ts=tokens(html),roots:DiyPresentationHtmlNode[]=[],stack:Extract<DiyPresentationHtmlNode,{type:'node'}>[]=[];let cursor=0,index=0;
  const children=()=>stack.at(-1)?.children??roots;
  const text=(value:string)=>{if(value)children().push({type:'text',text:value,interactive:false});};
  for(const token of ts){text(html.slice(cursor,token.start));cursor=token.start+token.source.length;
    if(token.closing){const node=stack.pop();if(node?.interactive&&stack.length)stack.at(-1)!.interactive=true;continue;}
    const attrs=Object.fromEntries(token.attrs.map(attr=>[attr.name,attr.value])),node:Extract<DiyPresentationHtmlNode,{type:'node'}>={type:'node',name:token.name,attrs,children:[],interactive:token.name==='video'||token.name==='a'&&!!attrs.href,...(token.name==='video'?{mediaIndex:index++}:{})};children().push(node);
    if(!voids.has(token.name))stack.push(node);else if(node.interactive&&stack.length)stack.at(-1)!.interactive=true;
  }
  text(html.slice(cursor));return roots;
}
