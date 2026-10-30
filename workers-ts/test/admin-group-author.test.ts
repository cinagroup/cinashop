import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {createHash} from 'node:crypto';
import {systemAdmin,systemRole,systemLog,user,userGroup} from '@/models/schema';
import {AdminGroupAuthorService} from '@/services/admin/AdminGroupAuthorService';
import {AdminUserGroupService} from '@/services/admin/AdminUserGroupService';
import {groupActionHash} from '@/services/admin/AdminGroupAuthorInput';
import {groupActor,seedUserGroups} from './helpers/adminUserGroups';
import {createAdminGroupAuthorFixture} from './helpers/adminGroupAuthorFixture';
import {md5} from '@/utils/jwt';
import type {GroupAction,GroupOperation} from '../../view/common/groupAuthor';

describe('mall user group recoverable author with actual SQL and restricted privileges',()=>{
  let f:Awaited<ReturnType<typeof createAdminGroupAuthorFixture>>,service:AdminGroupAuthorService;
  beforeAll(async()=>{
    f=await createAdminGroupAuthorFixture();service=new AdminGroupAuthorService(f.container);
    vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Group author forbids provider requests'));
  },30000);
  beforeEach(async()=>{await f.reset();await seedUserGroups(f.db);await f.exec("SELECT setval('public.user_group_id_seq',100,false)");});
  afterAll(async()=>{expect(fetch).not.toHaveBeenCalled();vi.restoreAllMocks();await f?.close();},30000);
  const catalog=(id=100)=>f.asAdmin(()=>service.catalog(new URLSearchParams(),groupActor(id)));
  async function intent(operation:GroupOperation,target_id=20,payload:Record<string,unknown>={},actor_id=100):Promise<GroupAction>{
    const a={operation_id:crypto.randomUUID(),actor_id,operation,target_id,revision:(await catalog()).revision,payload};
    return {...a,payload_hash:createHash('sha256').update(JSON.stringify({domain:'user-group-author-v1',actor_id,operation_id:a.operation_id,operation,target_id,revision:a.revision,payload})).digest('hex')};
  }
  const mutate=(action:GroupAction)=>f.asAdmin(()=>service.mutate(action,groupActor(action.actor_id)));
  async function snapshot(){return {groups:await f.db.select().from(userGroup).orderBy(userGroup.id),users:await f.db.select().from(user).orderBy(user.uid),
    logs:await f.db.select().from(systemLog).orderBy(systemLog.id),receipts:Array.from(await f.db.execute(sql`SELECT * FROM public.admin_group_operation ORDER BY operation_id`))};}
  async function unchanged(run:()=>Promise<unknown>){const before=await snapshot();try{return await run();}finally{expect(await snapshot()).toEqual(before);}}

  it('reads the complete two-value catalog without xmin, user PII or authority mutations',()=>unchanged(async()=>{
    const result=await catalog(102);expect(result).toMatchObject({count:3,write_ready:true,list:[{id:30,group_name:'历史分组'},{id:20,group_name:'会员'},{id:10,group_name:'普通用户'}]});
    expect(result.revision).toMatch(/^[a-f0-9]{64}$/);expect(JSON.stringify(result)).not.toMatch(/rowVersion|account|pwd|group-user|nowMoney/);
  }));
  it('creates, edits and deletes only group rows while keeping all user facts and atomic audit history',async()=>{
    const users=(await snapshot()).users;
    const create=await intent('create',0,{group_name:' 新用户分组 '},104);expect(groupActionHash(create)).toBe(create.payload_hash);
    const made=await mutate(create);expect(made.result).toMatchObject({id:100,created:1,updated:0,count:4});
    expect((await f.db.select().from(userGroup).where(eq(userGroup.id,100)))[0]).toEqual({id:100,groupName:'新用户分组'});
    await mutate(await intent('update',100,{group_name:'新名称'},101));await mutate(await intent('delete',100,{},101));
    expect((await snapshot()).users).toEqual(users);expect((await snapshot()).groups.map(row=>row.id)).toEqual([10,20,30]);
    expect((await snapshot()).logs.map(row=>JSON.parse(row.action))).toEqual([{operation:'create',id:100},{operation:'update',id:100},{operation:'delete',id:100}]);
  });
  it('retains the existing legacy20 and modern64 contracts alongside the new author',async()=>{
    const legacy=new AdminUserGroupService(f.container);
    await expect(f.asAdmin(()=>legacy.save({group_name:'名'.repeat(21)},groupActor(100),true))).rejects.toThrow('20');
    await f.asAdmin(()=>legacy.save({group_name:'😀'.repeat(64)},groupActor(100),false));
    const result=await catalog();expect(result.list[0]!.group_name).toBe('😀'.repeat(64));
    const revision=result.revision;await mutate(await intent('update',result.list[0]!.id,{group_name:result.list[0]!.group_name}));
    expect((await catalog()).revision).toBe(revision);
  });
  it('normalizes new64-codepoint names after trimming without truncating the original hashed payload',async()=>{
    const raw='  '+'😀'.repeat(64)+'  ',a=await intent('create',0,{group_name:raw});
    const receipt=await mutate(a);expect(receipt.payload_hash).toBe(a.payload_hash);
    expect((await f.db.select().from(userGroup).where(eq(userGroup.id,receipt.result.id)))[0]!.groupName).toBe('😀'.repeat(64));
    expect(await mutate(a)).toEqual(receipt);
  });
  for(const name of ['', ' ', 'x'.repeat(65), '😀'.repeat(65), 'x\n', 'x\u0085', 'x\ud800', 'x\udfff'])it('rejects invalid new or changed name atomically '+JSON.stringify(name),async()=>{
    await unchanged(async()=>expect(mutate(await intent('create',0,{group_name:name}))).rejects.toThrow());
    await unchanged(async()=>expect(mutate(await intent('update',20,{group_name:name}))).rejects.toThrow());
  });
  for(const historical of ['', ' 历史空白 ', '旧\u0085名'])it('preserves exact historical name bytes without silent normalization '+JSON.stringify(historical),async()=>{
    await f.db.update(userGroup).set({groupName:historical}).where(eq(userGroup.id,20));const revision=(await catalog()).revision;
    await mutate(await intent('update',20,{group_name:historical}));
    expect((await f.db.select().from(userGroup).where(eq(userGroup.id,20)))[0]!.groupName).toBe(historical);expect((await catalog()).revision).toBe(revision);
    await mutate(await intent('update',20,{group_name:'明确修改'}));
  });
  it('rejects new duplicate names but permits unchanged duplicate history',async()=>{
    await unchanged(async()=>expect(mutate(await intent('create',0,{group_name:'会员'}))).rejects.toThrow('已经存在'));
    await unchanged(async()=>expect(mutate(await intent('update',20,{group_name:'普通用户'}))).rejects.toThrow('已经存在'));
    await f.db.update(userGroup).set({groupName:'会员'}).where(eq(userGroup.id,30));await mutate(await intent('update',20,{group_name:'会员'}));
  });
  for(const id of [10,30])it('refuses deletion referenced by any user, including soft-deleted users, group '+id,async()=>{
    await unchanged(async()=>expect(mutate(await intent('delete',id))).rejects.toThrow('仍有用户'));
  });
  it('rejects unknown targets rather than creating rows through update/delete',async()=>{
    for(const operation of ['update','delete'] as const)await unchanged(async()=>expect(mutate(await intent(operation,999,operation==='update'?{group_name:'不存在'}:{}))).rejects.toThrow('不存在'));
  });
  for(const extra of [{id:10},{sort:1},{status:1},{image:'x'},{color:'red'}])it('keeps the single author field and refuses extra payload '+JSON.stringify(extra),async()=>{
    await unchanged(async()=>expect(mutate(await intent('update',20,{group_name:'有效',...extra}))).rejects.toThrow());
  });
  it('validates exact action envelope, owner, UUID, hash and create/target relation before mutation',async()=>{
    const a=await intent('create',0,{group_name:'原请求'});
    for(const patch of [{actor_id:101},{operation_id:a.operation_id.toUpperCase()},{operation_id:'bad'},{payload_hash:'a'.repeat(64)},{revision:'bad'},{target_id:20},{extra:1}]){
      await unchanged(()=>expect(f.asAdmin(()=>service.mutate({...a,...patch},groupActor(100)))).rejects.toThrow());
    }
    await unchanged(async()=>expect(mutate(await intent('delete',0))).rejects.toThrow());
  });
  for(const id of [102,103,105,106,107,108])it('does not promote view/page/form/product-only role '+id+' to group writer',async()=>{
    await unchanged(async()=>expect(mutate(await intent('delete',20,{},id))).rejects.toThrow());
  });
  it('replays an exact committed UUID before stale source, without extra DML or duplicate audit',async()=>{
    const a=await intent('update',20,{group_name:'原操作'}),receipt=await mutate(a);
    await f.db.update(userGroup).set({groupName:'旁路目录变化'}).where(eq(userGroup.id,30));
    await unchanged(async()=>{expect(await mutate(a)).toEqual(receipt);expect(await f.asAdmin(()=>service.receipt(a.operation_id,new URLSearchParams(),groupActor(100)))).toEqual(receipt);});
    const changed={...a,payload:{group_name:'不同内容'}};changed.payload_hash=groupActionHash(changed);
    await unchanged(()=>expect(mutate(changed)).rejects.toThrow('标识'));
  });
  it('keeps missing receipt unknown, seals exact not_applied and refuses a late original commit',async()=>{
    const a=await intent('delete');await unchanged(()=>expect(f.asAdmin(()=>service.receipt(a.operation_id,new URLSearchParams(),groupActor(100)))).rejects.toMatchObject({code:404}));
    const receipt=await f.asAdmin(()=>service.resolve(a,groupActor(100)));expect(receipt).toMatchObject({state:'not_applied',result:{id:20,created:0,updated:0,count:0,revision:a.revision}});
    await unchanged(async()=>{expect(await f.asAdmin(()=>service.resolve(a,groupActor(100)))).toEqual(receipt);await expect(mutate(a)).rejects.toThrow('封存');});
  });
  it('allows valid original owner recovery after every role grant is withdrawn, without allowing a new commit',async()=>{
    const a=await intent('delete',20,{},101);await f.db.update(systemRole).set({rules:''}).where(eq(systemRole.id,1));
    await unchanged(()=>expect(mutate(a)).rejects.toThrow());
    const receipt=await f.asAdmin(()=>service.resolve(a,groupActor(101)));expect(receipt.state).toBe('not_applied');
    expect(await f.asAdmin(()=>service.receipt(a.operation_id,new URLSearchParams(),groupActor(101)))).toEqual(receipt);
    await unchanged(()=>expect(f.asAdmin(()=>service.receipt(a.operation_id,new URLSearchParams(),groupActor(100)))).rejects.toMatchObject({code:404}));
    await unchanged(()=>expect(f.asAdmin(()=>service.resolve(a,groupActor(100)))).rejects.toThrow());
  });
  for(const patch of [{status:0},{isDel:1},{adminType:4},{relationId:1}])it('rejects disabled/deleted/foreign-realm owner recovery '+JSON.stringify(patch),async()=>{
    const a=await intent('delete');await f.db.update(systemAdmin).set(patch).where(eq(systemAdmin.id,100));
    await unchanged(()=>expect(f.asAdmin(()=>service.resolve(a,groupActor(100)))).rejects.toThrow());
  });
  it('checks live password and expiry even for owner-only recovery',async()=>{
    const a=await intent('delete');
    for(const actor of [{...groupActor(100),expiresAt:1},{...groupActor(100),authVersion:md5('changed')}])await unchanged(()=>expect(f.asAdmin(()=>service.resolve(a,actor))).rejects.toThrow());
  });
  for(const id of [20,30])it('private full-source xmin detects restored ABA at group '+id,async()=>{
    const a=await intent('delete'),old=(await f.db.select().from(userGroup).where(eq(userGroup.id,id)))[0]!;
    await f.db.update(userGroup).set({groupName:'ABA'}).where(eq(userGroup.id,id));await f.db.update(userGroup).set({groupName:old.groupName}).where(eq(userGroup.id,id));
    await unchanged(()=>expect(mutate(a)).rejects.toMatchObject({httpStatus:409}));
  });
  for(const body of ["NEW.group_name='forged';", "IF NEW.id=20 THEN UPDATE user_group SET group_name='forged' WHERE id=30; END IF;"])it('full write readback rolls back successful-looking catalog trigger '+body,async()=>{
    await f.exec(`CREATE FUNCTION owned_group_update() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN ${body} RETURN NEW;END$$;CREATE TRIGGER owned_group_update BEFORE UPDATE ON user_group FOR EACH ROW EXECUTE FUNCTION owned_group_update()`);
    try{await unchanged(async()=>expect(mutate(await intent('update',20,{group_name:'目标新名'}))).rejects.toThrow('回读'));}
    finally{await f.exec('DROP TRIGGER owned_group_update ON user_group;DROP FUNCTION owned_group_update()');}
  });
  it('rejects changed INSERT RETURNING values and a skipped DELETE with complete rollback',async()=>{
    await f.exec("CREATE FUNCTION owned_group_insert() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.group_name='forged';RETURN NEW;END$$;CREATE TRIGGER owned_group_insert BEFORE INSERT ON user_group FOR EACH ROW EXECUTE FUNCTION owned_group_insert()");
    try{await unchanged(async()=>expect(mutate(await intent('create',0,{group_name:'原插入'}))).rejects.toThrow('回读'));}
    finally{await f.exec('DROP TRIGGER owned_group_insert ON user_group;DROP FUNCTION owned_group_insert()');}
    await f.exec('CREATE FUNCTION owned_group_delete() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NULL;END$$;CREATE TRIGGER owned_group_delete BEFORE DELETE ON user_group FOR EACH ROW EXECUTE FUNCTION owned_group_delete()');
    try{await unchanged(async()=>expect(mutate(await intent('delete'))).rejects.toThrow('回读'));}
    finally{await f.exec('DROP TRIGGER owned_group_delete ON user_group;DROP FUNCTION owned_group_delete()');}
  });
  it('rolls back group writes and receipts when the existing audit cannot be inserted',async()=>{
    await f.exec("CREATE FUNCTION owned_group_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'audit refused';END$$;CREATE TRIGGER owned_group_audit BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION owned_group_audit()");
    try{for(const op of ['create','update','delete'] as const)await unchanged(async()=>expect(mutate(await intent(op,op==='create'?0:20,op==='delete'?{}:{group_name:'审计拒绝'}))).rejects.toThrow());}
    finally{await f.exec('DROP TRIGGER owned_group_audit ON system_log;DROP FUNCTION owned_group_audit()');}
  });
  it('rolls back the successful group and audit when a receipt trigger returns contradictory evidence',async()=>{
    await f.exec("CREATE FUNCTION owned_group_receipt() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.result='{}'::jsonb;RETURN NEW;END$$;CREATE TRIGGER owned_group_receipt BEFORE INSERT ON admin_group_operation FOR EACH ROW EXECUTE FUNCTION owned_group_receipt()");
    try{await unchanged(async()=>expect(mutate(await intent('update',20,{group_name:'回执失败'}))).rejects.toThrow());}
    finally{await f.exec('DROP TRIGGER owned_group_receipt ON admin_group_operation;DROP FUNCTION owned_group_receipt()');}
  });
  it('refuses unreviewed source columns and duplicate query keys instead of dropping input',async()=>{
    for(const query of ['page=1','id=20&id=30'])await expect(f.asAdmin(()=>service.catalog(new URLSearchParams(query),groupActor(100)))).rejects.toThrow();
    await f.exec('ALTER TABLE user_group ADD COLUMN unreviewed integer NOT NULL DEFAULT 1');
    try{await expect(catalog()).rejects.toMatchObject({code:503});}finally{await f.exec('ALTER TABLE user_group DROP COLUMN unreviewed');}
  });
  it('shows an unavailable author and writes nothing when immutable addon ACL drifts',async()=>{
    await f.exec(`GRANT UPDATE ON public.admin_group_operation TO ${f.names.admin}`);
    try{expect((await catalog()).write_ready).toBe(false);await unchanged(async()=>expect(mutate(await intent('delete'))).rejects.toMatchObject({code:503}));}
    finally{await f.exec(`REVOKE UPDATE ON public.admin_group_operation FROM ${f.names.admin}`);}
  });
  it('bounds the complete catalog without truncation and permits existing maintenance at20000',async()=>{
    await f.exec('INSERT INTO user_group(id) SELECT n FROM generate_series(1000,20996) n');expect((await catalog()).count).toBe(20000);
    await unchanged(async()=>expect(mutate(await intent('create',0,{group_name:'不能截断新增'}))).rejects.toThrow('20000'));
    await mutate(await intent('update',20,{group_name:'容量满仍可编辑'}));await f.db.insert(userGroup).values({id:22000,groupName:'多一项'});
    await expect(catalog()).rejects.toMatchObject({code:503});
  },30000);
});
