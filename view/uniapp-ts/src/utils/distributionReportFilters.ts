export type DistributionReportPeriod='all'|'today'|'yesterday'|'seven'|'custom';
export function shanghaiDay(now=Date.now()):string{return new Date(now+28800000).toISOString().slice(0,10);}
export function distributionDaySeconds(day:string):number {
 if(!/^\d{4}-\d{2}-\d{2}$/.test(day))throw Error('请选择有效日期');
 const stamp=Date.parse(day+'T00:00:00+08:00')/1000;
 if(!Number.isInteger(stamp)||stamp<=0||stamp+86399>2147483647||shanghaiDay(stamp*1000)!==day)throw Error('请选择1970年1月2日至2038年1月18日内的日期');
 return stamp;
}
export function distributionRange(period:Exclude<DistributionReportPeriod,'custom'>,now=Date.now()):{start:number;stop:number}{
 if(period==='all')return{start:0,stop:0};const today=distributionDaySeconds(shanghaiDay(now));
 return{start:today-(period==='yesterday'?86400:period==='seven'?6*86400:0),stop:today+(period==='yesterday'?-1:86399)};
}
export function distributionKeyword(value:string):string{const keyword=value.trim();if([...keyword].length>64||/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(keyword))throw Error('关键词最多64个字，不能含控制字符');return keyword;}
