import type { Env } from '@/env';
import type { Container } from '@/lib/di';
import { BadRequestException } from '@/utils/errors';
import { erpReadJson,parseErpCallback } from './ErpInput';
import { erpCanonical,erpSha256,erpVerifyCallbackQuery,type ErpCallbackKind } from './ErpProtocol';
import { ErpProviderClient } from './ErpProviderPolicy';
import { ErpProviderFactsService } from './ErpProviderFacts';
import { ErpOperationService,erpOperationDto } from './ErpOperationService';
import { ErpStockService } from './ErpStockService';

/** Provider claims become durable observations, never implied business success.
 * Every enabled effect below executes its genuine SQL writer; unavailable
 * mappings are explicit pending receipts. */
export class ErpService {
  constructor(private readonly container:Container,private readonly env:Env,private readonly provider=new ErpProviderClient()){}
  async callback(kind:ErpCallbackKind,request:Request){
    if(request.method!=='POST')throw new BadRequestException('ERP 回调仅支持 POST');
    const timestamp=Math.floor(Date.now()/1000),query=erpVerifyCallbackQuery(kind,request.url,timestamp),input=parseErpCallback(kind,await erpReadJson(request));
    const operations=new ErpOperationService(this.container,this.env),snapshot=await operations.snapshot(query);
    const observed=await new ErpProviderFactsService(this.provider).observe(snapshot,input);
    const {observedAt,...facts}=observed;
    if(Math.floor(Date.now()/1000)-observedAt>30)throw new BadRequestException('ERP 事实已过期，请重新查询');
    if(input.kind==='stock'){
      const stocks=facts.stocks;if(!stocks)throw new BadRequestException('ERP 库存事实缺失');
      const writer=new ErpStockService(this.container,operations),scope=await writer.plan(snapshot,input,stocks);
      const businessKey=erpSha256(erpCanonical({shop:snapshot.config.defaultShopId,stocks:stocks.map(row=>({code:row.code,version:row.version}))}));
      const admission=await operations.claim(snapshot,kind,businessKey,input,query.timestamp,scope,{callback:input,provider:facts});
      if(!admission.replay){
        if(stocks.some(row=>!row.supported)||input.items.some(item=>stocks.find(row=>row.code===item.code)?.available!==item.quantity)){
          return {completed:false,receipt:erpOperationDto(await operations.pending(admission,'pending_inventory_policy'))};
        }
        const completed=await writer.execute(admission);return {completed:true,receipt:erpOperationDto(completed)};
      }
      return {completed:admission.replay?admission.operation.state==='business_committed':true,receipt:erpOperationDto(admission.operation)};
    }
    // Development boundary: no finance/delivery mutation until an exact current
    // local order/refund mapping is admitted by its mature transactional writer.
    const businessKey=erpSha256(erpCanonical({kind,order:input.orderId,provider:facts}));
    const admission=await operations.claim(snapshot,kind,businessKey,input,query.timestamp,{}, {callback:input,provider:facts});
    return {completed:false,receipt:erpOperationDto(admission.replay?admission.operation:await operations.pending(admission,'pending_order_mapping'))};
  }
}
