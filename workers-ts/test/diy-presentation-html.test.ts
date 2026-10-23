import { describe, expect, it } from 'vitest';
import { canonicalizeDiyPresentationHtml, diyPresentationHtmlMediaReferences, diyPresentationHtmlTree, mapDiyPresentationHtmlMedia, sanitizeDiyPresentationHtml, DIY_PRESENTATION_HTML_MAX_BYTES } from '../../view/common/diyPresentationHtml';
import { canonicalizeDiyEditorialMedia, DIY_PRESENTATION_MEDIA_SLOT_LIMIT } from '@/services/content/DiyEditorialMediaPolicy';
import { normalizeAdminDiseJson } from '@/controllers/api/v1/AdminCrudController';
const old='/api/assets/7?expires=1&signature=old';
describe('actual WangEditor DIY media grammar and safe publication',()=>{
  it('changes only the real first img/video src value and preserves all other editor bytes',()=>{
    const source=`<p style='color:red'>原文 > &amp; <a href="${old}">link</a><img title="a > b" src='${old}' src="${old}" srcset="${old}"><video poster="${old}" src=${old} controls></video><source src="${old}"></p><!-- <img src="${old}"> --><script>const x='<img src="${old}">'</script><svg><svg></svg><img src="${old}"></svg><img src="https://foreign.test${old}">`;
    const expected=source.replace(`src='${old}'`,`src='/api/assets/7'`).replace(`src=${old} controls`,'src=/api/assets/7 controls');
    expect(canonicalizeDiyPresentationHtml(source)).toBe(expected);
    expect(diyPresentationHtmlMediaReferences(source).map(x=>x.kind)).toEqual(['image','video','image']);
  });
  it('handles entities, bare ticket equals, double quotes and arbitrary quoted greater-than characters',()=>{
    const source='<img title="x > y" src="&#47;api/assets/7?expires=1&amp;signature=old"><video src=\'/api/assets/8?expires=1&signature=old\'></video>';
    expect(canonicalizeDiyPresentationHtml(source)).toBe('<img title="x > y" src="/api/assets/7"><video src=\'/api/assets/8\'></video>');
    expect(mapDiyPresentationHtmlMedia('<img src="/api/assets/7">',()=>'/api/assets/7?expires=2&signature=new')).toBe('<img src="/api/assets/7?expires=2&amp;signature=new">');
  });
  it.each(['script','style','iframe','svg','math','template','textarea','object'])('does not discover or publish %s descendant media',tag=>{
    const html=`<${tag}>hidden<img src="${old}"></${tag}><p>visible<img src="/static/a.png"></p>`;
    expect(diyPresentationHtmlMediaReferences(html)).toEqual([{value:'/static/a.png',kind:'image'}]);
    const clean=sanitizeDiyPresentationHtml(html);expect(clean).not.toContain('hidden');expect(clean).not.toContain('/api/assets/7');expect(clean).toContain('visible');
  });
  it.each(['script','style','iframe','noscript','textarea','title','xmp'])('ignores broken fake tags inside raw %s and retains actual following paragraphs',tag=>{
    const html=`<${tag}>const value="<img src='${old}' title='broken>";</${tag}><p>必须保留的后续正文<img src="/static/visible.png"></p>`;
    expect(diyPresentationHtmlMediaReferences(html)).toEqual([{value:'/static/visible.png',kind:'image'}]);
    const clean=sanitizeDiyPresentationHtml(html);expect(clean).toContain('必须保留的后续正文');expect(clean).toContain('src="/static/visible.png"');expect(clean).not.toContain('broken');expect(clean).not.toContain('/api/assets/7');
    expect(canonicalizeDiyPresentationHtml(html)).toBe(html);
  });
  it('never treats spaced or longer fake raw closing tags as the actual HTML end tag',()=>{
    const html=`<script>bad< /script><img src="${old}"></scriptx><video src="${old}"></video>`;
    expect(diyPresentationHtmlMediaReferences(html)).toEqual([]);expect(sanitizeDiyPresentationHtml(html)).toBe('');
  });
  it('plaintext consumes the rest of author HTML even when it contains a literal closing tag',()=>{
    const html=`<p>前文</p><plaintext>hidden</plaintext><img src="${old}">`;
    expect(diyPresentationHtmlMediaReferences(html)).toEqual([]);expect(sanitizeDiyPresentationHtml(html)).toBe('<p>前文</p>');
  });
  it.each(['svg','math','template','object'])('keeps the real closing boundary of %s when its blocked child contains raw fake markup',tag=>{
    const html=`<${tag}><script>const value="<img src='${old}' title='broken>";</script></${tag}><p>命名空间之后的正文<img src="/static/after.png"></p>`;
    expect(diyPresentationHtmlMediaReferences(html)).toEqual([{value:'/static/after.png',kind:'image'}]);
    const clean=sanitizeDiyPresentationHtml(html);expect(clean).toContain('命名空间之后的正文');expect(clean).toContain('src="/static/after.png"');expect(clean).not.toContain('broken');expect(clean).not.toContain('/api/assets/7');
  });
  it('keeps safe authored typography/table formatting and video controls, dropping active HTML/CSS',()=>{
    const html='<p style="text-align:center;color:#123456;font-size:22px;position:fixed;background-image:url(https://bad.test);color:expression(alert(1))" onclick="bad()"><strong>标题</strong><a href="javascript&#58;bad()">bad</a><img onerror="bad()" src="data:image/svg+xml,bad"><video src="/static/a.mp4" autoplay onplay="bad()" style="width:90%"></video><table><tr><td colspan="2">内容</td></tr></table></p>';
    const clean=sanitizeDiyPresentationHtml(html);expect(clean).toContain('text-align:center;color:#123456;font-size:22px');expect(clean).toContain('<strong>标题</strong>');expect(clean).toContain('controls="controls"');expect(clean).toContain('src="/static/a.mp4"');expect(clean).toContain('colspan="2"');
    expect(clean).not.toMatch(/onclick|onerror|onplay|autoplay|javascript|data:|position|url\(|expression/iu);
    expect(sanitizeDiyPresentationHtml(clean)).toBe(clean);
  });
  it('public video markup without authored style is idempotent across save/read/preview passes',()=>{const once=sanitizeDiyPresentationHtml('<p><video src="/static/a.mp4" controls></video></p>');expect(sanitizeDiyPresentationHtml(once)).toBe(once);});
  it('typed native tree retains one paragraph around a real linked strong node and flags only its interaction ancestors',()=>{const tree=diyPresentationHtmlTree('<p>前<a href="/pages/cart/index"><strong>购物车</strong></a>后</p>');expect(tree).toHaveLength(1);expect(tree[0]).toMatchObject({name:'p',interactive:true,children:[{type:'text',text:'前'},{name:'a',attrs:{href:'/pages/cart/index'},interactive:true,children:[{name:'strong',interactive:false}]},{type:'text',text:'后'}]});});
  it('drops all ambiguous/incomplete active markup without inventing an extra media slot',()=>{
    const html='<p>原文 <img src="/api/assets/7?unfinished><video src="/api/assets/8">';
    expect(diyPresentationHtmlMediaReferences(html)).toEqual([]);expect(sanitizeDiyPresentationHtml(html)).not.toMatch(/<img|<video/u);
  });
  it('keeps native video order/index inside the actual balanced authored tree with formatting and links',()=>{const tree=diyPresentationHtmlTree('<p style="text-align:center">前<a href="/pages/cart/index">购物车</a><video src="/static/a.mp4" controls></video>后<strong>强调</strong></p>');expect(tree).toHaveLength(1);expect(tree[0]).toMatchObject({name:'p',attrs:{style:'text-align:center'},interactive:true,children:[{text:'前'},{name:'a'},{name:'video',mediaIndex:0,attrs:{src:'/static/a.mp4'}},{text:'后'},{name:'strong',interactive:false}]});});
  it('accepts all10000 media refs and rejects overflow before a mapper is invoked',()=>{
    const html='<img src="/static/a.png">'.repeat(10000);expect(diyPresentationHtmlMediaReferences(html)).toHaveLength(10000);
    let calls=0;const full=mapDiyPresentationHtmlMedia('原文<!-- untouched -->'+html,(_ref,_kind,index)=>{calls++;return `/static/${index}.png?label='&x=1`;});
    expect(full).toBe('原文<!-- untouched -->'+Array.from({length:10000},(_,index)=>`<img src="/static/${index}.png?label=&#39;&amp;x=1">`).join(''));expect(calls).toBe(10000);
    expect(mapDiyPresentationHtmlMedia("<img src='/static/a.png'>",()=>"/static/b.png?label='&x=1")).toBe("<img src='/static/b.png?label=&#39;&amp;x=1'>");
    calls=0;expect(()=>mapDiyPresentationHtmlMedia(html+'<video src="/static/b.mp4"></video>',()=>{calls++;return '';})).toThrow('完整媒体容量');expect(calls).toBe(0);
  });
  it('rejects UTF8 byte, complete tag and nesting overflow without slicing',()=>{
    expect(()=>sanitizeDiyPresentationHtml('中'.repeat(Math.floor(DIY_PRESENTATION_HTML_MAX_BYTES/3)+1))).toThrow('UTF8');
    expect(()=>sanitizeDiyPresentationHtml('<br>'.repeat(100001))).toThrow('标签容量');
    expect(()=>sanitizeDiyPresentationHtml('<p>'.repeat(65))).toThrow('64层');
  });
  it('retains the2MB Admin total contract, supports HTML beyond the unrelated article200k limit and canonicalizes save',()=>{
    const html='<p>'+'中'.repeat(80000)+`<img src="${old}"></p>`;
    const saved=JSON.parse(normalizeAdminDiseJson(JSON.stringify([{name:'richText',richText:{val:html},unknown:{link:old}}])));
    expect(saved[0].richText.val).toBe(html.replace(old,'/api/assets/7'));expect(saved[0].unknown.link).toBe(old);
    expect(()=>normalizeAdminDiseJson(JSON.stringify([{name:'richText',richText:{val:'中'.repeat(700000)}}]))).toThrow('value内容过长');
  });
  it('keeps the full prior42500 image slots plus the independent20000 presentation slots, with atomic overflow',()=>{
    type MediaBlock={name:string;swiperConfig?:{list:Array<{img:string}>};menuConfig?:{list:Array<{img:string}>};menuList?:Array<{imgList:string[]}>;videoConfig?:{url:string};imgConfig?:{url:string}};
    const components:MediaBlock[]=[{name:'swipers',swiperConfig:{list:Array.from({length:2500},()=>({img:old}))}},{name:'menus',menuConfig:{list:Array.from({length:20000},()=>({img:old}))}},{name:'pageFoot',menuList:Array.from({length:10000},()=>({imgList:[old,old]}))},...Array.from({length:DIY_PRESENTATION_MEDIA_SLOT_LIMIT/2},()=>({name:'videos',videoConfig:{url:old},imgConfig:{url:old}}))];
    canonicalizeDiyEditorialMedia(components);expect(components.at(-1)!.videoConfig!.url).toBe('/api/assets/7');
    const overflow=structuredClone(components);overflow[0].swiperConfig!.list[0].img=old;overflow.push({name:'videos',videoConfig:{url:old}});const before=JSON.stringify(overflow);
    expect(()=>canonicalizeDiyEditorialMedia(overflow)).toThrow('完整读取容量');expect(JSON.stringify(overflow)).toBe(before);
  });
});
