// Full PHP8ed2a5b ordinary defaults. Only new components use these; imports are never merged.
export const DIY_COMMERCE_DEFAULTS = {
  "coupon": {
    "cname": "优惠券",
    "name": "coupon",
    "timestamp": 0,
    "isHide": false,
    "setUp": {
      "tabVal": 0
    },
    "titleLeft": "展示设置",
    "titleData": "优惠券数据",
    "titleRight": "优惠券样式",
    "titleCurrency": "通用样式",
    "styleConfig": {
      "title": "选择风格",
      "tabVal": 0,
      "type": "coupon"
    },
    "numberConfig": {
      "title": "展示数量",
      "val": 5,
      "min": 1
    },
    "toneConfig": {
      "title": "色调",
      "tabVal": 0,
      "tabList": [
        {
          "name": "跟随主题风格"
        },
        {
          "name": "自定义"
        }
      ]
    },
    "couponMoneyColor": {
      "title": "优惠金额",
      "default": [
        {
          "item": "#E93323"
        }
      ],
      "color": [
        {
          "item": "#E93323"
        }
      ]
    },
    "bntBgColor": {
      "title": "按钮背景",
      "name": "bntBgColor",
      "default": [
        {
          "item": "#FF7931"
        },
        {
          "item": "#E93323"
        }
      ],
      "color": [
        {
          "item": "#FF7931"
        },
        {
          "item": "#E93323"
        }
      ]
    },
    "couponBgColor": {
      "title": "优惠券背景",
      "default": [
        {
          "item": "#E93323"
        }
      ],
      "color": [
        {
          "item": "#E93323"
        }
      ]
    },
    "spacingConfig": {
      "title": "优惠券间距",
      "val": 6,
      "min": 0
    },
    "moduleColor": {
      "title": "组件背景",
      "default": [
        {
          "item": "#E93323"
        },
        {
          "item": "#FF7931"
        }
      ],
      "color": [
        {
          "item": "#E93323"
        },
        {
          "item": "#FF7931"
        }
      ]
    },
    "moduleColor2": {
      "title": "组件背景",
      "default": [
        {
          "item": "#ffffff"
        }
      ],
      "color": [
        {
          "item": "#ffffff"
        }
      ]
    },
    "bottomBgColor": {
      "title": "底部背景",
      "default": [
        {
          "item": "#f5f5f5"
        }
      ],
      "color": [
        {
          "item": "#f5f5f5"
        }
      ]
    },
    "topConfig": {
      "title": "上边距",
      "val": 0,
      "min": 0
    },
    "bottomConfig": {
      "title": "下边距",
      "val": 0,
      "min": 0
    },
    "prConfig": {
      "title": "左右边距",
      "val": 10,
      "min": 0
    },
    "mbConfig": {
      "title": "页面上间距",
      "val": 0,
      "min": 0
    },
    "fillet": {
      "title": "背景圆角",
      "type": 0,
      "list": [
        {
          "val": "全部",
          "icon": "iconcaozuo-zhengti"
        },
        {
          "val": "单个",
          "icon": "iconcaozuo-bianjiao"
        }
      ],
      "valName": "圆角值",
      "val": 8,
      "min": 0,
      "valList": [
        {
          "val": 0
        },
        {
          "val": 0
        },
        {
          "val": 0
        },
        {
          "val": 0
        }
      ]
    }
  },
  "seckill": {
    "cname": "秒杀",
    "name": "seckill",
    "timestamp": 0,
    "isHide": false,
    "setUp": {
      "tabVal": 0
    },
    "titleLeft": "头部设置",
    "titleGoodsList": "商品列表",
    "titleGoods": "商品设置",
    "titleRight": "头部样式",
    "titleGoodsStyle": "商品样式",
    "titleCurrency": "通用样式",
    "styleConfig": {
      "title": "选择风格",
      "tabVal": 1,
      "tabList": [
        {
          "name": "背景色"
        },
        {
          "name": "背景图片"
        }
      ]
    },
    "imgBgConfig": {
      "info": "建议：710px * 96px",
      "url": "/static/images/diy/seckillBg.png",
      "type": "code",
      "delType": 0,
      "name": "背景图片"
    },
    "titleConfig": {
      "title": "标题类型",
      "tabVal": 0,
      "tabList": [
        {
          "name": "图片"
        },
        {
          "name": "文字"
        }
      ]
    },
    "imgConfig": {
      "info": "建议：154px * 32px",
      "url": "/static/images/diy/seckill02.png",
      "type": "code",
      "delType": 0,
      "name": "标题图片"
    },
    "imgColorConfig": {
      "info": "建议：154px * 32px",
      "url": "/static/images/diy/seckill01.png",
      "type": "code",
      "delType": 0,
      "name": "标题图片"
    },
    "titleTxtConfig": {
      "title": "标题文字",
      "value": "限时秒杀",
      "place": "请输入标题文字",
      "max": 6
    },
    "rightBntConfig": {
      "title": "右侧按钮",
      "value": "更多",
      "place": "请输入右侧按钮",
      "max": 6
    },
    "goodStyleConfig": {
      "title": "选择风格",
      "tabVal": 0,
      "tabList": [
        {
          "name": "单列展示"
        },
        {
          "name": "两列展示(纵向)"
        },
        {
          "name": "三列展示"
        },
        {
          "name": "左右滑动展示"
        }
      ]
    },
    "numberConfig": {
      "title": "商品数量",
      "val": 3,
      "min": 1
    },
    "checkboxInfo": {
      "title": "展示信息",
      "name": "checkboxInfo",
      "type": [
        0,
        1,
        2,
        3
      ],
      "list": [
        {
          "id": 0,
          "name": "商品名称"
        },
        {
          "id": 1,
          "name": "秒杀进度"
        },
        {
          "id": 2,
          "name": "商品价格"
        },
        {
          "id": 3,
          "name": "划线价"
        }
      ]
    },
    "seckillConfig": {
      "title": "秒杀按钮",
      "tabVal": 0,
      "tabList": [
        {
          "name": "显示"
        },
        {
          "name": "隐藏"
        }
      ]
    },
    "headerBgColor": {
      "title": "背景颜色",
      "name": "headerBgColor",
      "default": [
        {
          "item": "#fff"
        },
        {
          "item": "#fff"
        }
      ],
      "color": [
        {
          "item": "#fff"
        },
        {
          "item": "#fff"
        }
      ]
    },
    "titleText": {
      "title": "标题文字",
      "tabVal": 0,
      "tabList": [
        {
          "name": "加粗",
          "style": "bold"
        },
        {
          "name": "正常",
          "style": "normal"
        },
        {
          "name": "倾斜",
          "style": "italic"
        }
      ]
    },
    "titleColor": {
      "title": "标题颜色",
      "name": "titleColor",
      "default": [
        {
          "item": "#333333"
        }
      ],
      "color": [
        {
          "item": "#333333"
        }
      ]
    },
    "titleNumber": {
      "title": "标题字号",
      "val": 16,
      "min": 0
    },
    "headerBntColor": {
      "title": "按钮颜色",
      "name": "headerBntColor",
      "default": [
        {
          "item": "#fff"
        }
      ],
      "color": [
        {
          "item": "#fff"
        }
      ]
    },
    "headerBntColor2": {
      "title": "按钮颜色",
      "name": "headerBntColor2",
      "default": [
        {
          "item": "#999"
        }
      ],
      "color": [
        {
          "item": "#999"
        }
      ]
    },
    "bntNumber": {
      "title": "按钮字号",
      "val": 12,
      "min": 0
    },
    "tipsColor": {
      "title": "距离结束",
      "name": "tipsColor",
      "default": [
        {
          "item": "#fff"
        }
      ],
      "color": [
        {
          "item": "#fff"
        }
      ]
    },
    "tipsColor2": {
      "title": "距离结束",
      "name": "tipsColor2",
      "default": [
        {
          "item": "#666"
        }
      ],
      "color": [
        {
          "item": "#666"
        }
      ]
    },
    "numberBgColor": {
      "title": "数字背景",
      "name": "numberBgColor",
      "default": [
        {
          "item": "#fff"
        },
        {
          "item": "#fff"
        }
      ],
      "color": [
        {
          "item": "#fff"
        },
        {
          "item": "#fff"
        }
      ]
    },
    "numberBgColor2": {
      "title": "数字背景",
      "name": "numberBgColor2",
      "default": [
        {
          "item": "#E93323"
        },
        {
          "item": "#E93323"
        }
      ],
      "color": [
        {
          "item": "#E93323"
        },
        {
          "item": "#E93323"
        }
      ]
    },
    "numberColor": {
      "title": "数字",
      "name": "numberColor",
      "default": [
        {
          "item": "#E93323"
        }
      ],
      "color": [
        {
          "item": "#E93323"
        }
      ]
    },
    "numberColor2": {
      "title": "数字",
      "name": "numberColor2",
      "default": [
        {
          "item": "#fff"
        }
      ],
      "color": [
        {
          "item": "#fff"
        }
      ]
    },
    "filletImg": {
      "title": "图片圆角",
      "type": 0,
      "list": [
        {
          "val": "全部",
          "icon": "iconcaozuo-zhengti"
        },
        {
          "val": "单个",
          "icon": "iconcaozuo-bianjiao"
        }
      ],
      "valName": "圆角值",
      "val": 0,
      "min": 0,
      "valList": [
        {
          "val": 0
        },
        {
          "val": 0
        },
        {
          "val": 0
        },
        {
          "val": 0
        }
      ]
    },
    "goodsName": {
      "title": "商品名称",
      "tabVal": 1,
      "tabList": [
        {
          "name": "加粗",
          "style": "bold"
        },
        {
          "name": "正常",
          "style": "normal"
        }
      ]
    },
    "goodsNameColor": {
      "title": "商品名称",
      "name": "goodsNameColor",
      "default": [
        {
          "item": "#333333"
        }
      ],
      "color": [
        {
          "item": "#333333"
        }
      ]
    },
    "goodsPriceColor": {
      "title": "划线价",
      "name": "goodsPriceColor",
      "default": [
        {
          "item": "#999999"
        }
      ],
      "color": [
        {
          "item": "#999999"
        }
      ]
    },
    "toneConfig": {
      "title": "色调",
      "tabVal": 0,
      "tabList": [
        {
          "name": "跟随主题风格"
        },
        {
          "name": "自定义"
        }
      ]
    },
    "seckillPriceColor": {
      "title": "秒杀价格",
      "name": "seckillPriceColor",
      "default": [
        {
          "item": "#E93323"
        }
      ],
      "color": [
        {
          "item": "#E93323"
        }
      ]
    },
    "seckillPriceColor2": {
      "title": "秒杀价格",
      "name": "seckillPriceColor2",
      "default": [
        {
          "item": "#fff"
        }
      ],
      "color": [
        {
          "item": "#fff"
        }
      ]
    },
    "progressColor": {
      "title": "进度条颜色",
      "name": "progressColor",
      "default": [
        {
          "item": "#FF7931"
        },
        {
          "item": "#E93323"
        }
      ],
      "color": [
        {
          "item": "#FF7931"
        },
        {
          "item": "#E93323"
        }
      ]
    },
    "progressTxtColor": {
      "title": "秒杀进度",
      "name": "progressTxtColor",
      "default": [
        {
          "item": "#E93323"
        }
      ],
      "color": [
        {
          "item": "#E93323"
        }
      ]
    },
    "goodsBntColor": {
      "title": "按钮颜色",
      "name": "goodsBntColor",
      "default": [
        {
          "item": "#FF7931"
        },
        {
          "item": "#E93323"
        }
      ],
      "color": [
        {
          "item": "#FF7931"
        },
        {
          "item": "#E93323"
        }
      ]
    },
    "goodsBntTxtColor": {
      "title": "按钮文字",
      "name": "goodsBntTxtColor",
      "default": [
        {
          "item": "#fff"
        }
      ],
      "color": [
        {
          "item": "#fff"
        }
      ]
    },
    "moduleColor": {
      "title": "组件背景",
      "default": [
        {
          "item": "#fff"
        },
        {
          "item": "#fff"
        }
      ],
      "color": [
        {
          "item": "#fff"
        },
        {
          "item": "#fff"
        }
      ]
    },
    "bottomBgColor": {
      "title": "底部背景",
      "default": [
        {
          "item": "#f5f5f5"
        }
      ],
      "color": [
        {
          "item": "#f5f5f5"
        }
      ]
    },
    "topConfig": {
      "title": "上边距",
      "val": 0,
      "min": 0
    },
    "bottomConfig": {
      "title": "下边距",
      "val": 0,
      "min": 0
    },
    "prConfig": {
      "title": "左右边距",
      "val": 10,
      "min": 0
    },
    "mbConfig": {
      "title": "页面上间距",
      "val": 0,
      "min": 0
    },
    "fillet": {
      "title": "背景圆角",
      "type": 0,
      "list": [
        {
          "val": "全部",
          "icon": "iconcaozuo-zhengti"
        },
        {
          "val": "单个",
          "icon": "iconcaozuo-bianjiao"
        }
      ],
      "valName": "圆角值",
      "val": 8,
      "min": 0,
      "valList": [
        {
          "val": 0
        },
        {
          "val": 0
        },
        {
          "val": 0
        },
        {
          "val": 0
        }
      ]
    }
  },
  "combination": {
    "cname": "拼团",
    "name": "combination",
    "timestamp": 0,
    "isHide": false,
    "setUp": {
      "tabVal": 0
    },
    "titleLeft": "头部设置",
    "titleGoodsList": "商品列表",
    "titleGoods": "商品设置",
    "titleRight": "头部样式",
    "titleGoodsStyle": "商品样式",
    "titleCurrency": "通用样式",
    "styleConfig": {
      "title": "选择风格",
      "tabVal": 1,
      "tabList": [
        {
          "name": "背景色"
        },
        {
          "name": "背景图片"
        }
      ]
    },
    "imgBgConfig": {
      "info": "建议：710px * 96px",
      "url": "/static/images/diy/pinkBg.png",
      "type": "code",
      "delType": 0,
      "name": "背景图片"
    },
    "titleConfig": {
      "title": "标题类型",
      "tabVal": 0,
      "tabList": [
        {
          "name": "图片"
        },
        {
          "name": "文字"
        }
      ]
    },
    "imgConfig": {
      "info": "建议：154px * 32px",
      "url": "/static/images/diy/pink02.png",
      "type": "code",
      "delType": 0,
      "name": "标题图片"
    },
    "imgColorConfig": {
      "info": "建议：154px * 32px",
      "url": "/static/images/diy/pink01.png",
      "type": "code",
      "delType": 0,
      "name": "标题图片"
    },
    "titleTxtConfig": {
      "title": "标题文字",
      "value": "超值拼团",
      "place": "请输入标题文字",
      "max": 6
    },
    "rightBntConfig": {
      "title": "右侧按钮",
      "value": "更多",
      "place": "请输入右侧按钮",
      "max": 6
    },
    "goodStyleConfig": {
      "title": "选择风格",
      "tabVal": 0,
      "tabList": [
        {
          "name": "单列展示"
        },
        {
          "name": "两列展示(纵向)"
        },
        {
          "name": "三列展示"
        },
        {
          "name": "左右滑动展示"
        }
      ]
    },
    "numberConfig": {
      "title": "商品数量",
      "val": 3,
      "min": 1
    },
    "checkboxInfo": {
      "title": "展示信息",
      "name": "checkboxInfo",
      "type": [
        0,
        1,
        2,
        3
      ],
      "list": [
        {
          "id": 0,
          "name": "商品名称"
        },
        {
          "id": 1,
          "name": "商品标签"
        },
        {
          "id": 2,
          "name": "商品价格"
        },
        {
          "id": 3,
          "name": "划线价"
        }
      ]
    },
    "pinkConfig": {
      "title": "拼团按钮",
      "tabVal": 0,
      "tabList": [
        {
          "name": "显示"
        },
        {
          "name": "隐藏"
        }
      ]
    },
    "headerBgColor": {
      "title": "背景颜色",
      "name": "headerBgColor",
      "default": [
        {
          "item": "#fff"
        },
        {
          "item": "#fff"
        }
      ],
      "color": [
        {
          "item": "#fff"
        },
        {
          "item": "#fff"
        }
      ]
    },
    "titleText": {
      "title": "标题文字",
      "tabVal": 0,
      "tabList": [
        {
          "name": "加粗",
          "style": "bold"
        },
        {
          "name": "正常",
          "style": "normal"
        },
        {
          "name": "倾斜",
          "style": "italic"
        }
      ]
    },
    "titleColor": {
      "title": "标题颜色",
      "name": "titleColor",
      "default": [
        {
          "item": "#333333"
        }
      ],
      "color": [
        {
          "item": "#333333"
        }
      ]
    },
    "titleNumber": {
      "title": "标题字号",
      "val": 16,
      "min": 0
    },
    "labelColor": {
      "title": "标签颜色",
      "name": "labelColor",
      "default": [
        {
          "item": "#E93323"
        }
      ],
      "color": [
        {
          "item": "#E93323"
        }
      ]
    },
    "headerBntColor": {
      "title": "按钮颜色",
      "name": "headerBntColor",
      "default": [
        {
          "item": "#fff"
        }
      ],
      "color": [
        {
          "item": "#fff"
        }
      ]
    },
    "headerBntColor2": {
      "title": "按钮颜色",
      "name": "headerBntColor2",
      "default": [
        {
          "item": "#999"
        }
      ],
      "color": [
        {
          "item": "#999"
        }
      ]
    },
    "bntNumber": {
      "title": "按钮字号",
      "val": 12,
      "min": 0
    },
    "tipsColor": {
      "title": "提示文字",
      "name": "tipsColor",
      "default": [
        {
          "item": "#fff"
        }
      ],
      "color": [
        {
          "item": "#fff"
        }
      ]
    },
    "tipsColor2": {
      "title": "提示文字",
      "name": "tipsColor2",
      "default": [
        {
          "item": "#999"
        }
      ],
      "color": [
        {
          "item": "#999"
        }
      ]
    },
    "dividerColor": {
      "title": "分割线",
      "name": "dividerColor",
      "default": [
        {
          "item": "#DDDDDD"
        }
      ],
      "color": [
        {
          "item": "#DDDDDD"
        }
      ]
    },
    "filletImg": {
      "title": "图片圆角",
      "type": 0,
      "list": [
        {
          "val": "全部",
          "icon": "iconcaozuo-zhengti"
        },
        {
          "val": "单个",
          "icon": "iconcaozuo-bianjiao"
        }
      ],
      "valName": "圆角值",
      "val": 0,
      "min": 0,
      "valList": [
        {
          "val": 0
        },
        {
          "val": 0
        },
        {
          "val": 0
        },
        {
          "val": 0
        }
      ]
    },
    "goodsName": {
      "title": "商品名称",
      "tabVal": 1,
      "tabList": [
        {
          "name": "加粗",
          "style": "bold"
        },
        {
          "name": "正常",
          "style": "normal"
        }
      ]
    },
    "goodsNameColor": {
      "title": "商品名称",
      "name": "goodsNameColor",
      "default": [
        {
          "item": "#333333"
        }
      ],
      "color": [
        {
          "item": "#333333"
        }
      ]
    },
    "goodsPriceColor": {
      "title": "划线价",
      "name": "goodsPriceColor",
      "default": [
        {
          "item": "#999999"
        }
      ],
      "color": [
        {
          "item": "#999999"
        }
      ]
    },
    "toneConfig": {
      "title": "色调",
      "tabVal": 0,
      "tabList": [
        {
          "name": "跟随主题风格"
        },
        {
          "name": "自定义"
        }
      ]
    },
    "pinkPriceColor": {
      "title": "拼团价格",
      "name": "pinkPriceColor",
      "default": [
        {
          "item": "#E93323"
        }
      ],
      "color": [
        {
          "item": "#E93323"
        }
      ]
    },
    "goodsBntColor": {
      "title": "按钮颜色",
      "name": "goodsBntColor",
      "default": [
        {
          "item": "#FF7931"
        },
        {
          "item": "#E93323"
        }
      ],
      "color": [
        {
          "item": "#FF7931"
        },
        {
          "item": "#E93323"
        }
      ]
    },
    "goodsBntTxtColor": {
      "title": "按钮文字",
      "name": "goodsBntTxtColor",
      "default": [
        {
          "item": "#fff"
        }
      ],
      "color": [
        {
          "item": "#fff"
        }
      ]
    },
    "moduleColor": {
      "title": "组件背景",
      "default": [
        {
          "item": "#fff"
        },
        {
          "item": "#fff"
        }
      ],
      "color": [
        {
          "item": "#fff"
        },
        {
          "item": "#fff"
        }
      ]
    },
    "bottomBgColor": {
      "title": "底部背景",
      "default": [
        {
          "item": "#f5f5f5"
        }
      ],
      "color": [
        {
          "item": "#f5f5f5"
        }
      ]
    },
    "topConfig": {
      "title": "上边距",
      "val": 0,
      "min": 0
    },
    "bottomConfig": {
      "title": "下边距",
      "val": 0,
      "min": 0
    },
    "prConfig": {
      "title": "左右边距",
      "val": 10,
      "min": 0
    },
    "mbConfig": {
      "title": "页面上间距",
      "val": 0,
      "min": 0
    },
    "fillet": {
      "title": "背景圆角",
      "type": 0,
      "list": [
        {
          "val": "全部",
          "icon": "iconcaozuo-zhengti"
        },
        {
          "val": "单个",
          "icon": "iconcaozuo-bianjiao"
        }
      ],
      "valName": "圆角值",
      "val": 8,
      "min": 0,
      "valList": [
        {
          "val": 0
        },
        {
          "val": 0
        },
        {
          "val": 0
        },
        {
          "val": 0
        }
      ]
    }
  },
  "bargain": {
    "cname": "砍价",
    "name": "bargain",
    "timestamp": 0,
    "isHide": false,
    "setUp": {
      "tabVal": 0
    },
    "titleLeft": "头部设置",
    "titleGoodsList": "商品列表",
    "titleGoods": "商品设置",
    "titleRight": "头部样式",
    "titleGoodsStyle": "商品样式",
    "titleCurrency": "通用样式",
    "styleConfig": {
      "title": "选择风格",
      "tabVal": 1,
      "tabList": [
        {
          "name": "背景色"
        },
        {
          "name": "背景图片"
        }
      ]
    },
    "imgBgConfig": {
      "info": "建议：710px * 96px",
      "url": "/static/images/diy/bargainBg.png",
      "type": "code",
      "delType": 0,
      "name": "背景图片"
    },
    "titleConfig": {
      "title": "标题类型",
      "tabVal": 0,
      "tabList": [
        {
          "name": "图片"
        },
        {
          "name": "文字"
        }
      ]
    },
    "imgConfig": {
      "info": "建议：140px * 32px",
      "url": "/static/images/diy/bargain02.png",
      "type": "code",
      "delType": 0,
      "name": "标题图片"
    },
    "imgColorConfig": {
      "info": "建议：140px * 32px",
      "url": "/static/images/diy/bargain01.png",
      "type": "code",
      "delType": 0,
      "name": "标题图片"
    },
    "titleTxtConfig": {
      "title": "标题文字",
      "value": "疯狂砍价",
      "place": "请输入标题文字",
      "max": 6
    },
    "tipTxtConfig": {
      "title": "提示文字",
      "value": "低至0元免费拿",
      "place": "请输入提示文字",
      "max": 15
    },
    "rightBntConfig": {
      "title": "右侧按钮",
      "value": "更多",
      "place": "请输入右侧按钮",
      "max": 6
    },
    "goodStyleConfig": {
      "title": "选择风格",
      "tabVal": 0,
      "tabList": [
        {
          "name": "单列展示"
        },
        {
          "name": "两列展示(纵向)"
        },
        {
          "name": "三列展示"
        },
        {
          "name": "左右滑动展示"
        }
      ]
    },
    "numberConfig": {
      "title": "商品数量",
      "val": 3,
      "min": 1
    },
    "checkboxInfo": {
      "title": "展示信息",
      "name": "checkboxInfo",
      "type": [
        0,
        1,
        2,
        3
      ],
      "list": [
        {
          "id": 0,
          "name": "商品名称"
        },
        {
          "id": 1,
          "name": "参与人数"
        },
        {
          "id": 2,
          "name": "商品价格"
        },
        {
          "id": 3,
          "name": "划线价"
        }
      ]
    },
    "bargainConfig": {
      "title": "砍价按钮",
      "tabVal": 0,
      "tabList": [
        {
          "name": "显示"
        },
        {
          "name": "隐藏"
        }
      ]
    },
    "headerBgColor": {
      "title": "背景颜色",
      "name": "headerBgColor",
      "default": [
        {
          "item": "#fff"
        },
        {
          "item": "#fff"
        }
      ],
      "color": [
        {
          "item": "#fff"
        },
        {
          "item": "#fff"
        }
      ]
    },
    "titleText": {
      "title": "标题文字",
      "tabVal": 0,
      "tabList": [
        {
          "name": "加粗",
          "style": "bold"
        },
        {
          "name": "正常",
          "style": "normal"
        },
        {
          "name": "倾斜",
          "style": "italic"
        }
      ]
    },
    "titleColor": {
      "title": "标题颜色",
      "name": "titleColor",
      "default": [
        {
          "item": "#282828"
        }
      ],
      "color": [
        {
          "item": "#282828"
        }
      ]
    },
    "titleNumber": {
      "title": "标题字号",
      "val": 16,
      "min": 0
    },
    "headerBntColor": {
      "title": "按钮颜色",
      "name": "headerBntColor",
      "default": [
        {
          "item": "#fff"
        }
      ],
      "color": [
        {
          "item": "#fff"
        }
      ]
    },
    "headerBntColor2": {
      "title": "按钮颜色",
      "name": "headerBntColor2",
      "default": [
        {
          "item": "#999"
        }
      ],
      "color": [
        {
          "item": "#999"
        }
      ]
    },
    "bntNumber": {
      "title": "按钮字号",
      "val": 12,
      "min": 0
    },
    "tipsColor": {
      "title": "提示文字",
      "name": "tipsColor",
      "default": [
        {
          "item": "#fff"
        }
      ],
      "color": [
        {
          "item": "#fff"
        }
      ]
    },
    "tipsColor2": {
      "title": "提示文字",
      "name": "tipsColor2",
      "default": [
        {
          "item": "#999"
        }
      ],
      "color": [
        {
          "item": "#999"
        }
      ]
    },
    "dividerColor": {
      "title": "分割线",
      "name": "dividerColor",
      "default": [
        {
          "item": "#DDDDDD"
        }
      ],
      "color": [
        {
          "item": "#DDDDDD"
        }
      ]
    },
    "filletImg": {
      "title": "图片圆角",
      "type": 0,
      "list": [
        {
          "val": "全部",
          "icon": "iconcaozuo-zhengti"
        },
        {
          "val": "单个",
          "icon": "iconcaozuo-bianjiao"
        }
      ],
      "valName": "圆角值",
      "val": 0,
      "min": 0,
      "valList": [
        {
          "val": 0
        },
        {
          "val": 0
        },
        {
          "val": 0
        },
        {
          "val": 0
        }
      ]
    },
    "goodsName": {
      "title": "商品名称",
      "tabVal": 1,
      "tabList": [
        {
          "name": "加粗",
          "style": "bold"
        },
        {
          "name": "正常",
          "style": "normal"
        }
      ]
    },
    "goodsNameColor": {
      "title": "商品名称",
      "name": "goodsNameColor",
      "default": [
        {
          "item": "#333333"
        }
      ],
      "color": [
        {
          "item": "#333333"
        }
      ]
    },
    "goodsPriceColor": {
      "title": "划线价",
      "name": "goodsPriceColor",
      "default": [
        {
          "item": "#999999"
        }
      ],
      "color": [
        {
          "item": "#999999"
        }
      ]
    },
    "toneConfig": {
      "title": "色调",
      "tabVal": 0,
      "tabList": [
        {
          "name": "跟随主题风格"
        },
        {
          "name": "自定义"
        }
      ]
    },
    "joinNumColor": {
      "title": "参与人数",
      "name": "joinNumColor",
      "default": [
        {
          "item": "#E93323"
        }
      ],
      "color": [
        {
          "item": "#E93323"
        }
      ]
    },
    "joinNumColor2": {
      "title": "参与人数",
      "name": "joinNumColor2",
      "default": [
        {
          "item": "#fff"
        }
      ],
      "color": [
        {
          "item": "#fff"
        }
      ]
    },
    "joinBgColor": {
      "title": "参与背景",
      "name": "progressColor",
      "default": [
        {
          "item": "#FF7931"
        },
        {
          "item": "#E93323"
        }
      ],
      "color": [
        {
          "item": "#FF7931"
        },
        {
          "item": "#E93323"
        }
      ]
    },
    "bargainPriceColor": {
      "title": "砍价价格",
      "name": "bargainPriceColor",
      "default": [
        {
          "item": "#E93323"
        }
      ],
      "color": [
        {
          "item": "#E93323"
        }
      ]
    },
    "goodsBntColor": {
      "title": "按钮颜色",
      "name": "goodsBntColor",
      "default": [
        {
          "item": "#FF7931"
        },
        {
          "item": "#E93323"
        }
      ],
      "color": [
        {
          "item": "#FF7931"
        },
        {
          "item": "#E93323"
        }
      ]
    },
    "goodsBntTxtColor": {
      "title": "按钮文字",
      "name": "goodsBntTxtColor",
      "default": [
        {
          "item": "#fff"
        }
      ],
      "color": [
        {
          "item": "#fff"
        }
      ]
    },
    "moduleColor": {
      "title": "组件背景",
      "default": [
        {
          "item": "#fff"
        },
        {
          "item": "#fff"
        }
      ],
      "color": [
        {
          "item": "#fff"
        },
        {
          "item": "#fff"
        }
      ]
    },
    "bottomBgColor": {
      "title": "底部背景",
      "default": [
        {
          "item": "#f5f5f5"
        }
      ],
      "color": [
        {
          "item": "#f5f5f5"
        }
      ]
    },
    "topConfig": {
      "title": "上边距",
      "val": 0,
      "min": 0
    },
    "bottomConfig": {
      "title": "下边距",
      "val": 0,
      "min": 0
    },
    "prConfig": {
      "title": "左右边距",
      "val": 10,
      "min": 0
    },
    "mbConfig": {
      "title": "页面上间距",
      "val": 0,
      "min": 0
    },
    "fillet": {
      "title": "背景圆角",
      "type": 0,
      "list": [
        {
          "val": "全部",
          "icon": "iconcaozuo-zhengti"
        },
        {
          "val": "单个",
          "icon": "iconcaozuo-bianjiao"
        }
      ],
      "valName": "圆角值",
      "val": 8,
      "min": 0,
      "valList": [
        {
          "val": 0
        },
        {
          "val": 0
        },
        {
          "val": 0
        },
        {
          "val": 0
        }
      ]
    }
  },
  "presale": {
    "cname": "预售",
    "name": "presale",
    "timestamp": 0,
    "isHide": false,
    "setUp": {
      "tabVal": 0
    },
    "titleLeft": "头部设置",
    "titleGoodsList": "商品列表",
    "titleGoods": "商品设置",
    "titleRight": "头部样式",
    "titleGoodsStyle": "商品样式",
    "titleCurrency": "通用样式",
    "styleConfig": {
      "title": "选择风格",
      "tabVal": 1,
      "tabList": [
        {
          "name": "背景色"
        },
        {
          "name": "背景图片"
        }
      ]
    },
    "imgBgConfig": {
      "info": "建议：710px * 96px",
      "url": "/static/images/diy/presaleBg.png",
      "type": "code",
      "delType": 0,
      "name": "背景图片"
    },
    "titleConfig": {
      "title": "标题类型",
      "tabVal": 0,
      "tabList": [
        {
          "name": "图片"
        },
        {
          "name": "文字"
        }
      ]
    },
    "imgConfig": {
      "info": "建议：140px * 32px",
      "url": "/static/images/diy/presale02.png",
      "type": "code",
      "delType": 0,
      "name": "标题图片"
    },
    "imgColorConfig": {
      "info": "建议：140px * 32px",
      "url": "/static/images/diy/presale01.png",
      "type": "code",
      "delType": 0,
      "name": "标题图片"
    },
    "titleTxtConfig": {
      "title": "标题文字",
      "value": "预售专区",
      "place": "请输入标题文字",
      "max": 6
    },
    "tipTxtConfig": {
      "title": "提示文字",
      "value": "火热预定中",
      "place": "请输入提示文字",
      "max": 15
    },
    "rightBntConfig": {
      "title": "右侧按钮",
      "value": "更多",
      "place": "请输入右侧按钮",
      "max": 6
    },
    "goodStyleConfig": {
      "title": "选择风格",
      "tabVal": 0,
      "tabList": [
        {
          "name": "单列展示"
        },
        {
          "name": "两列展示(纵向)"
        },
        {
          "name": "三列展示"
        },
        {
          "name": "左右滑动展示"
        }
      ]
    },
    "numberConfig": {
      "title": "商品数量",
      "val": 3,
      "min": 1
    },
    "checkboxInfo": {
      "title": "展示信息",
      "name": "checkboxInfo",
      "type": [
        0,
        1,
        2
      ],
      "list": [
        {
          "id": 0,
          "name": "商品名称"
        },
        {
          "id": 1,
          "name": "预售价格"
        },
        {
          "id": 2,
          "name": "划线价"
        }
      ]
    },
    "presaleConfig": {
      "title": "预售按钮",
      "tabVal": 0,
      "tabList": [
        {
          "name": "显示"
        },
        {
          "name": "隐藏"
        }
      ]
    },
    "headerBgColor": {
      "title": "背景颜色",
      "name": "headerBgColor",
      "default": [
        {
          "item": "#fff"
        },
        {
          "item": "#fff"
        }
      ],
      "color": [
        {
          "item": "#fff"
        },
        {
          "item": "#fff"
        }
      ]
    },
    "titleText": {
      "title": "标题文字",
      "tabVal": 0,
      "tabList": [
        {
          "name": "加粗",
          "style": "bold"
        },
        {
          "name": "正常",
          "style": "normal"
        },
        {
          "name": "倾斜",
          "style": "italic"
        }
      ]
    },
    "titleColor": {
      "title": "标题颜色",
      "name": "titleColor",
      "default": [
        {
          "item": "#282828"
        }
      ],
      "color": [
        {
          "item": "#282828"
        }
      ]
    },
    "titleNumber": {
      "title": "标题字号",
      "val": 16,
      "min": 0
    },
    "headerBntColor": {
      "title": "按钮颜色",
      "name": "headerBntColor",
      "default": [
        {
          "item": "#fff"
        }
      ],
      "color": [
        {
          "item": "#fff"
        }
      ]
    },
    "headerBntColor2": {
      "title": "按钮颜色",
      "name": "headerBntColor2",
      "default": [
        {
          "item": "#999"
        }
      ],
      "color": [
        {
          "item": "#999"
        }
      ]
    },
    "bntNumber": {
      "title": "按钮字号",
      "val": 12,
      "min": 0
    },
    "tipsColor": {
      "title": "提示文字",
      "name": "tipsColor",
      "default": [
        {
          "item": "#fff"
        }
      ],
      "color": [
        {
          "item": "#fff"
        }
      ]
    },
    "tipsColor2": {
      "title": "提示文字",
      "name": "tipsColor2",
      "default": [
        {
          "item": "#999"
        }
      ],
      "color": [
        {
          "item": "#999"
        }
      ]
    },
    "dividerColor": {
      "title": "分割线",
      "name": "dividerColor",
      "default": [
        {
          "item": "#DDDDDD"
        }
      ],
      "color": [
        {
          "item": "#DDDDDD"
        }
      ]
    },
    "filletImg": {
      "title": "图片圆角",
      "type": 0,
      "list": [
        {
          "val": "全部",
          "icon": "iconcaozuo-zhengti"
        },
        {
          "val": "单个",
          "icon": "iconcaozuo-bianjiao"
        }
      ],
      "valName": "圆角值",
      "val": 0,
      "min": 0,
      "valList": [
        {
          "val": 0
        },
        {
          "val": 0
        },
        {
          "val": 0
        },
        {
          "val": 0
        }
      ]
    },
    "goodsName": {
      "title": "商品名称",
      "tabVal": 1,
      "tabList": [
        {
          "name": "加粗",
          "style": "bold"
        },
        {
          "name": "正常",
          "style": "normal"
        }
      ]
    },
    "goodsNameColor": {
      "title": "商品名称",
      "name": "goodsNameColor",
      "default": [
        {
          "item": "#333333"
        }
      ],
      "color": [
        {
          "item": "#333333"
        }
      ]
    },
    "goodsPriceColor": {
      "title": "划线价",
      "name": "goodsPriceColor",
      "default": [
        {
          "item": "#999999"
        }
      ],
      "color": [
        {
          "item": "#999999"
        }
      ]
    },
    "toneConfig": {
      "title": "色调",
      "tabVal": 0,
      "tabList": [
        {
          "name": "跟随主题风格"
        },
        {
          "name": "自定义"
        }
      ]
    },
    "presalePriceColor": {
      "title": "预售价格",
      "name": "presalePriceColor",
      "default": [
        {
          "item": "#E93323"
        }
      ],
      "color": [
        {
          "item": "#E93323"
        }
      ]
    },
    "goodsBntColor": {
      "title": "按钮颜色",
      "name": "goodsBntColor",
      "default": [
        {
          "item": "#E93323"
        },
        {
          "item": "#FF7931"
        }
      ],
      "color": [
        {
          "item": "#E93323"
        },
        {
          "item": "#FF7931"
        }
      ]
    },
    "goodsBntTxtColor": {
      "title": "按钮文字",
      "name": "goodsBntTxtColor",
      "default": [
        {
          "item": "#fff"
        }
      ],
      "color": [
        {
          "item": "#fff"
        }
      ]
    },
    "moduleColor": {
      "title": "组件背景",
      "default": [
        {
          "item": "#fff"
        },
        {
          "item": "#fff"
        }
      ],
      "color": [
        {
          "item": "#fff"
        },
        {
          "item": "#fff"
        }
      ]
    },
    "bottomBgColor": {
      "title": "底部背景",
      "default": [
        {
          "item": "#f5f5f5"
        }
      ],
      "color": [
        {
          "item": "#f5f5f5"
        }
      ]
    },
    "topConfig": {
      "title": "上边距",
      "val": 0,
      "min": 0
    },
    "bottomConfig": {
      "title": "下边距",
      "val": 0,
      "min": 0
    },
    "prConfig": {
      "title": "左右边距",
      "val": 10,
      "min": 0
    },
    "mbConfig": {
      "title": "页面上间距",
      "val": 0,
      "min": 0
    },
    "fillet": {
      "title": "背景圆角",
      "type": 0,
      "list": [
        {
          "val": "全部",
          "icon": "iconcaozuo-zhengti"
        },
        {
          "val": "单个",
          "icon": "iconcaozuo-bianjiao"
        }
      ],
      "valName": "圆角值",
      "val": 8,
      "min": 0,
      "valList": [
        {
          "val": 0
        },
        {
          "val": 0
        },
        {
          "val": 0
        },
        {
          "val": 0
        }
      ]
    }
  },
  "pointsMall": {
    "cname": "积分商城",
    "name": "pointsMall",
    "timestamp": 0,
    "isHide": false,
    "setUp": {
      "tabVal": 0
    },
    "titleLeft": "头部设置",
    "titleGoodsList": "商品列表",
    "titleGoods": "商品设置",
    "titleRight": "头部样式",
    "titleGoodsStyle": "商品样式",
    "titleCurrency": "通用样式",
    "styleConfig": {
      "title": "选择风格",
      "tabVal": 1,
      "tabList": [
        {
          "name": "背景色"
        },
        {
          "name": "背景图片"
        }
      ]
    },
    "titleConfig": {
      "title": "标题类型",
      "tabVal": 0,
      "tabList": [
        {
          "name": "图片"
        },
        {
          "name": "文字"
        }
      ]
    },
    "imgBgConfig": {
      "info": "建议：710px * 96px",
      "url": "/static/images/diy/pointsBg.png",
      "type": "code",
      "delType": 0,
      "name": "背景图片"
    },
    "imgConfig": {
      "info": "建议：154px * 32px",
      "url": "/static/images/diy/points01.png",
      "type": "code",
      "delType": 0,
      "name": "标题图片"
    },
    "imgConfig2": {
      "info": "建议：154px * 32px",
      "url": "/static/images/diy/points02.png",
      "type": "code",
      "delType": 0,
      "name": "标题图片"
    },
    "titleTxtConfig": {
      "title": "标题文字",
      "value": "积分兑好礼",
      "place": "请输入标题文字",
      "max": 10
    },
    "rightBntConfig": {
      "title": "右侧按钮",
      "value": "更多",
      "place": "请输入右侧按钮",
      "max": 6
    },
    "numberConfig": {
      "title": "商品数量",
      "val": 3,
      "min": 1
    },
    "goodStyleConfig": {
      "title": "选择风格",
      "tabVal": 0,
      "tabList": [
        {
          "name": "样式1"
        },
        {
          "name": "样式2"
        },
        {
          "name": "样式3"
        }
      ]
    },
    "headerBgColor": {
      "title": "背景颜色",
      "name": "headerBgColor",
      "default": [
        {
          "item": "#fff"
        },
        {
          "item": "#fff"
        }
      ],
      "color": [
        {
          "item": "#fff"
        },
        {
          "item": "#fff"
        }
      ]
    },
    "titleText": {
      "title": "标题文字",
      "tabVal": 0,
      "tabList": [
        {
          "name": "加粗",
          "style": "bold"
        },
        {
          "name": "正常",
          "style": "normal"
        },
        {
          "name": "倾斜",
          "style": "italic"
        }
      ]
    },
    "titleColor": {
      "title": "标题颜色",
      "name": "titleColor",
      "default": [
        {
          "item": "#333333"
        }
      ],
      "color": [
        {
          "item": "#333333"
        }
      ]
    },
    "titleNumber": {
      "title": "标题字号",
      "val": 16,
      "min": 0
    },
    "headerBntColor": {
      "title": "按钮颜色",
      "name": "headerBntColor",
      "default": [
        {
          "item": "#fff"
        }
      ],
      "color": [
        {
          "item": "#fff"
        }
      ]
    },
    "headerBntColor2": {
      "title": "按钮颜色",
      "name": "headerBntColor2",
      "default": [
        {
          "item": "#999"
        }
      ],
      "color": [
        {
          "item": "#999"
        }
      ]
    },
    "bntNumber": {
      "title": "按钮字号",
      "val": 12,
      "min": 0
    },
    "filletImg": {
      "title": "商品圆角",
      "type": 0,
      "list": [
        {
          "val": "全部",
          "icon": "iconcaozuo-zhengti"
        },
        {
          "val": "单个",
          "icon": "iconcaozuo-bianjiao"
        }
      ],
      "valName": "圆角值",
      "val": 5,
      "min": 0,
      "valList": [
        {
          "val": 0
        },
        {
          "val": 0
        },
        {
          "val": 0
        },
        {
          "val": 0
        }
      ]
    },
    "goodsNameColor": {
      "title": "商品名称",
      "name": "goodsNameColor",
      "default": [
        {
          "item": "#282828"
        }
      ],
      "color": [
        {
          "item": "#282828"
        }
      ]
    },
    "goodsNameColor2": {
      "title": "商品名称",
      "name": "goodsNameColor2",
      "default": [
        {
          "item": "#fff"
        }
      ],
      "color": [
        {
          "item": "#fff"
        }
      ]
    },
    "goodsUnitPriceColor2": {
      "title": "价格单位",
      "name": "goodsUnitPriceColor2",
      "default": [
        {
          "item": "#282828"
        }
      ],
      "color": [
        {
          "item": "#282828"
        }
      ]
    },
    "goodsUnitPriceColor": {
      "title": "价格单位",
      "name": "goodsUnitPriceColor",
      "default": [
        {
          "item": "#fff"
        }
      ],
      "color": [
        {
          "item": "#fff"
        }
      ]
    },
    "toneConfig": {
      "title": "色调",
      "tabVal": 0,
      "tabList": [
        {
          "name": "跟随主题风格"
        },
        {
          "name": "自定义"
        }
      ]
    },
    "goodsPriceColor": {
      "title": "商品价格",
      "name": "goodsPriceColor",
      "default": [
        {
          "item": "#fff"
        }
      ],
      "color": [
        {
          "item": "#fff"
        }
      ]
    },
    "goodsPriceColor2": {
      "title": "商品价格",
      "name": "goodsPriceColor2",
      "default": [
        {
          "item": "#E93323"
        }
      ],
      "color": [
        {
          "item": "#E93323"
        }
      ]
    },
    "priceBgColor": {
      "title": "价格背景",
      "name": "priceBgColor",
      "default": [
        {
          "item": "#FF7931"
        },
        {
          "item": "#E93323"
        }
      ],
      "color": [
        {
          "item": "#FF7931"
        },
        {
          "item": "#E93323"
        }
      ]
    },
    "moduleColor": {
      "title": "组件背景",
      "name": "moduleColor",
      "default": [
        {
          "item": "#FF7931"
        },
        {
          "item": "#E93323"
        }
      ],
      "color": [
        {
          "item": "#FF7931"
        },
        {
          "item": "#E93323"
        }
      ]
    },
    "moduleColor2": {
      "title": "组件背景",
      "name": "moduleColor",
      "default": [
        {
          "item": "#fff"
        },
        {
          "item": "#fff"
        }
      ],
      "color": [
        {
          "item": "#fff"
        },
        {
          "item": "#fff"
        }
      ]
    },
    "bottomBgColor": {
      "title": "底部背景",
      "name": "bgColor",
      "default": [
        {
          "item": "#f5f5f5"
        }
      ],
      "color": [
        {
          "item": "#f5f5f5"
        }
      ]
    },
    "topConfig": {
      "title": "上边距",
      "val": 0,
      "min": 0
    },
    "bottomConfig": {
      "title": "下边距",
      "val": 0,
      "min": 0
    },
    "prConfig": {
      "title": "左右边距",
      "val": 10,
      "min": 0
    },
    "mbConfig": {
      "title": "页面上间距",
      "val": 0,
      "min": 0
    },
    "fillet": {
      "title": "背景圆角",
      "type": 0,
      "list": [
        {
          "val": "全部",
          "icon": "iconcaozuo-zhengti"
        },
        {
          "val": "单个",
          "icon": "iconcaozuo-bianjiao"
        }
      ],
      "valName": "圆角值",
      "val": 8,
      "min": 0,
      "valList": [
        {
          "val": 0
        },
        {
          "val": 0
        },
        {
          "val": 0
        },
        {
          "val": 0
        }
      ]
    }
  },
  "promotionList": {
    "cname": "商品选项卡",
    "name": "promotionList",
    "timestamp": 0,
    "isHide": false,
    "setUp": {
      "tabVal": 0
    },
    "titleLeft": "展示设置",
    "titleTab": "选项卡设置",
    "titleRight": "选项卡样式",
    "titleCurrency": "通用样式",
    "titleCart": "购物车按钮",
    "styleConfig": {
      "title": "选择风格",
      "tabVal": 1,
      "tabList": [
        {
          "name": "样式一"
        },
        {
          "name": "样式二"
        },
        {
          "name": "样式三"
        },
        {
          "name": "样式四"
        },
        {
          "name": "样式五"
        }
      ]
    },
    "slideConfig": {
      "title": "滑动置顶",
      "tabVal": 1,
      "tabList": [
        {
          "name": "启用"
        },
        {
          "name": "不启用"
        }
      ]
    },
    "tabConfig": {
      "title": "点击下方选项卡可进行编辑；鼠标拖拽版块可调整顺序",
      "max": "",
      "tabCur": 0,
      "classList": [],
      "list": [
        {
          "chiild": [
            {
              "title": "标题",
              "val": "首发新品",
              "max": 4,
              "pla": "选填，不超过四个字"
            },
            {
              "title": "简介",
              "val": "最新出炉",
              "max": 4,
              "pla": "选填，不超过四个字"
            }
          ],
          "image": "",
          "tabVal": 1,
          "brandConfig": {
            "brandVal": []
          },
          "selectConfig": {
            "activeValue": []
          },
          "goodsLabel": {
            "activeValue": [],
            "list": []
          },
          "goodsSort": 0,
          "numConfig": {
            "val": 6
          },
          "goodsList": {
            "max": 20,
            "list": []
          },
          "productList": {
            "list": []
          }
        }
      ]
    },
    "cartConfig": {
      "title": "是否显示",
      "tabVal": 0,
      "tabList": [
        {
          "name": "显示"
        },
        {
          "name": "隐藏"
        }
      ]
    },
    "bntConfig": {
      "title": "按钮效果",
      "tabVal": 1,
      "tabList": [
        {
          "name": "进入商品详情页"
        },
        {
          "name": "商品加购"
        }
      ]
    },
    "bntStyleConfig": {
      "typeFrom": "bnt",
      "title": "按钮样式",
      "tabVal": 0
    },
    "toneConfig": {
      "title": "色调",
      "tabVal": 0,
      "tabList": [
        {
          "name": "跟随主题风格"
        },
        {
          "name": "自定义"
        }
      ]
    },
    "decorateColor": {
      "title": "装饰元素",
      "default": [
        {
          "item": "#E93323"
        },
        {
          "item": "#FF7931"
        }
      ],
      "color": [
        {
          "item": "#E93323"
        },
        {
          "item": "#FF7931"
        }
      ]
    },
    "decorateColor2": {
      "title": "装饰元素",
      "default": [
        {
          "item": "#E93323"
        }
      ],
      "color": [
        {
          "item": "#E93323"
        }
      ]
    },
    "textColor": {
      "title": "选中文字",
      "default": [
        {
          "item": "#333333"
        }
      ],
      "color": [
        {
          "item": "#333333"
        }
      ]
    },
    "textColor2": {
      "title": "选中文字",
      "default": [
        {
          "item": "#E93323"
        }
      ],
      "color": [
        {
          "item": "#E93323"
        }
      ]
    },
    "textColor3": {
      "title": "选中文字",
      "default": [
        {
          "item": "#FFFFFF"
        }
      ],
      "color": [
        {
          "item": "#FFFFFF"
        }
      ]
    },
    "toneCartConfig": {
      "title": "色调",
      "tabVal": 0,
      "tabList": [
        {
          "name": "跟随主题风格"
        },
        {
          "name": "自定义"
        }
      ]
    },
    "bntBgColor": {
      "title": "按钮颜色",
      "name": "bntBgColor",
      "default": [
        {
          "item": "#E93323"
        },
        {
          "item": "#FF7931"
        }
      ],
      "color": [
        {
          "item": "#E93323"
        },
        {
          "item": "#FF7931"
        }
      ]
    },
    "bottomBgColor": {
      "title": "底部背景",
      "default": [
        {
          "item": "#f5f5f5"
        }
      ],
      "color": [
        {
          "item": "#f5f5f5"
        }
      ]
    },
    "topConfig": {
      "title": "上边距",
      "val": 0,
      "min": 0
    },
    "bottomConfig": {
      "title": "下边距",
      "val": 0,
      "min": 0
    },
    "prConfig": {
      "title": "左右边距",
      "val": 10,
      "min": 0
    },
    "mbConfig": {
      "title": "页面间距",
      "val": 0,
      "min": 0
    },
    "fillet": {
      "title": "背景圆角",
      "type": 0,
      "list": [
        {
          "val": "全部",
          "icon": "iconcaozuo-zhengti"
        },
        {
          "val": "单个",
          "icon": "iconcaozuo-bianjiao"
        }
      ],
      "valName": "圆角值",
      "val": 0,
      "min": 0,
      "valList": [
        {
          "val": 0
        },
        {
          "val": 0
        },
        {
          "val": 0
        },
        {
          "val": 0
        }
      ]
    }
  },
  "liveBroadcast": {
    "cname": "小程序直播",
    "name": "liveBroadcast",
    "timestamp": 0,
    "isHide": false,
    "setUp": {
      "tabVal": 0
    },
    "titleLeft": "展示设置",
    "titleContent": "内容展示",
    "titleRight": "直播样式",
    "titleCurrency": "通用样式",
    "styleConfig": {
      "title": "选择风格",
      "tabVal": 0,
      "tabList": [
        {
          "name": "样式一"
        },
        {
          "name": "样式二"
        },
        {
          "name": "样式三"
        },
        {
          "name": "样式四"
        }
      ]
    },
    "numberConfig": {
      "title": "直播数量",
      "val": 3,
      "min": 1
    },
    "checkboxInfo": {
      "title": "展示信息",
      "name": "checkboxInfo",
      "type": [
        0,
        1
      ],
      "list": [
        {
          "id": 0,
          "name": "直播标题"
        },
        {
          "id": 1,
          "name": "用户名称"
        }
      ]
    },
    "liveConfig": {
      "title": "直播间距",
      "val": 10,
      "min": 0
    },
    "filletImg": {
      "title": "图片圆角",
      "type": 0,
      "list": [
        {
          "val": "全部",
          "icon": "iconcaozuo-zhengti"
        },
        {
          "val": "单个",
          "icon": "iconcaozuo-bianjiao"
        }
      ],
      "valName": "圆角值",
      "val": 8,
      "min": 0,
      "valList": [
        {
          "val": 0
        },
        {
          "val": 0
        },
        {
          "val": 0
        },
        {
          "val": 0
        }
      ]
    },
    "moduleColor": {
      "title": "组件背景",
      "default": [
        {
          "item": "#fff"
        },
        {
          "item": "#fff"
        }
      ],
      "color": [
        {
          "item": "#fff"
        },
        {
          "item": "#fff"
        }
      ]
    },
    "bottomBgColor": {
      "title": "底部背景",
      "default": [
        {
          "item": "#f5f5f5"
        }
      ],
      "color": [
        {
          "item": "#f5f5f5"
        }
      ]
    },
    "topConfig": {
      "title": "上边距",
      "val": 0,
      "min": 0
    },
    "bottomConfig": {
      "title": "下边距",
      "val": 0,
      "min": 0
    },
    "prConfig": {
      "title": "左右边距",
      "val": 10,
      "min": 0
    },
    "mbConfig": {
      "title": "页面上间距",
      "val": 0,
      "min": 0
    },
    "fillet": {
      "title": "背景圆角",
      "type": 0,
      "list": [
        {
          "val": "全部",
          "icon": "iconcaozuo-zhengti"
        },
        {
          "val": "单个",
          "icon": "iconcaozuo-bianjiao"
        }
      ],
      "valName": "圆角值",
      "val": 8,
      "min": 0,
      "valList": [
        {
          "val": 0
        },
        {
          "val": 0
        },
        {
          "val": 0
        },
        {
          "val": 0
        }
      ]
    }
  }
};
