import type { DiyPresentationHtmlNode } from '../../../common/diyPresentationHtml';
type Element = Extract<DiyPresentationHtmlNode, { type:'node' }>;
export type PresentationRichStyle = Record<string,string>;
const element = (node:DiyPresentationHtmlNode,name?:string):node is Element => node.type==='node'&&(!name||node.name===name);
/** Native wrappers need the same semantic defaults as their passive rich-text
 * siblings; authored safe CSS is applied after these defaults by the component. */
export function presentationRichStyle(node:DiyPresentationHtmlNode):PresentationRichStyle {
  if(!element(node))return {};
  const tag=node.name,style:PresentationRichStyle={};
  if('a abbr b bdi bdo big cite code del em font i ins label mark q rt ruby s small span strong sub sup tt u'.split(' ').includes(tag))style.display='inline';
  if(['b','strong','th'].includes(tag))style.fontWeight='bold';
  if(['i','em','cite','address'].includes(tag))style.fontStyle='italic';
  if(['u','ins'].includes(tag))style.textDecoration='underline';
  if(['s','del'].includes(tag))style.textDecoration='line-through';
  if(['code','tt','pre'].includes(tag))style.fontFamily='monospace';
  if(tag==='mark'){style.backgroundColor='yellow';style.color='black';}
  if(tag==='big')style.fontSize='larger';
  if(['small','sub','sup','rt'].includes(tag))style.fontSize='smaller';
  if(tag==='sub')style.verticalAlign='sub';if(tag==='sup')style.verticalAlign='super';
  if(tag==='bdi')style.unicodeBidi='isolate';if(tag==='bdo')style.unicodeBidi='bidi-override';
  if(node.attrs.dir)style.direction=node.attrs.dir;
  if(tag==='p')style.margin='1em 0';if(tag==='center')style.textAlign='center';
  if(/^h[1-6]$/u.test(tag)){const index=Number(tag[1])-1;style.fontSize=['2em','1.5em','1.17em','1em','.83em','.67em'][index]!;style.margin=['.67em 0','.83em 0','1em 0','1.33em 0','1.67em 0','2.33em 0'][index]!;style.fontWeight='bold';}
  if(tag==='pre'){style.whiteSpace='pre-wrap';style.margin='1em 0';}
  if(tag==='blockquote')style.margin='1em 40px';
  if(['ul','ol'].includes(tag)){style.margin='1em 0';style.paddingLeft='40px';}
  return style;
}
function alpha(value:number):string {let text='';while(value>0){value--;text=String.fromCharCode(65+value%26)+text;value=Math.floor(value/26);}return text;}
function roman(value:number):string {let text='';for(const [amount,glyph]of [[1000,'M'],[900,'CM'],[500,'D'],[400,'CD'],[100,'C'],[90,'XC'],[50,'L'],[40,'XL'],[10,'X'],[9,'IX'],[5,'V'],[4,'IV'],[1,'I']] as const)while(value>=amount){text+=glyph;value-=amount;}return text;}
export function presentationListItems(node:DiyPresentationHtmlNode):Array<{marker:string;node:DiyPresentationHtmlNode;children:DiyPresentationHtmlNode[]}> {
  if(!element(node)||!['ol','ul'].includes(node.name))return [];
  let index=/^-?\d{1,4}$/u.test(node.attrs.start??'')?Number(node.attrs.start):1;const type=node.attrs.type??'1';
  return node.children.map(child=>{if(!element(child,'li'))return {marker:'',node:child,children:[child]};let marker='•';
    if(node.name==='ol'){let label=String(index);if(index>0&&['A','a'].includes(type))label=alpha(index);if(index>0&&index<=3999&&['I','i'].includes(type))label=roman(index);if(['a','i'].includes(type))label=label.toLowerCase();marker=label+'.';index++;}
    return {marker,node:child,children:child.children};
  });
}
type GridCell={node:Element;row:number;column:number;rowSpan:number;columnSpan:number;style:PresentationRichStyle;rowStyle:string;sectionStyle:string};
type GridLayout={columns:number;style:PresentationRichStyle;cells:GridCell[]};
/** Grid spans are real CSS placement, never inert colspan attributes on views.
 * All cells of an interactive table pass this same placement algorithm, including
 * passive siblings. Sparse active intervals avoid a rows×columns bitmap. */
export function presentationTableGrid(node:DiyPresentationHtmlNode):GridLayout {
  if(!element(node,'table'))return {columns:0,style:{},cells:[]};
  const rows:Array<{node:Element;group:number;sectionStyle:string;rank:number;order:number}>=[],captions:Element[]=[],widths:string[]=[];let groups=0;
  function gather(children:DiyPresentationHtmlNode[],group:number,sectionStyle='',rank=1){
    for(const child of children){if(!element(child))continue;if(child.name==='tr')rows.push({node:child,group,sectionStyle,rank,order:rows.length});
      else if(['thead','tbody','tfoot'].includes(child.name))gather(child.children,++groups,child.attrs.style??'',child.name==='thead'?0:child.name==='tfoot'?2:1);
      else if(child.name==='caption')captions.push(child);
      else if(child.name==='colgroup')gather(child.children,group,sectionStyle,rank);
      else if(child.name==='col'){const styled=/(?:^|;)\s*width:([^;]+)/u.exec(child.attrs.style??'')?.[1],raw=styled??child.attrs.width??'';widths.push(/^(?:[1-9]\d{0,3})(?:px|%)?$/u.test(raw)?(/\D$/u.test(raw)?raw:raw+'px'):'minmax(0, 1fr)');}
    }
  }
  gather(node.children,0);rows.sort((a,b)=>a.rank-b.rank||a.order-b.order);const groupEnds:number[]=[];for(let index=rows.length-1;index>=0;index--)groupEnds[index]=index+1<rows.length&&rows[index+1]!.group===rows[index]!.group?groupEnds[index+1]!:index+1;const cells:GridCell[]=[];let columns=Math.max(1,widths.length),active:Array<{from:number;to:number;until:number}>=[];
  for(const [r,row]of rows.entries()){
    active=active.filter(span=>span.until>r);let cursor=1,at=0;const added:typeof active=[];
    const groupRows=groupEnds[r]!-r;
    for(const cell of row.node.children){if(!element(cell)||!['td','th'].includes(cell.name))continue;
      const span=(value:string|undefined)=>value&&/^[1-9]\d?$/u.test(value)?Number(value):1,columnSpan=span(cell.attrs.colspan),rowSpan=Math.min(span(cell.attrs.rowspan),groupRows);
      for(;;){while(at<active.length&&active[at]!.to<cursor)at++;const overlap=active[at];if(overlap&&overlap.from<cursor+columnSpan){cursor=overlap.to+1;at++;}else break;}
      cells.push({node:cell,row:r+captions.length+1,column:cursor,rowSpan,columnSpan,sectionStyle:row.sectionStyle,rowStyle:row.node.attrs.style??'',style:{gridColumn:`${cursor} / span ${columnSpan}`,gridRow:`${r+captions.length+1} / span ${rowSpan}`,minWidth:'0',boxSizing:'border-box'}});
      if(rowSpan>1)added.push({from:cursor,to:cursor+columnSpan-1,until:r+rowSpan});columns=Math.max(columns,cursor+columnSpan-1);cursor+=columnSpan;
    }
    // Both lists are ordered and disjoint within the next row.
    const merged:typeof active=[];let a=0,b=0;while(a<active.length||b<added.length){if(b>=added.length||a<active.length&&active[a]!.from<added[b]!.from)merged.push(active[a++]!);else merged.push(added[b++]!);}active=merged;
  }
  const captionCells:GridCell[]=captions.map((caption,index)=>({node:caption,row:index+1,column:1,rowSpan:1,columnSpan:columns,rowStyle:'',sectionStyle:'',style:{gridColumn:`1 / span ${columns}`,gridRow:`${index+1} / span 1`,minWidth:'0',textAlign:'center'}}));
  const template=widths.length?Array.from({length:columns},(_,index)=>widths[index]??'minmax(0, 1fr)').join(' '):`repeat(${columns}, minmax(0, 1fr))`;
  return {columns,style:{display:'grid',gridTemplateColumns:template,minWidth:'0',maxWidth:'100%'},cells:[...captionCells,...cells]};
}
