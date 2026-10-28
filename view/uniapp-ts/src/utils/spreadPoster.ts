import { shareUri } from '@/utils/legacyShare';
/** Signed sources are capabilities; a generated raster must not outlive them. */
export function spreadPosterDeadline(sources:string[]):number|null {
 const deadlines:number[]=[];
 for(const source of sources){if(!source||source.startsWith('data:'))continue;try{const u=shareUri(source);if(!/^\/api\/(?:assets\/[1-9]\d*|share\/code\/image\/[a-f0-9]{24}\/(?:wechat|routine))$/u.test(u.pathname))continue;
 const raw=u.searchParams.get('expires');if(u.searchParams.getAll('expires').length===1&&/^[1-9]\d{0,12}$/u.test(raw??'')){const n=Number(raw)*1000;if(Number.isSafeInteger(n))deadlines.push(n);}}catch{}}
 return deadlines.length?Math.min(...deadlines):null;
}
/** PHP wraps invitation copy by ASCII/non-ASCII width, with at most two rows. */
export function spreadInvitation(siteName:string):string[]{
 const rows:string[]=[];let row='',width=0;
 for(const character of '邀请您加入'+siteName){const size=character.charCodeAt(0)>255?2:1;if(width+size>25){rows.push(row);row='';width=0;}row+=character;width+=size;}
 if(row)rows.push(row);return rows.length>2?[rows[0]!,rows[1]+'...']:rows;
}
export function spreadSharePath(source:string):string {
 try{const u=shareUri(source),match=/^\/api\/share\/code\/image\/([a-f0-9]{24})\/(?:wechat|routine)$/u.exec(u.pathname);return match?'/pages/share/landing?q='+match[1]:'';}catch{return '';}
}
