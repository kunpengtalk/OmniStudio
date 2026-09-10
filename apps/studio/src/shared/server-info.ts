export const IMAGE_SERVER_PORT = 19782;
/** 本地推理服务器（llama.cpp / vLLM / SGLang）的默认端口。 */
export const DEFAULT_INFERENCE_PORT = "18080";

export function chatImageUrl(ref: string): string {
  return `http://localhost:${IMAGE_SERVER_PORT}/${ref}`;
}
