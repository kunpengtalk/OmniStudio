import { expect, test } from "bun:test";

import { mockModulePartial } from "./test-mocks";

// ---------------------------------------------------------------------------
// helper 自身的契约：铺开真实导出、只覆盖点名的那几个。
//
// 这个契约一旦被"简化"成 `mock.module(spec, () => overrides)`，整套测试又会回到
// 「被 mock 的模块新增一个导出 → 别的文件 import 阶段就报 Export named not found」
// 的老路上，而症状离原因很远。这里直接钉住行为，不靠读代码去发现。
// ---------------------------------------------------------------------------

test("铺开真实导出：覆盖一个函数后，其余导出仍是真实实现", async () => {
  const real = await mockModulePartial<typeof import("./path-safety")>("./path-safety", {
    isInsideDir: () => true,
  });

  const patched = await import("./path-safety");
  // 覆盖生效
  expect(patched.isInsideDir("/anywhere", "/anywhere-else")).toBe(true);
  // 导出面与真实模块一致（含真实实现，不是 undefined）
  expect(Object.keys(patched).sort()).toEqual(Object.keys(real).sort());
  // 没点名的导出连引用都没换（不是"重新包一层等价实现"）
  expect(patched.safeJoin).toBe(real.safeJoin);
  expect(patched.safeJoin("/base", "a/b")).toBe("/base/a/b");
});
