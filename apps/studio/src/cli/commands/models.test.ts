import { describe, expect, test } from "bun:test";

import { cloudModelRefsFromProviders } from "./models";

/**
 * 控制通道 `cloudProviders` （或离线读表的等价结果）→ 扁平模型清单。
 *
 * 这份清单是 `omi models` 与 `omi launch --model <云 id>` 的共同口径，而 GUI 的模型
 * 选择器按「全部已启用厂商」聚合 —— 以前 CLI 只看激活厂商的 `CLOUD_MODELS` 槽位，
 * 于是"应用里能用的云模型，命令行说找不到"。
 */
describe("云厂商模型清单（omi models / omi launch 共用）", () => {
  test("带出厂商名、启用状态、是否默认厂商、有没有配 Key", () => {
    const refs = cloudModelRefsFromProviders({
      activeId: "omnilabs",
      providers: [
        {
          id: "omnilabs",
          name: "OmniLabs",
          enabled: true,
          apiKey: "sk-xxx",
          models: [{ id: "deepseek-v4-flash" }],
        },
        {
          id: "custom-1",
          name: "Omin",
          enabled: true,
          apiKey: "",
          models: [{ id: "deepseek-v4.1" }],
        },
      ],
    });

    expect(refs).toEqual([
      {
        id: "deepseek-v4-flash",
        providerId: "omnilabs",
        providerName: "OmniLabs",
        enabled: true,
        active: true,
        hasKey: true,
      },
      {
        id: "deepseek-v4.1",
        providerId: "custom-1",
        providerName: "Omin",
        enabled: true,
        active: false,
        hasKey: false,
      },
    ]);
  });

  test("同名模型出现在两家时各留一条，靠 active 区分优先", () => {
    const refs = cloudModelRefsFromProviders({
      activeId: "b",
      providers: [
        { id: "a", name: "A", enabled: true, models: [{ id: "gpt-5" }] },
        { id: "b", name: "B", enabled: false, models: [{ id: "gpt-5" }] },
      ],
    });
    expect(refs.map((m) => [m.id, m.providerId, m.active])).toEqual([
      ["gpt-5", "a", false],
      ["gpt-5", "b", true],
    ]);
  });

  test("厂商没名字时回落到 id，脏数据（空 id / 非数组 models）跳过而不是炸掉", () => {
    const refs = cloudModelRefsFromProviders({
      activeId: null,
      providers: [
        { id: "no-name", enabled: true, models: [{ id: "m1" }, { id: "" }, { name: "无 id" }, null] },
        { id: "", name: "空 id", enabled: true, models: [{ id: "m2" }] },
        { id: "bad-models", name: "坏清单", enabled: true, models: "oops" },
        null,
      ],
    });
    expect(refs).toEqual([
      {
        id: "m1",
        providerId: "no-name",
        providerName: "no-name",
        enabled: true,
        active: false,
        hasKey: false,
      },
    ]);
  });

  test("控制通道给了不认识的结构（旧版实例 / 报错体）时返回空表", () => {
    expect(cloudModelRefsFromProviders(undefined)).toEqual([]);
    expect(cloudModelRefsFromProviders({ error: "未知命令" })).toEqual([]);
    expect(cloudModelRefsFromProviders({ providers: [] })).toEqual([]);
  });
});
