// Complete ordinary defaults from fixed PHP 8ed2a5b139f9170dd11b0dff91803f2fd59e40a5.
// Only the instance timestamp is bound by the author; imported records are never merged with these defaults.
export const DIY_LIST_DEFAULTS = {
  "goodList": {
    "cname": "商品列表",
    "name": "goodList",
    "timestamp": 0,
    "isHide": false,
    "setUp": {
      "tabVal": 0
    },
    "titleLeft": "列表设置",
    "titleGoods": "商品设置",
    "titleContents": "显示内容",
    "titleCart": "购物车按钮",
    "titleRight": "商品样式",
    "titleCurrency": "通用样式",
    "styleConfig": {
      "title": "选择风格",
      "tabVal": 1,
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
          "name": "两列展示(横向)"
        },
        {
          "name": "大图展示"
        },
        {
          "name": "左右滑动展示"
        }
      ]
    },
    "typeConfig": {
      "title": "选择方式",
      "activeValue": 1,
      "list": [
        {
          "activeValue": 1,
          "title": "指定商品"
        },
        {
          "activeValue": 2,
          "title": "指定品牌"
        },
        {
          "activeValue": 3,
          "title": "指定分类"
        },
        {
          "activeValue": 4,
          "title": "商品标签"
        }
      ]
    },
    "goodsList": {
      "max": 20,
      "list": []
    },
    "goodsSort": {
      "title": "商品排序",
      "tabVal": 1,
      "tabList": [
        {
          "name": "综合"
        },
        {
          "name": "销量"
        },
        {
          "name": "价格"
        }
      ]
    },
    "numberConfig": {
      "title": "商品数量",
      "val": 3,
      "min": 1
    },
    "brandList": {
      "title": "品牌名称",
      "brandVal": []
    },
    "classList": {
      "title": "商品名称",
      "classVal": []
    },
    "checkboxInfo": {
      "title": "展示信息",
      "name": "checkboxInfo",
      "type": [
        0,
        1,
        2,
        3,
        4,
        5
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
          "name": "商品销量"
        },
        {
          "id": 4,
          "name": "商品评分"
        },
        {
          "id": 5,
          "name": "会员价格"
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
      "title": "按钮样式",
      "tabVal": 0
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
      "title": "商品价格",
      "name": "goodsPriceColor",
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
    "soldNumColor": {
      "title": "已售数量",
      "name": "soldNumColor",
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
    "scoreColor": {
      "title": "评分颜色",
      "name": "scoreColor",
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
    },
    "goodsLabel": {
      "title": "商品标签",
      "activeValue": [],
      "list": []
    },
    "productList": {
      "title": "商品列表",
      "list": []
    }
  },
  "articleList": {
    "cname": "文章列表",
    "name": "articleList",
    "timestamp": 0,
    "isHide": false,
    "setUp": {
      "tabVal": 0
    },
    "titleLeft": "展示设置",
    "titleRight": "列表样式",
    "titleArticle": "文章设置",
    "titleList": "列表设置",
    "titleCurrency": "通用样式",
    "styleConfig": {
      "title": "选择风格",
      "tabVal": 1,
      "tabList": [
        {
          "name": "大图展示"
        },
        {
          "name": "两列展示(纵向)"
        },
        {
          "name": "两列展示(横向)"
        }
      ]
    },
    "numConfig": {
      "val": 3,
      "title": "文章数量"
    },
    "selectConfig": {
      "title": "文章分类",
      "activeValue": "",
      "list": [
        {
          "activeValue": "",
          "title": ""
        },
        {
          "activeValue": "",
          "title": ""
        }
      ]
    },
    "goodsList": {
      "max": 20,
      "list": []
    },
    "selectList": {
      "title": "文章列表",
      "list": []
    },
    "checkboxList": {
      "title": "是否显示",
      "type": [
        0,
        1,
        2
      ],
      "list": [
        {
          "id": 0,
          "name": "时间日期"
        },
        {
          "id": 1,
          "name": "浏览量"
        },
        {
          "id": 2,
          "name": "点赞"
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
    "nameConfig": {
      "title": "商品名称",
      "tabVal": 1,
      "tabList": [
        {
          "name": "加粗"
        },
        {
          "name": "常规"
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
    "likeSuccessColor": {
      "title": "点赞成功",
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
    "nameColor": {
      "title": "商品名称",
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
    "timeColor": {
      "title": "时间日期",
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
    "browseColor": {
      "title": "浏览元素",
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
    "likeColor": {
      "title": "点赞元素",
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
    "statisticColor": {
      "title": "数字统计",
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
    "bgColor": {
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
          "item": "#F5F5F5"
        }
      ],
      "color": [
        {
          "item": "#F5F5F5"
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
      "val": 6,
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
} as const;
