import { describe, expect, it } from 'vitest';
import { parseAdminWithdrawalDirectoryQuery as parse, withdrawalDirectoryPeriod as period,
  readAdminWithdrawalDirectoryQuery as read, parseAdminWithdrawalMediaId as mediaId,
  parseAdminWithdrawalMediaRevision as mediaRevision, readAdminWithdrawalMediaQuery as readMedia } from '@/services/admin/AdminWithdrawalDirectoryInput';
import { requiredAdminPermission } from '@/services/admin/AdminPermissionService';

const day = Date.UTC(2026, 9, 1, 16) / 1000; // Shanghai 2026/10/02 00:00
const defaults = {page:1,limit:20,status:null,extract_type:'',keyword:'',start:0,stop:0};

describe('closed additive Admin withdrawal directory input', () => {
  it('returns exact normalized scalars and preserves PHP raw keyword distinctions', () => {
    expect(parse(new URLSearchParams())).toEqual(defaults);
    for (const keyword of ['', '0', '00', '0 ', '%', '_', '汉字', '\uFFFD']) {
      expect(parse(new URLSearchParams({keyword}))).toEqual({...defaults,keyword});
    }
    expect(parse(new URLSearchParams({status:'all',extract_type:'wx',page:'1000',limit:'20'})))
      .toEqual({...defaults,page:1000,extract_type:'weixin'});
    for (const status of ['-1','0','1']) expect(parse(new URLSearchParams({status})).status).toBe(Number(status));
    expect(parse(new URLSearchParams({extract_type:'all'})).extract_type).toBe('');
    expect(parse(new URLSearchParams({keyword:'😀'.repeat(64)})).keyword).toBe('😀'.repeat(64));
  });

  it('applies equal before midnight, adds one full day inclusively, and preserves literal nonmidnight stops', () => {
    expect(period(defaults)).toEqual({start:0,stop:0,effective_stop:0,rule:'none'});
    expect(period({start:day,stop:day})).toEqual({start:day,stop:day,effective_stop:day+86400,rule:'equal-plus-day'});
    expect(period({start:day+60,stop:day+60})).toEqual({start:day+60,stop:day+60,effective_stop:day+86460,rule:'equal-plus-day'});
    expect(period({start:day,stop:day+86400})).toEqual({start:day,stop:day+86400,effective_stop:day+172800,rule:'midnight-plus-day'});
    expect(period({start:day,stop:day+60})).toEqual({start:day,stop:day+60,effective_stop:day+60,rule:'closed'});
    const maxMinute=2147483640;
    expect(period(parse(new URLSearchParams({start:String(maxMinute),stop:String(maxMinute)}))))
      .toEqual({start:maxMinute,stop:maxMinute,effective_stop:2147570040,rule:'equal-plus-day'});
  });

  it('uses actual historical Shanghai midnight instead of fixed UTC+8 and keeps explicit fold instants distinct',()=>{
    expect(period({start:581090400,stop:581094000})).toEqual({start:581090400,stop:581094000,effective_stop:581180400,rule:'midnight-plus-day'});
    expect(period({start:581090400,stop:581097600})).toEqual({start:581090400,stop:581097600,effective_stop:581097600,rule:'closed'});
    expect(period({start:589912200,stop:589915800})).toEqual({start:589912200,stop:589915800,effective_stop:589915800,rule:'closed'});
  });

  it('rejects duplicates, authority selectors, coercions, raw invalid ranges and controls', () => {
    const invalid=['page=0','page=01','page=1001','page=1.0','page=1e2','page=-1','limit=19','limit=21',
      'status=2','status=false','status=01','extract_type=WX','extract_type=wechat','uid=11','sort=id','revision=x',
      'page=1&page=1','status=0&status=1','keyword=a&keyword=b','keyword[]=x','start=0&stop=60',
      'start=60','stop=60','start=120&stop=60','start=61&stop=120','start=60&stop=2147483648',
      'keyword=%00','keyword=%0A','keyword=%7F'];
    for (const input of invalid) expect(()=>parse(new URLSearchParams(input)),input).toThrow();
    expect(()=>parse(new URLSearchParams({keyword:'😀'.repeat(65)}))).toThrow();
    // URLSearchParams converts its record input to USVString before parsing.
    // The original lone surrogate is no longer observable at this boundary.
    const repaired = new URLSearchParams({keyword:'\ud800'});
    expect(repaired.get('keyword')).toBe('\uFFFD');
    expect(parse(repaired)).toEqual({...defaults,keyword:'\uFFFD'});
  });

  it('rejects actual malformed UTF8/percent encoding and accepts encoded literal U+FFFD', () => {
    for (const query of ['keyword=%E0%A4','keyword=%FF','keyword=%C0%AF','keyword=%ED%A0%80','keyword=%','%FF=x','%']) {
      expect(()=>read(new Request('https://owned.local/adminapi/extract/directory?'+query)),query).toThrow();
    }
    expect(read(new Request('https://owned.local/adminapi/extract/directory?keyword=%EF%BF%BD'))).toEqual({...defaults,keyword:'\uFFFD'});
    expect(read(new Request('https://owned.local/adminapi/extract/directory',{method:'HEAD'}))).toEqual(defaults);
    expect(read(new Request('https://owned.local/adminapi/extract/directory',{headers:{'Content-Length':'0'}}))).toEqual(defaults);
    const invalidHeaders:Record<string,string>[]=[{'Content-Length':'1'},{'Content-Length':'00'},{'Transfer-Encoding':'chunked'}];
    for (const headers of invalidHeaders)
      expect(()=>read(new Request('https://owned.local/adminapi/extract/directory',{headers}))).toThrow();
    expect(()=>read(new Request('https://owned.local/adminapi/extract/directory',{method:'POST',body:'{}'}))).toThrow();
    expect(()=>read(new Request('https://owned.local/adminapi/extract/directory?keyword='+('a'.repeat(2048))))).toThrow();
  });

  it('admits exact GET/HEAD directory and canonical media aliases only without granting arbitrary children or writes', () => {
    for (const prefix of ['/adminapi','/api/admin']) {
      for (const method of ['GET','HEAD']) expect(requiredAdminPermission(method,prefix+'/extract/directory')).toBe('extract.view');
      for (const method of ['POST','PUT','PATCH','DELETE']) expect(requiredAdminPermission(method,prefix+'/extract/directory')).toBeNull();
      for (const id of ['1','2147483647',':id','<id>']) for (const method of ['GET','HEAD'])
        expect(requiredAdminPermission(method,prefix+'/extract/directory/'+id+'/media')).toBe('extract.view');
      for (const child of ['/1','/media','/list','/../review','/0/media','/-1/media','/01/media','/2147483648/media','/1/media/extra']) {
        for (const method of ['GET','POST']) expect(requiredAdminPermission(method,prefix+'/extract/directory'+child)).toBeNull();
      }
      for (const method of ['POST','PUT','PATCH','DELETE'])expect(requiredAdminPermission(method,prefix+'/extract/directory/1/media')).toBeNull();
      expect(requiredAdminPermission('GET',prefix+'/extract/list')).toBe('extract.view');
      expect(requiredAdminPermission('POST',prefix+'/extract/status/1')).toBe('extract.manage');
    }
  });

  it('requires exact positive media ID and one lowercase hexadecimal current revision only',()=>{
    expect(mediaId('1')).toBe(1);expect(mediaId('2147483647')).toBe(2147483647);
    for(const id of ['0','-1','01','1.0','1e2',' 1','2147483648','99999999999',':id'])expect(()=>mediaId(id),id).toThrow();
    const revision='ab'.repeat(32);expect(mediaRevision(new URLSearchParams({revision}))).toBe(revision);
    for(const input of ['', 'revision=', 'revision='+revision+'&revision='+revision,'revision='+revision+'&uid=11',
      'revision='+revision.toUpperCase(),'revision='+'a'.repeat(63),'revision='+'g'.repeat(64)])expect(()=>mediaRevision(new URLSearchParams(input)),input).toThrow();
    expect(readMedia(new Request('https://owned.local/adminapi/extract/directory/1/media?revision='+revision),'1')).toEqual({id:1,revision});
    expect(()=>readMedia(new Request('https://owned.local/adminapi/extract/directory/1/media?revision=%FF'),'1')).toThrow();
    expect(()=>readMedia(new Request('https://owned.local/adminapi/extract/directory/%31/media?revision='+revision),'1')).toThrow();
  });
});
