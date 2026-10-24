const base=require('./diy-navigation-runtime.cjs');
function mount(l,file,props,emit=()=>{}){
  const tree=base.node('root'),component=l.load(file).default;
  const app=base.renderer.createApp({setup:()=>()=>base.vue.h(component,{...props,'onUpdate:modelValue':value=>emit('update:modelValue',value)})});
  for(const name of [...base.elementNames,'el-checkbox'])app.component(name,l.componentOverrides?.[name]??base.elementStub(name));
  app.directive('loading',{});app.mount(tree);let alive=true;
  return{tree,get state(){return l.instances.get(file).at(-1);},unmount(){if(alive){alive=false;app.unmount();}}};
}
module.exports={...base,mount};
