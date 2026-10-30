import { expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createApp } from '@/app';
import { eq } from 'drizzle-orm';
import { systemRole } from '@/models/schema';
import type { Container } from '@/lib/di';
import { OwnedFixedLengthStream } from '../helpers/adminProductVideoUpload';
import { diyStateAuthorFixture, expectedStateRootEdit, expectedStateAlternateEdit, expectedStateMicroEdit, DIY_STATE_AUTHOR_NAMES } from '../helpers/diyStateAuthorFixture';
import { stateAuthorObserver } from '../helpers/diyStateAuthorObserver';
import { isNavigationAuthorBodyDisconnect, readNavigationAuthorBody as body, sendNavigationAuthorResponse } from '../helpers/diyNavigationAuthorTransport';
import { sortedDiyState, stableDiyState, type DiyStateRow as Row, type DiyStateSnapshot } from '../helpers/diyStateFixture';
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Missing owned state author SQL'); return wiring.container; },
  createAdminDatabaseSession: () => { if (!wiring.container) throw Error('Missing owned state author Admin SQL'); return { container: wiring.container, close: async () => {} }; } }));
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => hash(stableDiyState(value));
async function files(directory: string): Promise<string[]> { return (await Promise.all((await readdir(directory, { withFileTypes: true })).map(row => row.isDirectory() ? files(resolve(directory, row.name)) : [resolve(directory, row.name)]))).flat().sort(); }

it('actual complete state author controls, three GUI saves and anonymous built H5 on owned PG16', async () => {
  vi.stubGlobal('FixedLengthStream', OwnedFixedLengthStream);
  const f = await diyStateAuthorFixture(new Date(), { namespace: 'public' }); wiring.container = f.container;
  const app = createApp(), repository = resolve(import.meta.dirname, '../../..'), origin = 'http://127.0.0.1:40785';
  const control = '/__state-author/' + randomUUID(), prefix = '/tmp/cinashop-diy-state-author-browser-';
  const h5 = resolve(repository, 'view/uniapp-ts/dist/build/h5'), admin = resolve(repository, 'view/admin-ts/dist');
  const plans = ['admin','minimal','reader','revoked','rootOpen','builtin','latePending','lateClosed','lateReleased','rootEdited','rootSaved','rootH5','alternateOpen','alternateEdited','alternateSaved','alternateH5','user11','user22','guest','microOpen','microNoop','microEdited','microSaved','microH5','finished'];
  const evidence: Row[] = [], traces: Row[] = [], setup: Row[] = [], writes: Row[] = [], transport: Row[] = [], staticPaths: Row[] = [], servedHtml: Row[] = [];
  const snapshots: Record<string, DiyStateSnapshot> = {}, remember = (value: DiyStateSnapshot) => { const id = digest(value); snapshots[id] ??= structuredClone(value); return id; };
  const initialRoot = f.rootBlocks, initialMicro = f.microBlocks, editedRoot = expectedStateRootEdit(f), alternateRoot = expectedStateAlternateEdit(f), editedMicro = expectedStateMicroEdit(f);
  let expected = await f.snapshot(), sourceBefore: Row[] = [], h5Before: Row[] = [], adminBefore: Row[] = [], server: Server | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let alternateFrameEpoch = -1, microFrameEpoch = -1, minimalRevoked = false;
  let pending = 0, businessSave = 0, failure: unknown, lastObservation: Row | undefined, holdGallery = false;
  const held: Array<{ res: ServerResponse; release: () => void; trace: Row }> = [];
  const resources = () => f.resources(), initialResources = resources(), stage = () => plans[evidence.length]; remember(expected);
  let done!: () => void, fail!: (reason: Error) => void; const completion = new Promise<void>((yes, no) => { done = yes; fail = no; }); completion.catch(() => {});
  let queue = Promise.resolve(); function serial<T>(fn: () => Promise<T>) { const next = queue.then(fn); queue = next.then(() => {}, () => {}); return next; }
  const external = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned state author acceptance forbids external provider I/O'));
  const row = (id: number) => expected.system_dise.find(item => item.id === id)!;
  const send = (res: ServerResponse, value: string | Uint8Array, status = 200, type = 'text/html') => sendNavigationAuthorResponse(res, value, status, type, () => {
    transport.push({ kind: 'actual-client-disconnect', phase: 'response', method: res.req.method, path: res.req.url, request_aborted: res.req.aborted, response_destroyed: res.destroyed });
  });
  const json = (res: ServerResponse, value: unknown, status = 200) => send(res, JSON.stringify(value), status, 'application/json');
  const sources = async () => {
    const selected = ['workers-ts/test/browser/diy-state-author.acceptance.ts', 'workers-ts/vitest.diy-state-author-browser.config.ts', 'workers-ts/scripts/run-local-finance-postgres.mjs', 'workers-ts/package.json', 'workers-ts/package-lock.json', 'workers-ts/test/fixtures/diy-state-author-defaults.json', 'workers-ts/test/fixtures/diy-navigation-author-defaults.json', 'workers-ts/test/fixtures/community-teal.png', 'view/admin-ts/public/static/images/diy/ranking.png', 'view/uniapp-ts/package.json', 'view/uniapp-ts/package-lock.json', 'view/admin-ts/package.json', 'view/admin-ts/package-lock.json'];
    const all = [...selected.map(path => resolve(repository, path)), ...await files(resolve(repository, 'workers-ts/src')), ...await files(resolve(repository, 'workers-ts/test/helpers')), ...await files(resolve(repository, 'view/admin-ts/src')), ...await files(resolve(repository, 'view/uniapp-ts/src')), ...await files(resolve(repository, 'view/common'))];
    return Promise.all([...new Set(all)].sort().map(async path => ({ path: path.slice(repository.length + 1), sha256: hash(await readFile(path)) })));
  };
  const artifacts = async (directory: string) => Promise.all((await files(directory)).map(async path => ({ path: path.slice(directory.length + 1), sha256: hash(await readFile(path)) })));
  async function dispatch(path: string, method = 'GET', raw?: Buffer, incoming?: IncomingMessage, token?: string) {
    const headers = new Headers(); if (incoming) for (let i = 0; i < incoming.rawHeaders.length; i += 2) headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
    if (token) headers.set('Authori-zation', 'Bearer ' + token); if (raw?.length) headers.set('Content-Type', 'application/json');
    const waits: Promise<unknown>[] = [], response = await app.fetch(new Request('https://127.0.0.1:40785' + path, { method, headers, ...(raw?.length ? { body: raw } : {}) }), f.env,
      { waitUntil: (promise: Promise<unknown>) => { waits.push(promise); }, passThroughOnException() {} } as unknown as ExecutionContext);
    await Promise.all(waits); const bytes = Buffer.from(await response.arrayBuffer());
    return { response, bytes, payload: response.headers.get('Content-Type')?.includes('application/json') ? JSON.parse(bytes.toString()) as Row : undefined };
  }
  async function measured(path: string, token: string | undefined, label: string, wanted: number) {
    const before = await f.snapshot(), beforeResources = resources(), result = await dispatch(path, 'GET', undefined, undefined, token), after = await f.snapshot();
    expect(result.payload?.status ?? result.response.status).toBe(wanted); expect(after).toEqual(before); expect(resources()).toEqual(beforeResources);
    traces.push({ path: path.split('?')[0], query: new URL(path, origin).search, method: 'GET', actor: label, phase: 'actual-read-only-preflight', synthetic: false, status: wanted, material: result.payload?.data,
      before: remember(before), after: remember(after), unchanged: true, resources_before: beforeResources, resources_after: resources() }); return result.payload?.data;
  }
  function writeDiff(before: DiyStateSnapshot, after: DiyStateSnapshot, id: number, value: Row[], result: Row) {
    const want = structuredClone(before), target = want.system_dise.find(item => item.id === id)!;
    expect(typeof result.version).toBe('string'); expect(result.version).not.toBe(target.version); expect(result.update_time).toBeGreaterThan(target.update_time);
    Object.assign(target, { value: JSON.stringify(value), version: result.version, update_time: result.update_time }); expect(after).toEqual(sortedDiyState(want));
    expect(after.system_dise.find(item => item.id === id)!.content).toBe(before.system_dise.find(item => item.id === id)!.content);
  }
  const persist = async () => writeFile(prefix + 'partial.json', JSON.stringify({ status: failure ? 'failed' : 'running', error: failure instanceof Error ? failure.stack : failure, next: stage(), evidence, traces, setup, writes, transport,
    snapshots_by_sha256: snapshots, observation: lastObservation, source_before: sourceBefore, h5_before: h5Before, admin_before: adminBefore }, null, 2) + '\n');
  const instructions: Row = {
    admin:'真实Admin列表，只有既有真实持久化角色会话。',
    minimal:'最小作者编辑ID1；图库禁用。分别选择newVip/signIn/ranking并点击读取当前公开内容预览；只匿名3GET，不得借Admin会员身份，JSON完整保持。最后选userInfor核图库disabled。',
    reader:'只读账号编辑ID1，新增/字段/图库/公开内容读取全部禁用，JSON不变。',
    revoked:'外层撤回最小作者：真实role903.rules临时设dise.view并实际GET证明服务端400011；新持久化会话如实同步。编辑ID1确认作者/图库禁用。此为明确fixture维护，不是业务保存。',
    rootOpen:'外层恢复最小作者真实原rules，再点击真实Admin并编辑ID1；原始4组件、邻居、footer、content完整保持。',
    builtin:'选择ranking，点击读取当前公开内容预览；标题原始ranking.png真实完成102×32自然像素、CSS51×16。还没替换图库图片。',
    latePending:'暂缓下一图库；在ranking图片打开图库，实际服务已完成全读而HTTP响应held。',
    lateClosed:'真实关闭图库，再取消整个父编辑对话框；旧响应仍held。',
    lateReleased:'释放图库旧响应，再实际编辑ID1；旧图片不能选入、JSON仍原始值。',
    rootEdited:'userInfor风格0、newVip风格0；signIn/ranking保持0。ranking从真实图库选择footer-unselected.png(secondIcon)。依次选择4组件，newVip/signIn/ranking都点读取当前公开内容预览，使实际Admin4种style0完整渲染；不改其他字段。',
    rootSaved:'真实点击保存第1次，等父dialog关闭。',rootH5:'匿名首页，4可见组件全部style0、真实状态API与图库图片；没有个人资料请求。',
    alternateOpen:'回真实Admin编辑ID1，已保存第一版不变。',
    alternateEdited:'全4style1；user进度条色调1、progressColor起始#a13f67。newVip优惠券色调1、couponBgColor2起始#ffeedd、现代优惠券间距8.5。sign色调1、labelBgColor起始#ffeecc。ranking文字标题1、真实榜单、看更多、斜体2、标题字号17.5、色调1、价格色#13579b。每组件实际预览；其他完整字段保持。',
    alternateSaved:'真实保存第2次。',alternateH5:'匿名首页新实例，4style1，真实榜单文字/奖励/现代新人/左右会员卡。',
    user11:'外层真实账号11首页；独立5个只读state/level接口，0积分0余额、2券、蓝会员、Monday已签，无领取/签到/购买/analytics。',
    user22:'外层真实账号22首页；50积分88余额、1券、绿会员、新人不符合、今天已签；不能留账号11结果。',
    guest:'外层重新游客首页；个人昵称/积分/券/等级清除，公开新人和签到榜单仍实际GET。',
    microOpen:'回真实Admin编辑ID2导入微页；8state实例、4隐藏与所有数值原样。',
    microNoop:'实际逐个选择8state作者项，隐藏重复也检查；可见4个导入值中focus/blur微小/指数/空白/true四角控件，不修改。至少真实上边距与四角focusin/focusout。整个JSON字节不被自动改写。',
    microEdited:'仅既有内容编辑器的titles正文改状态作者已验收微页；8state配置、rawstrings/true/oversized/未知邻居/footer与独立content完整不变。',
    microSaved:'真实保存第3次。',microH5:'匿名微页2，实际4可见/4隐藏，raw导入保留且新正文发布，媒体当前owner检查。',
    finished:'3次真实GUI成功POST；全部实际GET全表/序列/KV/R2/queue/IMAGES零写，角色setup已精确恢复；资源及source/build闭包收尾。',
  };
  const saves: Record<string, { id: number; value: Row[] }> = { rootSaved: { id: 1, value: editedRoot }, alternateSaved: { id: 1, value: alternateRoot }, microSaved: { id: 2, value: editedMicro } };
  try {
    setup.push({ ...f.stateAuthorSetup });
    expect(f.tables).toContain('user_sign'); expect(f.tables).toContain('system_dise'); expect(f.tables).toContain('system_role'); expect(f.tables.length).toBeGreaterThan(73);
    for(const [token,label]of[[undefined,'actual-guest'],[f.token,'actual-user11'],[f.otherToken,'actual-user22']]as const)for(const path of['/api/diy/user_info','/api/diy/newcomer_list?page=1&limit=10','/api/diy/product_rank?limit=3','/api/diy/sign'])await measured(path,token,label,200);
    for(const [token,label]of[[f.token,'actual-user11'],[f.otherToken,'actual-user22']]as const)await measured('/api/user/level/info',token,label,200);
    await measured('/adminapi/dise/author-options/hot-words',f.minimalToken,'actual-minimal903',200);
    await measured('/adminapi/dise/author-options/hot-words',f.readerToken,'actual-reader902',400011);
    expect(await f.snapshot()).toEqual(expected); expect(resources()).toEqual(initialResources);
    sourceBefore = await sources(); h5Before = await artifacts(h5); adminBefore = await artifacts(admin); expect(h5Before.length).toBeGreaterThan(100); expect(adminBefore.length).toBeGreaterThan(20);
    const chrome: Row = { '/api/site_config': { site_name: '状态作者完整验收', site_logo: '', record_No: '', ico_path: '' }, '/api/share': { title: '状态作者', synopsis: '', img: '' },
      '/api/get_open_adv': { status: 0, time: 3, interval_time: 24, type: 'pic', value: [], video_link: '' }, '/api/v2/diy/color_change/color_change': {}, '/adminapi/new_push': { ordernum: 0, inventory: 0, commentnum: 0, reflectnum: 0, msgcount: 0, sampled_at: Math.floor(Date.now()/1000) } };
    async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
      pending++; try { await serial(async () => {
        const raw = await body(req), method = req.method ?? 'GET', before = await f.snapshot(), startResources = resources(), reads = f.bucket.get.mock.calls.length, path = url.pathname;
        expect(before).toEqual(expected); const header = req.headers['authori-zation'] || req.headers.authorization, token = typeof header === 'string' ? header.replace(/^Bearer\s+/u, '').trim() : '';
        const actor = token === f.adminToken ? 901 : token === f.minimalToken ? 903 : token === f.readerToken ? 902 : token === f.token ? 11 : token === f.otherToken ? 22 : 0;
        if(['/api/diy/user_info','/api/user/level/info'].includes(path))expect([11,22]).toContain(actor);
        if(['/api/diy/user_info','/api/user/level/info','/api/diy/newcomer_list','/api/diy/product_rank','/api/diy/sign'].includes(path))expect([0,11,22]).toContain(actor);
        expect(path).not.toMatch(/video_list|community\/(?:detail|browse|share)|sign\/integral|coupon\/receive|order\/create|cart\/add/u);
        if (Object.hasOwn(chrome, path)) { expect(method).toBe('GET'); expect(raw.length).toBe(0); traces.push({ path, query: url.search, method, stage: stage(), actor, synthetic: true, declared: 'unrelated branding/advert/theme/Admin notification chrome only', before: remember(before), after: remember(before), unchanged: true, resources_before: startResources, resources_after: resources() }); json(res, { status: 200, msg: 'Declared unrelated chrome only', data: chrome[path] }); return; }
        if (method === 'GET') expect(raw.length).toBe(0); else { expect(method).toBe('POST'); expect(path).toBe('/adminapi/dise/save'); expect(Object.hasOwn(saves, stage() ?? '')).toBe(true); expect(actor).toBe(901); }
        const result = await dispatch(path + url.search, method, raw, req), after = await f.snapshot();
        if (method === 'POST') {
          const target = saves[stage()!]!, input = JSON.parse(raw.toString()), old = row(target.id);
          expect(input).toEqual({ id: target.id, name: old.name.trim(), title: old.title.trim(), value: JSON.stringify(target.value), content: old.content, status: old.status });
          expect(result.payload?.status).toBe(200); writeDiff(before, after, target.id, target.value, result.payload!.data);
          expected = after; businessSave++; writes.push({ stage: stage(), input, before: remember(before), after: remember(after), allowed: ['system_dise.' + target.id + '.value', 'system_dise.' + target.id + '.version', 'system_dise.' + target.id + '.update_time'] });
        } else expect(after).toEqual(before);
        expect(resources()).toEqual(startResources);
        expect(result.payload ? [200,400011,410000,410002].includes(result.payload.status) : [200,206,404].includes(result.response.status)).toBe(true);
        const trace: Row = { path, query: url.search, method, actor, stage: stage(), synthetic: false, status: result.payload?.status ?? result.response.status, material: result.payload?.data,
          before: remember(before), after: remember(after), unchanged: digest(before) === digest(after), resources_before: startResources, resources_after: resources(), r2_reads: f.bucket.get.mock.calls.length - reads, bytes: result.bytes.length, body_sha256: hash(result.bytes) };
        traces.push(trace);
        const deliver = () => { if (res.destroyed) { trace.transport = 'client-closed-before-delivery'; return; } const headers: Record<string,string> = {}; result.response.headers.forEach((value,key) => { if (!['content-length','content-encoding','transfer-encoding','connection'].includes(key.toLowerCase())) headers[key] = value; }); res.writeHead(result.response.status, headers); res.end(result.bytes); trace.delivered = true; };
        if (holdGallery && path === '/adminapi/file/file') { holdGallery = false; held.push({ res, release: deliver, trace }); trace.transport = 'actual-response-held-after-complete-read'; return; } deliver();
      }); } finally { pending--; }
    }
    function assertAdminStyles(data:Row,style:number,minEpoch=0){for(const kind of DIY_STATE_AUTHOR_NAMES){const capture=data.styles.find((item:Row)=>item.trusted&&item.actorRoute==='admin'&&item.frameEpoch>=minEpoch&&item.kind===kind&&item.style===style&&item.rendered);expect(capture,`${kind} actual Admin style${style}`).toBeDefined();expect(capture.box.width).toBe(375);expect(capture.box.height).toBeGreaterThan(0);}}
    function assertH5(data:Row,micro=false,style=0,viewer=0){
      expect(data.clientWidth).toBe(375);expect(data.scrollWidth).toBeLessThanOrEqual(375);expect(new URL(data.href).pathname).toBe('/__h5');
      expect(data.widgets.map((item:Row)=>item.kind).sort()).toEqual([...DIY_STATE_AUTHOR_NAMES].sort());expect(data.bodyText).toContain(micro?'状态作者已验收微页':'状态作者首页正文');
      for(const widget of data.widgets){expect(widget.error).toBe('');expect(widget.box.width).toBeGreaterThan(0);expect(Math.round(widget.box.width)).toBeLessThanOrEqual(375);expect(widget.box.height).toBeGreaterThan(0);expect(widget.style).toBe(micro?({userInfor:0,newVip:1,signIn:0,ranking:1}as Row)[widget.kind]:style);}
      const member=data.widgets.find((item:Row)=>item.kind==='userInfor'),vip=data.widgets.find((item:Row)=>item.kind==='newVip'),sign=data.widgets.find((item:Row)=>item.kind==='signIn'),rank=data.widgets.find((item:Row)=>item.kind==='ranking');
      expect(member.member.name).toBe(viewer===11?'零值会员11':viewer===22?'另一会员22':'请点击登录');
      if(viewer){expect(member.member.badge).toBe(viewer===11?'蓝色会员':'绿色会员');expect(member.member.metrics.find((item:Row)=>item.action==='integral').value).toBe(viewer===11?'0':'50');expect(member.member.metrics.find((item:Row)=>item.action==='money').value).toBe(viewer===11?'0.00':'88.00');expect(member.member.progress).toBe(viewer===11?'0%':'25%');}else{expect(member.member.metrics).toHaveLength(0);expect(member.member.badge).toBe('');}
      expect(vip.newcomer.coupons.map((item:Row)=>item.id)).toEqual(viewer===22?[]:viewer===11?[92,91]:[82,81]);expect(vip.newcomer.products).toEqual(viewer===22?[]:[71]);
      if(sign.style===0){expect(sign.sign.days).toHaveLength(7);expect(sign.sign.days.filter((item:Row)=>item.today)).toHaveLength(1);}else{expect(sign.sign.days).toHaveLength(0);expect(sign.sign.reward).toContain('连续签到7天');expect(sign.sign.reward).toContain('0积分');expect(sign.sign.reward).toContain('3经验');}
      expect(sign.sign.button.includes('已签到')).toBe(viewer===22||viewer===11&&f.shanghaiDay===f.monday);
      expect(rank.rank.groups.map((item:Row)=>item.key)).toEqual(rank.style===0?['sales','collect','star']:['sales','star','collect']);
      expect(rank.rank.groups.find((item:Row)=>item.key==='sales').products).toEqual([301,302,303]);expect(rank.rank.groups.find((item:Row)=>item.key==='star').products).toEqual([302,601,303]);expect(rank.rank.groups.find((item:Row)=>item.key==='collect').products).toEqual([303,301,302]);
      if(!micro&&style===0)expect(rank.images.some((image:Row)=>image.src.includes(f.secondIcon.url+'?')&&image.complete&&image.naturalWidth===160&&image.naturalHeight===90)).toBe(true);
      if(!micro&&style===1)expect(rank.rank.title).toBe('真实榜单');
      if(!viewer)expect(member.images.some((image:Row)=>image.src.includes(f.platformImage.url+'?')&&image.complete&&image.naturalWidth===160&&image.naturalHeight===90)).toBe(true);
      expect(traces.some(item=>item.path===(micro?'/api/diy/get_diy/2':'/api/diy/get_diy/0')&&item.status===200&&!item.synthetic)).toBe(true);
    }
    async function checkpoint(name:string,data:Row,res:ServerResponse){expect(pending).toBe(0);await serial(async()=>{
      lastObservation=data;expect(name).toBe(stage());expect(data.loaded).toBe(true);expect(data.errors).toEqual([]);expect(data.consoleErrors).toEqual([]);expect(data.jsonEdits).toEqual([]);
      const gui=traces.filter(item=>item.phase!=='actual-read-only-preflight'&&!item.synthetic);
      if(name==='admin')expect(data.href).toContain('/content/dise');
      else if(['minimal','reader','revoked','rootOpen','builtin','latePending','lateReleased'].includes(name)){
        expect(data.admin.editor).toBe(true);expect(JSON.parse(data.admin.value)).toEqual(initialRoot);expect(data.admin.content).toBe(row(1).content);
        if(name==='minimal'){expect(data.admin.addDisabled).toBe(false);expect(data.admin.imageButtons.length).toBeGreaterThan(0);expect(data.admin.imageButtons.every((item:Row)=>item.disabled)).toBe(true);for(const path of['/api/diy/newcomer_list','/api/diy/sign','/api/diy/product_rank'])expect(gui.some(item=>item.path===path&&item.stage==='minimal'&&item.actor===0&&item.status===200)).toBe(true);}
        if(name==='reader'||name==='revoked')expect(data.admin.addDisabled).toBe(true);
        if(name==='revoked')expect(minimalRevoked).toBe(true);if(name==='rootOpen')expect(minimalRevoked).toBe(false);
        if(name==='builtin'){const picture=data.admin.preview.images.find((item:Row)=>new URL(item.src,origin).pathname==='/static/images/diy/ranking.png');expect(picture).toBeDefined();expect(picture.complete).toBe(true);expect([picture.naturalWidth,picture.naturalHeight]).toEqual([102,32]);expect([picture.box.width,picture.box.height]).toEqual([51,16]);}
        if(name==='latePending')expect(held).toHaveLength(1);if(name==='lateReleased')expect(held).toHaveLength(0);
      }else if(name==='lateClosed'){expect(data.admin.dialog).toBe(false);expect(held).toHaveLength(1);}
      else if(['rootEdited','alternateOpen','alternateEdited','microOpen','microNoop','microEdited'].includes(name)){
        expect(data.admin.editor).toBe(true);const wanted=name==='rootEdited'?editedRoot:name==='alternateEdited'?alternateRoot:name==='alternateOpen'?editedRoot:name==='microEdited'?editedMicro:initialMicro;expect(JSON.parse(data.admin.value)).toEqual(wanted);expect(data.admin.content).toBe(row(name.startsWith('micro')?2:1).content);
        if(name==='rootEdited')assertAdminStyles(data,0);if(name==='alternateOpen')alternateFrameEpoch=data.frameEpoch;if(name==='alternateEdited')assertAdminStyles(data,1,alternateFrameEpoch);
        if(name==='microOpen')microFrameEpoch=data.frameEpoch;
        if(name==='microNoop'){const selected=data.selections.filter((item:Row)=>item.trusted&&item.actorRoute==='admin'&&item.frameEpoch>=microFrameEpoch);for(const[index,item]of initialMicro.entries())if(DIY_STATE_AUTHOR_NAMES.includes(item.name))expect(selected.some((row:Row)=>row.index===index&&row.kind===item.name),`actual imported state index${index}`).toBe(true);for(const type of['focusin','focusout'])expect(data.events.some((item:Row)=>item.trusted&&item.frameEpoch>=microFrameEpoch&&item.type===type&&/上边距|圆角/u.test(item.label))).toBe(true);}
      }else if(Object.hasOwn(saves,name)){expect(data.admin.dialog).toBe(false);expect(businessSave).toBe(['rootSaved','alternateSaved','microSaved'].indexOf(name)+1);}
      else if(['rootH5','alternateH5','user11','user22','guest','microH5'].includes(name)){
        const viewer=name==='user11'?11:name==='user22'?22:0;assertH5(data,name==='microH5',name==='rootH5'?0:1,viewer);
        const current=gui.filter(item=>item.stage===name);
        if(viewer){for(const path of['/api/diy/user_info','/api/user/level/info','/api/diy/newcomer_list','/api/diy/product_rank','/api/diy/sign'])expect(current.some(item=>item.path===path&&item.actor===viewer&&item.status===200)).toBe(true);
          const member=current.find(item=>item.path==='/api/diy/user_info'&&item.actor===viewer)!.material;expect(member.uid).toBe(viewer);expect(member.coupon_num).toBe(viewer===11?2:1);expect(member.integral).toBe(viewer===11?0:50);
        }
        else expect(current.some(item=>['/api/diy/user_info','/api/user/level/info'].includes(item.path))).toBe(false);
      }else expect(name).toBe('finished');
      expect(await f.snapshot()).toEqual(expected);expect(resources()).toEqual(initialResources);evidence.push({stage:name,at:Date.now(),observation:data,traceCount:traces.length,snapshot:remember(await f.snapshot()),resources:resources()});await persist();
      await writeFile(prefix+'progress.json',JSON.stringify({checked:evidence.map(item=>item.stage),next:stage(),traces:traces.length,business_save_count:businessSave})+'\n');
      if(name==='finished'){
        expect(businessSave).toBe(3);expect(held).toHaveLength(0);expect(minimalRevoked).toBe(false);expect(external).not.toHaveBeenCalled();
        const sourceAfter=await sources(),h5After=await artifacts(h5),adminAfter=await artifacts(admin);expect(sourceAfter).toEqual(sourceBefore);expect(h5After).toEqual(h5Before);expect(adminAfter).toEqual(adminBefore);
        await writeFile(prefix+'evidence.json',JSON.stringify({status:'passed-all-declared-state-author-checkpoints',plans,evidence,traces,setup,writes,transport,snapshots_by_sha256:snapshots,tables:f.tables,sequences:f.sequences,source_before:sourceBefore,source_after:sourceAfter,h5_before:h5Before,h5_after:h5After,admin_before:adminBefore,admin_after:adminAfter,static_paths:staticPaths,served_html:servedHtml,resources_before:initialResources,resources_after:resources(),business_save_count:businessSave,
          boundaries:['Actual built Admin/H5 and Worker/native owned PG16/R2 bytes; only unrelated branding/advert/theme/notification chrome is synthetic.','Exactly3 successful real GUI saves; real8 Admin previews are four style0 and four style1. Micro has4 visible and4 hidden instances, not8 visible H5 widgets.','Only explicit fixture role903.rules revoke/restore control is setup, separately all-row/sequence/resource verified, never a business save or a claimed zero-write GET.','Every actual HTTP GET body/asset fully read before complete inventory/resource equality. No member sign/claim/purchase/business action.','Outer Root driver independently binds installed modules and driver bytes; this inner receipt binds exact consumed source and served artifacts.','Real completed gallery HTTP response held and released after closure; not falsely called an abort-ignoring app callback.','Owned maintenance SQL DI is not a production LOGIN grant or physical MP/App-device/deployment claim.']},null,2)+'\n');done();
      }
      json(res,{checked:evidence.map(item=>item.stage),next:stage(),instruction:instructions[stage()??'']});
    });}
    const shell = () => {
      const bootstrap = { control, user11:f.token, user22:f.otherToken, sessions: { admin: { token: f.adminToken, session: f.adminSession }, minimal: { token: f.minimalToken, session: f.minimalSession }, reader: { token: f.readerToken, session: f.readerSession } } };
      return '<!doctype html><html lang="zh"><meta charset="utf-8"><title>真实状态作者验收</title><style>body{font:13px sans-serif;margin:8px}button{margin:3px}iframe{display:block;width:1200px;height:900px;border:1px solid #ddd}pre{max-height:100px;overflow:auto;white-space:pre-wrap}</style><body><h1>真实状态作者/Admin/H5</h1>' +
        '<button data-route="admin">真实Admin</button><button data-route="minimal">最小作者</button><button data-route="reader">只读账号</button><button data-route="home">匿名首页</button><button data-route="user11">实际账号11</button><button data-route="user22">实际账号22</button><button data-route="guest">重新游客</button><button data-route="micro">匿名微页</button><button data-control="revoke-minimal">撤回最小作者</button><button data-control="restore-minimal">恢复最小作者</button><button data-control="hold-gallery">暂缓下一图库</button><button data-control="release-gallery">释放图库旧响应</button>' +
        plans.map(name => '<button data-stage="' + name + '">' + name + '</button>').join('') + '<pre id="result"></pre><iframe title="真实应用验收帧"></iframe><script>' + stateAuthorObserver.replace('__BOOTSTRAP__', JSON.stringify(bootstrap)) + '</script></body></html>';
    };
    async function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL) {
      if (url.pathname === '/__h5' || url.pathname === '/content/dise') { const h5Index = url.pathname === '/__h5', raw = await readFile(resolve(h5Index ? h5 : admin, 'index.html'));
        const augmentation = '<style data-owned-state-scrollbar>html{scrollbar-width:none!important}</style>', served = h5Index ? Buffer.from(raw.toString().replace('</head>', augmentation + '</head>')) : raw;
        servedHtml.push({ scope: h5Index ? 'H5' : 'Admin', raw_sha256: hash(raw), served_sha256: hash(served), augmentation: h5Index ? augmentation : null }); send(res, served); return; }
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, ''), preferred = String(req.headers.referer ?? '').includes('/content/dise') ? [admin,h5] : [h5,admin];
      for (const directory of preferred) { const path = resolve(directory, relative); if (!path.startsWith(directory + sep)) continue; try {
        const raw = await readFile(path), types: Record<string,string> = { '.js':'application/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.webp':'image/webp','.woff2':'font/woff2','.ico':'image/x-icon' };
        staticPaths.push({ path: url.pathname, build: directory === admin ? 'Admin' : 'H5', sha256: hash(raw) }); send(res, raw, 200, types[extname(path)] ?? 'application/octet-stream'); return;
      } catch (reason) { if (!['ENOENT','EISDIR'].includes((reason as NodeJS.ErrnoException).code ?? '')) throw reason; } }
      throw Error('Unowned static path ' + url.pathname);
    }
    server = createServer((req, res) => { void (async () => {
      expect(req.socket.remoteAddress).toBe('127.0.0.1'); const url = new URL(req.url ?? '/', origin);
      if (url.pathname === '/') { expect(req.method).toBe('GET'); send(res, shell()); return; }
      if (url.pathname === control + '/state') { json(res, { next: stage(), checked: evidence.map(item => item.stage), pending, held: held.length, instruction: instructions[stage() ?? ''] }); return; }
      if (url.pathname === control + '/transport') { expect(req.method).toBe('POST'); const input = JSON.parse((await body(req)).toString());
        await serial(async()=>{
        expect(['hold-gallery','release-gallery','revoke-minimal','restore-minimal']).toContain(input.action);
        const wanted=input.action==='hold-gallery'?'latePending':input.action==='release-gallery'?'lateReleased':input.action==='revoke-minimal'?'revoked':'rootOpen';expect(stage()).toBe(wanted);
        const before=await f.snapshot(),start=resources();let session:Row|undefined;
        if(input.action==='revoke-minimal'||input.action==='restore-minimal'){
          const revoked=input.action==='revoke-minimal';expect(minimalRevoked).toBe(!revoked);const rules=revoked?'dise.view':'dise.view,dise.manage';
          await f.db.update(systemRole).set({rules}).where(eq(systemRole.id,903));const after=await f.snapshot(),want=structuredClone(before);want.system_role.find(row=>row.id===903)!.rules=rules;expect(after).toEqual(sortedDiyState(want));expect(resources()).toEqual(start);expected=after;minimalRevoked=revoked;
          setup.push({phase:'explicit owned role revocation/restore; not GUI business POST or measured GET',action:input.action,allowed:['system_role.903.rules'],before:remember(before),after:remember(after),resources_before:start,resources_after:resources()});
          await measured('/adminapi/dise/author-options/hot-words',f.minimalToken,'actual-minimal903-after-role-setup',revoked?400011:200);
          session={...f.minimalSession,uniqueAuth:rules.split(',')};
        }else{if(input.action==='hold-gallery')holdGallery=true;else{expect(held).toHaveLength(1);for(const item of held.splice(0))item.release();}expect(await f.snapshot()).toEqual(before);expect(resources()).toEqual(start);}
        transport.push({action:input.action,stage:stage(),before:remember(before),after:remember(await f.snapshot()),resources:start});json(res,{next:stage(),held:held.length,...(session?{session}:{})});
        });return;
      }
      if (url.pathname.startsWith(control + '/checkpoint/')) { expect(req.method).toBe('POST'); await checkpoint(url.pathname.slice((control + '/checkpoint/').length), JSON.parse((await body(req)).toString()), res); return; }
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/adminapi/')) { await api(req, res, url); return; }
      expect(req.method).toBe('GET'); await serveStatic(req, res, url);
    })().catch(async reason => {
      if (isNavigationAuthorBodyDisconnect(reason, req)) {
        transport.push({ kind: 'actual-client-disconnect', phase: 'request-body-before-dispatch', method: req.method, path: req.url, request_aborted: req.aborted, response_destroyed: res.destroyed });
        await persist(); return;
      }
      failure ??= reason; await persist(); if (!res.headersSent) json(res, { error: reason instanceof Error ? reason.message : String(reason), stage: stage() }, 500); else res.end(); fail(reason instanceof Error ? reason : Error(String(reason)));
    }); });
    await new Promise<void>((yes, no) => { server!.once('error', no); server!.listen(40785, '127.0.0.1', yes); });
    timer = setTimeout(() => { failure = Error('Owned state author Browser deadline exceeded'); fail(failure as Error); }, 63 * 60_000);
    await writeFile(prefix + 'ready.json', JSON.stringify({ url: origin + '/', origin, control, plans, instructions, pid: process.pid, tables: f.tables, sequences: f.sequences, source: sourceBefore, h5: h5Before, admin: adminBefore,
      expected: { initialRoot, initialMicro, editedRoot, alternateRoot, editedMicro, platformImage: f.platformImage, secondIcon: f.secondIcon, supplierImage: f.supplierImage, phases: 'three actual GUI business saves; explicit role903 revoke/restore separately audited' },
      boundary: 'Only initial true persisted-role sessions and HTTP response transport gating are outer controls. No app method invocation, application event dispatch or fabricated business DTO.' }, null, 2) + '\n');
    console.log('DIY state author Browser ready', origin); await completion;
  } catch (reason) { failure ??= reason; throw reason; }
  finally {
    if (timer) clearTimeout(timer); for (const item of held.splice(0)) item.res.destroy(); server?.closeAllConnections(); if (server?.listening) await new Promise<void>(yes => server!.close(() => yes())); await queue;
    let finalSnapshot: DiyStateSnapshot | undefined, sourceAfter: Row[] = [], h5After: Row[] = [], adminAfter: Row[] = [], inspectionError: unknown;
    try { finalSnapshot = await f.snapshot(); remember(finalSnapshot); sourceAfter = sourceBefore.length ? await sources() : []; h5After = h5Before.length ? await artifacts(h5) : []; adminAfter = adminBefore.length ? await artifacts(admin) : []; await persist(); }
    catch (reason) { inspectionError = reason instanceof Error ? reason.stack : String(reason); }
    finally { external.mockRestore(); wiring.container = undefined; vi.unstubAllGlobals(); await f.close(); }
    await writeFile(prefix + 'cleanup.json', JSON.stringify({ server_closed: true, database_fixture_closed: true, timer_cleared: true, external_restored: true, fixed_stream_restored: true, checked: evidence.map(item => item.stage), inspection_error: inspectionError,
      final_snapshot: finalSnapshot, snapshots_by_sha256: snapshots, final_resources: resources(), source_after: sourceAfter, h5_after: h5After, admin_after: adminAfter,
      source_drift: sourceBefore.length ? digest(sourceBefore) !== digest(sourceAfter) : null, h5_drift: h5Before.length ? digest(h5Before) !== digest(h5After) : null, admin_drift: adminBefore.length ? digest(adminBefore) !== digest(adminAfter) : null }, null, 2) + '\n');
    if (inspectionError && !failure) throw Error(String(inspectionError));
  }
}, 65 * 60_000);
