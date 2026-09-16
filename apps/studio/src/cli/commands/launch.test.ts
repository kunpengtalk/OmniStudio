import { describe, expect, test } from "bun:test";

import { pickCloudModelFor } from "./launch";
import type { CloudModelRef } from "./models";

const ref = (
  id: string,
  providerId: string,
  opts: Partial<CloudModelRef> = {},
): CloudModelRef => ({
  id,
  providerId,
  providerName: opts.providerName ?? providerId,
  enabled: opts.enabled ?? true,
  active: opts.active ?? false,
  hasKey: opts.hasKey ?? true,
});

/**
 * `omi launch <工具> --model <云模型 id>` 挑厂商的决策表。
 *
 * 真实现场：`deepseek-v4.1` 属于已启用的「Omin」，但默认厂商是「OmniLabs」——
 * 旧实现只比对默认厂商的模型槽位（`CLOUD_MODELS`），直接报「未找到模型」，
 * 而 GUI 的模型选择器里这个模型明明列着、选一下就能用。
 */
describe("--model 指定云模型时挑哪一家", () => {
  test("模型属于默认厂商：直接命中，不用切", () => {
    const refs = [ref("deepseek-v4-flash", "omnilabs", { active: true }), ref("deepseek-v4.1", "omin")];
    expect(pickCloudModelFor(refs, "deepseek-v4.1")).toEqual({
      hit: ref("deepseek-v4.1", "omin"),
      disabled: undefined,
    });
  });

  test("模型属于已启用但不是默认的厂商：命中（调用方据此把默认厂商切过去）", () => {
    const refs = [ref("deepseek-v4-flash", "omnilabs", { active: true }), ref("deepseek-v4.1", "omin")];
    expect(pickCloudModelFor(refs, "deepseek-v4-flash").hit?.providerId).toBe("omnilabs");
    expect(pickCloudModelFor(refs, "deepseek-v4.1").hit?.active).toBe(false);
  });

  test("同名模型在多家：默认厂商优先", () => {
    const refs = [
      ref("gpt-5", "a", { active: true }),
      ref("gpt-5", "b"),
    ];
    expect(pickCloudModelFor(refs, "gpt-5").hit?.providerId).toBe("a");
  });

  test("默认厂商没有、已启用厂商有：选已启用的那家", () => {
    const refs = [
      ref("gpt-5", "disabled-one", { enabled: false }),
      ref("gpt-5", "enabled-one", { active: false }),
    ];
    expect(pickCloudModelFor(refs, "gpt-5").hit?.providerId).toBe("enabled-one");
  });

  test("厂商已停用：不命中，但把厂商带出来 —— 报错要说清「模型在，只是该厂商没启用」", () => {
    const refs = [ref("deepseek-v4.1", "omin", { enabled: false, providerName: "Omin" })];
    const picked = pickCloudModelFor(refs, "deepseek-v4.1");
    expect(picked.hit).toBeUndefined();
    expect(picked.disabled?.providerName).toBe("Omin");
  });

  test("完全没有这个模型：既没命中也没有停用线索（走「未找到」分支）", () => {
    const refs = [ref("deepseek-v4-flash", "omnilabs", { active: true })];
    expect(pickCloudModelFor(refs, "no-such-model")).toEqual({ hit: undefined, disabled: undefined });
    expect(pickCloudModelFor([], "deepseek-v4.1")).toEqual({ hit: undefined, disabled: undefined });
  });
});
