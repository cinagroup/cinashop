import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { systemAttachment } from '@/models/schema';
import { R2_IMAGE_TYPE } from '@/services/system/AttachmentService';
import { canonicalizeDiyEditorialMedia,DIY_COMMUNITY_MEDIA_SLOT_LIMIT,renderDiyEditorialMedia } from '@/services/content/DiyEditorialMediaPolicy';
import { financeMemoryPostgres } from './helpers/financePostgres';
const historical=(id:number)=>`/api/assets/${id}?expires=1&signature=old`;
const appKey='community-author-owned-media';
const sample=(url:string)=>({name:'community',timestamp:17,isHide:true,imgConfig:{url,title:'原标题图',keep:{zero:0,empty:[]}},posts:[{image:historical(1),author_image:historical(1),sliderImage:[historical(1)]}],selectConfig:{list:[{image:historical(1)}],activeValue:'999'},link:historical(1),child:{name:'community',imgConfig:{url:historical(1)}},imgBgConfig:{url:historical(1)}});
describe('community exact authored header image and independent atomic capacity',()=>{
 let f:Awaited<ReturnType<typeof financeMemoryPostgres>>;
 beforeAll(async()=>{f=await financeMemoryPostgres([systemAttachment]);});afterAll(async()=>{await f?.close();});
 beforeEach(async()=>{await f.reset();await f.db.insert(systemAttachment).values([
  {attId:1,type:1,relationId:0,moduleType:1,fileType:1,imageType:R2_IMAGE_TYPE,attDir:'/api/assets/1',name:'attachments/admin/1/2026/10/public.png',attType:'image/png'},
  {attId:2,type:1,relationId:0,moduleType:1,fileType:2,imageType:R2_IMAGE_TYPE,attDir:'/api/assets/2',name:'attachments/admin/1/2026/10/00000000-0000-4000-8000-000000000002.mp4',attType:'video/mp4'},
  {attId:4,type:3,relationId:11,moduleType:3,fileType:1,imageType:R2_IMAGE_TYPE,attDir:'/api/assets/4',name:'attachments/user/11/2026/10/private.png',attType:'image/png'},
  {attId:5,type:4,relationId:9,moduleType:1,fileType:1,imageType:R2_IMAGE_TYPE,attDir:'/api/assets/5',name:'attachments/supplier/9/2026/10/private.png',attType:'image/png'},
 ]);});
 it('canonicalizes/signs only the actual dormant header image, preserving complete schema and database',async()=>{
  const block=sample(historical(1)),before=structuredClone(block),rows=await f.db.select().from(systemAttachment);
  canonicalizeDiyEditorialMedia([block]);expect(block.imgConfig.url).toBe('/api/assets/1');await renderDiyEditorialMedia(f.db,appKey,[block]);expect(block.imgConfig.url).toMatch(/^\/api\/assets\/1\?expires=\d+&signature=[A-Za-z0-9_-]{43}$/u);
  block.imgConfig.url=historical(1);expect(block).toEqual(before);expect(await f.db.select().from(systemAttachment)).toEqual(rows);
 });
 it('uses actual legacy entity grammar and rechecks decoded owner instead of trusting historical tickets',async()=>{
  const block=sample('/&#97;pi/assets/1?expires=1&amp;signature=old');canonicalizeDiyEditorialMedia([block]);expect(block.imgConfig.url).toBe('/api/assets/1');await renderDiyEditorialMedia(f.db,appKey,[block]);expect(block.imgConfig.url).toMatch(/^\/api\/assets\/1\?expires=/u);
  for(const id of [2,4,5,999]){const privateBlock=sample(`/&#x61;pi/assets/${id}?expires=1&amp;signature=old`);await renderDiyEditorialMedia(f.db,appKey,[privateBlock]);expect(privateBlock.imgConfig.url).toBe('');}
 });
 it.each([{type:3,relationId:11},{moduleType:3},{fileType:2},{imageType:0},{name:'attachments/admin/2/foreign.png'},{attType:'image/svg+xml'},{attType:'text/html'}])('rechecks current raster ownership %j',async patch=>{
  await f.db.update(systemAttachment).set(patch).where(eq(systemAttachment.attId,1));const block=sample(historical(1));await renderDiyEditorialMedia(f.db,appKey,[block]);expect(block.imgConfig.url).toBe('');
 });
 it('leaves wrong-case, nested, API post/avatar/slider and malformed image holders opaque',async()=>{
  const blocks=[{name:'Community',imgConfig:{url:historical(1)}},{name:'community',imgConfig:[{url:historical(1)}],posts:[sample(historical(1))],image:historical(1),author_image:historical(1),sliderImage:[historical(1)]}],before=structuredClone(blocks),select=vi.spyOn(f.db,'select');
  try{canonicalizeDiyEditorialMedia(blocks);await renderDiyEditorialMedia(f.db,appKey,blocks);expect(blocks).toEqual(before);expect(select).not.toHaveBeenCalled();}finally{select.mockRestore();}
 });
 it('preserves static/external literals with no SQL, network or signing key',async()=>{
  const select=vi.spyOn(f.db,'select'),fetch=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('No network'));
  try{for(const url of ['/static/images/diy/community.png','https://foreign.example/api/assets/4?keep=1']){const block=sample(url);canonicalizeDiyEditorialMedia([block]);await renderDiyEditorialMedia(f.db,undefined,[block]);expect(block.imgConfig.url).toBe(url);}expect(select).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();}finally{select.mockRestore();fetch.mockRestore();}
 });
 it('retains the full independent20000 community slots alongside the unchanged2500 ordinary budget',async()=>{
  expect(DIY_COMMUNITY_MEDIA_SLOT_LIMIT).toBe(20000);const community=Array.from({length:20000},(_,i)=>({name:'community',imgConfig:{url:historical(1)},i})),slides=Array.from({length:2500},(_,i)=>({img:historical(1),i})),blocks=[...community,{name:'swipers',swiperConfig:{list:slides}}];
  canonicalizeDiyEditorialMedia(blocks);await renderDiyEditorialMedia(f.db,appKey,blocks);expect(community).toHaveLength(20000);expect(community.every((block,i)=>block.i===i&&block.imgConfig.url===community[0]!.imgConfig.url)).toBe(true);expect(slides.every((slide,i)=>slide.i===i&&slide.img===community[0]!.imgConfig.url)).toBe(true);
 });
 it('rejects slot20001 before any canonical mutation, owner lookup or signature',async()=>{
  const blocks=[...Array.from({length:20001},()=>({name:'community',imgConfig:{url:historical(1)}})),{name:'news',imgConfig:{url:historical(1)}}],before=structuredClone(blocks),select=vi.spyOn(f.db,'select');
  try{expect(()=>canonicalizeDiyEditorialMedia(blocks)).toThrow('DIY公开素材超过完整读取容量');expect(blocks).toEqual(before);await expect(renderDiyEditorialMedia(f.db,appKey,blocks)).rejects.toThrow('DIY公开素材超过完整读取容量');expect(blocks).toEqual(before);expect(select).not.toHaveBeenCalled();}finally{select.mockRestore();}
 });
});
