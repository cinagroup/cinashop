import { API_BASE } from '@/utils/request';
import { buyerReviewImageSource } from '../../../common/buyerReview';
/** Display transport only: canonical references in drafts and SQL stay unchanged. */
export function reviewImageSource(value:unknown):string {
  try {const source=buyerReviewImageSource(value);return source.startsWith('/api/assets/')?API_BASE+source:source;} catch {return '';}
}
export function reviewImagePreview(images:readonly string[],current:string):{urls:string[];current:string}|null {
  if(!images.includes(current))return null;const selected=reviewImageSource(current),urls=images.map(reviewImageSource).filter(Boolean);
  return selected&&urls.includes(selected)?{urls,current:selected}:null;
}
