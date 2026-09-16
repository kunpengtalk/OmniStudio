/**
 * 小应用页面 → 字符串。
 *
 * 小应用是**手写的自包含 HTML**（`src/mainview/miniapps/<id>.html`，内联样式与脚本），
 * 用 `?raw` 取原文后塞进 sandbox iframe 的 `srcdoc`：
 *   - 不参与主前端构建：加一个小应用 = 加一个 HTML + shared/miniapps.ts 里一条登记，
 *     既不用改 vite 入口，也不会因为一个新页面把主包的体积顶大；
 *   - 沙箱隔离（无 allow-same-origin）：小应用碰不到宿主的 DOM / store / localStorage，
 *     它能做的事情只有宿主在 `lib/miniapp-bridge.ts` 里放行的那几个动作；
 *   - 显式 import（而不是 import.meta.glob）：漏文件是构建错误，不是运行时空卡片。
 */
import bgRemoveHtml from "../../miniapps/bg-remove.html?raw";
import idPhotoHtml from "../../miniapps/id-photo.html?raw";
import mosaicHtml from "../../miniapps/mosaic.html?raw";
import portraitHtml from "../../miniapps/portrait.html?raw";
import meetingNotesHtml from "../../miniapps/meeting-notes.html?raw";
import copywriterHtml from "../../miniapps/copywriter.html?raw";
import notesHtml from "../../miniapps/notes.html?raw";

export const MINIAPP_HTML: Record<string, string> = {
  "bg-remove": bgRemoveHtml,
  "id-photo": idPhotoHtml,
  mosaic: mosaicHtml,
  portrait: portraitHtml,
  "meeting-notes": meetingNotesHtml,
  copywriter: copywriterHtml,
  notes: notesHtml,
};
