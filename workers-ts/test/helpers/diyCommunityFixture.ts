import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { community, communityUser, systemConfig, systemDise, systemUserLevel, userFriends, video } from "@/models/schema";
import { AttachmentService, userAttachmentScope } from "@/services/system/AttachmentService";
import { communityVideoFixture } from "./communityVideoFixture";

/** Explicit, process-owned historical seed. Community and short-video IDs
 * collide deliberately so a wrong data source has observable consequences. */
export async function diyCommunityFixture() {
  const f = await communityVideoFixture([userFriends, systemUserLevel, video, systemDise]);
  try {
    const png = new Uint8Array(await readFile(resolve(import.meta.dirname, "../fixtures/community-teal.png")));
    const attachment = new AttachmentService(f.container, f.env);
    const image = await attachment.uploadImage(userAttachmentScope(11), new File([png], "diy-community.png", { type: "image/png" }), 0);
    const clip = await attachment.uploadUserVideo(11, f.file());
    const publicIds = [1,2,3,4,5,6,7,8,9];
    await f.db.insert(communityUser).values([
      { type: 2, relationId: 11, nickname: "社区资料11", communityNum: 7, likeNum: 40 },
      { type: 2, relationId: 22, nickname: "社区资料22", communityNum: 1, likeNum: 50 },
      { type: 1, relationId: 11, nickname: "商户同号资料", communityNum: 1, likeNum: 999 },
    ]);
    await f.db.insert(community).values([
      ...publicIds.slice(0,7).map((id,i) => ({ id, type: 2, relationId: 11,
        title: id===2 ? "社区视频02" : `社区图文${String(id).padStart(2,"0")}`,
        content: `实际社区内容${id}`, contentType: id===2 ? 2 : 1, image: image.url,
        sliderImage: id===2 ? "[]" : JSON.stringify([image.url]), videoUrl: id===2 ? clip.url : "",
        status: 1, isVerify: 1, star: 100-i, addTime: 1000+i, likeNum: id+2, playNum: id+10 })),
      { id: 8, type: 1, relationId: 11, title: "商户公共帖子", content: "实际商户社区内容", contentType: 1, image: image.url, status: 1, isVerify: 1, star: 20 },
      { id: 9, type: 2, relationId: 22, title: "跨作者污染封面", content: "实际其他作者社区内容", contentType: 1, image: image.url, status: 1, isVerify: 1, star: 10 },
      { id: 10, type: 2, relationId: 11, title: "本人待审旁观", isVerify: 0, status: 1, star: 999 },
      { id: 11, type: 2, relationId: 11, title: "删除旁观", isVerify: 1, status: 1, isDel: 1, star: 999 },
      { id: 12, type: 2, relationId: 11, title: "下架旁观", isVerify: 1, status: 0, star: 999 },
    ]);
    await f.db.insert(video).values([1,2,3].map(id => ({ id, desc: `错误短视频域${id}`, playNum: 77+id,
      sort: 100-id, isShow: 1, isVerify: 1 })));
    const settings = { station_open: "1", community_status: "1", community_comment_status: "1", community_comment_add: "1",
      community_comment_verify: "0", video_func_status: "1", site_name: '"DIY社区验收"', wap_login_logo: '""', routine_contact_type: "0" };
    await f.db.insert(systemConfig).values(Object.entries(settings).map(([menuName,value])=>({ menuName,value,status:1 })));
    const block = (timestamp: number, count: number, columns: boolean) => ({ name: "community", timestamp, isHide: 0,
      numberConfig: { val: count }, styleConfig: { tabVal: columns?1:0 }, titleConfig: { tabVal: columns?0:1 },
      titleTxtConfig: { value: columns ? "图片标题七条" : "社区横向三条" }, imgConfig: { url: "/static/logo.png" },
      rightBntConfig: { value: "更多社区" }, selectConfig: { activeValue: "999" },
      headerBgColor: { color: [{item:"#ffffff"},{item:"#f0f8ff"}] }, titleText: { tabVal: 0 }, titleNumber: { val: 16 },
      titleColor: { color:[{item:"#163a50"}] }, bntNumber: { val: 12 }, headerBntColor: { color:[{item:"#25636b"}] },
      videoSpace: { val: 8 }, videoSpace2: { val: 8 }, filletImg: { type:0,val:8 }, topConfig:{val:8},prConfig:{val:10},bottomConfig:{val:8},mbConfig:{val:8},
      bottomBgColor:{color:[{item:"#f5f7fa"}]},fillet:{type:0,val:12},moduleColor:{color:[{item:"#ffffff"},{item:"#ffffff"}]} });
    const blocks = [{ name:"titles",timestamp:1,titleConfig:{value:"保留商城内容"} },block(101,3,false),block(102,7,true)];
    await f.db.insert(systemDise).values([
      { id:1,title:"社区组件首页",templateName:"default",type:1,status:1,isDiy:1,isShow:1,version:"diy-community-1",value:JSON.stringify(blocks) },
      { id:2,title:"社区组件微页面",templateName:"micro",type:2,status:1,isDiy:1,isShow:1,version:"diy-community-1",value:JSON.stringify(blocks) },
    ]);
    return { ...f, image, clip, png, blocks, publicIds, mainId:1, videoId:2 };
  } catch (error) { await f.close(); throw error; }
}
