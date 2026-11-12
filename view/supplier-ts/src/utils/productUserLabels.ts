export interface SupplierUserLabelEntry { id:number; title:string; available:boolean }
export interface SupplierUserLabelSelection { version:1; ids:number[]; entries:SupplierUserLabelEntry[]; consistent:boolean; truncated:boolean }
export interface SupplierUserLabelOption { id:number; title:string }
export interface SupplierUserLabelCatalog { version:1; list:Array<{id:number;title:string}>; count:number; page:number; limit:number; runtime_configured:boolean }
export interface ProductUserLabelEditor {ready:boolean; changed:boolean; ids:number[]; selection:SupplierUserLabelSelection|null}
export function productUserLabelIds(raw:unknown):number[] {
  if (!Array.isArray(raw) || raw.length>100 || raw.some(id=>typeof id!=='number'||!Number.isSafeInteger(id)||id<=0||id>2147483647)
    || new Set(raw).size!==raw.length || raw.join(',').length>64) throw Error('用户标签编号不可重复，总长度最多64字符');
  return [...raw];
}
export function productUserLabelEditor(raw?:unknown,creating=false):ProductUserLabelEditor {
  if(raw===undefined)return{ready:creating,changed:false,ids:[],selection:null};
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('购买用户标签响应无效');
  const row=raw as SupplierUserLabelSelection,ids=productUserLabelIds(row.ids);
  if(Object.keys(row).length!==5||row.version!==1||typeof row.consistent!=='boolean'||typeof row.truncated!=='boolean'
    ||!Array.isArray(row.entries)||row.entries.length!==ids.length||row.entries.some((entry,i)=>!entry||entry.id!==ids[i]
      ||typeof entry.title!=='string'||[...entry.title].length>255||typeof entry.available!=='boolean'))throw Error('购买用户标签响应无效');
  return{ready:true,changed:false,ids,selection:row};
}
export function productUserLabelPayload(editor:ProductUserLabelEditor):{label_id?:number[]} {
  return editor.ready&&editor.changed?{label_id:productUserLabelIds(editor.ids)}:{};
}
export function productUserLabelCatalog(raw:unknown):SupplierUserLabelCatalog {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('用户标签目录响应无效');
  const row=raw as SupplierUserLabelCatalog;
  if(Object.keys(row).length!==6||row.version!==1||!Number.isSafeInteger(row.count)||row.count<0||typeof row.runtime_configured!=='boolean'
    ||!Number.isSafeInteger(row.page)||row.page<1||!Number.isSafeInteger(row.limit)||row.limit<1||row.limit>50||!Array.isArray(row.list)
    ||row.list.length>row.limit||new Set(row.list.map(x=>x.id)).size!==row.list.length||row.list.some(x=>!x||!Number.isSafeInteger(x.id)||x.id<=0||x.id>2147483647
      ||typeof x.title!=='string'||[...x.title].length>255))throw Error('用户标签目录响应无效');
  return row;
}
