import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { apiMembershipRightAuthorPage, apiSaveMembershipRightMetadata, apiSetMembershipRightStatus, apiSaveMembershipRightContent,
  membershipRightMetadata, type MembershipRightAuthorRow, type MembershipRightDraft } from '@/api/membershipRights';
import { useMembershipPlanOwner } from './useMembershipPlanOwner';
import { memberRightImage, memberRightMediaDeadline } from '../../../common/memberRightMedia';
const empty = (): MembershipRightDraft => ({ id:0, right_type:'', title:'', show_title:'', image:'', explain:'', number:1, sort:0, status:1 });
export function useMembershipRights() {
  const owner=useMembershipPlanOwner(), rights=ref<MembershipRightAuthorRow[]>([]), rightPage=ref(1), rightCount=ref(0);
  const rightLoading=ref(false), rightSaving=ref(false), rightStatusId=ref(0), rightError=ref(''), rightBlocked=ref(false);
  const rightDialog=ref(false), contentDialog=ref(false), rightForm=reactive(empty()), rightContent=ref(''), rightContentPreview=ref('');
  const rightPreview=ref(''), mediaClock=ref(0), editorClock=ref(0), failed=ref<string[]>([]);
  let alive=false, activated=false, generation=0, controller:AbortController|undefined, timer:ReturnType<typeof setTimeout>|undefined;
  let editorOwner='', base:MembershipRightAuthorRow|undefined;
  const rightBusy=computed(()=>rightLoading.value||rightSaving.value||rightStatusId.value>0);
  const current=(stamp:string)=>alive&&owner.current(stamp);
  const editorKey=computed(()=>`${editorClock.value}:${editorOwner}:${base?.id??0}:${base?.version??'absent'}`);
  const editorStale=computed(()=>{void editorClock.value;return !!base&&!rights.value.includes(base);});
  const canSaveRight=computed(()=>owner.canManage.value&&!rightBusy.value&&!rightBlocked.value&&!editorStale.value);
  function closeRight(){ editorClock.value++; rightDialog.value=contentDialog.value=false; editorOwner='';base=undefined;Object.assign(rightForm,empty());rightContent.value=rightContentPreview.value=rightPreview.value=''; }
  function requestCloseRight(){if(!rightSaving.value)closeRight();}
  function reset(){generation++;controller?.abort();controller=undefined;clearTimeout(timer);timer=undefined;rights.value=[];rightCount.value=0;rightPage.value=1;rightLoading.value=rightSaving.value=false;rightStatusId.value=0;rightError.value='';rightBlocked.value=false;failed.value=[];closeRight();mediaClock.value++;}
  function schedule(){
    clearTimeout(timer);timer=undefined;mediaClock.value++;
    const deadlines=[...rights.value.map(v=>memberRightMediaDeadline([v.image_preview],[v.content_preview])),memberRightMediaDeadline([rightPreview.value],[])].filter((v):v is number=>v!==null&&v>Date.now());
    const until=deadlines.length?Math.min(...deadlines):null;
    if(until!==null){const stamp=owner.stamp();timer=setTimeout(()=>{if(current(stamp))schedule();},Math.min(2147483647,Math.max(1,until-Date.now()+1)));}
  }
  async function loadRights(page=rightPage.value):Promise<boolean>{
    activated=true;if(!alive||!owner.has()||rightSaving.value||rightStatusId.value||!Number.isInteger(page)||page<1||page>3334)return false;
    const stamp=owner.stamp(),ticket=++generation;controller?.abort();const abort=new AbortController();controller=abort;rightLoading.value=true;rightError.value='';
    let timeout:ReturnType<typeof setTimeout>|undefined;
    const deadline=new Promise<never>((_,reject)=>{timeout=setTimeout(()=>{reject(Error('权益读取超时，请重新读取'));abort.abort();},12000);});
    const valid=()=>ticket===generation&&current(stamp);
    try{
      let target=page,data=await Promise.race([apiMembershipRightAuthorPage(target,owner.auth.userInfo!.id,abort.signal),deadline]);
      if(!valid()||abort.signal.aborted)return false;
      const last=Math.max(1,Math.ceil(data.count/30));if(target>last){target=last;data=await Promise.race([apiMembershipRightAuthorPage(target,owner.auth.userInfo!.id,abort.signal),deadline]);}
      if(!valid()||abort.signal.aborted)return false;
      rights.value=data.list;rightCount.value=data.count;rightPage.value=target;rightBlocked.value=false;failed.value=[];schedule();editorClock.value++;return true;
    }catch(reason){if(valid())rightError.value=reason instanceof Error?reason.message:'会员权益读取失败';return false;}
    finally{clearTimeout(timeout);if(valid()){rightLoading.value=false;if(controller===abort)controller=undefined;}}
  }
  function writable(){return owner.has('paid_membership.manage')&&!rightBusy.value&&!rightBlocked.value;}
  function openRight(row?:MembershipRightAuthorRow,content=false){
    if(!writable()||row&&!rights.value.includes(row)||content&&!row)return;
    closeRight();base=row;editorOwner=owner.stamp();editorClock.value++;
    Object.assign(rightForm,row?{id:row.id,right_type:row.right_type,title:row.title,show_title:row.show_title,image:row.image,explain:row.explain,number:row.number,sort:row.sort,status:row.status===1?1:0}:empty());
    rightPreview.value=row?.image_preview??'';rightContent.value=row?.content??'';rightContentPreview.value=row?.content_preview??'';
    if(content)contentDialog.value=true;else rightDialog.value=true;
  }
  const chooseRightImage=computed(()=>{const key=editorKey.value,stamp=editorOwner;return(reference:string,preview:string)=>{
    if(!rightDialog.value||!writable()||!current(stamp)||key!==editorKey.value||!memberRightImage(reference,preview))return;
    rightForm.image=reference;rightPreview.value=preview;schedule();
  };});
  const rightIcon=computed(()=>{void mediaClock.value;return memberRightImage(rightForm.image,rightPreview.value);});
  const rightItems=computed(()=>{void mediaClock.value;return rights.value.map(row=>{
    const src=memberRightImage(row.image,row.image_preview),stamp=owner.stamp(),ticket=generation;
    return{...row,original:row,preview:failed.value.includes(src)?'':src,imageError:()=>{if(src&&current(stamp)&&ticket===generation&&rights.value.includes(row)&&!failed.value.includes(src))failed.value.push(src);}};
  });});
  async function write(work:(signal:AbortSignal)=>Promise<{id:number;version:string}>,kind:'metadata'|'content'|'status',row?:MembershipRightAuthorRow){
    if(!writable()||row&&!rights.value.includes(row)||kind!=='status'&&(!current(editorOwner)||editorStale.value))return;
    const stamp=owner.stamp(),editor=editorKey.value;
    if(kind==='status')rightStatusId.value=row!.id;else rightSaving.value=true;
    const abort=new AbortController();controller=abort;let timeout:ReturnType<typeof setTimeout>|undefined,confirmed=false;
    try{
      await Promise.race([work(abort.signal),new Promise<never>((_,reject)=>{timeout=setTimeout(()=>{reject(Error('保存结果未确认'));abort.abort();},15000);})]);
      if(!current(stamp)||kind!=='status'&&editor!==editorKey.value)return;
      confirmed=true;rightBlocked.value=true;closeRight();ElMessage.success('会员权益已保存，正在重新读取');
    }catch(reason){if(current(stamp)){rightBlocked.value=true;rightError.value=`${reason instanceof Error?reason.message:'保存结果未确认'}。请重新读取核对后再编辑；当前草稿已保留。`;}}
    finally{clearTimeout(timeout);if(controller===abort)controller=undefined;if(current(stamp)){rightSaving.value=false;rightStatusId.value=0;if(confirmed)await loadRights();}}
  }
  async function saveRight(){
    if(!rightDialog.value||!canSaveRight.value)return;
    try{const data=membershipRightMetadata(rightForm,base);if(!base&&!data.image)throw Error('请选择权益图标');
      const id=base?.id??0,version=base?.version??'absent',status=rightForm.status;
      await write(signal=>apiSaveMembershipRightMetadata(id,version,data,status,signal),'metadata');
    }catch(reason){ElMessage.warning(reason instanceof Error?reason.message:'请核对权益资料');}
  }
  async function saveContent(){if(!contentDialog.value||!canSaveRight.value||!base)return;const id=base.id,version=base.version,content=rightContent.value;await write(signal=>apiSaveMembershipRightContent(id,version,content,signal),'content');}
  async function toggleRight(row:MembershipRightAuthorRow,enabled:string|number|boolean){if(typeof enabled!=='boolean'||!writable()||!rights.value.includes(row)||row.status===(enabled?1:0))return;await write(signal=>apiSetMembershipRightStatus(row.id,row.version,enabled?1:0,signal),'status',row);}
  watch(owner.identity,()=>{reset();if(alive&&activated&&owner.has())void loadRights(1);},{flush:'sync'});
  onMounted(()=>{alive=true;});onBeforeUnmount(()=>{alive=false;reset();});
  return{rights,rightItems,rightPage,rightCount,rightLoading,rightSaving,rightStatusId,rightBusy,rightError,rightBlocked,rightDialog,contentDialog,rightForm,rightContent,rightContentPreview,rightIcon,editorKey,editorStale,canSaveRight,
    canViewRights:owner.canView,canManageRights:owner.canManage,loadRights,openRight,closeRight,requestCloseRight,saveRight,saveContent,toggleRight,chooseRightImage};
}
