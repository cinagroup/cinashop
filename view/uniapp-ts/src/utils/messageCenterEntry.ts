import {resolveRegisteredPageRoute} from '@/config/navigation';
type EntryHost={location:{hash:string;pathname:string;search:string};history:Pick<History,'replaceState'>};
/** Resolve only the two migrated PHP hash entry points before H5 router startup. */
export function prepareMessageCenterEntry(host:EntryHost|undefined=typeof window==='undefined'?undefined:window){
 if(!host)return;const raw=host.location.hash.slice(1),split=raw.indexOf('?'),path=split<0?raw:raw.slice(0,split);
 if(path!=='/pages/users/message_center/index'&&path!=='/pages/users/message_center/messageDetail')return;
 const query=split<0?'':raw.slice(split+1),target=resolveRegisteredPageRoute(path,query);
 host.history.replaceState(null,'',host.location.pathname+host.location.search+'#'+target);
}
