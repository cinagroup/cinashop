import {expect,it} from 'vitest';
import {parseSupplierBillDates,parseSupplierBillGroupQuery,parseSupplierBillDetailQuery} from '@/services/supplier/SupplierBillReadService';
const epoch=(value:string)=>Math.floor(Date.parse(value)/1000),now=epoch('2026-10-17T12:34:56+08:00');
it.each([
 ['today','2026-10-17T00:00:00+08:00','2026-10-17T23:59:59+08:00'],
 ['yesterday','2026-10-16T00:00:00+08:00','2026-10-16T23:59:59+08:00'],
 ['week','2026-10-12T00:00:00+08:00','2026-10-18T23:59:59+08:00'],
 ['last week','2026-10-05T00:00:00+08:00','2026-10-11T23:59:59+08:00'],
 ['month','2026-10-01T00:00:00+08:00','2026-10-31T23:59:59+08:00'],
 ['last month','2026-09-01T00:00:00+08:00','2026-09-30T23:59:59+08:00'],
 ['year','2026-01-01T00:00:00+08:00','2026-12-31T23:59:59+08:00'],
 ['last year','2025-01-01T00:00:00+08:00','2025-12-31T23:59:59+08:00'],
 ['quarter','2026-10-01T00:00:00+08:00','2026-12-31T00:00:00+08:00'],
 ['lately7','2026-10-10T12:34:56+08:00','2026-10-17T12:34:56+08:00'],
 ['lately30','2026-09-17T12:34:56+08:00','2026-10-17T12:34:56+08:00'],
])('preserves the actual PHP %s clock boundaries',(data,from,to)=>{
 expect(parseSupplierBillDates(data,now)).toEqual({data,start:epoch(from),end:epoch(to)});
});
it('keeps inclusive midnight/equal boundaries, ISO input and open legacy ranges explicit',()=>{
 expect(parseSupplierBillDates('2026/09/01-2026/09/01')).toMatchObject({start:epoch('2026-09-01T00:00:00+08:00'),end:epoch('2026-09-02T00:00:00+08:00')});
 expect(parseSupplierBillDates('2026/09/01 12:00:00-2026/09/01 12:00:00')).toMatchObject({end:epoch('2026-09-02T12:00:00+08:00')});
 expect(parseSupplierBillDates('2026-09-01-2026-09-02')).toMatchObject({end:epoch('2026-09-03T00:00:00+08:00')});
 expect(parseSupplierBillDates('2026/09/01-')).toMatchObject({start:epoch('2026-09-01T00:00:00+08:00'),end:null});
 expect(parseSupplierBillDates('-2026/09/01')).toMatchObject({start:null,end:epoch('2026-09-01T23:59:59+08:00')});
});
it.each(['2026/02/30-2026/03/01','2026/10/18-2026/10/17','2020/01/01-2026/01/01','2039/01/01-2039/01/02','not-a-date','-'])('rejects malformed or unbounded closed dates %s',data=>{
 expect(()=>parseSupplierBillDates(data,now)).toThrow();
});
it('separates modern period selectors from the complete bounded legacy identity list',()=>{
 expect(parseSupplierBillGroupQuery({selection:'period',timeType:'week',status:'0',page:'2',limit:'100'})).toMatchObject({selection:'period',status:'0',offset:100});
 expect(parseSupplierBillDetailQuery({ids:'1, 2,1',keyword:' Alice ',staff_id:''})).toMatchObject({selection:'ids',ids:[1,2],keyword:'Alice'});
 expect(parseSupplierBillDetailQuery({selection:'period',period:'1970-01-01'})).toMatchObject({period:'1970-01-01',ids:[]});
 expect(parseSupplierBillDetailQuery({selection:'period',period:'2021-00',timeType:'week'})).toMatchObject({period:'2021-00'});
 expect(parseSupplierBillDetailQuery({selection:'period',period:'2026-09',timeType:'month',page:'101',limit:'100'})).toMatchObject({offset:10000});
});
it.each([
 {supplier_id:'8'},{status:'2'},{timeType:'quarter'},{selection:'anything'},{limit:'101'},{page:'2147483647',limit:'100'},
])('rejects an unsupported group query %j',query=>expect(()=>parseSupplierBillGroupQuery(query)).toThrow());
it.each([
 {selection:'period',period:'2026-09-01',ids:'1'}, {selection:'period',period:'2026-02-30'},
 {selection:'period',period:'2026-54',timeType:'week'}, {ids:'0'}, {ids:'1,,2'}, {ids:'1',staff_id:'21'},
 {ids:'1',keyword:'\u0000'}, {ids:'1',supplier_id:'8'}, {ids:Array.from({length:1001},(_,i)=>String(i+1)).join(',')},
])('rejects ambiguous, malformed or excessive detail selection %j',query=>expect(()=>parseSupplierBillDetailQuery(query)).toThrow());
