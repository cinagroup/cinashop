import { expect, it, vi } from 'vitest';
import { dropOwnedAuditDatabase } from '../scripts/data-migration/drop-owned-audit-database';

const name='orm_audit_table_gate_0123456789abcdef0123456789abcdef';
const timeout=Object.assign(new Error('cancelled'),{code:'57014'});
it('drops only a recorded exact target once on normal success',async()=>{
  const execute=vi.fn(async()=>[]);
  expect(await dropOwnedAuditDatabase(execute,name,[name])).toEqual({timeoutRecovered:false,retried:false});
  expect(execute).toHaveBeenCalledExactlyOnceWith(`DROP DATABASE "${name}"`);
});
it.each(['postgres','orm_audit_table_gate_bad',name])('refuses unowned or malformed %s before SQL',async target=>{
  const execute=vi.fn(async()=>[]);
  await expect(dropOwnedAuditDatabase(execute,target,[])).rejects.toThrow('Unsafe audit cleanup target');
  expect(execute).not.toHaveBeenCalled();
});
it('retries once only after observing a recorded invalid database without sessions',async()=>{
  const execute=vi.fn().mockRejectedValueOnce(timeout).mockResolvedValueOnce([{datconnlimit:-2,connections:0}]).mockResolvedValueOnce([]);
  expect(await dropOwnedAuditDatabase(execute,name,[name])).toEqual({timeoutRecovered:true,retried:true});
  expect(execute).toHaveBeenCalledTimes(3);
  expect(execute.mock.calls[1][1]).toEqual([name]);
  expect(execute.mock.calls[2]).toEqual(execute.mock.calls[0]);
});
it('recognizes already-confirmed absence after cancellation without another DROP',async()=>{
  const execute=vi.fn().mockRejectedValueOnce(timeout).mockResolvedValueOnce([]);
  expect(await dropOwnedAuditDatabase(execute,name,[name])).toEqual({timeoutRecovered:true,retried:false});
  expect(execute).toHaveBeenCalledTimes(2);
});
it.each([{datconnlimit:-1,connections:0},{datconnlimit:-2,connections:1},{datconnlimit:'-2',connections:0}])('does not retry an unproven safe state %j',async state=>{
  const execute=vi.fn().mockRejectedValueOnce(timeout).mockResolvedValueOnce([state]);
  await expect(dropOwnedAuditDatabase(execute,name,[name])).rejects.toBe(timeout);
  expect(execute).toHaveBeenCalledTimes(2);
});
it('does not retry a lock or permission error',async()=>{
  const error=Object.assign(new Error('locked'),{code:'55P03'});
  const execute=vi.fn().mockRejectedValue(error);
  await expect(dropOwnedAuditDatabase(execute,name,[name])).rejects.toBe(error);
  expect(execute).toHaveBeenCalledTimes(1);
});
it('propagates a failed retry without looping',async()=>{
  const execute=vi.fn().mockRejectedValueOnce(timeout).mockResolvedValueOnce([{datconnlimit:-2,connections:0}]).mockRejectedValueOnce(timeout);
  await expect(dropOwnedAuditDatabase(execute,name,[name])).rejects.toBe(timeout);
  expect(execute).toHaveBeenCalledTimes(3);
});
