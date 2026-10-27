import { ValidateException } from '@/utils/errors';
const zone=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
const parts=(stamp:number)=>{const p=Object.fromEntries(zone.formatToParts(new Date(stamp*1000)).map(v=>[v.type,v.value]));return[p.year,p.month,p.day,p.hour,p.minute,p.second].map(Number);};
/** A date is a unique Shanghai midnight, including historical DST/LMT. Reject
 * missing/repeated wall times instead of guessing a host or fixed UTC offset. */
export function profileBirthdayParse(value:string):number{
  if(value==='')return 0;const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(value);if(!m)throw new ValidateException('生日格式错误');
  const y=Number(m[1]),month=Number(m[2]),day=Number(m[3]),wall=Date.UTC(y,month-1,day),d=new Date(wall);
  if(y<1900||y>2038||d.getUTCFullYear()!==y||d.getUTCMonth()!==month-1||d.getUTCDate()!==day)throw new ValidateException('生日格式错误');
  const offsets=new Set<number>();
  for(const hour of [-48,-24,-12,0,12,24,48]){const at=wall/1000+hour*3600,p=parts(at);offsets.add(Date.UTC(p[0]!,p[1]!-1,p[2]!,p[3]!,p[4]!,p[5]!)/1000-at);}
  const candidates=[...offsets].map(offset=>wall/1000-offset).filter(at=>{const p=parts(at);return p[0]===y&&p[1]===month&&p[2]===day&&p[3]===0&&p[4]===0&&p[5]===0;});
  if(candidates.length!==1||!Number.isSafeInteger(candidates[0])||candidates[0]!< -2147483648||candidates[0]!>2147483647)throw new ValidateException('生日不是可唯一保存的北京时间日期');
  return candidates[0]!;
}
export function profileBirthdayText(stamp:number):string{if(stamp===0)return '';const p=parts(stamp);return`${p[0]}-${String(p[1]).padStart(2,'0')}-${String(p[2]).padStart(2,'0')}`;}
