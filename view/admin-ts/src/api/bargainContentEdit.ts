export interface BargainEditorContent { title:string; info:string; unitName:string; images:string[]; description:string }
export interface BargainContentForm { title:string; info:string; unitName:string; imageLines:string; description:string }
export function contentForm(value?: BargainEditorContent | null): BargainContentForm {
  return {title:value?.title ?? '',info:value?.info ?? '',unitName:value?.unitName ?? '',imageLines:value?.images.join('\n') ?? '',description:value?.description ?? ''};
}
export function withBargainContent(payload:Record<string,unknown>,form:BargainContentForm,original:BargainContentForm|null,ready:boolean) {
  if(!ready)return payload; // Fields remain disabled until the existing content is read.
  const result={...payload};
  for(const key of ['title','info','unitName','description'] as const)if(!original||form[key]!==original[key])result[key]=form[key];
  if(!original||form.imageLines!==original.imageLines){
    result.images=form.imageLines.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
    delete result.image; // Backend derives the main image from the first gallery entry.
  }
  return result;
}
