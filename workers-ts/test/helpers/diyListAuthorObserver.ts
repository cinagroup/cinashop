/** Read-only DOM observer and initial persisted-session transport. Never calls
 * application methods, dispatches application events or creates business DTOs. */
export const listAuthorObserver = String.raw`
const boot=__BOOTSTRAP__,frame=document.querySelector('iframe');
let loaded=false,errors=[],consoleErrors=[],events=[],styles=[],jsonEdits=[],removeListeners=()=>{};
const visible=n=>!!n&&n.getClientRects().length>0&&n.ownerDocument.defaultView.getComputedStyle(n).visibility!=='hidden';
const box=n=>{if(!n)return null;const r=n.getBoundingClientRect();return{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
const ready=(w,d)=>w===frame.contentWindow&&d===frame.contentDocument&&d?.readyState==='complete'&&w.location.origin===location.origin;
function snapshotStyle(d){const editor=[...d.querySelectorAll('.list-author-editor')].find(visible),p=editor?.querySelector('.list-author-preview');return p?{kind:p.dataset.kind,layout:Number(p.dataset.layout),box:box(p),products:[...p.querySelectorAll('.preview-product')].map(n=>({id:Number(n.dataset.productId),text:n.textContent.trim(),box:box(n),action:n.querySelector('.product-action')?.textContent.trim(),actionDisabled:n.querySelector('.product-action')?.disabled})),articles:[...p.querySelectorAll('.preview-article')].map(n=>({id:Number(n.dataset.articleId),text:n.textContent.trim(),box:box(n)})),error:p.querySelector('[role=alert]')?.textContent.trim()??'',images:[...p.querySelectorAll('img')].map(n=>({src:n.currentSrc||n.src,complete:n.complete,naturalWidth:n.naturalWidth,naturalHeight:n.naturalHeight}))}:null;}
frame.onload=()=>{removeListeners();const w=frame.contentWindow,d=frame.contentDocument;
 const update=()=>{loaded=ready(w,d);},error=e=>errors.push({kind:'error',message:String(e.message)}),rejection=e=>errors.push({kind:'unhandledrejection',message:String(e.reason)}),previous=w.console.error;
 const log=(...args)=>{consoleErrors.push(args.map(String).join(' '));previous.apply(w.console,args);};w.console.error=log;
 let trusted=false;const capture=()=>{const current=snapshotStyle(d);if(trusted&&current&&(current.products.length||current.articles.length)){const key=JSON.stringify([current.kind,current.layout,current.products.map(r=>r.id),current.articles.map(r=>r.id)]);if(!styles.some(r=>r.captureKey===key))styles.push({...current,captureKey:key,trusted:true,source:'actual DOM after trusted GUI interaction'});}};const observer=new w.MutationObserver(()=>w.requestAnimationFrame(capture));observer.observe(d.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['data-layout','src']});
 const event=e=>{const n=e.target,label=n.closest?.('.el-form-item')?.querySelector('.el-form-item__label')?.textContent.trim()||'';
  if(n.matches?.('textarea')&&label==='装修 value'&&e.type==='input')jsonEdits.push({type:e.type,trusted:e.isTrusted});
  if(n.closest?.('.list-author-editor,.el-dialog,.el-select-dropdown')&&['click','input','change'].includes(e.type))events.push({type:e.type,trusted:e.isTrusted,label,text:n.closest?.('button')?.textContent.trim().slice(0,160)||'',value:n.matches?.('input')?n.value:undefined,option:n.closest?.('.el-select-dropdown__item')?.textContent.trim()||''});
  if(e.isTrusted&&['click','input','change'].includes(e.type)){trusted=true;}if(e.isTrusted&&['click','input','change'].includes(e.type))w.requestAnimationFrame(()=>w.requestAnimationFrame(()=>{const current=snapshotStyle(d);if(current)styles.push({...current,trusted:true,event:e.type});}));
 };
 for(const type of ['click','input','change'])d.addEventListener(type,event,true);w.addEventListener('hashchange',update);w.addEventListener('error',error);w.addEventListener('unhandledrejection',rejection);update();
 removeListeners=()=>{for(const type of ['click','input','change'])d.removeEventListener(type,event,true);w.removeEventListener('hashchange',update);w.removeEventListener('error',error);w.removeEventListener('unhandledrejection',rejection);observer.disconnect();if(w.console.error===log)w.console.error=previous;};
};
window.addEventListener('pagehide',()=>removeListeners());
function navigate(target){loaded=false;errors=[];consoleErrors=[];const href=new URL(target,location.href).href;if(frame.contentWindow.location.href===href)frame.contentWindow.location.reload();else frame.src=href;}
for(const b of document.querySelectorAll('[data-route]'))b.onclick=()=>{const route=b.dataset.route;
 if(['admin','minimal','reader'].includes(route)){const s=boot.sessions[route];localStorage.setItem('admin_token',s.token);localStorage.setItem('admin_session',JSON.stringify(s.session));frame.style.width='1200px';navigate('/content/dise');return;}
 localStorage.removeItem('uni_token');localStorage.removeItem('uni_uid');for(const key of Object.keys(localStorage))if(key.startsWith('cinashop_diy_page_v1_'))localStorage.removeItem(key);
 frame.style.width='375px';navigate(route==='micro'?'/__h5#/pages/diy/detail?id=2':'/__h5#/pages/index/index');
};
function observe(){const w=frame.contentWindow,d=frame.contentDocument,dialog=[...d.querySelectorAll('.el-dialog')].find(n=>visible(n)&&n.querySelector('.list-author-editor'));
 const field=label=>dialog?[...dialog.querySelectorAll('.el-form-item')].find(n=>n.querySelector('.el-form-item__label')?.textContent.trim()===label):null,editor=dialog?.querySelector('.list-author-editor');
 const image=n=>({src:n.currentSrc||n.src||'',complete:!!n.complete,naturalWidth:n.naturalWidth||0,naturalHeight:n.naturalHeight||0});
 const widgets=[...d.querySelectorAll('.diy-list-widget')].filter(visible).map(n=>({kind:n.dataset.kind,key:n.dataset.componentKey,layout:Number(n.dataset.layout),box:box(n),style:n.getAttribute('style'),text:n.textContent.trim(),products:[...n.querySelectorAll('.diy-list-product')].map(p=>({id:Number(p.dataset.productId),layout:Number(p.dataset.layout),text:p.textContent.trim(),box:box(p),action:p.querySelector('.list-action')?.textContent.trim(),actionStyle:p.querySelector('.list-action')?.dataset.actionStyle})),articles:[...n.querySelectorAll('.list-article')].map(a=>({id:Number(a.dataset.articleId),text:a.textContent.trim(),box:box(a)})),errors:[...n.querySelectorAll('.list-error')].map(e=>e.textContent.trim()),images:[...n.querySelectorAll('img')].map(image)}));
 return{loaded:loaded&&ready(w,d),href:w.location.href,clientWidth:d.documentElement.clientWidth,scrollWidth:d.documentElement.scrollWidth,bodyText:d.body.innerText,
  admin:{dialog:!!dialog,editor:!!editor,value:field('装修 value')?.querySelector('textarea')?.value??'',content:field('旧版 content')?.querySelector('textarea')?.value??'',
   addDisabled:editor?[...editor.querySelectorAll('button')].find(b=>b.textContent.trim()==='添加列表组件')?.disabled:null,
   catalogButtons:editor?[...editor.querySelectorAll('button')].filter(b=>b.textContent.trim()==='从真实目录选择').map(b=>({disabled:b.disabled,text:b.textContent.trim()})):[],
   picker:{open:[...d.querySelectorAll('.list-author-picker')].some(visible),kind:[...d.querySelectorAll('.list-author-picker')].find(visible)?.dataset.kind,targets:[...d.querySelectorAll('.list-author-picker .list-author-target')].filter(visible).map(n=>({id:Number(n.dataset.targetId),text:n.textContent.trim(),images:[...n.querySelectorAll('img')].map(image),buttons:[...n.querySelectorAll('button')].map(b=>({text:b.textContent.trim(),disabled:b.disabled}))}))},
   numberInputs:editor?[...editor.querySelectorAll('input[type=number]')].map(n=>({value:n.value,min:n.min,max:n.max,label:n.closest('.el-form-item')?.querySelector('.el-form-item__label')?.textContent.trim()})):[],preview:snapshotStyle(d)},
  widgets,images:[...d.querySelectorAll('img')].map(image),events:[...events],styles:[...styles],jsonEdits:[...jsonEdits],errors:[...errors],consoleErrors:[...consoleErrors]};
}
for(const b of document.querySelectorAll('[data-control]'))b.onclick=async()=>{b.disabled=true;try{const response=await fetch(boot.control+'/transport',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:b.dataset.control})});document.getElementById('result').textContent=await response.text();}finally{b.disabled=false;}};
for(const b of document.querySelectorAll('[data-stage]'))b.onclick=async()=>{b.disabled=true;try{
 const until=Date.now()+15000;for(;;){const state=await(await fetch(boot.control+'/state')).json();if(!state.pending)break;if(Date.now()>until)throw Error('actual API still pending');await new Promise(resolve=>setTimeout(resolve,100));}
 await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
 const response=await fetch(boot.control+'/checkpoint/'+b.dataset.stage,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(observe())});document.getElementById('result').textContent=JSON.stringify(await response.json());
 }catch(reason){document.getElementById('result').textContent=String(reason);}finally{b.disabled=false;}};
`;
