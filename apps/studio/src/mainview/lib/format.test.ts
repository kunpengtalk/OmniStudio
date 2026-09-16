import { describe, expect, test } from "bun:test";
import { formatBytes, formatSize } from "./format";

// 口径统一后，各页原来"各写一份"的差异都收敛成参数；这里锁住默认值与各页覆盖值，
// 避免以后有人顺手改小数位把界面显示值给改了。
describe("formatBytes（十进制）", () => {
  test("默认：非正数给 —，GB 两位、MB 零位、KB 取整", () => {
    expect(formatBytes(0)).toBe("—");
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
    expect(formatBytes(500)).toBe("1 KB");
    expect(formatBytes(5_000_000)).toBe("5 MB");
    expect(formatBytes(1_500_000_000)).toBe("1.50 GB");
  });

  test("覆盖 zero / gbDecimals / mbDecimals（dashboard、download-view、skills 的旧口径）", () => {
    expect(formatBytes(0, { zero: "0 B" })).toBe("0 B");
    expect(formatBytes(1_500_000_000, { zero: "0 B", gbDecimals: 1 })).toBe("1.5 GB");
    expect(formatBytes(5_000_000, { mbDecimals: 1 })).toBe("5.0 MB");
    expect(formatBytes(0, { zero: "0 B", mbDecimals: 1 })).toBe("0 B");
  });

  test("与 IEC 的 formatSize 是两套口径，不混用", () => {
    // 同一数值：十进制 5.00 MB vs IEC 4.8 MB
    expect(formatBytes(5_000_000)).toBe("5 MB");
    expect(formatSize(5_000_000)).toBe("4.8 MB");
  });
});
