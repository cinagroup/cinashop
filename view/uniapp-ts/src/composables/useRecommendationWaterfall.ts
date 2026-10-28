import {computed,getCurrentInstance,nextTick,onScopeDispose,ref,watch} from 'vue';
import {onHide,onShow,onUnload} from '@dcloudio/uni-app';
import {useAuthStore} from '@/stores/auth';

type Entry<T>={item:T;index:number};
type Rect={top:number;bottom:number;dataset:Record<string,unknown>};
const integer=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:
 typeof value==='string'&&/^(?:0|[1-9]\d*)$/u.test(value)&&Number.isSafeInteger(Number(value))?Number(value):-1;
function rectangles(value:unknown):Rect[]|null {
 if(!Array.isArray(value))return null;
 const rows:Rect[]=[];
 for(const item of value){
  if(!item||typeof item!=='object')return null;
  const row=item as Record<string,unknown>;
  if(typeof row.top!=='number'||!Number.isFinite(row.top)||typeof row.bottom!=='number'||!Number.isFinite(row.bottom)||row.bottom<row.top||!row.dataset||typeof row.dataset!=='object')return null;
  rows.push({top:row.top,bottom:row.bottom,dataset:row.dataset as Record<string,unknown>});
 }
 return rows;
}

/** PHP's two independent stacks, with measured tail placement and stable append.
 * Every row stays rendered while measuring; no text-height estimates or timers. */
export function useRecommendationWaterfall<T extends{id:number}>(items:()=>readonly T[],allowed:()=>boolean){
 const auth=useAuthStore(),instance=getCurrentInstance(),sides=ref<number[]>([]),pending=ref(false),visible=ref(false);
 let disposed=false,revision=0,ids:number[]=[];
 const active=()=>visible.value&&!disposed&&allowed()&&auth.isLoggedIn&&auth.uid>0;
 const columns=computed<[Entry<T>[],Entry<T>[]]>(()=>{
  const result:[Entry<T>[],Entry<T>[]]=[[],[]];if(!active())return result;
  items().forEach((item,index)=>result[(sides.value[index]??index%2)===1?1:0].push({item,index}));return result;
 });
 function clear(){revision++;pending.value=false;ids=[];sides.value=[];}
 function reflow(){
  const ticket=++revision;pending.value=false;if(!active()){ids=[];sides.value=[];return;}
  const next=items().map(row=>row.id),previous=ids,append=previous.length>0&&next.length>previous.length&&previous.every((id,index)=>next[index]===id);
  const same=next.length===previous.length&&next.every((id,index)=>previous[index]===id);
  const retained=append||same;sides.value=next.map((_id,index)=>retained&&index<previous.length?sides.value[index]??index%2:index%2);ids=next;
  const base=next.length<3?next.length:next.length<=7?next.length-1:next.length-2,start=append?Math.max(previous.length,base):base;
  if(start>=next.length)return;
  const owner={uid:auth.uid,token:auth.token,version:auth.sessionVersion};
  const current=()=>ticket===revision&&active()&&auth.uid===owner.uid&&auth.token===owner.token&&auth.sessionVersion===owner.version&&items().length===next.length&&items().every((row,index)=>row.id===next[index]);
  pending.value=true;
  function measure(index:number){
   void nextTick(()=>{
    if(!current())return;
    if(!instance?.proxy||typeof uni.createSelectorQuery!=='function'){pending.value=false;return;}
    try{
     const query=uni.createSelectorQuery();query.in(instance.proxy);let measuredColumns:unknown,measuredCards:unknown;
     query.selectAll('.recommendation-column').fields({rect:true,size:true,dataset:true},value=>{measuredColumns=value;});
     query.selectAll('.recommendation-card').fields({rect:true,size:true,dataset:true},value=>{measuredCards=value;});
     query.exec(()=>{
      if(!current())return;
      const stacks=rectangles(measuredColumns),cards=rectangles(measuredCards);
      if(!stacks||stacks.length!==2||!cards||cards.length!==next.length){pending.value=false;return;}
      const tops=new Map<number,number>(),rects=new Map<number,Rect>();
      for(const row of stacks){const side=integer(row.dataset.levelColumn);if(side>1||side<0||tops.has(side)){pending.value=false;return;}tops.set(side,row.top);}
      for(const row of cards){const i=integer(row.dataset.levelProductIndex);if(i<0||i>=next.length||rects.has(i)||integer(row.dataset.levelProductId)!==next[i]||row.bottom<=row.top){pending.value=false;return;}rects.set(i,row);}
      const heights=[0,0];
      // Pending tail cards follow every considered index in each column. Their
      // presence cannot affect the measured bottom of the already placed prefix.
      for(let i=0;i<index;i++){const side=sides.value[i]===1?1:0;heights[side]=Math.max(heights[side]!,rects.get(i)!.bottom-tops.get(side)!);}
      const side=heights[0]! > heights[1]! ? 1 : 0;
      if(sides.value[index]!==side){const updated=sides.value.slice();updated[index]=side;sides.value=updated;}
      if(index+1<next.length)measure(index+1);else pending.value=false;
     });
    }catch{if(current())pending.value=false;}
   });
  }
  measure(start);
 }
 const resized=()=>reflow();
 function listen(){if(typeof uni.onWindowResize==='function')uni.onWindowResize(resized);}
 function unlisten(){if(typeof uni.offWindowResize==='function')uni.offWindowResize(resized);}
 watch(items,reflow,{flush:'post'});
 watch(()=>[auth.uid,auth.token,auth.sessionVersion,allowed()],()=>{clear();reflow();},{flush:'sync'});
 onShow(()=>{if(disposed)return;visible.value=true;clear();unlisten();listen();reflow();});
 function leave(){visible.value=false;unlisten();clear();}
 onHide(leave);onUnload(()=>{leave();disposed=true;});onScopeDispose(()=>{leave();disposed=true;});
 return{columns,pending,reflow};
}
