const path=require('node:path'),vue=require('vue');
const {runtime,tick,deferred}=require('./uni-store-runtime.cjs');
const commerce=require('./diy-commerce-fixture.cjs');
const root=path.resolve(__dirname,'..');
const listBlock=(kind='goodList',extra={})=>({name:kind,timestamp:501,styleConfig:{tabVal:0},typeConfig:{activeValue:1},goodsList:{ids:[601,611]},numberConfig:{val:2},numConfig:{val:2},selectConfig:{activeValue:811},checkboxInfo:{type:[0,1,2,3,4,5]},checkboxList:{type:[0,1,2]},cartConfig:{tabVal:0},bntConfig:{tabVal:1},...extra});
const product=(id=601,extra={})=>commerce.product(id,{activity_frame:id===601?{image:'/frame.png'}:[],store_label:[{id:704,label_name:'实际标签',color:'#333',bg_color:'#fff',border_color:'#aaa',icon:'/label.png'}],vip_price:'5.00',is_vip:1,price_type:'member',...extra});
const article=(id=801,extra={})=>({id,title:'实际文章'+id,image_input:['/article.png'],visit:'0',likes:0,add_time:'2026-10-22 09:30',synopsis:'实际摘要',url:'https://external.example/ignored',...extra});
function answer(c){
 if(c.url.endsWith('/products')){const ids=c.data.ids?c.data.ids.split(',').map(Number):[601];return{data:{list:ids.slice(0,c.data.limit).map(id=>product(id)),count:ids.length}};}
 if(c.url.includes('/article/list/'))return{data:[article(),article(802)].slice(0,c.data.limit)};
 if(c.url.endsWith('/wechat/follow'))return{data:{path:'/api/wechat/follow/image/revision?expires=1800000000&signature=fixture'}};
 return commerce.answer(c);
}
const editorialBlock=(kind='follow',extra={})=>({name:kind,timestamp:541,titleConfig:{value:'实际关注',tabVal:1},imgConfig:{url:'/profile.png'},codeConfig:{url:'/code.png'},titleTxtConfig:{value:'实际资讯'},listConfig:{list:[{show:1,chiild:[{val:'第一条实际资讯'},{val:'/pages/article/list'}]},{show:1,chiild:[{val:'第二条实际资讯'},{val:'/pages/goods/list?cid=9'}]}]},menuConfig:{list:[{img:'/party.png',info:[{value:'活动一'},{value:'实际活动说明'},{value:'/pages/article/list'}]}]},desConfig:{value:'实际徽标'},picStyle:{url:'/hotspot.png',list:[{starX:75,starY:50,areaWidth:150,areaHeight:100,link:'/pages/article/list'}]},...extra});
function setupList(kind='goodList',extra={}){const props=vue.reactive({block:listBlock(kind,extra.block),active:true,...extra.props});const r=runtime({component:'components/diy/DiyListWidget.vue',props,send:extra.send??answer,platform:extra.platform??'H5',authenticated:extra.authenticated??true});return{...r,props,c:r.checkout.state};}
function setupEditorial(kind='follow',extra={}){const props=vue.reactive({block:editorialBlock(kind,extra.block),active:true,...extra.props});const r=runtime({component:'components/diy/DiyEditorialWidget.vue',props,send:extra.send??answer,platform:extra.platform??'H5',authenticated:extra.authenticated??true});return{...r,props,c:r.checkout.state};}
function sibling(r,props,component='components/diy/DiyListWidget.vue'){const scope=vue.effectScope(),instance=scope.run(()=>r.load(path.join(root,'src',component)).default.setup(props,{expose(){},emit(){}}));return{c:instance.state,scope,instance};}
function boundary(r,name){if(name==='uid')r.auth.setLogin('owner22',22);else if(name==='token')r.auth.setLogin('new-token',11);else if(name==='session')r.auth.setLogin('synthetic-local-token',11);else if(name==='config')r.props.block={...r.props.block,titleConfig:{value:'新版配置'},timestamp:999};else if(name==='hide')r.props.active=false;else if(name==='dispose')r.c.dispose();else if(name==='close'){r.c.closeFollow();r.c.showFollowCode();}}
const calls=(r,re)=>r.calls.filter(c=>re.test(c.url));
module.exports={root,vue,runtime,tick,deferred,listBlock,product,article,answer,editorialBlock,setupList,setupEditorial,sibling,boundary,calls};
