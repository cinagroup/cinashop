import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { PaidMembershipService } from "@/services/user/PaidMembershipService";
import { NotFoundException, ValidateException } from "@/utils/errors";
import { jsonFail, jsonOk } from "@/utils/json";
import { clientIp } from "@/controllers/api/v1/UserBehaviorController";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

function service(c: C): PaidMembershipService {
  return new PaidMembershipService(c.get("container"), c.env);
}

export async function index(c: C) {
  return jsonOk(c, await service(c).index(c.get("uid")));
}

export async function draw(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as {
    member_card_code?: unknown;
    member_card_pwd?: unknown;
    from?: unknown;
  };
  try {
    const result = await service(c).redeem(c.get("uid"), {
      cardCode: body.member_card_code,
      cardPassword: body.member_card_pwd,
      from: body.from,
    });
    return jsonOk(c, result, "激活成功");
  } catch (error) {
    if (error instanceof ValidateException || error instanceof NotFoundException) {
      return jsonFail(c, error.message);
    }
    throw error;
  }
}

export async function memberCouponList(c: C) {
  return jsonOk(
    c,
    await service(c).memberCoupons(c.get("uid"), c.req.query("page"), c.req.query("limit")),
  );
}

export async function createOrder(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as {
    member_type?: unknown;
    from?: unknown;
  };
  try {
    const result = await service(c).createOrder(c.get("uid"), {
      memberType: body.member_type,
      from: body.from,
    });
    return jsonOk(c, result, result.paid ? "免费会员领取成功" : "订单创建成功");
  } catch (error) {
    if (error instanceof ValidateException || error instanceof NotFoundException) {
      return jsonFail(c, error.message);
    }
    throw error;
  }
}

export async function payOrder(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as {
    uni?: unknown;
    paytype?: unknown;
    from?: unknown;
  };
  try {
    const result = await service(c).payOrder(c.get("uid"), {
      orderId: body.uni,
      payType: body.paytype,
      from: body.from,
      payerClientIp: clientIp(c),
    });
    return jsonOk(c, result, result.paid === true ? "支付成功" : "支付下单成功");
  } catch (error) {
    if (error instanceof ValidateException || error instanceof NotFoundException) {
      return jsonFail(c, error.message);
    }
    throw error;
  }
}

export async function overdueTime(c: C) {
  try {
    return jsonOk(
      c,
      await service(c).projectedExpiry(c.get("uid"), c.req.query("member_type")),
    );
  } catch (error) {
    if (error instanceof ValidateException || error instanceof NotFoundException) {
      return jsonFail(c, error.message);
    }
    throw error;
  }
}
