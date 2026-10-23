/** Observer/initial-session transport only. This script never calls application
 * methods, dispatches application events or fabricates any business response. */
export const navigationAuthorObserver = String.raw`
const boot=__BOOTSTRAP__,frame=document.querySelector('iframe');
let loaded=false,errors=[],consoleErrors=[],events=[],layouts=[],jsonEdits=[],removeListeners=()=>{};
const visible=node=>!!node&&node.getClientRects().length>0&&node.ownerDocument.defaultView.getComputedStyle(node).visibility!=='hidden';
const box=node=>{if(!node)return null;const r=node.getBoundingClientRect();return{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
const ready=(w,d)=>w===frame.contentWindow&&d===frame.contentDocument&&d?.readyState==='complete'&&w.location.origin===location.origin;
function snapshotLayout(d){const editor=[...d.querySelectorAll('.navigation-editor')].find(visible),preview=editor?.querySelector('.navigation-preview');return preview?{layout:Number(preview.dataset.layout),kind:preview.dataset.kind,cells:[...preview.querySelectorAll('.cube-cell')].map(n=>({slot:Number(n.dataset.previewSlot),box:box(n),style:n.getAttribute('style')})),grid:editor.querySelectorAll('.draw-canvas>button:not(.draw-rectangle)').length}:null;}
frame.onload=()=>{removeListeners();const w=frame.contentWindow,d=frame.contentDocument;
 const update=()=>{loaded=ready(w,d);},error=e=>errors.push({kind:'error',message:String(e.message)}),rejection=e=>errors.push({kind:'unhandledrejection',message:String(e.reason)}),previous=w.console.error;
 const log=(...args)=>{consoleErrors.push(args.map(String).join(' '));previous.apply(w.console,args);};w.console.error=log;
 const event=e=>{const n=e.target,field=n.closest?.('.el-form-item'),label=field?.querySelector('.el-form-item__label')?.textContent.trim()||'';
  if(n.matches?.('textarea')&&label==='装修 value'&&e.type==='input')jsonEdits.push({type:e.type,trusted:e.isTrusted});
  if(n.closest?.('.navigation-editor,.el-dialog')&&['click','input','change'].includes(e.type))events.push({type:e.type,trusted:e.isTrusted,label,text:n.closest?.('button')?.textContent.trim().slice(0,160)||'',value:n.matches?.('input')?n.value:undefined});
  const layout=n.closest?.('.layout-choices button');if(e.type==='click'&&layout){const clicked=layout.getAttribute('aria-label');w.requestAnimationFrame(()=>w.requestAnimationFrame(()=>{const current=snapshotLayout(d);if(current)layouts.push({...current,clicked,trusted:e.isTrusted});}));}
 };
 for(const type of ['click','input','change'])d.addEventListener(type,event,true);w.addEventListener('hashchange',update);w.addEventListener('error',error);w.addEventListener('unhandledrejection',rejection);update();
 removeListeners=()=>{for(const type of ['click','input','change'])d.removeEventListener(type,event,true);w.removeEventListener('hashchange',update);w.removeEventListener('error',error);w.removeEventListener('unhandledrejection',rejection);if(w.console.error===log)w.console.error=previous;};
};
window.addEventListener('pagehide',()=>removeListeners());
function navigate(target){loaded=false;errors=[];consoleErrors=[];const href=new URL(target,location.href).href;if(frame.contentWindow.location.href===href)frame.contentWindow.location.reload();else frame.src=href;}
for(const b of document.querySelectorAll('[data-route]'))b.onclick=()=>{const route=b.dataset.route;
 if(['admin','minimal','reader'].includes(route)){const s=boot.sessions[route];localStorage.setItem('admin_token',s.token);localStorage.setItem('admin_session',JSON.stringify(s.session));frame.style.width='1200px';navigate('/content/dise');return;}
 localStorage.removeItem('uni_token');localStorage.removeItem('uni_uid');for(const key of Object.keys(localStorage))if(key.startsWith('cinashop_diy_page_v1_'))localStorage.removeItem(key);
 frame.style.width='375px';navigate(route==='micro'?'/__h5#/pages/diy/detail?id=2':'/__h5#/pages/index/index');
};
function observe(){const w=frame.contentWindow,d=frame.contentDocument,css=n=>w.getComputedStyle(n),dialog=[...d.querySelectorAll('.el-dialog')].find(n=>visible(n)&&n.querySelector('.navigation-editor'));
 const field=label=>dialog?[...dialog.querySelectorAll('.el-form-item')].find(n=>n.querySelector('.el-form-item__label')?.textContent.trim()===label):null,editor=dialog?.querySelector('.navigation-editor');
 const image=n=>({src:n.currentSrc||n.src||'',complete:!!n.complete,naturalWidth:n.naturalWidth||0,naturalHeight:n.naturalHeight||0});
 const widgets=[...d.querySelectorAll('.diy-navigation-widget')].filter(visible).map(n=>({kind:n.dataset.kind,key:n.dataset.componentKey,box:box(n),text:n.textContent.trim(),images:[...n.querySelectorAll('img')].map(image),layout:Number(n.querySelector('.navigation-canvas')?.dataset.layout??-1),
  menuPages:[...n.querySelectorAll('.navigation-menu-page')].map(page=>({page:Number(page.dataset.page??0),box:box(page),items:[...page.querySelectorAll('.navigation-menu-item')].filter(visible).map(item=>({index:Number(item.dataset.itemIndex),label:item.textContent.trim(),box:box(item)}))})),
  cells:[...n.querySelectorAll('.navigation-cube-cell')].map(cell=>({index:Number(cell.dataset.itemIndex),style:cell.getAttribute('style'),box:box(cell)}))}));
 return{loaded:loaded&&ready(w,d),href:w.location.href,clientWidth:d.documentElement.clientWidth,scrollWidth:d.documentElement.scrollWidth,bodyText:d.body.innerText,
  admin:{dialog:!!dialog,editor:!!editor,value:field('装修 value')?.querySelector('textarea')?.value??'',content:field('旧版 content')?.querySelector('textarea')?.value??'',
   addDisabled:editor?[...editor.querySelectorAll('button')].find(b=>b.textContent.trim()==='添加导航组件')?.disabled:null,
   imageButtons:editor?[...editor.querySelectorAll('button')].filter(b=>b.textContent.trim()==='从图库选择').map(b=>({disabled:b.disabled,text:b.textContent.trim()})):[],
   numberInputs:editor?[...editor.querySelectorAll('input[type=number]')].map(n=>({value:n.value,min:n.min,max:n.max,label:n.closest('.el-form-item')?.querySelector('.el-form-item__label')?.textContent.trim()})):[],preview:snapshotLayout(d)},
  widgets,images:[...d.querySelectorAll('img')].map(image),events:[...events],layouts:[...layouts],jsonEdits:[...jsonEdits],errors:[...errors],consoleErrors:[...consoleErrors]};
}
for(const b of document.querySelectorAll('[data-control]'))b.onclick=async()=>{b.disabled=true;try{const response=await fetch(boot.control+'/transport',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:b.dataset.control})});document.getElementById('result').textContent=await response.text();}finally{b.disabled=false;}};
for(const b of document.querySelectorAll('[data-stage]'))b.onclick=async()=>{b.disabled=true;try{
 const until=Date.now()+15000;for(;;){const state=await(await fetch(boot.control+'/state')).json();if(!state.pending)break;if(Date.now()>until)throw Error('actual API still pending');await new Promise(resolve=>setTimeout(resolve,100));}
 await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
 const response=await fetch(boot.control+'/checkpoint/'+b.dataset.stage,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(observe())});document.getElementById('result').textContent=JSON.stringify(await response.json());
 }catch(reason){document.getElementById('result').textContent=String(reason);}finally{b.disabled=false;}};
`;
