import { describe, expect, it } from 'vitest';
import { user } from '@/models/schema';
import type { DbClient } from '@/lib/di';
import { ownedBuyerReplyImage, renderProductReplyMedia, validateBuyerReplyMedia, verifyBuyerReplyMedia } from '@/services/product/ProductReplyMediaPolicy';
const asset = (id = 1) => ({ attId:id,type:3,relationId:11,moduleType:3,fileType:1,imageType:8,
  name:`attachments/user/11/local_${id}.png`,attDir:`/api/assets/${id}`,sattDir:`/api/assets/${id}`,
  attSize:'24',attType:'image/png',pid:0,time:1,realName:'local.png',scanToken:'' });
function fixture(initial = [asset()]) {
  let rows = initial; const calls: unknown[] = [];
  const db = { select: () => ({ from(table: unknown) {
    const result = () => table === user ? [{ uid:11 }] : rows.map(row => ({ ...row }));
    const query = { where: () => query, orderBy: () => query, limit: () => query,
      for: (kind: string, options: unknown) => { calls.push([kind,options]); return Promise.resolve(result()); },
      then: (yes: (value:unknown)=>unknown, no: (reason:unknown)=>unknown) => Promise.resolve(result()).then(yes,no) };
    return query;
  } }) } as unknown as DbClient;
  return { db,calls,replace(next: ReturnType<typeof asset>[]) { rows=next; } };
}
const published = { uid:11,type:2,relationId:7,avatar:'',pics:['/api/assets/1'],status:1,isDel:0 };
describe('buyer review own image publication', () => {
  it('locks admitted images in the owner transaction and rechecks exact metadata after insertion', async () => {
    const f=fixture(); const proof=await validateBuyerReplyMedia(f.db,11,['/api/assets/1']);
    expect(proof.attachments).toEqual([asset()]); expect(f.calls).toEqual([['share',{noWait:true}],['share',{noWait:true}]]);
    await verifyBuyerReplyMedia(f.db,proof); f.replace([{...asset(),realName:'changed.png'}]);
    await expect(verifyBuyerReplyMedia(f.db,proof)).rejects.toThrow('图片资料已变化');
  });
  it('does not reinterpret or query historical HTTP/static picture strings', async () => {
    const f=fixture(); expect(await validateBuyerReplyMedia(f.db,11,['https://images.example.invalid/a.png','/uploads/old.png'])).toEqual({uid:11,references:[],attachments:[]}); expect(f.calls).toEqual([]);
    expect((await renderProductReplyMedia(f.db,[{...published,pics:['https://images.example.invalid/a.png','/uploads/old.png']}])).map(row=>row.pics)).toEqual([['https://images.example.invalid/a.png','/uploads/old.png']]);
  });
  it.each(['/api/assets/1?signature=preview','/api/assets/01','/api/assets/%31','/api/assets/1/','/attachments/one.png'])('refuses noncanonical private write reference %s', async reference => {
    await expect(validateBuyerReplyMedia(fixture().db,11,[reference])).rejects.toThrow('稳定的站内素材引用');
  });
  it.each([{type:1},{moduleType:2},{relationId:22},{fileType:2},{imageType:1},{name:'attachments/user/22/other.png'},
    {name:'attachments/user/11/../other.png'},{name:'attachments/user/11/a.webp'}, {attType:'image/jpeg'}, {sattDir:'/api/assets/2'}])('refuses mismatched metadata %j', async change => {
    const row={...asset(),...change}; expect(ownedBuyerReplyImage(row,11)).toBe(false);
    await expect(validateBuyerReplyMedia(fixture([row]).db,11,['/api/assets/1'])).rejects.toThrow('不属于');
  });
  it('signs published buyer pictures by reviewer UID rather than supplier product ownership', async () => {
    const [row]=await renderProductReplyMedia(fixture().db,[published],'local-review-public-key');
    expect(row.pics).toHaveLength(1); const url=new URL((row.pics as string[])[0],'http://local.invalid');
    expect(url.pathname).toBe('/api/assets/1'); expect(url.searchParams.get('signature')).toMatch(/^[A-Za-z0-9_-]+$/); expect(Number(url.searchParams.get('expires'))).toBeGreaterThan(Date.now()/1000);
    expect(published.pics).toEqual(['/api/assets/1']);
  });
  it.each([{uid:22},{status:0},{isDel:1},{status:undefined},{isDel:undefined}])('does not mint a buyer image capability for hidden/foreign/unproven row %j', async change => {
    expect((await renderProductReplyMedia(fixture().db,[{...published,...change}],'local-review-public-key'))[0].pics).toEqual(['']);
  });
  it('requires APP_KEY and never exposes bare canonical paths or preview URLs on read', async () => {
    expect((await renderProductReplyMedia(fixture().db,[published]))[0].pics).toEqual(['']);
    expect((await renderProductReplyMedia(fixture().db,[{...published,pics:['/api/assets/1?signature=old']}],'local-review-public-key'))[0].pics).toEqual(['']);
  });
});
