const {test,assert,path,vue,root,loader,node,renderer,all,tick} = require('./helpers/diy-navigation-runtime.cjs');
const file=path.join(root,'layouts/AdminSidebarNavigation.vue');

// Compile the real SFC and utility. Adapters expose Element Plus props/slots;
// browser acceptance covers its actual accordion, popups and keyboard behavior.
function mount(allowed=['/order'],active='/order') {
  const gates=vue.reactive({allowed:new Set(allowed)});
  const props=vue.reactive({active,collapsed:false,canMenu:key=>gates.allowed.has(key)});
  const component=loader().load(file).default,tree=node('root'),openCalls=[];
  const app=renderer.createApp({setup:()=>()=>vue.h(component,props)});
  for(const tag of ['el-menu','el-menu-item','el-sub-menu','el-icon']) app.component(tag,vue.defineComponent({
    inheritAttrs:false,props:{index:String,defaultActive:String,defaultOpeneds:Array,collapse:Boolean,uniqueOpened:Boolean,router:Boolean},
    setup(p,{attrs,slots,expose}) {if(tag==='el-menu') expose({open:id=>openCalls.push(id)});return ()=>vue.h(tag,{...attrs,...p},[slots.title?.(),slots.default?.()]);},
  }));
  app.mount(tree);
  return {tree,gates,props,openCalls,unmount:()=>app.unmount()};
}
const items=m=>all(m.tree,n=>n.tag==='el-menu-item').map(n=>n.props.index);
const sections=m=>all(m.tree,n=>n.tag==='el-sub-menu').map(n=>n.props.index);
const menu=m=>all(m.tree,n=>n.tag==='el-menu')[0].props;

test('grouping preserves inherited order/user/config gates without exposing unrelated pages',()=>{
  const m=mount(['/order','/user','/config']);
  try {
    for(const route of ['/order','/order/offline','/user','/user/groups','/config/newcomer','/marketing/sign-rewards']) assert.ok(items(m).includes(route),route);
    for(const route of ['/order/invoice','/refund','/supplier/directory','/system','/product','/dashboard']) assert.ok(!items(m).includes(route),route);
    assert.ok(!sections(m).includes('nav:supplier'));
    assert.ok(!sections(m).includes('nav:catalog'));
  } finally {m.unmount();}
});

test('permission replacement and revocation immediately remove child entries and empty groups',async()=>{
  const m=mount(['/order']);
  try {
    assert.deepEqual(items(m),['/order','/order/offline']);
    m.gates.allowed=new Set(['/supplier/directory']);await tick();
    assert.deepEqual(items(m),['/supplier/directory']);
    assert.deepEqual(sections(m),['nav:supplier']);
    m.gates.allowed=new Set();await tick();
    assert.deepEqual(items(m),[]);assert.deepEqual(sections(m),[]);
    m.gates.allowed=new Set(['/dashboard']);await tick();
    assert.deepEqual(items(m),['/dashboard']);assert.deepEqual(sections(m),[]);
  } finally {m.unmount();}
});

test('direct child navigation opens its permitted group and collapse restores the same selection',async()=>{
  const m=mount(['/supplier/directory','/label'],'/supplier/directory');
  try {
    assert.deepEqual(menu(m).defaultOpeneds,['nav:supplier']);
    assert.equal(menu(m).uniqueOpened,true);assert.equal(menu(m).router,true);
    m.props.collapsed=true;await tick();assert.deepEqual(menu(m).defaultOpeneds,[]);
    assert.equal(menu(m).defaultActive,'/supplier/directory');
    m.props.active='/label/products';await tick();
    m.props.collapsed=false;await tick();assert.deepEqual(menu(m).defaultOpeneds,['nav:catalog']);
    assert.equal(m.openCalls.at(-1),'nav:catalog');
    m.props.active='/supplier/directory';await tick();assert.equal(m.openCalls.at(-1),'nav:supplier');
    m.props.active='/label/products';await tick();assert.equal(m.openCalls.at(-1),'nav:catalog');
    m.gates.allowed=new Set(['/supplier/directory']);await tick();
    assert.deepEqual(menu(m).defaultOpeneds,[]);
  } finally {m.unmount();}
});


test('collapsed sections can be opened by click and Enter without depending on hover',async()=>{
  const m=mount(['/order']);
  try {
    m.props.collapsed=true;await tick();m.openCalls.length=0;
    const section=all(m.tree,n=>n.tag==='el-sub-menu')[0];
    assert.equal(section.props.tabindex,0);
    section.props.onClick();assert.deepEqual(m.openCalls,['nav:orders']);
    let prevented=false;
    section.props.onKeydown({key:'Enter',preventDefault:()=>{prevented=true;}});
    assert.equal(prevented,true);assert.deepEqual(m.openCalls,['nav:orders','nav:orders']);
    section.props.onKeydown({key:'Tab',preventDefault:()=>{throw Error('Tab must remain available');}});
    assert.equal(m.openCalls.length,2);
  } finally {m.unmount();}
});
