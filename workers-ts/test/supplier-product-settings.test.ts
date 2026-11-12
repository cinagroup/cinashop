import { describe,expect,it } from 'vitest';
import {supplierProductSettingsInput,supplierVideoOpen} from '@/services/supplier/SupplierProductSettings';
import {productSettingsEditor,productSettingsPayload,productCommandWord} from '../../view/supplier-ts/src/utils/productSettings';
describe('Supplier command and video setting intents',()=>{
  it('never treats undefined inherited or platform-only inputs as Supplier settings',()=>{
    for(const raw of [{},{command_word:undefined,video_open:undefined},Object.create({command_word:'other',video_open:1}),{mer_use:'bad'}])expect(supplierProductSettingsInput(raw)).toEqual({});
  });
  it.each([0,1,'0','1',false,true])('accepts actual legacy flag spelling %j',raw=>expect(supplierProductSettingsInput({video_open:raw})).toEqual({videoOpen:[1,'1',true].includes(raw)?1:0}));
  it.each([null,'',2,-1,'01',' 1 ',{},[]])('rejects malformed explicit video flag %j',raw=>expect(()=>supplierProductSettingsInput({video_open:raw})).toThrow());
  it('distinguishes retained closed videos from explicitly changed link defaults',()=>{
    const old={videoOpen:0,videoLink:'/owned.mp4'};expect(supplierVideoOpen({},old.videoLink,old)).toBe(0);
    expect(supplierVideoOpen({},'/new.mp4',old)).toBe(1);expect(supplierVideoOpen({},'',old)).toBe(0);expect(supplierVideoOpen({},'/new.mp4')).toBe(1);
    expect(supplierVideoOpen({videoOpen:0},'/new.mp4',old)).toBe(0);expect(supplierVideoOpen({videoOpen:1},old.videoLink,old)).toBe(1);
  });
  it('accepts exactly255 Unicode characters without counting surrogate pairs twice',()=>{
    const command='🛍'.repeat(255);expect(supplierProductSettingsInput({command_word:' '+command+' '})).toEqual({commandWord:command});expect(productCommandWord(command)).toBe(command);
    expect(()=>productCommandWord(command+'x')).toThrow();expect(()=>supplierProductSettingsInput({command_word:command+'x'})).toThrow();
  });
  it.each([null,1,{},[],'bad\ntext','\ud800','\u0000'])('rejects malformed explicit command %j',raw=>{expect(()=>supplierProductSettingsInput({command_word:raw})).toThrow();expect(()=>productCommandWord(raw)).toThrow();});
  it('keeps legacy read text omittable and the command and video dirty states independent',()=>{
    const editor=productSettingsEditor({version:1,command_word:'old\ncommand',video_open:0});expect(productSettingsPayload(editor)).toEqual({});
    expect(productSettingsPayload({...editor,videoOpen:1,videoChanged:true})).toEqual({video_open:1});
    expect(productSettingsPayload({...editor,commandWord:'',commandChanged:true})).toEqual({command_word:''});
    expect(productSettingsPayload({...productSettingsEditor(),commandChanged:true,videoChanged:true})).toEqual({});
    expect(productSettingsEditor(undefined,true).ready).toBe(true);
    const odd=productSettingsEditor({version:1,command_word:'keep',video_open:2});expect(productSettingsPayload(odd)).toEqual({});expect(productSettingsPayload({...odd,videoOpen:0,videoChanged:true})).toEqual({video_open:0});
  });
  it.each([null,[],{}, {version:2,command_word:'',video_open:0},{version:1,command_word:1,video_open:0},{version:1,command_word:'',video_open:'0'},{version:1,command_word:'',video_open:0,extra:true}])('rejects corrupt read %j',raw=>expect(()=>productSettingsEditor(raw)).toThrow());
});
