export const IMAGE_SERVER_PORT = 19782;

export function chatImageUrl(ref: string): string {
  return `http://localhost:${IMAGE_SERVER_PORT}/${ref}`;
}
