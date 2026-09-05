import { describe, expect, it } from "vitest";
import { estimateWithdrawal, newWithdrawalKey, withdrawalStorageKey } from "../../view/uniapp-ts/src/utils/withdrawal";
import { withdrawalPolicy, withdrawalCents } from "@/services/user/UserWithdrawalService";

const configuration = (rate: string) => ({ commissionCount: "9999999999.99", minPrice: "0.01", maxPrice: "9999999999.99", withdraw_fee: rate, extractBank: [], extract_wechat_type: 0, user_extract_balance_status: 1 });
const input = (amount: string, method = "bank") => ({ extract_type: method, extract_price: amount, extract_number: "", real_name: "" });

describe("UniApp withdrawal preview uses the server's exact money rules", () => {
  it("matches PHP fee truncation at cent and maximum supported amount boundaries", () => {
    for (const amount of ["0.01", "1.01", "19.99", "100.01", "9999999999.99"]) {
      for (const rate of ["0", "2.5", "2.5599", "99.999999"]) {
        const server = withdrawalPolicy({ user_extract_min_price: "0.01", user_extract_max_price: "9999999999.99", withdraw_fee: rate }, withdrawalCents(amount), "bank");
        expect(estimateWithdrawal(input(amount), configuration(rate))).toMatchObject({ fee: (server.feeCents / 100).toFixed(2), net: (server.netCents / 100).toFixed(2) });
      }
    }
  });
  it("rejects non-decimal amounts and malformed fee configurations", () => {
    for (const amount of ["0", "-1", "1e2", "01", "1.001", "NaN", "10000000000"]) expect(estimateWithdrawal(input(amount), configuration("2.5"))).toBeNull();
    for (const rate of ["1e1", "-1", "100", "NaN", "", "2.1234567"]) expect(estimateWithdrawal(input("20"), configuration(rate))).toBeNull();
    expect(estimateWithdrawal(input("20"), null)).toBeNull();
  });
  it("charges no fee for balance and scopes persistent intent identity to the user", () => {
    expect(estimateWithdrawal(input("20", "balance"), configuration("2.5"))).toEqual({ gross: 20, fee: "0.00", net: "20.00" });
    expect(newWithdrawalKey()).toMatch(/^[A-Za-z0-9_-]{16,96}$/);
    expect(withdrawalStorageKey(7)).not.toBe(withdrawalStorageKey(8));
  });
});
