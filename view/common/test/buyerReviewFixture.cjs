const revision='a'.repeat(64);
function record(id){return {id:500+id,uid:11,orderId:91,cartInfoId:id,unique:'line_'+id,comment:'已保存评价 '+id,replyScore:3,productScore:5,serviceScore:4,logisticsScore:3,pics:[],addTime:'2026-11-14 10:00:00',visible:true};}
function page(done=[],change={}){return {version:1,uid:11,orderId:91,orderNo:'review_order_A',paid:true,status:done.length===2?3:2,canReview:done.length!==2,reason:done.length===2?'订单已完成评价':'',lines:[101,102,103].map(id=>({id,unique:'line_'+id,productId:70,name:'验收商品 '+id,sku:'红色',price:'10.00',image:'',isGift:id===103,revision,canReply:id!==103&&!done.includes(id),reason:done.includes(id)?'该商品已提交评价':id===103?'赠品无需评价':'',review:done.includes(id)?record(id):null})),...change};}
function ack(body,completed=false){return {version:1,uid:11,orderId:body.orderId,orderNo:body.orderNo,cartInfoId:body.cartInfoId,unique:body.unique,replyId:500+body.cartInfoId,completed,toLottery:false};}
const upload={url:'/api/assets/991',src:'/api/assets/991?expires=1900000000&signature='+'a'.repeat(43),name:'local.png'};
module.exports={revision,page,ack,upload};
