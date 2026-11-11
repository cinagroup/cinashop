/** Opt-in CUA host. Built Admin -> actual JWT/Hono/Admin LOGIN API -> real
 * paid-authored tasks. The labelled local shell supplies synthetic sessions,
 * config maintenance, one committed-response loss and direct Queue invocation.
 * No browser driver, provider request, real login-form or production claim. */
import { expect,it,vi } from 'vitest';
import { createServer, type IncomingMessage } from 'node:http';
import { createHash,randomUUID } from 'node:crypto';
import { mkdir,readFile,writeFile,readdir,stat } from 'node:fs/promises';
import { resolve,extname,sep } from 'node:path';
import { sql } from 'drizzle-orm';
import { purchasedLabelOperationsFixture } from '../helpers/purchasedLabelOperationsFixture';
import { capturePurchasedLabelTaskList } from '../../../view/common/purchasedProductLabelTasks';
const digest=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
async function fingerprint(dir:string):Promise<unknown[]> {
  const out:unknown[]=[];for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
    const p=resolve(dir,entry.name);if(entry.isDirectory())for(const value of await fingerprint(p))out.push([entry.name,value]);else if(entry.isFile()){const b=await readFile(p);out.push([entry.name,b.length,digest(b)]);}
  }return out;
}
async function body(req:IncomingMessage){const chunks:Buffer[]=[];let size=0;for await(const chunk of req){const b=Buffer.from(chunk);size+=b.length;if(size>200000)throw Error('Bounded local body required');chunks.push(b);}return Buffer.concat(chunks);}
it('serves real purchased-label task maintenance for manual CUA acceptance',async()=>{
  const network=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('No external provider in owned CUA host'));
  const f=await purchasedLabelOperationsFixture(21),dist=resolve(import.meta.dirname,'../../../view/admin-ts/dist');
  const output='/tmp/php-ts-purchased-label-operations-20261110',control='/__owned_label_qa/'+randomUUID();
  let origin='',drop=false,finished=false,replayedId='',timer:ReturnType<typeof setTimeout>|undefined;
  let complete!:()=>void,fail!:(e:Error)=>void;const completion=new Promise<void>((yes,no)=>{complete=yes;fail=no;});
  const calls:Array<{path:string;method:string;status:number;envelopeStatus:number;dropped:boolean}>=[],checks:unknown[]=[];
  const stages=['initial','pagination','uncertain','restored','completed','viewer','mobile','finish'];let stage=0;
  const build=await fingerprint(dist);expect(build.length).toBeGreaterThan(1);await mkdir(output,{recursive:true});
  const businessBefore=await f.facts();
  const token=await f.bearer(1,'admin','offline-native-admin-password'),viewer=await f.bearer(92,'admin','offline-native-admin-password');
  const session=(id:number)=>({userInfo:{id,account:'owned-label-qa-'+id,head_pic:'',real_name:'本机任务验收',level:id===1?0:1,roles:id===1?'':'92'},
    menus:[{id:1,pid:0,path:'/operations/outbox',name:'任务运维',icon:'',sort:1,type:1,children:[]}],uniqueAuth:id===1?['outbox.view','outbox.manage']:['outbox.view']});
  const shell=()=>`<!doctype html><html lang="zh"><meta charset="utf-8"><title>本机购买标签任务验收</title><style>body{font:14px sans-serif;margin:10px}button{margin:4px;padding:7px}iframe{display:block;width:100%;height:820px;border:1px solid #bbb;box-sizing:border-box}pre{white-space:pre-wrap;max-height:70px;overflow:auto}</style>
<h1>本机购买标签任务验收</h1><p>以下是标记清楚的本机 QA 控制。业务操作使用下方实际构建的后台。</p>
<button data-role="root">打开管理账号</button><button data-role="viewer">打开只读账号</button><button id="maintain">维护标签配置并丢失下一次已提交响应（仅验收）</button><button id="consume">执行原任务 Queue 消费（仅验收）</button><button id="narrow">窄屏 375</button>
<div>${stages.map(s=>`<button data-check="${s}">核对 ${s}</button>`).join('')}</div><pre id="result"></pre><iframe title="实际购买标签任务页面"></iframe><script>
const frame=document.querySelector('iframe'),control=${JSON.stringify(control)},tokens=${JSON.stringify({root:token,viewer})},sessions=${JSON.stringify({root:session(1),viewer:session(92)})};
async function request(name,data={}){const r=await fetch(control+'/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});document.querySelector('#result').textContent=JSON.stringify(await r.json());}
for(const b of document.querySelectorAll('[data-role]'))b.onclick=()=>{const k=b.dataset.role;localStorage.setItem('admin_token',tokens[k]);localStorage.setItem('admin_session',JSON.stringify(sessions[k]));frame.src='/operations/outbox?section=purchased-labels&qa='+Date.now();};
document.querySelector('#maintain').onclick=()=>request('maintain');document.querySelector('#consume').onclick=()=>request('consume');document.querySelector('#narrow').onclick=()=>{frame.style.width='377px';for(let i=0;i<2;i++){const delta=375-frame.contentDocument.documentElement.clientWidth;if(!delta)break;frame.style.width=(parseFloat(frame.style.width)+delta)+'px';}};
for(const b of document.querySelectorAll('[data-check]'))b.onclick=()=>{const d=frame.contentDocument;request('checkpoint',{name:b.dataset.check,text:d?.body?.innerText??'',width:d?.documentElement.clientWidth??0,scrollWidth:d?.documentElement.scrollWidth??0,href:frame.contentWindow.location.href,title:d?.title??'',errors:frame.contentWindow.__ownedErrors??[],reason:d?.querySelector('[aria-label="购买标签维护原因"]')?.value??'',replayButtons:[...d.querySelectorAll('button')].filter(b=>b.textContent.trim()==='维护重放').length});};</script></html>`;
  const json=(res:any,data:unknown,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
  async function checkpoint(value:any){
    expect(value.name).toBe(stages[stage]);expect(value.href).toContain('/operations/outbox');expect(value.title).toBeTruthy();expect(value.errors).toEqual([]);
    expect(value.text).toContain('购买标签任务');expect(value.text).not.toMatch(/Internal Server Error|Vite Error Overlay/);
    const page=capturePurchasedLabelTaskList((await f.adminRequest('/admin/order/product-label-tasks?limit=20')).body.data);
    const posts=calls.filter(c=>c.method==='POST'&&c.path.endsWith('/replay'));
    if(value.name==='initial'){expect(value.text).toContain('本页 20 项');expect(page.items).toHaveLength(20);expect(posts).toHaveLength(0);}
    if(value.name==='pagination'){expect(value.text).toContain('本页 1 项');expect(value.text).toContain('第 2 页');}
    if(value.name==='uncertain'){expect(value.text).toContain('本次结果暂未确认');expect(value.reason).toBe('已核对平台标签归属');expect(posts).toHaveLength(1);expect(posts[0]?.dropped).toBe(true);}
    if(value.name==='restored'){expect(value.text).toContain('已查询到原任务的维护重放记录');expect(value.reason).toBe('已核对平台标签归属');expect(posts).toHaveLength(1);}
    if(value.name==='completed'){expect(value.text).toContain('原任务已有完成回执');expect(posts).toHaveLength(1);const row=capturePurchasedLabelTaskList((await f.adminRequest('/admin/order/product-label-tasks?task_id='+replayedId)).body.data).items[0];expect(row).toMatchObject({status:'COMPLETED',replayCount:1,recovery:'receipt'});}
    if(value.name==='viewer'){expect(value.text).toContain('仅查看');expect(value.replayButtons).toBe(0);expect(posts).toHaveLength(1);}
    if(value.name==='mobile'){expect(value.width).toBe(375);expect(value.scrollWidth).toBeLessThanOrEqual(375);expect(value.text).toContain('仅查看');}
    if(value.name==='finish'){
      expect(await fingerprint(dist)).toEqual(build);expect(network).not.toHaveBeenCalled();expect(posts).toHaveLength(1);
      const after=await f.facts();expect({...after,product:null,audits:null}).toEqual({...businessBefore,product:null,audits:null});
      expect(after.product).toEqual((businessBefore.product as any[]).map(row=>row.id===70?{...row,label_id:'9201'}:row));
      expect((after.audits as any[]).filter(row=>row.change_type!=='product_label_replay')).toEqual(businessBefore.audits);
      const audits=await f.maintenanceDb.execute(sql`SELECT change_message FROM public.store_order_status WHERE change_type='product_label_replay'`);expect(audits).toHaveLength(1);
      const result=await f.maintenanceDb.execute(sql`SELECT count(*)::int AS n FROM public.purchased_product_label_result`);expect(result[0]?.n).toBe(2);
      finished=true;
    }
    checks.push({...value,calls:calls.length,replayPosts:posts.length});stage++;
    await writeFile(resolve(output,'browser-checkpoints.json'),JSON.stringify({checks,calls,build,finished,boundary:'Actual built Admin/JWT/Hono/independent restricted LOGIN API/paid authors/Queue grant. Labelled synthetic sessions, current config maintenance and one committed response-loss. No real login form, provider, production, workerd or device proof.'},null,2)+'\n',{mode:0o600});
    return {checked:value.name,next:stages[stage]??null};
  }
  let queue=Promise.resolve();
  const server=createServer((req,res)=>{void(async()=>{
    if(req.socket.remoteAddress!=='127.0.0.1'||req.headers.host!==new URL(origin).host){res.writeHead(403);res.end();return;}
    const url=new URL(req.url??'/',origin);res.setHeader('Cache-Control','no-store');
    if(req.method==='GET'&&url.pathname===control){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(shell());return;}
    if(req.method==='POST'&&url.pathname.startsWith(control+'/')){
      if(req.headers.origin!==origin)throw Error('Same-origin QA UI required');const value=JSON.parse((await body(req)).toString()),op=url.pathname.slice(control.length+1);
      queue=queue.then(async()=>{if(op==='maintain'){await f.maintain();drop=true;json(res,{configMaintained:true,loseNextCommittedReplay:true});}
        else if(op==='consume'){const task=f.tasks.find(t=>t.ref.taskId===replayedId);if(!task)throw Error('UI-authored replay absent');expect(await f.appTasks.process(task.ref)).toBe('completed');json(res,{originalTaskConsumed:true});}
        else if(op==='checkpoint'){const result=await checkpoint(value);if(finished)res.once('finish',complete);json(res,result);}else throw Error('Unknown QA control');});await queue;return;
    }
    if(req.method==='GET'&&url.pathname==='/api/site_config'){json(res,{status:200,msg:'Synthetic branding only',data:{site_name:'本机任务验收',site_logo:'',site_logo_square:'',login_logo:'',ico_path:'',record_No:'',admin_login_slide:[]}});return;}
    if(url.pathname.startsWith('/adminapi/')||url.pathname.startsWith('/api/')){
      const raw=await body(req),headers=new Headers();for(let i=0;i<req.rawHeaders.length;i+=2)headers.append(req.rawHeaders[i],req.rawHeaders[i+1]);
      queue=queue.then(async()=>{const response=await f.raw((url.pathname.startsWith('/adminapi/')?'/admin/'+url.pathname.slice('/adminapi/'.length):url.pathname.slice('/api'.length))+url.search,{method:req.method,headers,...(raw.length?{body:new Uint8Array(raw)}:{})});
        const bytes=Buffer.from(await response.arrayBuffer());let parsed:any={};try{parsed=JSON.parse(bytes.toString());}catch{/* actual nonJSON remains */}
        const lost=drop&&req.method==='POST'&&url.pathname.endsWith('/replay')&&parsed.status===200;
        calls.push({path:url.pathname,method:req.method??'GET',status:response.status,envelopeStatus:parsed.status,dropped:lost});
        if(lost){drop=false;replayedId=parsed.data.taskId;json(res,{status:503,msg:'本机 QA：已提交响应丢失',data:null},503);}else{res.writeHead(response.status,Object.fromEntries(response.headers));res.end(bytes);}
      });await queue;return;
    }
    if(req.method!=='GET')throw Error('Unexpected static write');if(url.pathname==='/favicon.ico'){res.writeHead(204);res.end();return;}
    let path=resolve(dist,'.'+decodeURIComponent(url.pathname));if(path!==dist&&!path.startsWith(dist+sep))throw Error('Build path escape');
    try{if(path===dist||!(await stat(path)).isFile())path=resolve(dist,'index.html');}catch{path=resolve(dist,'index.html');}
    let bytes=await readFile(path);if(extname(path)==='.html')bytes=Buffer.from(bytes.toString().replace('<head>','<head><script>window.__ownedErrors=[];window.addEventListener("error",e=>window.__ownedErrors.push(e.message));window.addEventListener("unhandledrejection",e=>window.__ownedErrors.push(String(e.reason)));const w=console.warn,e=console.error;console.warn=(...a)=>{window.__ownedErrors.push(a.map(v=>typeof v==="object"?Object.prototype.toString.call(v):String(v)).join(" "));w(...a)};console.error=(...a)=>{window.__ownedErrors.push(a.map(v=>typeof v==="object"?Object.prototype.toString.call(v):String(v)).join(" "));e(...a)};</script>'));
    res.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'}as Record<string,string>)[extname(path)]??'application/octet-stream'});res.end(bytes);
  })().catch(error=>{fail(error instanceof Error?error:Error(String(error)));if(!res.headersSent)json(res,{error:'Owned acceptance failed'},500);else res.destroy();});});
  try {
    await new Promise<void>((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});const address=server.address();if(!address||typeof address==='string')throw Error('Owned port absent');origin='http://127.0.0.1:'+address.port;
    const ready={url:origin+control,stages,output,windowSeconds:360};await writeFile(resolve(output,'browser-ready.json'),JSON.stringify(ready,null,2)+'\n',{mode:0o600});console.log('PURCHASED_LABEL_OPERATIONS_BROWSER_READY '+JSON.stringify(ready));
    timer=setTimeout(()=>fail(Error('Owned six-minute CUA completion absent')),360000);await completion;await queue;expect(finished).toBe(true);
  }finally{if(timer)clearTimeout(timer);server.closeAllConnections();if(server.listening)await new Promise<void>(yes=>server.close(()=>yes()));network.mockRestore();await f.close();}
},9*60000);
