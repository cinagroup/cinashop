import {expect,it} from 'vitest';
import {parseSupplierBillExportQuery,supplierBillExportAmount,supplierBillExportBudget,supplierBillExportText,
 SUPPLIER_BILL_EXPORT_BYTES,SUPPLIER_BILL_EXPORT_MILLISECONDS,supplierBillExportHeader,supplierBillExportFilekey} from '@/services/supplier/SupplierBillExportService';
const base={selection:'period',period:'2026-09-04'};
it('selects the complete period without client paging, ids or a keyword subset',()=>{
 expect(parseSupplierBillExportQuery(base)).toMatchObject({selection:'period',period:'2026-09-04',status:'',data:'',timeType:'day',ids:[],keyword:''});
 expect(supplierBillExportHeader).toEqual(['交易单号','关联订单','交易时间','交易金额','支出收入','交易人','交易类型','支付方式']);
 expect(supplierBillExportFilekey).toEqual(['order_id','link_id','trade_time','number','pm','user_nickname','type_name','pay_type_name']);
});
it.each([
 {page:'1'},{limit:'1000'},{ids:'1,2'},{keyword:'Alice'},{supplier_id:'8'},{staff_id:'21'},
 {selection:'ids'},{selection:''},{timeType:'quarter'},{status:'2'},{period:'2026-02-30'},
 {timeType:'week',period:'2026-54'},{timeType:'month',period:'2026-13'},{data:'2026/02/30-2026/03/01'},
])('rejects partial or ambiguous export parameters %j',changes=>expect(()=>parseSupplierBillExportQuery({...base,...changes})).toThrow());
it('preserves the mature settled/date/week00/53 query basis and open PHP dates',()=>{
 expect(parseSupplierBillExportQuery({...base,status:'1',data:'2026/09/01-2026/09/01'})).toMatchObject({status:'1',start:1788192000,end:1788278400});
 for(const period of ['2021-00','2020-53'])expect(parseSupplierBillExportQuery({...base,timeType:'week',period})).toMatchObject({timeType:'week',period});
 expect(parseSupplierBillExportQuery({...base,timeType:'month',period:'2026-09',data:'2026/09/01-'})).toMatchObject({end:null});
});
it.each(['0.00','-0.01','999999999999999999.99','-999999999999999999.99'])('keeps signed exact amount %s',value=>expect(supplierBillExportAmount(value)).toBe(value));
it.each(['01.00','1.0','1e2','NaN','-0.00','1000000000000000000.00'])('rejects noncanonical or overflowing amount %s',value=>expect(()=>supplierBillExportAmount(value)).toThrow());
it.each(['=1+1',' +SUM(A1:A2)','\t@DDE','-HYPERLINK("owned")','\u00a0=1'])('neutralizes formula-prefixed text %s',value=>expect(supplierBillExportText(value)).toBe("'"+value));
it('keeps ordinary UTF8 intact and rejects invisible controls instead of creating a partial file',()=>{
 expect(supplierBillExportText('交易 买家')).toBe('交易 买家');expect(supplierBillExportText('ordinary')).toBe('ordinary');
 expect(()=>supplierBillExportText('bad\u0000text')).toThrow();expect(()=>supplierBillExportText('too long',3)).toThrow();
});
it('accepts the exact byte/deadline boundary and rejects the first excess without a row-count cutoff',()=>{
 expect(()=>supplierBillExportBudget(SUPPLIER_BILL_EXPORT_BYTES,1000,1000+SUPPLIER_BILL_EXPORT_MILLISECONDS)).not.toThrow();
 expect(()=>supplierBillExportBudget(SUPPLIER_BILL_EXPORT_BYTES+1,1000,1000)).toThrow('16MiB');
 expect(()=>supplierBillExportBudget(10005,1000,1001)).not.toThrow();
 expect(()=>supplierBillExportBudget(0,1000,1001+SUPPLIER_BILL_EXPORT_MILLISECONDS)).toThrow('事务时间预算');
 expect(()=>supplierBillExportBudget(0,1000,999)).toThrow();
});
