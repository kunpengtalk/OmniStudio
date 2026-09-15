import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { db } from "./db";
import { settings as settingsTable } from "./db/schema";
import {
  ensureSettingsEncrypted,
  getAllSettings,
  getSetting,
  invalidateSettingsCache,
  updateSettings,
} from "./db/settings";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "./secrets";

// ---------------------------------------------------------------------------
// 密钥落盘加密（FUT-02）：模型云/网关的 Key 不再明文躺 SQLite。
//   1. 密文往返 + 旧明文透传（老库兼容）；
//   2. settings 透明层：落盘密文、读取明文，消费方零改动；
//   3. EMPTY 哨兵 / 空值不制造密文；
//   4. 历史明文一次性迁移（幂等）。
// ---------------------------------------------------------------------------
const KEYS = ["VLLM_API_KEY", "GATEWAY_API_KEY"] as const;
const original = Object.fromEntries(KEYS.map((k) => [k, getSetting(k)]));

/** 直接读库里的原始值（绕过 settings 的透明解密），用于断言"盘上到底是明文还是密文"。 */
function rawValue(key: string): string | undefined {
  return db.select().from(settingsTable).where(eq(settingsTable.key, key)).get()?.value;
}

/** 写一份「历史明文」进库，模拟升级前的老数据。 */
function seedPlaintext(key: string, value: string): void {
  db.insert(settingsTable)
    .values({ key, value })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value } })
    .run();
}

afterAll(() => {
  updateSettings({ ...original });
});

test("密文往返：v1: 前缀、可解回；旧明文透传；空串不加密", () => {
  const ct = encryptSecret("sk-abc-123");
  expect(ct.startsWith("v1:")).toBe(true);
  expect(isEncryptedSecret(ct)).toBe(true);
  expect(decryptSecret(ct)).toBe("sk-abc-123");
  // 老库里的明文没有 v1: 前缀 —— 读取侧必须原样透传，否则升级即坏。
  expect(isEncryptedSecret("legacy-plain")).toBe(false);
  expect(decryptSecret("legacy-plain")).toBe("legacy-plain");
  expect(encryptSecret("")).toBe("");
});

test("settings 透明加密：落盘是密文，读取是明文", () => {
  for (const key of KEYS) {
    updateSettings({ [key]: "sk-secret-value" });
    invalidateSettingsCache();
    const stored = rawValue(key);
    expect(isEncryptedSecret(stored!)).toBe(true);
    expect(stored).not.toContain("sk-secret-value");
    expect(getSetting(key)).toBe("sk-secret-value");
    expect(getAllSettings()[key]).toBe("sk-secret-value");
  }
});

test("EMPTY 哨兵与空值不制造密文", () => {
  updateSettings({ VLLM_API_KEY: "EMPTY", GATEWAY_API_KEY: "" });
  invalidateSettingsCache();
  expect(rawValue("VLLM_API_KEY")).toBe("EMPTY");
  expect(getSetting("VLLM_API_KEY")).toBe("EMPTY");
  expect(rawValue("GATEWAY_API_KEY")).toBe("");
  expect(getSetting("GATEWAY_API_KEY")).toBe("");
});

test("历史明文迁移：ensureSettingsEncrypted 翻成密文且仍可读（幂等）", () => {
  for (const key of KEYS) seedPlaintext(key, "plain-legacy-key");
  invalidateSettingsCache();
  expect(isEncryptedSecret(rawValue("VLLM_API_KEY")!)).toBe(false);

  ensureSettingsEncrypted();

  for (const key of KEYS) expect(isEncryptedSecret(rawValue(key)!)).toBe(true);
  invalidateSettingsCache();
  expect(getSetting("VLLM_API_KEY")).toBe("plain-legacy-key");
  expect(getSetting("GATEWAY_API_KEY")).toBe("plain-legacy-key");

  // 再跑一次不得重复加密（密文再加密会解不出原文）。
  const once = rawValue("VLLM_API_KEY");
  ensureSettingsEncrypted();
  expect(rawValue("VLLM_API_KEY")).toBe(once!);
  invalidateSettingsCache();
  expect(getSetting("VLLM_API_KEY")).toBe("plain-legacy-key");
});
