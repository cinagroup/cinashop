const path=require('node:path'),vue=require('vue');
const {runtime}=require('./uni-store-runtime.cjs');
const component='components/diy/DiyCommerceWidget.vue',root=path.resolve(__dirname,'..');
const block=(name='combination',extra={})=>({name,timestamp:301,styleConfig:{tabVal:0},goodStyleConfig:{tabVal:1},titleConfig:{tabVal:1},titleTxtConfig:{value:'实际活动标题'},numberConfig:{val:2},checkboxInfo:{type:[0,1,2,3]},...extra});
const card=(id=701,extra={})=>({id,product_id:id+1000,title:`真实活动${id}`,image:'/owned.png',price:0,ot_price:12,people:2,pink_count:0,stock:8,percent:0,min_price:0,sales:0,integral:0,...extra});
const product=(id=601,extra={})=>({id,store_name:`真实商品${id}`,image:'/owned.png',price:'0.00',ot_price:'12.00',vip_price:'0.00',sales:23,stock:8,is_vip:0,is_vip_product:0,cart_button:1,unit_name:'箱',star:'5',brand_name:'品牌',spec_type:1,is_presale_product:0,cart_num:0,activity:'0,1,2,3',diy_navigation:{version:1,product_id:id,kind:'product',id,ends_at:null},store_label:[],...extra});
const coupon=(id=901,extra={})=>({id,type:0,coupon_type:1,coupon_title:`真实券${id}`,coupon_price:'0.00',use_min_price:'0.00',is_use:false,remain_count:8,receive_limit:1,...extra});
const room=(id=2101,extra={})=>({id,room_id:id+1000,name:`真实直播${id}`,cover_img:'/cover.png',show_time:'10/21 12:00',anchor_name:'真实主播',anchor_img:'/avatar.png',live_status:101,goods:[{id:4101,name:'真实直播商品',cover_img:'/goods.png',price:'0.00'}],...extra});
const index=()=>({seckillTime:[{id:501,start_time:'00:00',end_time:'23:59',state:'疯抢中',stop:Math.floor(Date.now()/1000)+7200,status:1},{id:502,start_time:'23:59',end_time:'24:00',state:'即将开始',stop:Math.floor(Date.now()/1000)+10800,status:2}],seckillTimeIndex:0});
const detail=(id=601)=>({id,storeName:`真实商品${id}`,image:'/owned.png',price:'0.00',stock:8,isVip:1,cart_button:1,specType:1,productType:0,systemFormId:0,productAttr:[{attr_name:'颜色',attr_values:['红','蓝']}],attr_value:[{unique:'red001',suk:'红',price:'0.00',stock:8},{unique:'blue001',suk:'蓝',price:'12.00',stock:3}]});
function answer(c){
 if(c.url.endsWith('/seckill/index'))return{data:index()};
 if(/\/seckill\/list\//.test(c.url))return{data:[card(Number(c.url.split('/').at(-1))+1200)]};
 if(c.url.endsWith('/combination/list'))return{data:[card()]};
 if(c.url.endsWith('/bargain/list'))return{data:[card(801)]};
 if(c.url.endsWith('/store_integral/list'))return{data:[card(1001)]};
 if(c.url.endsWith('/presale/list'))return{data:{list:[{...product(605),presale_pay_status:2}],count:1}};
 if(c.url.endsWith('/v2/coupons'))return{data:{list:[coupon()],count:[1,0,0,0]}};
 if(c.url.endsWith('/pink'))return{data:{pink_count:0,avatars:['/avatar.png']}};
 if(c.url.endsWith('/wechat/live'))return{data:[room()]};
 if(c.url.endsWith('/products'))return{data:{list:[product()],count:1}};
 if(c.url.endsWith('/coupon/receive'))return{data:{couponUserId:3001}};
 if(c.url.includes('/product/detail/'))return{data:detail(Number(c.url.split('/').at(-1)))};
 if(c.url.endsWith('/cart/add'))return{data:{id:91,cartNum:1}};
 if(c.url.endsWith('/cart/list'))return{data:[]};
 if(c.url.endsWith('/cart/count'))return{data:{count:0}};
 throw Error(`Unexpected I/O ${c.url}`);
}
const tabs=()=>({list:[{chiild:[{val:'固定商品'},{val:'商品说明'}],tabVal:1,goodsList:{ids:[601]},numConfig:{val:2}},{chiild:[{val:'品牌'}],tabVal:2,brandConfig:{brandVal:[11]},numConfig:{val:3},goodsSort:1}]});
function setup(kind='combination',send=answer,extra={}){
 const props=vue.reactive({block:block(kind,{...(kind==='promotionList'?{tabConfig:tabs()}:{}),...extra.block}),active:true,...extra.props});
 const r=runtime({component,props,send,platform:extra.platform??'H5',authenticated:extra.authenticated??true,storage:extra.storage??new Map()});
 return{...r,props,c:r.checkout.state};
}
function sibling(r,props){const scope=vue.effectScope(),instance=scope.run(()=>r.load(path.join(root,'src',component)).default.setup(props,{expose(){},emit(){}}));return{c:instance.state,instance,scope};}
const calls=(r,re)=>r.calls.filter(c=>re.test(c.url));
const writes=r=>calls(r,/coupon\/receive|cart\/(?:add|num|del)|order\/|bargain\/start|combination\/join|sign\/integral/);
module.exports={root,component,block,card,product,coupon,room,index,detail,answer,tabs,setup,sibling,calls,writes};
