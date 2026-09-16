/**
 * 拖拽上传的文档体积上限。
 *
 * 拖进来的是一个 `File`，webview 里拿不到它的磁盘路径，只能把字节编码成 base64 走 RPC
 * 传给主进程 —— 而 RPC 消息是**整条**在内存里编解码的：一个 500MB 的 PDF 会先变成
 * 约 670MB 的字符串，主进程再解回 500MB Buffer，两端各留一份峰值。
 *
 * 超限要在**读文件之前**就拒绝（见 `main-layout/drop-zone.tsx` 与 RPC `addDocumentByUpload`），
 * 否则光是编码这一步就能把界面卡死几十秒。
 */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** 给用户看的体积上限文案（如 `100 MB`）。 */
export function formatUploadLimit(): string {
  return `${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB`;
}
