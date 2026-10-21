// Independent PHP group inventory plus the three TS aliases and read-only state.
export const communityAvailabilityRoutes = [
  {
    "method": "GET",
    "path": "/api/community/topic",
    "auth": "optional",
    "handler": "communityTopic"
  },
  {
    "method": "GET",
    "path": "/api/community/list",
    "auth": "optional",
    "handler": "communityList"
  },
  {
    "method": "GET",
    "path": "/api/community/detail/:id",
    "auth": "optional",
    "handler": "communityDetail"
  },
  {
    "method": "GET",
    "path": "/api/community/state/:id",
    "auth": "optional",
    "handler": "communityState"
  },
  {
    "method": "GET",
    "path": "/api/community/product_list",
    "auth": "optional",
    "handler": "communityProductList"
  },
  {
    "method": "GET",
    "path": "/api/community/topic_count/:id",
    "auth": "optional",
    "handler": "communityTopicCount"
  },
  {
    "method": "POST",
    "path": "/api/community/like/:id",
    "auth": "required",
    "handler": "communityLike"
  },
  {
    "method": "POST",
    "path": "/api/community_save",
    "auth": "required",
    "handler": "communitySave"
  },
  {
    "method": "GET",
    "path": "/api/community/comment/list",
    "auth": "optional",
    "handler": "communityCommentList"
  },
  {
    "method": "POST",
    "path": "/api/community/comment/save",
    "auth": "required",
    "handler": "communityCommentSave"
  },
  {
    "method": "DELETE",
    "path": "/api/community_delete/:id",
    "auth": "required",
    "handler": "communityDelete"
  },
  {
    "method": "POST",
    "path": "/api/community/community_like/:id",
    "auth": "required",
    "handler": "communityLike"
  },
  {
    "method": "POST",
    "path": "/api/community/community_save",
    "auth": "required",
    "handler": "communitySave"
  },
  {
    "method": "POST",
    "path": "/api/community/community_update/:id",
    "auth": "required",
    "handler": "communityUpdate"
  },
  {
    "method": "GET",
    "path": "/api/community/like_list",
    "auth": "required",
    "handler": "communityLikeList"
  },
  {
    "method": "GET",
    "path": "/api/community/elegant_list",
    "auth": "required",
    "handler": "communityElegantList"
  },
  {
    "method": "GET",
    "path": "/api/community/share/:id",
    "auth": "required",
    "handler": "communityShare"
  },
  {
    "method": "POST",
    "path": "/api/community/comment_like/:id",
    "auth": "required",
    "handler": "communityCommentLike"
  },
  {
    "method": "DELETE",
    "path": "/api/community/comment_delete/:id",
    "auth": "required",
    "handler": "communityCommentDelete"
  },
  {
    "method": "DELETE",
    "path": "/api/community/community_delete/:id",
    "auth": "required",
    "handler": "communityDelete"
  },
  {
    "method": "PUT",
    "path": "/api/community/browse/:id",
    "auth": "optional",
    "handler": "communityBrowse"
  },
  {
    "method": "GET",
    "path": "/api/community/user_info/:authorUid",
    "auth": "required",
    "handler": "communityUserInfo"
  },
  {
    "method": "POST",
    "path": "/api/community/update_desc",
    "auth": "required",
    "handler": "communityUpdateDesc"
  },
  {
    "method": "POST",
    "path": "/api/community/set_interest/:authorUid",
    "auth": "required",
    "handler": "communitySetInterest"
  },
  {
    "method": "GET",
    "path": "/api/community/follow_list/:type",
    "auth": "required",
    "handler": "communityFollowList"
  },
  {
    "method": "GET",
    "path": "/api/community/user_friend",
    "auth": "required",
    "handler": "communityUserFriend"
  },
  {
    "method": "GET",
    "path": "/api/community/recommend_list",
    "auth": "required",
    "handler": "communityRecommendList"
  },
  {
    "method": "GET",
    "path": "/api/community/follow",
    "auth": "required",
    "handler": "communityFollow"
  }
] as const;
