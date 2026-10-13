import type {ShareScene} from './legacyShare';
export interface ShareScanSession { uid: number; token: string; sessionVersion: number }
export interface ShareScanInput { namespace: 'member-barcode'|'order-code'; value: string }
const targets = {customer:'/pages/customer-work/scanning',staff:'/pages/operator/writeoff?role=staff',delivery:'/pages/delivery/scanning'} as const;
/** One navigation handoff only. Never persist the barcode, token or session. */
export class ShareScanTransfer {
  private pending: {target:string; input:ShareScanInput; session:ShareScanSession; expires:number}|null = null;
  constructor(private now:()=>number = Date.now) {}
  clear() { this.pending = null; }
  stage(scene:ShareScene, session:ShareScanSession) {
    this.clear();
    const scope = scene.viewer_scope;
    if (!scope || scope === 'owner' || scene.path !== targets[scope] || !session.uid || !session.token ||
      !(scene.type === 90 && scene.namespace === 'member' || scene.type === 91 && scene.namespace === 'order') ||
      scene.spid !== 0 || typeof scene.code !== 'string' || !scene.code || scene.code.length > 32 || scene.code !== scene.code.trim() || scene.code === 'undefined' || /[\u0000-\u001f\u007f]/u.test(scene.code) || scene.type === 90 && /^\d{12}$/u.test(scene.code) || scene.type === 91 && !/^\d{12}$/u.test(scene.code)) throw Error('查询资料已变化，请重新核对分享码');
    this.pending = {target:scene.path,input:{namespace:scene.namespace === 'member'?'member-barcode':'order-code',value:scene.code},session:{uid:session.uid,token:session.token,sessionVersion:session.sessionVersion},expires:this.now()+30000};
  }
  take(target:string, session:ShareScanSession):ShareScanInput|null {
    const row = this.pending; this.clear();
    if (!row || row.target !== target || this.now() >= row.expires || row.session.uid !== session.uid || row.session.token !== session.token || row.session.sessionVersion !== session.sessionVersion) return null;
    return {...row.input};
  }
}
export const shareScanTransfer = new ShareScanTransfer();
