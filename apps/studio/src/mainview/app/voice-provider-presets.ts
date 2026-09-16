/**
 * 语音页（TTS 合成 / ASR 识别）的默认服务地址。
 *
 * 这里原来还有一套「内置服务商预设 + 按地址反查预设」表，配合页面手填 Base URL 用。
 * 改造后地址与密钥一律来自「设置 → 模型云服务」的厂商行，页面只选厂商与模型 ——
 * 那张预设表（以及它的匹配器）就再没有调用方了，已删除。
 */

/** 默认服务地址：线上 OmniLabs 多模态平台（TTS / ASR / LLM / OCR 统一接入）。 */
export const DEFAULT_VOICE_BASE_URL = "https://omnilabs.vibeadmin.cn/v1";
