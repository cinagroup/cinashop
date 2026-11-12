export interface ProductSettingsSelection {version:1;command_word:string;video_open:number}
export interface ProductSettingsEditor {ready:boolean;commandWord:string;videoOpen:number;commandChanged:boolean;videoChanged:boolean}
export function productSettingsEditor(raw?:unknown,creating=false):ProductSettingsEditor {
  if(raw===undefined)return{ready:creating,commandWord:'',videoOpen:0,commandChanged:false,videoChanged:false};
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('商品口令与视频设置响应无效');
  const row=raw as ProductSettingsSelection;
  // Legacy text is displayed but never resubmitted until deliberately edited.
  if(Object.keys(row).length!==3||row.version!==1||typeof row.command_word!=='string'||[...row.command_word].length>255
    ||!Number.isSafeInteger(row.video_open))throw Error('商品口令与视频设置响应无效');
  return{ready:true,commandWord:row.command_word,videoOpen:row.video_open,commandChanged:false,videoChanged:false};
}
export function productCommandWord(raw:unknown):string {
  if(typeof raw!=='string'||[...raw.trim()].length>255||/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(raw))throw Error('商品口令最多255字符，不能含换行或控制字符');
  return raw.trim();
}
export function productSettingsPayload(editor:ProductSettingsEditor):{command_word?:string;video_open?:0|1} {
  if(!editor.ready)return{};
  if(editor.videoChanged&&editor.videoOpen!==0&&editor.videoOpen!==1)throw Error('商品视频开关无效');
  return{...(editor.commandChanged?{command_word:productCommandWord(editor.commandWord)}:{}),...(editor.videoChanged?{video_open:editor.videoOpen as 0|1}:{})};
}
