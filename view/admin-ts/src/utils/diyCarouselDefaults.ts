// Complete literal defaults from immutable PHP author registrations.
// banner.vue:157–355; home_comb.vue:137–473 @8ed2a5b139f9170dd11b0dff91803f2fd59e40a5.
// Imports are never merged with these ordinary-new defaults. No legacy swipers default is asserted.
export const DIY_CAROUSEL_DEFAULTS: Record<string, Record<string, unknown>> = {
  "swiperBg": {
    "cname": "轮播图",
    "name": "swiperBg",
    "timestamp": 0,
    "isHide": false,
    "setUp": {
      "tabVal": 0
    },
    "titleLeft": "展示设置",
    "titleContent": "内容设置",
    "titleRight": "指示器设置",
    "titleImg": "图片设置",
    "titleCurrency": "通用样式",
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
        }
      ]
    },
    "swiperConfig": {
      "maxList": 10,
      "list": [
        {
          "img": "",
          "imgTitle": "图一",
          "info": [
            {
              "title": "链接",
              "value": "",
              "tips": "请输入链接",
              "max": 100
            }
          ]
        }
      ]
    },
    "docConfig": {
      "title": "指示器样式",
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
    "docPosition": {
      "title": "指示器位置",
      "tabVal": 1,
      "tabList": [
        {
          "name": "左对齐"
        },
        {
          "name": "居中对齐"
        },
        {
          "name": "右对齐"
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
    "dotColor": {
      "title": "选中样式",
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
    "dotBgColor": {
      "title": "常规样式",
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
      "val": 10,
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
    "imgConfig": {
      "title": "图片间距",
      "val": 10,
      "min": 0
    },
    "bgColor": {
      "title": "底部背景",
      "default": [
        {
          "item": "#F62C2C"
        }
      ],
      "color": [
        {
          "item": "#F62C2C"
        }
      ]
    },
    "topConfig": {
      "title": "上边距",
      "val": 10,
      "min": 0
    },
    "bottomConfig": {
      "title": "下边距",
      "val": 10,
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
    "txtStyle": {
      "title": "指示器位置",
      "type": 0,
      "list": [
        {
          "val": "居左",
          "icon": "icondoc_left"
        },
        {
          "val": "居中",
          "icon": "icondoc_center"
        },
        {
          "val": "居右",
          "icon": "icondoc_right"
        }
      ]
    }
  },
  "homeComb": {
    "cname": "轮播搜索",
    "name": "homeComb",
    "timestamp": 0,
    "isHide": false,
    "setUp": {
      "tabVal": 0
    },
    "titleLeft": "展示设置",
    "titleSearch": "搜索设置",
    "titleHotWords": "搜索热词",
    "titleTab": "选项卡设置",
    "titleImg": "图片设置",
    "titleRight": "标签设置",
    "titlePointer": "指示器设置",
    "styleConfig": {
      "title": "选择风格",
      "tabVal": 0,
      "tabList": [
        {
          "name": "样式一"
        },
        {
          "name": "样式二"
        }
      ]
    },
    "classConfig": {
      "title": "分类设置",
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
    "searchConfig": {
      "title": "搜索设置",
      "tabVal": 0,
      "tabList": [
        {
          "name": "正常显示"
        },
        {
          "name": "滚动至顶部固定"
        }
      ]
    },
    "logoConfig": {
      "info": "建议：138px * 48px",
      "url": "",
      "type": "code",
      "name": "logo图"
    },
    "inputConfig": {
      "title": "提示文字",
      "value": "请输入搜索词",
      "place": "填写内容",
      "max": 10
    },
    "hotWords": {
      "list": [
        {
          "val": ""
        }
      ]
    },
    "numConfig": {
      "placeholder": "设置搜索热词显示时间",
      "title": "滚动时间",
      "val": 3,
      "type": "words"
    },
    "tabListConfig": {
      "title": "鼠标拖拽版块可调整选项卡顺序",
      "max": 100,
      "list": [
        {
          "text": {
            "title": "显示文字",
            "val": "标题标题",
            "max": 4,
            "pla": "请输入分类名称"
          },
          "dataType": {
            "title": "数据类型",
            "tabVal": 0,
            "tabList": [
              {
                "name": "微页面"
              },
              {
                "name": "商品分类"
              }
            ]
          },
          "microPage": {
            "name": "",
            "id": 0
          },
          "classPage": {
            "name": "",
            "id": 0
          }
        },
        {
          "text": {
            "title": "显示文字",
            "val": "标题标题",
            "max": 4,
            "pla": "请输入分类名称"
          },
          "dataType": {
            "title": "数据类型",
            "tabVal": 0,
            "tabList": [
              {
                "name": "微页面"
              },
              {
                "name": "商品分类"
              }
            ]
          },
          "microPage": {
            "name": "",
            "id": 0
          },
          "classPage": {
            "name": "",
            "id": 0
          }
        },
        {
          "text": {
            "title": "显示文字",
            "val": "标题标题",
            "max": 4,
            "pla": "请输入分类名称"
          },
          "dataType": {
            "title": "数据类型",
            "tabVal": 0,
            "tabList": [
              {
                "name": "微页面"
              },
              {
                "name": "商品分类"
              }
            ]
          },
          "microPage": {
            "name": "",
            "id": 0
          },
          "classPage": {
            "name": "",
            "id": 0
          }
        },
        {
          "text": {
            "title": "显示文字",
            "val": "标题标题",
            "max": 4,
            "pla": "请输入分类名称"
          },
          "dataType": {
            "title": "数据类型",
            "tabVal": 0,
            "tabList": [
              {
                "name": "微页面"
              },
              {
                "name": "商品分类"
              }
            ]
          },
          "microPage": {
            "name": "",
            "id": 0
          },
          "classPage": {
            "name": "",
            "id": 0
          }
        }
      ]
    },
    "contentConfig": {
      "title": "内容间距",
      "val": 20,
      "min": 0
    },
    "classColor": {
      "title": "下拉分类",
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
    "docConfig": {
      "title": "指示器样式",
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
    "docPosition": {
      "title": "指示器位置",
      "tabVal": 1,
      "tabList": [
        {
          "name": "左对齐"
        },
        {
          "name": "居中对齐"
        },
        {
          "name": "右对齐"
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
    "dotColor": {
      "title": "选中样式",
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
    "dotBgColor": {
      "title": "常规样式",
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
      "val": 10,
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
    "swiperConfig": {
      "title": "建议：图片尺寸702*320px；鼠标拖拽版块可调整图片顺序",
      "bnt": "添加",
      "maxList": 10,
      "list": [
        {
          "img": "",
          "info": [
            {
              "title": "标题",
              "value": "标题",
              "tips": "选填，不超过4个字",
              "max": 4
            },
            {
              "title": "链接",
              "value": "",
              "tips": "请输入链接",
              "max": 100
            }
          ]
        }
      ]
    }
  }
};
