const {test,assert,path,vue,root,node,loader,tick,all}=require('./helpers/diy-list-runtime.cjs');
const file=path.join(root,'components/content/DiyListPreview.vue'),util=path.join(root,'utils/diyListEditor.ts');
function mountPreview(){
  const observations=[],renderedRefs=[],old=global.ResizeObserver;
  global.ResizeObserver=class{constructor(callback){this.callback=callback;this.elements=new Set();this.disconnected=false;observations.push(this);}observe(element){this.elements.add(element);}unobserve(element){this.elements.delete(element);}disconnect(){this.disconnected=true;this.elements.clear();}};
  const create=tag=>Object.assign(node(tag),{dataset:{},height:1,getBoundingClientRect(){return{height:this.height};}});
  const renderer=vue.createRenderer({createElement:create,createText:text=>Object.assign(create('#text'),{text}),createComment:text=>Object.assign(create('#comment'),{text}),setText:(n,text)=>{n.text=text;},setElementText:(n,text)=>{n.text=text;n.children=[];},parentNode:n=>n.parent,nextSibling:n=>n.parent?.children[n.parent.children.indexOf(n)+1]??null,patchProp:(n,key,_old,value)=>{n.props[key]=value;if(key==='data-product-id'){n.dataset.productId=String(value);n.height={1:100,2:20,3:30,4:40,5:60}[value]??10;}},insert(n,parent,anchor){if(n.parent){const at=n.parent.children.indexOf(n);if(at>=0)n.parent.children.splice(at,1);}n.parent=parent;const at=anchor?parent.children.indexOf(anchor):-1;at<0?parent.children.push(n):parent.children.splice(at,0,n);},remove(n){if(n.parent){const at=n.parent.children.indexOf(n);if(at>=0)n.parent.children.splice(at,1);n.parent=null;}}});
  const l=loader(),block=l.load(util).newListBlock('goodList',10);block.styleConfig.tabVal=1;
  const product=id=>({id,title:'真实商品'+id,image:'',frameImage:'',price:'9.50',offer:null,sales:0,unit:'件',star:'4.5',brand:'',labels:[]});
  let lease=true;const props=vue.reactive({block,products:[1,2,3,4].map(product),articles:[],loaded:true,loading:false,error:'',allowed:()=>lease}),tree=create('root'),component=l.load(file).default,render=component.render;
  // Observe actual compiler-produced VNode refs without replacing their work.
  component.render=function(...args){const result=render.apply(this,args),refs=[];let column=-1;function visit(v,current){if(!v||typeof v!=='object')return;if(v.props?.class==='product-column')current=++column;if(v.props?.class==='preview-product'){assert.equal(typeof v.ref?.r,'function');refs.push({id:Number(v.props['data-product-id']),column:current,callback:v.ref.r});}if(Array.isArray(v.children))for(const child of v.children)visit(child,current);}visit(result,-1);renderedRefs.push(refs);return result;};
  const app=renderer.createApp({render:()=>vue.h(component,props)});app.mount(tree);let alive=true;
  return{props,tree,observations,renderedRefs,product,get state(){return l.instances.get(file).at(-1);},deny(){lease=false;},stop(){if(alive){alive=false;app.unmount();}global.ResizeObserver=old;}};
}
test('compiled author preview balances actual unequal measured heights into two independent columns',async()=>{const r=mountPreview();try{await tick();await tick();assert.deepEqual(r.state.columns.map(column=>column.map(row=>row.id)),[[1],[2,3,4]]);assert.deepEqual([...r.state.heights.entries()].sort((a,b)=>a[0]-b[0]),[[1,100],[2,20],[3,30],[4,40]]);assert.ok(r.observations.length);assert.ok(r.observations.at(-1).elements.size===4);}finally{r.stop();}});
for(const change of ['block','products','lease','denied','unmount'])test('actual measured preview rejects delayed ResizeObserver after '+change,async()=>{const r=mountPreview();try{await tick();await tick();const old=r.observations.at(-1),elements=[...old.elements];for(const e of elements)e.height=900;if(change==='block')r.props.block={...r.props.block,styleConfig:{tabVal:0}};if(change==='products')r.props.products=[r.product(5)];if(change==='lease')r.props.allowed=()=>false;if(change==='denied')r.deny();if(change==='unmount')r.stop();await tick();await tick();const heights=[...r.state.heights.entries()],columns=r.state.columns.map(c=>c.map(p=>p.id));old.callback(elements.map(target=>({target})));await tick();assert.deepEqual([...r.state.heights.entries()],heights);assert.deepEqual(r.state.columns.map(c=>c.map(p=>p.id)),columns);assert.equal([...r.state.heights.values()].includes(900),false);}finally{r.stop();}});
test('actual compiled cross-column refs retain the replacement when an old later-column null arrives after earlier-column registration',async()=>{
  const r=mountPreview();try{
    await tick();await tick();assert.deepEqual(r.state.columns.map(c=>c.map(p=>p.id)),[[1],[2,3,4]]);
    const oldRef=r.renderedRefs.at(-1).find(ref=>ref.id===4);assert.equal(oldRef.column,1);const previous=r.state.cards.get(4);assert.ok(previous);const observer=r.observations.at(-1),second=r.state.cards.get(2);second.height=400;
    // Real observer work changes the actual computed columns; Vue mounts the
    // earlier-column replacement before unmounting the old later-column card.
    observer.callback([{target:second}]);await tick();await tick();assert.deepEqual(r.state.columns.map(c=>c.map(p=>p.id)),[[1,3,4],[2]]);
    const replacement=all(r.tree,n=>n.props['data-product-id']===4)[0],newRef=r.renderedRefs.at(-1).find(ref=>ref.id===4);assert.ok(replacement);assert.notEqual(replacement,previous);assert.equal(newRef.column,0);assert.notEqual(newRef.callback,oldRef.callback);
    assert.equal(r.state.cards.get(4),replacement);assert.equal(r.observations.at(-1).elements.has(replacement),true);
    // Deliver the actual captured old template callback again after the new
    // registration. It must affect only its own old DOM placement.
    oldRef.callback(null);assert.equal(r.state.cards.get(4),replacement);assert.equal(r.observations.at(-1).elements.has(replacement),true);
    replacement.height=55;r.observations.at(-1).callback([{target:replacement}]);await tick();assert.equal(r.state.heights.get(4),55);assert.equal(r.state.cards.get(4),replacement);
  }finally{r.stop();}
});
