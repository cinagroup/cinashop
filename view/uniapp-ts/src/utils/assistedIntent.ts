import { AssistedIntentJournal } from '../../../common/assistedCheckout';
export function assistedJournal() {
  return new AssistedIntentJournal({get:key=>uni.getStorageSync(key),set:(key,value)=>uni.setStorageSync(key,value),remove:key=>uni.removeStorageSync(key)});
}
