<template>
  <ThemePage>
    <view class="personal-data">
      <view v-if="!s.loggedIn" class="profile-state"><text>登录后管理个人资料</text><button @tap="s.login">去登录</button></view>
      <template v-else>
        <view v-if="s.loading" class="profile-state" role="status">正在读取个人资料…</view>
        <view v-if="s.error" class="profile-notice error" role="alert"><text>{{ s.error }}</text><button :disabled="s.locked" @tap="s.load">重新读取并核对</button></view>
        <view v-if="s.notice" class="profile-notice" role="status">{{ s.notice }}</view>
        <template v-if="s.snapshot">
          <view class="profile-toolbar"><text>个人资料</text><button :disabled="s.locked" @tap="s.load">重新读取</button></view>
          <view class="profile-list">
            <view class="profile-item avatar-row"><text>头像</text>
              <!-- #ifdef MP-WEIXIN -->
              <button v-if="s.nativeAvatarAvailable" :key="s.nativeAvatarButton.key" class="avatar-box" open-type="chooseAvatar" :disabled="!s.editable" aria-label="修改头像" @chooseavatar="s.nativeAvatarButton.choose"><image v-if="s.avatarView.src" :key="s.avatarView.src" :src="s.avatarView.src" mode="aspectFill" @error="s.avatarView.error" /><text v-else class="avatar-empty">{{ s.draft.nickname.slice(0,1) || '头像' }}</text></button>
              <template v-else>
              <!-- #endif -->
              <button class="avatar-box" :disabled="!s.editable" aria-label="修改头像" @tap="s.chooseAvatar"><image v-if="s.avatarView.src" :key="s.avatarView.src" :src="s.avatarView.src" mode="aspectFill" @error="s.avatarView.error" /><text v-else class="avatar-empty">{{ s.draft.nickname.slice(0,1) || '头像' }}</text></button>
              <!-- #ifdef MP-WEIXIN -->
              </template>
              <!-- #endif -->
            </view>
            <view v-if="s.busy==='choose'||s.busy==='prepare'||s.busy==='upload'" class="field-note"><text>{{ s.busy==='upload'?'头像上传中…':s.busy==='prepare'?'头像图片处理中…':'请选择一张头像图片' }}</text><button v-if="s.busy==='choose'" aria-label="取消头像选择" @tap="s.cancelAvatarChoice">取消选择</button></view>
            <view v-if="s.uploadReview" class="field-note"><button :disabled="s.locked" @tap="s.keepAvatar">保留原头像</button></view>
            <view class="profile-item"><text>昵称</text><input class="profile-input" :value="s.draft.nickname" type="nickname" :maxlength="Math.max(16,s.snapshot.profile.nickname.length)" placeholder="请输入昵称" aria-label="昵称" :disabled="!s.editable" @input="s.setNickname" /></view>
            <view class="profile-item action-row" role="button" aria-label="手机号码" @tap="s.phone"><text>手机号码</text><view class="profile-value"><text>{{ s.snapshot.profile.phone || '点击绑定手机号' }}</text><text class="arrow">›</text></view></view>
            <view class="profile-item"><text>ID号</text><view class="profile-value"><text>{{ s.snapshot.profile.uid }}</text><text class="lock-symbol" aria-label="不可修改"></text></view></view>
            <view v-if="s.snapshot.profile.phone && s.passwordAvailable" class="profile-item action-row" role="button" aria-label="修改密码" @tap="s.password"><text>密码</text><view class="profile-value"><text>点击修改密码</text><text class="arrow">›</text></view></view>
            <view v-for="field in s.fields" :key="field.info" class="profile-item extended-item" :data-profile-field="field.info">
              <view class="field-label"><text>{{ field.info }}</text><text v-if="field.required" class="required">*</text></view>
              <radio-group v-if="field.format==='radio'" class="profile-radios" :aria-label="field.info" @change="(event: unknown) => s.setField(field.info,event)">
                <label v-for="(option,index) in field.singlearr" :key="index"><radio :value="String(index)" :checked="s.draft.fields[field.info]===String(index)" :disabled="!s.editable" color="#e93323" /><text>{{ option }}</text></label>
              </radio-group>
              <picker v-else-if="field.format==='date'" mode="date" :value="s.draft.fields[field.info]" :disabled="!s.editable" class="date-picker" :aria-label="field.info" @change="(event: unknown) => s.setField(field.info,event)"><view class="profile-value"><text>{{ s.draft.fields[field.info] || field.tip }}</text><text class="arrow">›</text></view></picker>
              <input v-else class="profile-input" :value="s.draft.fields[field.info]" :type="field.format==='num'?'digit':field.format==='id'?'idcard':'text'" :inputmode="field.format==='mail'?'email':field.format==='phone'?'tel':field.format==='num'?'decimal':'text'" :maxlength="Math.max(1024,field.value.length)" :placeholder="field.tip" :aria-label="field.info" :disabled="!s.editable" @input="(event: unknown) => s.setField(field.info,event)" />
            </view>
          </view>
          <view v-if="s.backup" class="draft-card"><text class="draft-title">已保留的草稿</text><view class="draft-row"><text>昵称</text><text>{{ s.backup.draft.nickname }}</text></view><view v-for="(value,name) in s.backup.draft.fields" :key="name" class="draft-row"><text>{{ name }}</text><text>{{ value || '未填写' }}</text></view><text v-if="!s.canRestore" class="field-note">资料填写要求已变化时，请按当前要求重新填写。</text><view class="draft-actions"><button :disabled="!s.canRestore" @tap="s.restore">恢复草稿</button><button :disabled="s.locked" @tap="s.discardBackup">放弃草稿</button></view></view>
          <button class="modifyBnt" :loading="s.busy==='save'" :disabled="!s.editable" @tap="s.save">{{ s.busy==='save'?'保存中…':'保存修改' }}</button>
        </template>
      </template>
    </view>
    <!-- Mount at the target size so H5 initializes its backing buffer before drawing. -->
    <canvas :key="s.avatarCanvas.width+'x'+s.avatarCanvas.height" :canvas-id="s.avatarCanvasId" :id="s.avatarCanvasId" class="avatar-canvas" :style="{width:s.avatarCanvas.width+'px',height:s.avatarCanvas.height+'px'}" aria-hidden="true" />
    <DiySuspendedNavigation />
  </ThemePage>
</template>
<script setup lang="ts">
import { reactive } from 'vue';
import ThemePage from '@/components/ThemePage.vue';
import { useCustomerProfile } from '@/composables/useCustomerProfile';
const s=reactive(useCustomerProfile());
</script>
<style scoped>
.avatar-canvas{position:fixed;left:-100000px;top:0;pointer-events:none}
.personal-data{min-height:100vh;padding:15rpx 20rpx 50rpx;background:#f5f5f5;box-sizing:border-box;color:#333;max-width:1000rpx;margin:auto}.profile-list{background:#fff;border-radius:24rpx;overflow:hidden}.profile-item{display:flex;align-items:center;justify-content:space-between;gap:24rpx;padding:32rpx 20rpx 32rpx 24rpx;font-size:30rpx;min-height:42rpx;border-bottom:1rpx solid #f3f3f3}.profile-item:last-child{border-bottom:0}.profile-input{flex:1;min-width:0;max-width:460rpx;text-align:right;color:#666;font-size:30rpx}.profile-value{display:flex;align-items:center;justify-content:flex-end;gap:12rpx;color:#999;min-width:0;overflow-wrap:anywhere}.arrow{font-size:38rpx;line-height:1;color:#aaa}.lock-symbol{display:inline-block;position:relative;width:17rpx;height:14rpx;border:2rpx solid #aaa;border-radius:3rpx;box-sizing:border-box;margin-top:8rpx}.lock-symbol::before{content:"";position:absolute;width:9rpx;height:10rpx;border:2rpx solid #aaa;border-bottom:0;border-radius:8rpx 8rpx 0 0;left:2rpx;top:-11rpx;box-sizing:border-box}.avatar-box{width:96rpx;height:96rpx;border-radius:50%;margin:0;padding:0;flex-shrink:0;border:1rpx solid #eee;overflow:hidden;background:#f5f5f5}.avatar-box::after{border:0}.avatar-box image{width:100%;height:100%}.avatar-empty{display:flex;align-items:center;justify-content:center;width:100%;height:100%;font-size:34rpx;color:#999}.field-label{display:flex;gap:6rpx;align-items:center;flex-shrink:0;max-width:240rpx;overflow-wrap:anywhere}.required{color:#e93323;font-size:22rpx}.profile-radios{display:flex;gap:16rpx;flex-wrap:wrap;justify-content:flex-end;flex:1;min-width:0}.profile-radios label{display:flex;align-items:center;gap:4rpx;font-size:27rpx}.date-picker{flex:1;min-width:0}.modifyBnt{font-size:30rpx;color:#333;width:100%;height:98rpx;border-radius:24rpx;line-height:98rpx;margin:20rpx auto 0;padding:0;background:#fff}.modifyBnt::after{border:0}.profile-toolbar{display:flex;justify-content:space-between;align-items:center;font-size:26rpx;color:#777;padding:8rpx 4rpx 18rpx}.profile-toolbar button,.profile-notice button,.field-note button,.draft-actions button{margin:0;padding:4rpx 20rpx;border-radius:16rpx;font-size:24rpx;line-height:2;background:#fff;color:#666}.profile-toolbar button::after,.profile-notice button::after,.field-note button::after,.draft-actions button::after{border:1rpx solid #ddd}.profile-state{padding:70rpx 20rpx;text-align:center;font-size:28rpx;color:#777}.profile-state button{font-size:28rpx;margin-top:24rpx}.profile-notice{padding:22rpx 24rpx;margin-bottom:20rpx;border-radius:18rpx;background:#fff;color:#666;font-size:25rpx;line-height:1.6;overflow-wrap:anywhere}.profile-notice button{margin-top:12rpx;width:max-content}.profile-notice.error{color:#a82f25;background:#fff6f3}.field-note{display:block;padding:0 24rpx 20rpx;color:#999;font-size:24rpx;line-height:1.6}.draft-card{margin-top:20rpx;border-radius:24rpx;background:#fff;padding:24rpx;font-size:26rpx;color:#666}.draft-title{display:block;font-size:28rpx;font-weight:600;margin-bottom:12rpx}.draft-row{display:flex;gap:24rpx;justify-content:space-between;padding:12rpx 0;overflow-wrap:anywhere}.draft-row text:last-child{max-width:70%;text-align:right}.draft-actions{display:flex;gap:16rpx;margin-top:20rpx}.draft-card .field-note{padding:12rpx 0}button[disabled]{opacity:.55}@media(max-width:360px){.extended-item{align-items:flex-start;flex-wrap:wrap}.extended-item .profile-input,.extended-item .profile-radios,.extended-item .date-picker{flex-basis:100%;max-width:100%;margin-top:8rpx}}
</style>
