export const IMAGE_SERVER_PORT = 19782;
/** 本地推理服务器（llama.cpp / vLLM / SGLang）的默认端口。 */
export const DEFAULT_INFERENCE_PORT = "18080";
/**
 * 提示词库封面/视频的远程源。部署时把 vibedesign 的
 * `frontend/public/prompt-library` 内容放到该域根路径下即可。
 */
export const PROMPT_LIBRARY_MEDIA_ORIGIN = "https://kunpengtalk.com";

export function chatImageUrl(ref: string): string {
  return `http://localhost:${IMAGE_SERVER_PORT}/${ref}`;
}
