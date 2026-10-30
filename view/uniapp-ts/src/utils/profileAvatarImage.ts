import { nextTick, type ComponentPublicInstance } from 'vue';

export const PROFILE_AVATAR_CANVAS_ID='customer-profile-avatar-canvas';
const MAX_BYTES=10*1024*1024, LARGE_BYTES=2*1024*1024;
type AvatarFile={path:string;size:number};
type CanvasSize={width:number;height:number};

// These callbacks belong to one visible page/session and one selection. Native
// image APIs have no abort handle; reject our wait and ignore their late replies.
export function createProfileAvatarPreparation(active:()=>boolean,resize:(size:CanvasSize)=>void,instance?:ComponentPublicInstance|null){
  let cancelled=false;
  const pending=new Set<()=>void>();
  const live=()=>!cancelled&&active();
  function check(){if(!live())throw Error('头像选择已失效，请重新选择');}
  function wait<T>(start:(resolve:(value:T)=>void,reject:()=>void)=>void,timeout:number|null=60_000):Promise<T>{
    return new Promise((resolve,reject)=>{
      if(!live()){reject(Error('头像选择已失效，请重新选择'));return;}
      let settled=false;
      const finish=(value:T|undefined,reason?:string)=>{
        if(settled)return;settled=true;clearTimeout(timer);pending.delete(cancel);
        if(reason||!live())reject(Error(reason??'头像选择已失效，请重新选择'));else resolve(value as T);
      };
      const cancel=()=>finish(undefined,'头像选择已失效，请重新选择');
      const timer=timeout===null?undefined:setTimeout(()=>finish(undefined,'头像图片处理超时，请重新选择'),timeout);
      pending.add(cancel);
      try{start(value=>finish(value),()=>finish(undefined,'头像图片处理失败，请重新选择'));}
      catch{finish(undefined,'头像图片处理失败，请重新选择');}
    });
  }
  function path(value:unknown):string{
    // H5 canvas returns a base64 JPEG; native platforms return a temporary path.
    if(typeof value!=='string'||!value||value.length>Math.ceil(MAX_BYTES/3)*4+8192||/[\u0000-\u001f\u007f]/u.test(value))throw Error('头像图片路径无效，请重新选择');
    return value;
  }
  function size(value:number){if(!Number.isSafeInteger(value)||value<=0||value>MAX_BYTES)throw Error('请选择10 MiB以内的头像图片');}
  async function localFile(filePath:string):Promise<AvatarFile>{
    check();
    const info=await wait<UniNamespace.GetFileInfoSuccess>((resolve,reject)=>uni.getFileInfo({filePath,success:resolve,fail:reject}));
    check();size(info.size);return{path:filePath,size:info.size};
  }
  async function choose():Promise<AvatarFile|null>{
    // Waiting for the user has no processing deadline (as in the PHP chooser).
    // Page/session invalidation or explicit cancellation still aborts this wait.
    return wait<AvatarFile|null>((resolve,reject)=>uni.chooseImage({count:1,sizeType:['compressed'],sourceType:['album','camera'],
      success:value=>{
        if(!Array.isArray(value.tempFilePaths)||value.tempFilePaths.length!==1||!Array.isArray(value.tempFiles)||value.tempFiles.length!==1){reject();return;}
        try{resolve({path:path(value.tempFilePaths[0]),size:value.tempFiles[0]!.size});}catch{reject();}
      },
      fail:value=>value.errMsg?.includes('cancel')?resolve(null):reject(),
    }),null);
  }
  async function prepare(file:AvatarFile):Promise<string>{
    check();size(file.size);
    const info=await wait<UniNamespace.GetImageInfoSuccessData>((resolve,reject)=>uni.getImageInfo({src:file.path,success:resolve,fail:reject}));
    check();
    const source=path(info.path);
    if(!Number.isSafeInteger(info.width)||info.width<=0||!Number.isSafeInteger(info.height)||info.height<=0)throw Error('头像图片尺寸无效，请重新选择');
    if(file.size<=LARGE_BYTES)return source;
    // Match PHP uploadImageChange: only files above 2 MiB are re-encoded,
    // cap width at 750, preserve aspect ratio, export JPEG at quality 0.7.
    const width=Math.min(info.width,750),height=info.height*width/info.width;
    resize({width,height});await nextTick();check();
    const context=uni.createCanvasContext(PROFILE_AVATAR_CANVAS_ID,instance??undefined);
    context.clearRect(0,0,width,height);context.drawImage(source,0,0,width,height);
    await wait<void>((resolve)=>context.draw(false,()=>resolve()));
    check();
    const output=await wait<UniNamespace.CanvasToTempFilePathRes>((resolve,reject)=>uni.canvasToTempFilePath({
      canvasId:PROFILE_AVATAR_CANVAS_ID,x:0,y:0,width,height,destWidth:width,destHeight:height,fileType:'jpg',quality:0.7,
      success:resolve,fail:reject,
    },instance??undefined));
    check();
    return(await localFile(path(output.tempFilePath))).path;
  }
  async function native(event:unknown):Promise<string>{
    const value=(event as {detail?:{avatarUrl?:unknown}})?.detail?.avatarUrl;
    return(await localFile(path(value))).path;
  }
  return{choose,prepare,native,abort(){cancelled=true;for(const cancel of [...pending])cancel();}};
}
