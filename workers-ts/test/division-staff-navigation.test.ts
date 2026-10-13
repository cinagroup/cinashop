import { describe, expect, it } from 'vitest';
import { resolveRegisteredPageRoute, REGISTERED_PAGE_ROUTES } from '../../view/uniapp-ts/src/config/navigation';
describe('real registered employee invite navigation keeps the old no-invitation destination', () => {
  const old='/pages/users/user_spread_user/index';
  it('registers the new binding page while ordinary commission navigation stays unchanged',()=>{
    expect(REGISTERED_PAGE_ROUTES.has('/pages/users/agent/bind')).toBe(true);
    expect(resolveRegisteredPageRoute(old)).toBe('/pages/user/finance');
    expect(resolveRegisteredPageRoute(old,'from=menu')).toBe('/pages/user/finance?from=menu');
  });
  it('preserves genuine old QR row and expected agent ID rather than treating either as a UID authority',()=>{
    expect(resolveRegisteredPageRoute(old,'scene=id%3D9007%26spid%3D77')).toBe('/pages/users/agent/bind?id=9007&spid=77');
    expect(resolveRegisteredPageRoute(old,'scene=9007')).toBe('/pages/users/agent/bind?id=9007');
  });
  it('keeps the distinct modern QR and original H5 agent contracts',()=>{
    expect(resolveRegisteredPageRoute(old,'a=9007')).toBe('/pages/users/agent/bind?a=9007');
    expect(resolveRegisteredPageRoute(old,'agent_id=77')).toBe('/pages/users/agent/bind?agent_id=77');
  });
  it('rejects mixed, duplicated, malformed and unbounded invitation parameters',()=>{
    for(const query of ['agent_id=77&a=9007','id=9007&id=9008','scene=%ZZ','scene=9007&spid=77','a=0','a=9007&extra=77',`scene=${'9'.repeat(1030)}`]) expect(resolveRegisteredPageRoute(old,query)).toBe('');
  });
});
