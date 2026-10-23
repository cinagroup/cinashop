import { canonicalDiyPresentationReference, diyPresentationHtmlMediaReferences, mapDiyPresentationHtmlMedia, sanitizeDiyPresentationHtml, type DiyPresentationMediaKind } from '../../../../view/common/diyPresentationHtml';
import { publicDiyPresentationVideos, publicDiyPresentationImages } from './DiyPresentationVideoPolicy';
import type { DbClient } from '@/lib/di';
import { publicProductPictures, renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { ValidateException } from '@/utils/errors';
import { canonicalizePublishedAttachmentReference } from './ArticleContentPolicy';
import { canonicalDiyPageBackground, signDiyPageBackground } from './DiyPageAppearancePolicy';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | null => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null;
export const DIY_FOOTER_MEDIA_SLOT_LIMIT = 20_000;
export const DIY_PRESENTATION_MEDIA_SLOT_LIMIT = 20_000;
export const DIY_CUSTOMER_SERVICE_MEDIA_SLOT_LIMIT = 20_000;

/** Editorial, carousel and navigation components expose only these authored image slots.
 * Navigation URLs, preview rows, neighboring components and arbitrary
 * schema strings never acquire an attachment signature. The shared policy
 * verifies the current platform owner, raster type, object key and MIME before
 * signing; historical tickets are canonicalized and refreshed only in output. */
function editorialMediaSlots(components: unknown[], publication = false, page?: RecordValue) {
  const slots: Array<{ value: string; kind?: DiyPresentationMediaKind | 'page-background'; set: (value: string) => void }> = [];
  const counts = { ordinary: 0, navigation: 0, footer: 0, presentation: 0, customerService: 0 };
  const htmlGroups: Array<{owner: RecordValue; source: string; slots: number[]}> = [];
  const collect = (value: unknown, key: string, navigation = false) => {
    const owner = record(value);
    if (!owner || typeof owner[key] !== 'string') return;
    slots.push({ value: owner[key], set: value => { owner[key] = value; } });
    // The UI accepts 200 components, including homeComb's ten Admin-authored
    // slides plus logo (2200 slots). Legacy carousels can contain more than ten
    // slides, so preserve their complete list within an explicit total budget.
    // Reject oversize output/save rather than silently sign a partial schema.
    // Navigation's separate budget covers 200 UI components with all 100
    // Admin-authored menu entries. Retain the previous editorial/carousel
    // capacity contract, including its atomic 2501-slot rejection.
    counts[navigation ? 'navigation' : 'ordinary']++;
  };
  for (const value of components) {
    const component = record(value);
    if (!component) continue;
    if (typeof component.name === 'string' && component.name.toLowerCase() === 'pagefoot') {
      const list = component.menuList;
      if (Array.isArray(list)) for (const item of list) {
        const images = record(item)?.imgList;
        if (!Array.isArray(images)) continue;
        // These two actual array positions are the selected/unselected icons.
        // An object with numeric keys, later indices, links and previews are
        // never image authority. Imported lists remain complete, not sliced.
        for (const index of [0, 1]) if (typeof images[index] === 'string') {
          slots.push({ value: images[index], set: value => { images[index] = value; } });
          counts.footer++;
        }
      }
    }
    else if (component.name === 'customerService') {
      const owner = record(component.logoConfig);
      if (owner && typeof owner.url === 'string') {
        slots.push({value: owner.url, kind: 'image', set: value => { owner.url = value; }});
        counts.customerService++;
      }
      // The authored destination and Admin preview fields are never media slots.
    }
    else if (component.name === 'videos') {
      for(const [key,kind] of [['videoConfig','video'],['imgConfig','image']] as const){
        const owner=record(component[key]);if(!owner||typeof owner.url!=='string')continue;
        slots.push({value:owner.url,kind,set:value=>{owner.url=value;}});counts.presentation++;
      }
    }
    else if (component.name === 'richText') {
      const owner=record(component.richText);if(!owner||typeof owner.val!=='string')continue;
      let source=owner.val;
      let refs: ReturnType<typeof diyPresentationHtmlMediaReferences>;
      try{if(publication)source=sanitizeDiyPresentationHtml(source);refs=diyPresentationHtmlMediaReferences(source);}catch(reason){throw new ValidateException(reason instanceof Error?reason.message:'DIY富文本格式错误');}
      const group={owner,source,slots:[] as number[]};htmlGroups.push(group);
      for(const ref of refs){group.slots.push(slots.length);slots.push({value:ref.value,kind:ref.kind,set:()=>{}});counts.presentation++;}
    }
    else if (component.name === 'news') collect(component.imgConfig, 'url');
    else if (component.name === 'hotspot') collect(component.picStyle, 'url');
    else if (component.name === 'follow') { collect(component.imgConfig, 'url'); collect(component.codeConfig, 'url'); }
    else if (component.name === 'activeParty') {
      const list = record(component.menuConfig)?.list;
      if (Array.isArray(list)) for (const item of list.slice(0, 4)) collect(item, 'img');
    }
    else if (component.name === 'swipers' || component.name === 'swiperBg' || component.name === 'homeComb') {
      const list = record(component.swiperConfig)?.list;
      if (Array.isArray(list)) for (const item of list) collect(item, 'img');
      if (component.name === 'homeComb') collect(component.logoConfig, 'url');
      // homeComb's blurred background is derived from the selected slide.
      // Its tabs contain text/typed destinations only, not another image slot.
    }
    else if (component.name === 'headerSerch') collect(component.logoConfig, 'url', true);
    else if (component.name === 'menus') {
      const list = record(component.menuConfig)?.list;
      if (Array.isArray(list)) for (const item of list) collect(item, 'img', true);
    }
    else if (component.name === 'pictureCube') {
      const picture = record(component.picStyle);
      if (Array.isArray(picture?.picList)) for (const item of picture.picList) collect(item, 'image', true);
      const style = record(component.styleConfig)?.tabVal;
      if ((style === 11 || style === '11') && Array.isArray(picture?.docPicList)) {
        for (const item of picture.docPicList) collect(item, 'img', true);
      }
      // menuConfig is the Admin picker bridge. Non-custom docPicList rows,
      // links and similarly named neighboring fields are not public slots.
    }
    // goodList and articleList receive their real media from their independent
    // product/article APIs. Their Admin preview rows are not public authority.
  }
  // Row metadata has exactly one separate image slot. It is not a component,
  // and cannot consume or enlarge any existing family budget. Its JSON grammar
  // is deliberately separate from the legacy article attribute decoder.
  if (page) {
    let background = '';
    try { background = canonicalDiyPageBackground(page.bg_pic); } catch { /* Invalid imported row backgrounds are unavailable in the public projection. */ }
    slots.push({ value: background, kind: 'page-background', set: value => { page.bg_pic = value; } });
  }
  // Collect first, reject before any canonical mutation, database owner lookup
  // or signature. The footer's independent budget cannot consume a previously
  // valid full editorial/carousel or navigation budget.
  if (counts.ordinary > 2500 || counts.navigation > 20000 || counts.footer > DIY_FOOTER_MEDIA_SLOT_LIMIT || counts.presentation > DIY_PRESENTATION_MEDIA_SLOT_LIMIT || counts.customerService > DIY_CUSTOMER_SERVICE_MEDIA_SLOT_LIMIT) {
    throw new ValidateException('DIY公开素材超过完整读取容量');
  }
  return {slots, htmlGroups};
}

/** Local relative asset references only. The shared rule never treats an
 * arbitrary foreign HTTPS /api/assets path as a platform attachment. */
function commitMedia(collection: ReturnType<typeof editorialMediaSlots>, values: string[], publication = false) {
  const html=collection.htmlGroups.map(group=>{const mapped=mapDiyPresentationHtmlMedia(group.source,(_ref,_kind,index)=>values[group.slots[index]!]!);return {owner:group.owner,value:publication?sanitizeDiyPresentationHtml(mapped):mapped};});
  collection.slots.forEach((slot,index)=>slot.set(values[index]!));
  html.forEach(item=>{item.owner.val=item.value;});
}
export function canonicalizeDiyEditorialMedia(components: unknown[]): void {
  const collection=editorialMediaSlots(components);
  commitMedia(collection,collection.slots.map(slot=>slot.kind?canonicalDiyPresentationReference(slot.value):canonicalizePublishedAttachmentReference(slot.value)));
}

export async function renderDiyEditorialMedia(db: Pick<DbClient, 'select'>, appKey: string | undefined, components: unknown[], page?: RecordValue): Promise<void> {
  const collection=editorialMediaSlots(components,true,page), {slots}=collection;
  if(!slots.length){commitMedia(collection,[],true);return;}
  // Kind belongs to the actual slot, never to client-supplied file metadata.
  const resolved=new Map<string,string>();
  for(const kind of ['legacy-image','image','video','page-background'] as const){
    const authored=[...new Set(slots.filter(slot=>(slot.kind??'legacy-image')===kind).map(slot=>slot.value))];
    for(let i=0;i<authored.length;i+=10000){const batch=authored.slice(i,i+10000);
      const approved=kind==='video'?await publicDiyPresentationVideos(db,batch):kind==='image'||kind==='page-background'?await publicDiyPresentationImages(db,batch):await publicProductPictures(db,batch.map(image=>({image,type:0,relationId:0})));
      batch.forEach((reference,index)=>resolved.set(kind+'\n'+reference,approved[index]!));
    }
  }
  // Every family retains its own budget; adding a service icon cannot consume
  // an already valid editorial, navigation, footer or presentation allowance.
  // Resolve all owners first, then bounded HMAC batches, then one atomic commit.
  const approved=[...new Set([...resolved].filter(([key])=>!key.startsWith('page-background\n')).map(([,value])=>value))],rendered=new Map<string,string>();
  for(let i=0;i<approved.length;i+=256){const batch=approved.slice(i,i+256),values=await renderProductPictures(appKey,batch);batch.forEach((ref,index)=>rendered.set(ref,values[index]!));}
  const backgroundSlot=slots.find(slot=>slot.kind==='page-background');
  const background=backgroundSlot?await signDiyPageBackground(appKey,resolved.get('page-background\n'+backgroundSlot.value)??''):'';
  commitMedia(collection,slots.map(slot=>slot.kind==='page-background'?background:rendered.get(resolved.get((slot.kind??'legacy-image')+'\n'+slot.value)!)!),true);
}
