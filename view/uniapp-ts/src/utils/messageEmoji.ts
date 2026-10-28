import {messageEmojiPositions} from './messageEmojiPositions';
export type MessageSegment={kind:'text';text:string}|{kind:'emoji';name:string;marker:string;position:string};
/** The single-line preview needs only a bounded prefix; full chat text is untouched. */
export function messagePreviewSegments(value:string):MessageSegment[]{
 const points=Array.from(value),text=points.slice(0,512).join('')+(points.length>512?'…':''),segments:MessageSegment[]=[];
 const marker=/\[em-([a-z_]*)\]/gu;let cursor=0;
 for(const match of text.matchAll(marker)){const start=match.index!,position=messageEmojiPositions[match[1]!];if(typeof position!=='string')continue;if(start>cursor)segments.push({kind:'text',text:text.slice(cursor,start)});segments.push({kind:'emoji',name:match[1]!,marker:match[0],position});cursor=start+match[0].length;}
 if(cursor<text.length)segments.push({kind:'text',text:text.slice(cursor)});return segments;
}

/** A 41-cell sprite at 22px per cell; CSS percentages range across the 40-cell travel. */
export function messageEmojiSheetStyle(position:string):{left:string;top:string}{
 const match=/^(\d+(?:\.\d+)?)% (\d+(?:\.\d+)?)%$/u.exec(position);
 if(!match||Number(match[1])>100||Number(match[2])>100)throw new RangeError('Invalid fixed emoji position');
 return{left:(-880*Number(match[1])/100)+'px',top:(-880*Number(match[2])/100)+'px'};
}
