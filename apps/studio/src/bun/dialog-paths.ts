/**
 * 「用户亲手在系统文件对话框里选过」的路径白名单。
 *
 * 为什么需要：OCR 暂存、文档导入、修图参考图这些接口收的是**绝对路径**，而
 * `stageOcrImage` / `addDocument` 之前只检查 `existsSync` + 扩展名。路径来自 webview，
 * 按 AGENTS.md 的口径（"anything that resolves a user-supplied path must validate it"）
 * 不能直接信 —— 一个被注入的 webview 就能把 `~/.ssh/id_rsa` 丢进 OCR 管线，
 * 而应用自己的凭据黑名单（`agent-sandbox.ts`）明确把这些路径视为不可读。
 *
 * 为什么不用"限制在数据目录内"那一套：这些功能的输入**本来就该是任意路径**
 * （用户要 OCR 桌面上的合同、要导入 ~/Documents 里的 PDF），限位会把功能改坏。
 * 真正的约束不是"在哪"，而是"谁给的"：只有用户在原生对话框里亲手选出来的路径才算数，
 * 对话框是主进程自己弹的，用户看得见自己选了什么。
 *
 * 记录有 TTL 与条数上限：这是一份"最近选过什么"的短期凭据，不是长期授权表。
 */

const TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 500;

const picked = new Map<string, number>();

/** 路径按字面比较：对话框返回什么就记什么，调用方原样传回来。 */
function normalize(p: string): string {
  return p.trim();
}

/** 记下用户刚选过的路径（由 `openFileDialog` 的 RPC 处理器调用）。 */
export function rememberDialogPickedPaths(paths: readonly string[]): void {
  const now = Date.now();
  for (const p of paths) {
    const key = normalize(p);
    if (key) picked.set(key, now);
  }
  purgeExpired(now);
  // 超上限时按插入顺序丢最早的（Map 保持插入顺序）。
  while (picked.size > MAX_ENTRIES) {
    const oldest = picked.keys().next().value;
    if (oldest === undefined) break;
    picked.delete(oldest);
  }
}

/** 这个路径是不是用户最近在对话框里选过的。 */
export function isDialogPickedPath(path: string): boolean {
  const key = normalize(path);
  if (!key) return false;
  const at = picked.get(key);
  if (at === undefined) return false;
  if (Date.now() - at > TTL_MS) {
    picked.delete(key);
    return false;
  }
  return true;
}

/** 测试用：清空白名单。 */
export function resetDialogPickedPaths(): void {
  picked.clear();
}

function purgeExpired(now: number): void {
  for (const [key, at] of picked) {
    if (now - at > TTL_MS) picked.delete(key);
  }
}
