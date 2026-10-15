// +----------------------------------------------------------------------
// | CRMEB [ CRMEB赋能开发者，助力企业发展 ]
// +----------------------------------------------------------------------
// | Copyright (c) 2016~2021 https://www.crmeb.com All rights reserved.
// +----------------------------------------------------------------------
// | Licensed CRMEB并不是自由软件，未经许可不能去掉CRMEB相关版权
// +----------------------------------------------------------------------
// | Author: CRMEB Team <admin@crmeb.com>
// +----------------------------------------------------------------------
import request from '@/plugins/request';
/**
 * 供应商-获取供应商列表
 */
export function supplierList(data) {
    return request({
        url: 'supplier/supplier',
        method: 'get',
        params: data
    });
}
/**
 *供应商-获取供应商信息
 */
export function getSupplier(id) {
    return request({
        url: `/supplier/supplier/${id}`,
        method: 'get'
    });
}
/**
 *供应商-添加供应商信息
 */
export function addSupplier(data) {
    return request({
        url: 'supplier/supplier',
        method: 'post',
        data
    });
}

/**
 *供应商-修改供应商信息
 */
export function putSupplier(id, data) {
    return request({
        url: `supplier/supplier/${id}`,
        method: 'put',
        data
    });
}

/**
 *供应商-修改供应商状态
 */
export function putSupplierStatus(id, status) {
    return request({
        url: `/supplier/supplier/set_status/${id}/${status}`,
        method: 'put',

    });
}

/**
 *供应商-下拉供应商
 */
export function getSupplierList(data) {
    return request({
        url: `/supplier/list`,
        method: 'get',
        params: data
    });
}


/**
 * 订单列表
 */
export function getList(data) {
    return request({
        url: `/supplier/order/list`,
        method: 'get',
        params: data
    })
};

/**
 * 提醒订单发货
 */
export function deliverRemind(data) {
    return request({
        url: `/supplier/order/deliver_remind/${data.supplier_id}/${data.id}`,
        method: 'put',
    })
};

/**
 * 订单详情
 */
export function orderInfo(id) {
    return request({
        url: `/supplier/order/info/${id}`,
        method: 'get',

    });
};

/**
 * 订单详情-打印
 */
export function distributionInfo(id) {
    return request({
        url: `/supplier/order/distribution_info`,
        method: 'get',
        params:{ids:id}
    });
};

/**
 * 售后列表
 */
export function refundList(data) {
    return request({
        url: `/supplier/refund/list`,
        method: 'get',
        data
    });
};

/**
 * @description 发货记录
 * @param {Object} param data {Object} 传值参数
 */
export function splitOrder(id, data) {
    return request({
        url: '/supplier/order/split_order/' + id,
        method: 'get',
        params: data
    })
};

/**
 * @description 订单记录
 * @param {Number} param data.id {Number} 订单id
 * @param {String} param data.datas {String} 分页参数
 */
export function getOrderRecord(data) {
    return request({
        url: `/supplier/order/status/${data.id}`,
        method: 'get',
        params: data.datas
    });
};
/**
 * @description 获取主动退款表单数据
 * @param {Number} param id {Number} 订单id
 */
export function getRefundFrom(id) {
    return request({
        url: `/supplier/order/refund/${id}`,
        method: 'get'
    });
};

/**
 * @description 售后订单
 * @param {Object} param data {Object} 传值参数
 */
export function orderRefundList(data) {
    return request({
        url: '/supplier/refund/list',
        method: 'get',
        params: data
    })
};
/**
 * @description 售后订单
 * @param {Object} param data {Object} 传值参数
 */
export function homeHeader(data) {
    return request({
        url: '/supplier/home/header',
        method: 'get',
        params: data
    })
};

/**
 * @description 订单统计趋势图
 * @param {Object} param data {Object} 传值参数
 */
export function homeOrder(data) {
    return request({
        url: '/supplier/home/order',
        method: 'get',
        params: data
    })
};

/**
 * @description 订单来源
 * @param {Object} param data {Object} 传值参数
 */
export function orderChannel(data) {
    return request({
        url: '/supplier/home/order_channel',

        method: 'get',
        params: data
    })
};

/**
 * @description 订单类型
 * @param {Object} param data {Object} 传值参数
 */
export function orderType(data) {
    return request({
        url: `/supplier/home/order_type`,

        method: 'get',
        params: data
    })
};

/**
 * @description 表格统计图
 * @param {Object} param data {Object} 传值参数
 */
export function homeStore(data) {
    return request({
        url: `/supplier/home/store`,
        method: 'get',
        params: data
    })
};

/**
 * @description 登录供应商
 * @param {Object} param data {Object} 传值参数
 */
export function supplierLogin(id) {
    return request({
        url: `/supplier/supplier/login/${id}`,
        method: 'get',

    })
};

export function homeSupplier(data) {
    return request({
        url:`/supplier/home/supplier`,
        method: 'get',
        params: data
    })
};
/**
 * @description 订单表单详情数据-退款详情
 * @param {Number} param id {Number} 订单id
 */
 export function getRefundDataInfo (id) {
    return request({
        url: `/supplier/refund/detail/${id}`,
        method: 'get'
    })
};

/**
 * @description 获取售后退款表单数据
 * @param {Number} param id {Number} 订单id
 */
 export function getRefundOrderFrom(id) {
    return request({
        url: `/supplier/refund/refund/${id}`,
        method: 'get'
    });
};

/**
 * @description 获取不退款表单数据
 * @param {Number} param id {Number} 订单id
 */
 export function getnoRefund(id) {
    return request({
        url: `/supplier/order/no_refund/${id}`,
        method: 'get'
    });
};

/**
 * @description 获取退积分表单
 * @param {Number} param id {Number} 订单id
 */
 export function refundIntegral(id) {
    return request({
        url: `/supplier/order/refund_integral/${id}`,
        method: 'get'
    });
};

/**
 * @description 配送信息表单
 * @param {Number} param id {Number}
 */
 export function getDistribution(id) {
    return request({
        url: `/supplier/order/distribution/${id}`,
        method: 'get'
    });
};

/**
 * @description 供应商申请列表
 * @param {Number} param id {Number}
 */
 export function getApplyList(data) {
    return request({
        url: `/supplier/apply/list`,
        method: 'get',
		params: data
    })
};

/**
 * @description 供应商审核表单
 * @param {Number} param id {Number}
 */
 export function getVerifyForm(id) {
    return request({
        url: `/supplier/apply/verify/form/${id}`,
        method: 'get'
    })
};

/**
 * @description 供应商备注表单
 * @param {Number} param id {Number}
 */
 export function getMarkForm(id) {
    return request({
        url: `/supplier/apply/mark/form/${id}`,
        method: 'get'
    })
};

/**
 * 供应商流水列表
 * @param {*} params
 * @returns
 */
export function supplierFinanceInfo(params) {
  return request({
      url: '/supplier/flowing_water/list',
      method: 'get',
      params
  });
}

/**
 * 供应商流水备注
 * @param {*} id
 * @param {*} params
 * @returns
 */
export function supplierFlowingWaterMark(id, params) {
  return request({
      url: `/supplier/flowing_water/mark/${id}`,
      method: 'put',
      params
  });
}

/**
 * 供应商流水导出
 * @param {*} params
 * @returns
 */
export function exportTableList(params) {
  return request({
      url: `/export/supplierWaterExport`,
      method: 'get',
      params
  });
}

/**
 * 供应商账单记录
 * @param {*} params
 * @returns
 */
export function supplierFlowingWaterFundRecord(params) {
  return request({
      url: '/supplier/flowing_water/fund_record',
      method: 'get',
      params
  });
}

/**
 * 导出门店账单记录
 * @param {*} params
 * @returns
 */
export function exportfundRecordApi(params) {
  return request({
      url: `/export/supplierWaterRecord`,
      method: 'get',
      params
  });
}

/**
 * 供应商转账列表
 * @param {*} params
 * @returns
 */
export function supplierExtractInfo(params) {
  return request({
      url: '/supplier/extract/list',
      method: 'get',
      params
  });
}

/**
 * 供应商转账记录备注
 * @param {*} id
 * @param {*} data
 * @returns
 */
export function supplierExtractMarkApi(id, data) {
  return request({
      url: `/supplier/extract/mark/${id}`,
      method: 'post',
      data
  });
}

/**
 * 提现审核
 * @param {*} id
 * @param {*} data
 * @returns
 */
export function supplierExtractVerifyApi(id, data) {
  return request({
      url: `/supplier/extract/verify/${id}`,
      method: 'post',
      data
  });
}

/**
 * 转账表单
 * @param {*} id
 * @returns
 */
export function supplierpaying(id) {
  return request({
      url: `/supplier/extract/transfer/${id}`,
      method: 'get'
  });
}

/**
 * 供应商账单详情
 * @param {*} params
 * @returns
 */
export function supplierFfundRecordInfoApi(params) {
    return request({
        url: `/supplier/flowing_water/fund_record_info`,
        method: 'get',
        params
    });
}
