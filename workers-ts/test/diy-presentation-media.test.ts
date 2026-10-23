import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { systemAttachment } from '@/models/schema';
import { R2_IMAGE_TYPE } from '@/services/system/AttachmentService';
import { canonicalizeDiyEditorialMedia, renderDiyEditorialMedia } from '@/services/content/DiyEditorialMediaPolicy';
import { publicDiyPresentationVideos } from '@/services/content/DiyPresentationVideoPolicy';
import * as productMedia from '@/services/activity/ProductAssetPolicy';
import { financeMemoryPostgres } from './helpers/financePostgres';
const key='attachments/admin/1/2026/10/00000000-0000-4000-8000-000000000002.mp4',ticket=(id:number)=>`/api/assets/${id}?expires=1&signature=old`,appKey='diy-presentation-owned-unit-key';
describe('current platform MP4 ownership and atomic DIY presentation publication',()=>{
  let f:Awaited<ReturnType<typeof financeMemoryPostgres>>;
  beforeAll(async()=>{f=await financeMemoryPostgres([systemAttachment]);});afterAll(async()=>{await f?.close();});
  beforeEach(async()=>{await f.reset();await f.db.insert(systemAttachment).values([
    {attId:1,type:1,relationId:0,moduleType:1,fileType:1,imageType:R2_IMAGE_TYPE,attDir:'/api/assets/1',name:'attachments/admin/1/2026/10/real.png',attType:'image/png'},
    ...Array.from({length:8},(_,i)=>Object.assign({attId:i+2,type:1,relationId:0,moduleType:1,fileType:2,imageType:R2_IMAGE_TYPE,attDir:`/api/assets/${i+2}`,name:key,attType:'video/mp4'},(i===1?{type:4,relationId:9,name:key.replace('admin/1','supplier/9')}:i===2?{type:3,relationId:11,moduleType:3,name:key.replace('admin/1','user/11')}:i===3?{attType:'image/png'}:i===4?{name:key.replace('.mp4','.png')}:i===5?{attDir:'https://foreign.test/api/assets/7'}:i===6?{attType:''}:i===7?{fileType:1}:{}))),
  ]);});
  it('admits only the real platform R2 MP4 row; image/foreign/user/supplier/contradictory MIME/keys remain unavailable',async()=>{
    const refs=Array.from({length:10},(_,i)=>ticket(i+1));const before=await f.db.select().from(systemAttachment);
    expect(await publicDiyPresentationVideos(f.db,refs)).toEqual(['','/api/assets/2','','','','','','','','']);
    expect(await f.db.select().from(systemAttachment)).toEqual(before);
    expect(await publicDiyPresentationVideos(f.db,['/static/a.mp4','https://cdn.test/a.mp4','https://foreign.test/api/assets/2?signature=old','data:video/mp4,bad'])).toEqual(['/static/a.mp4','https://cdn.test/a.mp4','https://foreign.test/api/assets/2?signature=old','']);
  });
  it.each([{relationId:11},{moduleType:2},{fileType:1},{imageType:0},{name:key.replace('/1/','/0/')},{attType:'video/webm'}])('rechecks current row on each read after metadata mutation %j',async change=>{
    expect(await publicDiyPresentationVideos(f.db,[ticket(2)])).toEqual(['/api/assets/2']);await f.db.update(systemAttachment).set(change).where(eq(systemAttachment.attId,2));expect(await publicDiyPresentationVideos(f.db,[ticket(2)])).toEqual(['']);
  });
  it('canonical save and public projection distinguish actual image/video slots and never sign href/previews',async()=>{
    const html=`<p style="color:#123456">正文<a href="${ticket(2)}">link</a><img src="${ticket(1)}"><video src="${ticket(2)}" autoplay onplay="bad()"></video><img src="${ticket(2)}"></p>`;
    const blocks=[{name:'videos',videoConfig:{url:ticket(2)},imgConfig:{url:ticket(1)},preview:ticket(3)},{name:'richText',richText:{val:html}}];
    canonicalizeDiyEditorialMedia(blocks);expect(blocks[0].videoConfig!.url).toBe('/api/assets/2');expect(blocks[1].richText!.val).toContain(`href="${ticket(2)}"`);expect(blocks[0].preview).toBe(ticket(3));
    const before=await f.db.select().from(systemAttachment);await renderDiyEditorialMedia(f.db,appKey,blocks);
    expect(blocks[0].videoConfig!.url).toMatch(/^\/api\/assets\/2\?expires=\d+&signature=/u);expect(blocks[0].imgConfig!.url).toMatch(/^\/api\/assets\/1\?expires=/u);
    expect(blocks[1].richText!.val).toContain('controls="controls"');expect(blocks[1].richText!.val).not.toMatch(/autoplay|onplay/u);expect(blocks[1].richText!.val).toContain(`href="${ticket(2).replace('&','&amp;')}"`);
    expect(blocks[1].richText!.val).toContain('<img style="max-width:100%;height:auto">');expect(await f.db.select().from(systemAttachment)).toEqual(before);
  });
  it('does not decode JSON entities or double-decode HTML values into new asset authority',async()=>{const encoded='&#47;api/assets/2',double='&amp;#47;api/assets/2',html=`<img src="${double}"><video src="${double}"></video>`,blocks=[{name:'videos',videoConfig:{url:encoded},imgConfig:{url:encoded}},{name:'richText',richText:{val:html}}];canonicalizeDiyEditorialMedia(blocks);expect(blocks[0].videoConfig!.url).toBe(encoded);expect(blocks[1].richText!.val).toBe(html);await renderDiyEditorialMedia(f.db,appKey,blocks);expect(blocks[0].videoConfig!.url).toBe('');expect(blocks[0].imgConfig!.url).toBe('');expect(blocks[1].richText!.val).not.toContain('/api/assets/2');expect(JSON.stringify(blocks)).not.toContain('signature=');});
  it('publishes safe text-only HTML even when no media exists, without DB or key access',async()=>{
    const blocks=[{name:'richText',richText:{val:'<script>bad()</script><p onclick="bad()">正文</p>'}},{name:'richText',richText:{val:'<script>const s="<img src=\'/api/assets/2\' title=\'broken>";</script><p>后续正文</p>'}}];
    await renderDiyEditorialMedia({select:()=>{throw Error('unexpected DB');}} as unknown as typeof f.db,undefined,blocks);expect(blocks.map(block=>block.richText.val)).toEqual(['<p>正文</p>','<p>后续正文</p>']);
  });
  it('preserves complete long JSON media URLs without widening old catalogue/editorial image limits',async()=>{const long='https://cdn.test/'+ 'a'.repeat(300)+'.mp4',blocks=[{name:'videos',videoConfig:{url:long},imgConfig:{url:long.replace('.mp4','.png')}},{name:'news',imgConfig:{url:long.replace('.mp4','.png')}}];await renderDiyEditorialMedia(f.db,appKey,blocks);expect(blocks[0].videoConfig!.url).toBe(long);expect(blocks[0].imgConfig!.url).toBe(long.replace('.mp4','.png'));expect(blocks[1].imgConfig!.url).toBe('');});
  it('a later HMAC batch failure leaves all media and raw HTML byte-for-byte unchanged',async()=>{
    const blocks=[{name:'richText',richText:{val:'<p onclick="bad()">'+Array.from({length:257},(_,i)=>`<img src="/static/${i}.png">`).join('')+'</p>'}},{name:'videos',videoConfig:{url:'/static/a.mp4'},imgConfig:{url:'/static/cover.png'}}];
    const before=JSON.stringify(blocks),real=productMedia.renderProductPictures;let calls=0;
    const signing=vi.spyOn(productMedia,'renderProductPictures').mockImplementation(async(...args)=>{if(++calls===2)throw Error('owned second HMAC failure');return real(...args);});
    try{await expect(renderDiyEditorialMedia(f.db,appKey,blocks)).rejects.toThrow('owned second HMAC failure');expect(calls).toBe(2);expect(JSON.stringify(blocks)).toBe(before);}finally{signing.mockRestore();}
  });
  it('complete HTML media excess is rejected before owner lookup or any component mutation',async()=>{
    const blocks=[{name:'videos',videoConfig:{url:ticket(2)}},{name:'richText',richText:{val:'<img src="/api/assets/1">'.repeat(10001)}}],before=JSON.stringify(blocks);
    await expect(renderDiyEditorialMedia({select:()=>{throw Error('unexpected owner lookup');}} as unknown as typeof f.db,appKey,blocks)).rejects.toThrow('完整媒体容量');expect(JSON.stringify(blocks)).toBe(before);
  });
});
