/**
 * 网关 API Key 的展示规则（主进程与界面共用）。
 *
 * Key 是"能调用本机模型、读共享记忆"的凭据，默认一律掩码展示：界面上不出现明文，
 * 只有用户主动点"显示"（或复制）时才把值交给界面。掩码长度固定，顺带不泄漏真实
 * 长度；前缀 `osk-` 是恒定标识，留着不影响保密，还便于一眼认出这是本网关的 Key。
 */

/** 本地网关生成的 Key 前缀（手输的旧 Key 可能不带）。 */
export const GATEWAY_KEY_PREFIX = "osk-";

/** 掩码位数：固定值，不随真实长度变化。 */
const MASK = "*".repeat(12);

export function maskGatewayKey(key: string): string {
  const value = (key ?? "").trim();
  if (!value) return "";
  return value.startsWith(GATEWAY_KEY_PREFIX) ? `${GATEWAY_KEY_PREFIX}${MASK}` : MASK;
}
