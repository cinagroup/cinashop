import {supplierProactiveRefundId,supplierProactiveRefundUuid} from './SupplierProactiveRefundInput';

/** user_bill.link_id is only32 characters. Keep every actor/UUID bit rather
 * than truncate the original operation or expand a mature financial column. */
export function supplierProactiveRefundApplicationNumber(actorId:number,operationId:string):string {
 const actor=supplierProactiveRefundId(actorId),hex=supplierProactiveRefundUuid(operationId).replaceAll('-','');
 const bytes=hex.match(/../g)!.map(pair=>Number.parseInt(pair,16));
 const encoded=btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
 return `SR${actor.toString(36)}_${encoded}`;
}
