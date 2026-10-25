/** Read-only DOM observations and explicit persisted-session transport only.
 * No application methods, synthetic application events or business DTO writes. */
export const stateAuthorObserver = String.raw`
const boot=__BOOTSTRAP__,frame=document.querySelector('iframe');
let loaded=false,errors=[],consoleErrors=[],events=[],styles=[],selections=[],jsonEdits=[],removeListeners=()=>{},actorRoute='admin',frameEpoch=0;
const visible=n=>!!n&&n.getClientRects().length>0&&n.ownerDocument.defaultView.getComputedStyle(n).visibility!=='hidden';
const box=n=>{if(!n)return null;const r=n.getBoundingClientRect();return{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
const ready=(w,d)=>w===frame.contentWindow&&d===frame.contentDocument&&d?.readyState==='complete'&&w.location.origin===location.origin;
const image=n=>({src:n.currentSrc||n.src||'',complete:!!n.complete,naturalWidth:n.naturalWidth||0,naturalHeight:n.naturalHeight||0,box:box(n)});
function snapshotStyle(d){const editor=[...d.querySelectorAll('.state-author-editor')].find(visible),p=editor?.querySelector('.state-author-preview');if(!p)return null;
 const labelled=editor.querySelector('[aria-label="选择会员权益组件"]'),selector=labelled?.closest('.el-select')||labelled,caption=selector?.querySelector('.el-select__selected-item:not(.el-select__input-wrapper)')?.textContent||labelled?.value||selector?.querySelector('input')?.value||'',match=/第\s*(\d+)\s*项/u.exec(caption);
 return{kind:p.dataset.kind,style:Number(p.dataset.style),index:match?Number(match[1])-1:null,actorRoute,frameEpoch,box:box(p),rendered:!!p.querySelector('.member,.bonus,.sign,.ranks'),text:p.textContent.trim(),images:[...p.querySelectorAll('img')].map(image),metrics:p.querySelectorAll('.metrics>div').length,week:p.querySelectorAll('.week>div').length,rankGroups:p.querySelectorAll('.rank-card').length,hidden:p.textContent.includes('发布时隐藏此组件')};}
frame.onload=()=>{removeListeners();frameEpoch++;const w=frame.contentWindow,d=frame.contentDocument;
 const update=()=>{loaded=ready(w,d);},error=e=>errors.push({kind:'error',message:String(e.message)}),rejection=e=>errors.push({kind:'unhandledrejection',message:String(e.reason)}),previous=w.console.error;
 const log=(...args)=>{consoleErrors.push(args.map(String).join(' '));previous.apply(w.console,args);};w.console.error=log;let trusted=false;
 const capture=()=>{const p=snapshotStyle(d);if(!trusted||!p)return;const key=JSON.stringify([p.actorRoute,p.frameEpoch,p.kind,p.style,p.index,p.rendered,p.hidden]);if(!styles.some(row=>row.captureKey===key))styles.push({...p,captureKey:key,trusted:true,source:'actual DOM after trusted GUI interaction'});if(p.index!==null&&!selections.some(row=>row.frameEpoch===p.frameEpoch&&row.index===p.index))selections.push({kind:p.kind,index:p.index,hidden:p.hidden,frameEpoch:p.frameEpoch,actorRoute,trusted:true});};
 const observer=new w.MutationObserver(()=>w.requestAnimationFrame(capture));observer.observe(d.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['data-kind','data-style','src']});
 const event=e=>{const n=e.target,label=n.closest?.('.el-form-item')?.querySelector('.el-form-item__label')?.textContent.trim()||'';
  if(n.matches?.('textarea')&&label==='装修 value'&&e.type==='input')jsonEdits.push({type:e.type,trusted:e.isTrusted,frameEpoch});
  if(n.closest?.('.state-author-editor,.el-dialog,.el-select-dropdown')&&['click','input','change','focusin','focusout'].includes(e.type))events.push({type:e.type,trusted:e.isTrusted,label,text:n.closest?.('button')?.textContent.trim().slice(0,160)||'',value:n.matches?.('input')?n.value:undefined,option:n.closest?.('.el-select-dropdown__item')?.textContent.trim()||'',frameEpoch,actorRoute});
  if(e.isTrusted&&['click','input','change','focusin','focusout'].includes(e.type)){trusted=true;w.requestAnimationFrame(()=>w.requestAnimationFrame(capture));}
 };
 for(const type of ['click','input','change','focusin','focusout'])d.addEventListener(type,event,true);w.addEventListener('hashchange',update);w.addEventListener('error',error);w.addEventListener('unhandledrejection',rejection);update();
 removeListeners=()=>{for(const type of ['click','input','change','focusin','focusout'])d.removeEventListener(type,event,true);w.removeEventListener('hashchange',update);w.removeEventListener('error',error);w.removeEventListener('unhandledrejection',rejection);observer.disconnect();if(w.console.error===log)w.console.error=previous;};
};
window.addEventListener('pagehide',()=>removeListeners());
function navigate(target){loaded=false;errors=[];consoleErrors=[];const href=new URL(target,location.href).href;if(frame.contentWindow.location.href===href)frame.contentWindow.location.reload();else frame.src=href;}
function adminSession(route){const s=boot.sessions[route];localStorage.setItem('admin_token',s.token);localStorage.setItem('admin_session',JSON.stringify(s.session));actorRoute=route;frame.style.width='1200px';navigate('/content/dise');}
for(const b of document.querySelectorAll('[data-route]'))b.onclick=()=>{const route=b.dataset.route;if(['admin','minimal','reader'].includes(route)){adminSession(route);return;}
 actorRoute=route;const uid=route==='user11'?11:route==='user22'?22:0,token=uid===11?boot.user11:uid===22?boot.user22:'';
 if(uid){localStorage.setItem('uni_token',JSON.stringify({type:'string',data:token}));localStorage.setItem('uni_uid',JSON.stringify({type:'number',data:uid}));}else{localStorage.removeItem('uni_token');localStorage.removeItem('uni_uid');}
 for(const key of Object.keys(localStorage))if(key.startsWith('cinashop_diy_page_v1_'))localStorage.removeItem(key);
 frame.style.width='375px';navigate((route==='micro'?'/__h5?state_author=2':'/__h5?state_author='+uid)+'#'+(route==='micro'?'/pages/diy/detail?id=2':'/pages/index/index'));
};
function observe(){const w=frame.contentWindow,d=frame.contentDocument,dialog=[...d.querySelectorAll('.el-dialog')].find(n=>visible(n)&&n.querySelector('.state-author-editor'));
 const field=label=>dialog?[...dialog.querySelectorAll('.el-form-item')].find(n=>n.querySelector('.el-form-item__label')?.textContent.trim()===label):null,editor=dialog?.querySelector('.state-author-editor'),txt=n=>n?.textContent.trim()||'';
 const widgets=[...d.querySelectorAll('.diy-state-widget')].filter(visible).map(n=>({kind:n.dataset.kind,key:n.dataset.componentKey,style:Number(n.dataset.style),box:box(n),text:txt(n),error:txt(n.querySelector('.diy-state-error')),images:[...n.querySelectorAll('img')].map(image),
  member:{name:txt(n.querySelector('.diy-member-name')),badge:txt(n.querySelector('.diy-member-badge')),progress:n.querySelector('.diy-member-progress-fill')?.style.width||'',metrics:[...n.querySelectorAll('.diy-member-action')].map(m=>({action:m.dataset.action,value:txt(m.querySelector('.diy-member-count'))}))},
  newcomer:{points:txt(n.querySelector('.diy-newcomer-points')),coupons:[...n.querySelectorAll('.diy-coupon')].map(c=>({id:Number(c.dataset.couponId),text:txt(c)})),products:[...n.querySelectorAll('.diy-newcomer-product')].map(p=>Number(p.dataset.productId))},
  sign:{days:[...n.querySelectorAll('.diy-sign-day')].map(day=>({day:day.dataset.day,signed:day.classList.contains('signed'),today:day.classList.contains('today')})),reward:txt(n.querySelector('.diy-sign-next-reward')),button:txt(n.querySelector('.diy-sign-destination'))},
  rank:{title:txt(n.querySelector('.diy-state-title')),titleImage:n.querySelector('.diy-state-title-image')?[...n.querySelectorAll('.diy-state-title-image img')].map(image):[],groups:[...n.querySelectorAll('.diy-rank-group')].map(g=>({key:g.dataset.rank,products:[...g.querySelectorAll('.diy-rank-product')].map(p=>Number(p.dataset.productId))}))}}));
 return{loaded:loaded&&ready(w,d),href:w.location.href,actorRoute,frameEpoch,clientWidth:d.documentElement.clientWidth,scrollWidth:d.documentElement.scrollWidth,bodyText:d.body.innerText,
  admin:{dialog:!!dialog,editor:!!editor,value:field('装修 value')?.querySelector('textarea')?.value??'',content:field('旧版 content')?.querySelector('textarea')?.value??'',addDisabled:editor?[...editor.querySelectorAll('button')].find(b=>b.textContent.trim()==='添加会员权益组件')?.disabled:null,
   imageButtons:editor?[...editor.querySelectorAll('button')].filter(b=>b.textContent.trim()==='从图库选择').map(b=>({disabled:b.disabled,text:b.textContent.trim()})):[],preview:snapshotStyle(d),numberInputs:editor?[...editor.querySelectorAll('input[type=number]')].map(n=>({value:n.value,min:n.min,max:n.max,label:n.closest('.el-form-item')?.querySelector('.el-form-item__label')?.textContent.trim()})):[]},
  widgets,images:[...d.querySelectorAll('img')].map(image),events:[...events],styles:[...styles],selections:[...selections],jsonEdits:[...jsonEdits],errors:[...errors],consoleErrors:[...consoleErrors]};
}
for(const b of document.querySelectorAll('[data-control]'))b.onclick=async()=>{b.disabled=true;try{const response=await fetch(boot.control+'/transport',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:b.dataset.control})});const result=await response.json();document.getElementById('result').textContent=JSON.stringify(result);if(result.session){boot.sessions.minimal.session=result.session;adminSession('minimal');}}finally{b.disabled=false;}};
for(const b of document.querySelectorAll('[data-stage]'))b.onclick=async()=>{b.disabled=true;try{
 const until=Date.now()+15000;for(;;){const state=await(await fetch(boot.control+'/state')).json();if(!state.pending)break;if(Date.now()>until)throw Error('actual API still pending');await new Promise(resolve=>setTimeout(resolve,100));}
 await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
 const response=await fetch(boot.control+'/checkpoint/'+b.dataset.stage,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(observe())});document.getElementById('result').textContent=JSON.stringify(await response.json());
 }catch(reason){document.getElementById('result').textContent=String(reason);}finally{b.disabled=false;}};
`;
