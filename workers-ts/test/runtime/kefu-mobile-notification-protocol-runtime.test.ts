import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@/env';
import { KefuRealtimeService, type ChatSocketSession, type PersistedRealtimeMessage } from '@/services/kefu/KefuRealtimeService';
import type { TransferDeliveryEvent } from '@/do/ChatRoomDO';

const bindings=env as Env,peerUid=1_000_000_001;
function session(role:1|2|3=2,isTourist:0|1=0):ChatSocketSession{return{principalUid:101,role,isTourist,toUid:peerUid,authId:1,tokenKey:'a'.repeat(32),expiresAt:Math.floor(Date.now()/1000)+600,authVersion:'transport-fixture',connectedAt:Math.floor(Date.now()/1000)};}
function nextFrame(socket:WebSocket,predicate:(frame:any)=>boolean=()=>true){return new Promise<any>((resolve)=>{
  const handler=(event:MessageEvent)=>{const frame=JSON.parse(String(event.data));if(predicate(frame)){socket.removeEventListener('message',handler);resolve(frame);}};socket.addEventListener('message',handler);
});}
async function connect(s=session()){
  const stub=bindings.CHAT_ROOM.getByName(`kefu-mobile-${crypto.randomUUID()}`);
  const response=await stub.fetch(new Request('https://chat.internal/connect',{headers:{Upgrade:'websocket','Sec-WebSocket-Protocol':'cinashop',
    'X-Chat-Principal-Uid':String(s.principalUid),'X-Chat-Role':String(s.role),'X-Chat-To-Uid':String(s.toUid),'X-Chat-Is-Tourist':String(s.isTourist),
    'X-Chat-Auth-Id':String(s.authId),'X-Chat-Token-Key':s.tokenKey,'X-Chat-Token-Exp':String(s.expiresAt),'X-Chat-Auth-Version':s.authVersion}}));
  expect(response.status).toBe(101);const client=response.webSocket;if(!client)throw Error('Missing actual workerd WebSocket');const hello=nextFrame(client,frame=>frame.status===200);client.accept();await hello;return{stub,client};
}
function message(isTourist:0|1=1):PersistedRealtimeMessage{return{id:10,uid:peerUid,to_uid:101,is_tourist:isTourist,msn:'PRIVATE FULL CHAT BODY',msn_type:1,add_time:1,type:0,nickname:'对应会话',avatar:'',sender_role:isTourist?3:1,
  recored:{id:9,user_id:101,to_uid:peerUid,is_tourist:isTourist,nickname:'对应会话',avatar:'',online:1,type:isTourist?3:1,add_time:1,update_time:1,mssage_num:2,message:'PRIVATE FULL CHAT BODY',message_type:1}};}
function transfer(type:'transfer_out'|'transfer',isTourist:0|1=1):TransferDeliveryEvent{
  const shared={request_key:crypto.randomUUID(),is_tourist:isTourist};return type==='transfer_out'?{type,data:{...shared,uid:peerUid,toUid:102,nickname:'目标客服',avatar:''}}:
    {type,data:{...shared,recored:message(isTourist).recored,kefuInfo:{uid:102,nickname:'来源客服',avatar:''}}};
}
beforeEach(()=>{vi.spyOn(KefuRealtimeService.prototype,'setOnline').mockResolvedValue(undefined);vi.spyOn(KefuRealtimeService.prototype,'setDisconnected').mockResolvedValue(undefined);vi.spyOn(KefuRealtimeService.prototype,'assertSession').mockResolvedValue(undefined);vi.spyOn(KefuRealtimeService.prototype,'canDeliverConversation').mockImplementation(async(_session,_peer,_domain,recordId)=>recordId!==undefined);});
afterEach(async()=>{await reset();vi.restoreAllMocks();});

describe('actual workerd kefu composite-domain delivery and background subscription',()=>{
  it('sends only a redacted unread summary for the other domain even when peer UID is identical',async()=>{
    const{stub,client}=await connect(),received=nextFrame(client);
    expect(await stub.deliver(message(1))).toEqual({connected:1,viewing:0});
    const frame=await received;expect(frame).toMatchObject({type:'mssage_num',data:{uid:peerUid,message_id:10,is_tourist:1,num:2,recored:{is_tourist:1,message:''}}});expect(JSON.stringify(frame)).not.toContain('PRIVATE FULL CHAT BODY');expect(frame.data).not.toHaveProperty('msn');client.close();
  });
  it('delivers a chat body and viewing receipt only for the exact active UID and domain',async()=>{
    const{stub,client}=await connect(),received=nextFrame(client);
    expect(await stub.deliver(message(0))).toEqual({connected:1,viewing:1});expect(await received).toMatchObject({type:'reply',data:{msn:'PRIVATE FULL CHAT BODY',is_tourist:0}});client.close();
  });
  it('never reports viewing when the real registered socket fails to send',async()=>{
    const{stub,client}=await connect();await runInDurableObject(stub,async(instance,state)=>{
      const socket=state.getWebSockets()[0];const send=vi.spyOn(socket,'send').mockImplementation(()=>{throw Error('transport write failed');});
      expect(await instance.deliver(message(0))).toEqual({connected:0,viewing:0});send.mockRestore();
    });client.close();
  });
  it('redacts cross-domain incoming transfer summaries and clears transfer_out viewing only in the matching domain',async()=>{
    const{stub,client}=await connect();let received=nextFrame(client);expect(await stub.deliverTransfer(transfer('transfer',1))).toBe(1);expect(await received).toMatchObject({type:'transfer',data:{is_tourist:1,recored:{message:'',is_tourist:1}}});
    received=nextFrame(client);expect(await stub.deliverTransfer(transfer('transfer_out',1))).toBe(1);await received;
    expect(await runInDurableObject(stub,(_instance,state)=>(state.getWebSockets()[0].deserializeAttachment() as ChatSocketSession).toUid)).toBe(peerUid);
    received=nextFrame(client);expect(await stub.deliverTransfer(transfer('transfer_out',0))).toBe(1);await received;
    expect(await runInDurableObject(stub,(_instance,state)=>(state.getWebSockets()[0].deserializeAttachment() as ChatSocketSession).toUid)).toBe(0);client.close();
  });
  it('cancels active viewing with to_chat zero and keeps later unread delivery as a summary',async()=>{
    const switched=vi.spyOn(KefuRealtimeService.prototype,'switchConversation').mockResolvedValue(0),read=vi.spyOn(KefuRealtimeService.prototype,'markMessageRead').mockResolvedValue(undefined);
    const{stub,client}=await connect(),ack=nextFrame(client,frame=>frame.type==='mssage_num'&&frame.data.uid===0);
    client.send(JSON.stringify({type:'to_chat',data:{id:0}}));expect(await ack).toMatchObject({type:'mssage_num',data:{uid:0,is_tourist:0,num:0}});expect(switched).toHaveBeenCalledWith(expect.objectContaining({role:2}),0);expect(read).not.toHaveBeenCalled();
    const received=nextFrame(client);expect(await stub.deliver(message(0))).toEqual({connected:1,viewing:0});expect((await received).type).toBe('mssage_num');client.close();
  });
  it('keeps registered and visitor buyer sockets strictly in their own domain',async()=>{
    for(const s of [session(1,0),session(3,1)]){
      const{stub,client}=await connect(s);const opposite=s.isTourist===0?1:0;
      expect(await stub.deliver(message(opposite))).toEqual({connected:0,viewing:0});
      const toTransfer:TransferDeliveryEvent={type:'to_transfer',data:{request_key:crypto.randomUUID(),is_tourist:opposite,toUid:102,nickname:'客服',avatar:'',online:1}};
      expect(await stub.deliverTransfer(toTransfer)).toBe(0);expect(await runInDurableObject(stub,(_instance,state)=>(state.getWebSockets()[0].deserializeAttachment() as ChatSocketSession).toUid)).toBe(peerUid);client.close();
    }
  });
  it('closes a revoked staff socket without emitting either-domain summaries or viewing receipts',async()=>{
    const{stub,client}=await connect(),frames:string[]=[];client.addEventListener('message',event=>frames.push(String(event.data)));const closed=new Promise<CloseEvent>(resolve=>client.addEventListener('close',resolve,{once:true}));
    vi.spyOn(KefuRealtimeService.prototype,'assertSession').mockRejectedValue(Error('revoked'));
    expect(await stub.deliver(message(1))).toEqual({connected:0,viewing:0});expect((await closed).code).toBe(4001);expect(frames).toEqual([]);
  });
});
