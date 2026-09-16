/**
 * 小应用的运行时与宿主桥。
 *
 * 两半：
 *   - `MINIAPP_RUNTIME_SCRIPT`：注入到每个小应用页面里的那段 JS，负责把小应用里的
 *     `omni.image.generate(...)` 变成一条 postMessage 请求；
 *   - `dispatchMiniAppRequest`：宿主侧的执行器，**只认 `MiniAppAction` 里的动作**，
 *     逐个翻译成具体的 RPC 调用。
 *
 * 两个必须守住的点：
 *   1. **没有任意方法透传**。小应用发来的 action 是联合类型里的字符串，认不出来就整条
 *      拒绝 —— 一旦在这里写 `call(params.method, params.params)`，sandbox 里的一段
 *      第三方 HTML 就等于拿到了整个 RPC 面（含读设置、写磁盘）。
 *   2. **参数一律当不可信输入**：长度、范围、枚举都夹一遍。iframe 里可能是个
 *      写着死循环的页面，不能让它用 200MB 的 prompt 把主进程撑死。
 */
import { chatImageUrl } from "../../shared/server-info";
import type { UILang } from "../../shared/i18n";
import {
  MINIAPP_CHANNEL,
  type MiniAppAction,
  type MiniAppCapabilitySnapshot,
  type MiniAppReadyPayload,
  type MiniAppRequestMessage,
  type MiniAppResponseMessage,
} from "../../shared/miniapps";

// ---------------------------------------------------------------------------
// 小应用侧的运行时
// ---------------------------------------------------------------------------

/**
 * 注入到小应用页面 `<head>` 里的运行时。
 *
 * 刻意用 ES5 写法 + 单引号（整段是个字符串常量，不经过任何构建步骤）：它会被塞进
 * `srcdoc`，语法错了整个小应用白屏，而且是那种"控制台里只有一句语法错误"的白屏。
 */
export const MINIAPP_RUNTIME_SCRIPT = `
(function () {
  var boot = window.__OMNI_BOOT__ || {};
  var CHANNEL = boot.channel || 'omni-miniapp';
  if (boot.theme) document.documentElement.setAttribute('data-theme', boot.theme);
  var seq = 0;
  var pending = {};
  var readyResolve;
  var ready = new Promise(function (resolve) { readyResolve = resolve; });

  function call(action, params) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending[id] = { resolve: resolve, reject: reject };
      parent.postMessage(
        { channel: CHANNEL, kind: 'request', id: id, action: action, params: params || {} },
        '*'
      );
    });
  }

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || msg.channel !== CHANNEL) return;
    if (msg.kind === 'response') {
      var slot = pending[msg.id];
      if (!slot) return;
      delete pending[msg.id];
      if (msg.ok) slot.resolve(msg.result);
      else slot.reject(new Error(msg.error || '调用失败'));
      return;
    }
    if (msg.kind === 'event' && (msg.event === 'ready' || msg.event === 'capabilities')) {
      var changed = msg.event === 'capabilities';
      if (msg.payload) {
        api.lang = msg.payload.lang;
        api.capabilities = msg.payload.capabilities;
        if (msg.payload.theme) document.documentElement.setAttribute('data-theme', msg.payload.theme);
      }
      // 能力变化时通知页面自己重画（用户在设置里配好了模型再切回来）。
      if (changed && typeof api.onCapabilities === 'function') api.onCapabilities(api.capabilities);
      readyResolve(api);
    }
  });

  var api = {
    appId: boot.appId || '',
    lang: boot.lang || 'zh',
    capabilities: boot.capabilities || null,
    ready: ready,
    capabilitiesOf: function () { return api.capabilities; },
    /** 页面可选的回调：宿主推来新的能力快照时调用。 */
    onCapabilities: null,
    /** 重新读一次能力：用户可能刚在设置里配好模型又切回来。 */
    refresh: function () {
      return call('host.capabilities').then(function (payload) {
        api.capabilities = payload.capabilities;
        return payload.capabilities;
      });
    },
    openSettings: function (tab) { return call('host.openSettings', { tab: tab }); },
    log: function (event, message, detail) {
      return call('host.log', { event: event, message: message, detail: detail }).catch(function () {});
    },
    image: {
      generate: function (params) { return call('image.generate', params); },
      edit: function (params) { return call('image.edit', params); }
    },
    // 本地抠图（去背景）。模型在主进程里跑，图片不出本机。
    //
    // run 一次返回剪切图与灰度掩膜两个 URL，之后换底色 / 擦除复原全在小应用自己的
    // 画布上做（掩膜是灰度 PNG，加载后即 alpha 平面）—— 不必每换一次底色再跑一遍模型。
    // 图片服务带 Access-Control-Allow-Origin: *，沙箱 iframe 加 crossorigin 就能把
    // 这两个 URL 画进画布并读像素，不会污染 canvas。
    //
    // 注意本文件这一整段是注入用的模板字符串（见上面的 MINIAPP_RUNTIME_SCRIPT），
    // 所以这里只能写普通 JS：不能出现反引号，也不能写 TS 泛型。
    bg: {
      status: function () { return call('bg.status'); },
      download: function (model) { return call('bg.download', { model: model }); },
      run: function (params) { return call('bg.run', params); }
    },
    audio: {
      transcribe: function (params) { return call('audio.transcribe', params); },
      // 录音由宿主采集：小应用跑在不透明源的 sandbox iframe 里，那里
      // navigator.mediaDevices 根本不存在（试过才知道，见 lib/mic-record.ts）。
      record: function (op) { return call('audio.record', { op: op || 'start' }); }
    },
    text: {
      complete: function (params) { return call('text.complete', params); }
    },
    files: {
      pick: function (params) { return call('files.pick', params); },
      read: function (params) { return call('files.read', params); },
      save: function (params) { return call('files.save', params); },
      /** 选文件 + 读回 dataUrl：小应用里最常用的一步。 */
      pickAndRead: function (params) {
        return call('files.pick', params).then(function (picked) {
          var path = (picked.paths || [])[0];
          if (!path) return null;
          return call('files.read', { path: path }).then(function (file) {
            return { path: path, dataUrl: file.dataUrl, name: file.name, size: file.size };
          });
        });
      }
    },
    // 笔记：正文进主库、附件进数据目录。小应用自己没有存储 —— sandbox iframe 是不透明源，
    // 那里 localStorage 会直接抛错，所以「随手记」这类要留存数据的应用必须走宿主。
    // 长度 / 标签数 / 附件数在宿主侧再夹一遍（见 dispatchMiniAppRequest）。
    notes: {
      list: function () { return call('notes.list'); },
      save: function (params) { return call('notes.save', params); },
      remove: function (id) { return call('notes.remove', { id: id }); },
      attach: function (params) { return call('notes.attach', params); }
    }
  };

  // 小应用里的未捕获错误宿主看不到（跨源，读不到它的 console）——
  // 转发一条到 app.log，"点了没反应"才有线索。
  window.addEventListener('error', function (event) {
    api.log('window.error', String((event && event.message) || 'unknown'), {
      source: (event && event.filename) || '',
      line: (event && event.lineno) || 0
    });
  });

  window.omni = api;
})();
`;

/**
 * 宿主提供给所有小应用的基础样式（"组件库"）。
 *
 * 与小应用各自的样式分开：主题变量、按钮 / 输入 / 卡片 / 忙碌态这些每个小应用都要用，
 * 让它们各自抄一遍的结果是五个页面五种灰。小应用只写自己的业务样式，
 * 于是"新增一个小应用"的成本降到只写它独有的那部分。
 *
 * 主题靠 `<html data-theme>`（由运行时按宿主主题设置）：小应用与宿主跨源，
 * 读不到宿主的主题 class。
 */
export const MINIAPP_BASE_STYLE = `
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;min-height:100%}
:root{
  --bg:#fff;--fg:#18181b;--muted:#71717a;--line:#e4e4e7;--card:#fafafa;--soft:#f4f4f5;
  --accent:#6d28d9;--accent-fg:#fff;--ok:#047857;--warn:#b45309;--radius:14px;
}
html[data-theme="dark"]{
  --bg:#09090b;--fg:#fafafa;--muted:#a1a1aa;--line:#27272a;--card:#131316;--soft:#1c1c20;
  --accent:#a78bfa;--accent-fg:#18181b;--ok:#34d399;--warn:#fbbf24;
}
body{
  background:var(--bg);color:var(--fg);
  font:13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,"PingFang SC","Microsoft YaHei",sans-serif;
}
.shell{max-width:940px;margin:0 auto;padding:18px 20px 28px;display:flex;flex-direction:column;gap:14px}
.hd{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.hd h1{margin:0;font-size:15px;font-weight:600}
.hd .sub{font-size:11px;color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:14px}
.row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.col{display:flex;flex-direction:column;gap:8px}
.grow{flex:1;min-width:0}
.lb{font-size:11px;font-weight:500;color:var(--muted)}
.hint{font-size:11px;line-height:1.7;color:var(--muted)}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.btn{
  appearance:none;border:1px solid var(--line);background:var(--bg);color:inherit;
  border-radius:10px;padding:8px 13px;font:inherit;font-weight:500;cursor:pointer;
  transition:background .15s,border-color .15s,opacity .15s;
}
.btn:hover:not(:disabled){border-color:var(--accent)}
.btn.primary{background:var(--accent);color:var(--accent-fg);border-color:transparent}
.btn.primary:hover:not(:disabled){opacity:.9}
.btn.ghost{border-color:transparent;background:transparent;color:var(--muted)}
.btn.ghost:hover:not(:disabled){color:var(--fg);background:var(--soft)}
.btn:disabled{opacity:.45;cursor:not-allowed}
.btn.sm{padding:5px 10px;font-size:12px}
.chip{
  appearance:none;border:1px solid var(--line);background:var(--bg);color:var(--muted);
  border-radius:999px;padding:5px 11px;font:inherit;font-size:12px;cursor:pointer;
}
.chip:hover{border-color:var(--accent)}
.chip[aria-pressed="true"],.chip.on{background:var(--accent);color:var(--accent-fg);border-color:transparent}
.field{
  width:100%;background:var(--bg);border:1px solid var(--line);border-radius:10px;
  padding:9px 11px;color:inherit;font:inherit;outline:none;
}
.field:focus-visible{border-color:var(--accent)}
textarea.field{resize:vertical;min-height:74px;line-height:1.6}
/* 滑块 / 勾选框：不设的话会落到浏览器默认的蓝色，跟主题色对不上 */
input[type="range"],input[type="checkbox"]{accent-color:var(--accent)}
.drop{
  border:1px dashed var(--line);border-radius:var(--radius);padding:22px;text-align:center;
  cursor:pointer;color:var(--muted);transition:border-color .15s,background .15s;
}
.drop:hover{border-color:var(--accent);background:var(--soft)}
.thumb{max-width:100%;max-height:300px;border-radius:12px;border:1px solid var(--line);display:block;background:var(--soft)}
.busy{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted)}
.spin{width:13px;height:13px;border:2px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:omni-spin .7s linear infinite}
@keyframes omni-spin{to{transform:rotate(360deg)}}
.err{font-size:12px;color:var(--warn)}
.ok{font-size:12px;color:var(--ok)}
.out{
  margin:0;white-space:pre-wrap;word-break:break-word;background:var(--bg);border:1px solid var(--line);
  border-radius:10px;padding:12px;max-height:320px;overflow:auto;
  font:12px/1.75 ui-monospace,SFMono-Regular,Menlo,monospace;
}
.hidden{display:none!important}
`;

/**
 * 把基础样式、运行时与启动配置注入小应用 HTML。
 *
 * 要求页面里有 `<head>`：小应用是手写的自包含 HTML，统一在 `<head>` 里注入，
 * 保证 `window.omni` 在任何业务脚本之前就存在。
 */
export function injectMiniAppRuntime(
  html: string,
  boot: {
    appId: string;
    lang: UILang;
    theme: "light" | "dark";
    capabilities: MiniAppCapabilitySnapshot;
  },
): string {
  const bootScript = `<script>window.__OMNI_BOOT__=${JSON.stringify({
    channel: MINIAPP_CHANNEL,
    ...boot,
  })};</script>`;
  const runtimeScript = `<script>${MINIAPP_RUNTIME_SCRIPT}</script>`;
  const baseStyle = `<style>${MINIAPP_BASE_STYLE}</style>`;
  const head = `<head>`;
  const index = html.indexOf(head);
  if (index === -1) return `${baseStyle}${bootScript}${runtimeScript}${html}`;
  const at = index + head.length;
  return `${html.slice(0, at)}${baseStyle}${bootScript}${runtimeScript}${html.slice(at)}`;
}

// ---------------------------------------------------------------------------
// 宿主侧：参数归一化
// ---------------------------------------------------------------------------

const MAX_TEXT = 60_000;

// ---------------------------------------------------------------------------
// 笔记的边界
// ---------------------------------------------------------------------------
//
// 与 `bun/notes.ts` 的 `NOTE_LIMITS` 是同一套数字（那边是权威，这里只是第一道门：
// 不把小应用随手编的超长内容送进主进程）。改一处要改两处。

const MAX_NOTE_TITLE = 200;
const MAX_NOTE_BODY = 20_000;
const MAX_NOTE_TAGS = 12;
const MAX_NOTE_TAG_CHARS = 24;
const MAX_NOTE_IMAGES = 9;

/**
 * 附件 ref 的形状（与 `bun/notes.ts` 的 `isNoteImageRef` 同一份规则）。
 *
 * 删除笔记时主进程会按 ref 反推目录并整目录删掉，所以这里必须先把
 * `notes/../..` 这类字符串挡在外面 —— 两层都卡，才谈得上"删附件不会删到别处"。
 */
const NOTE_IMAGE_REF = /^notes\/[a-z0-9]{6,32}\/[A-Za-z0-9._-]{1,120}\.(png|jpg|webp|gif)$/;

/** 本地时区的 `YYYY-MM-DD`：小应用给不出合法日期时兜底（与主进程同一口径）。 */
function localDay(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function stringList(value: unknown, max: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, max)
    .map((item) => str(item, maxChars).trim())
    .filter((item) => item.length > 0);
}

function str(value: unknown, max = 4000): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function num(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function optionalNum(value: unknown, min: number, max: number): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * 同 optionalNum，但**不取整**：给 0..1 这类连续量用（抠图的边缘优化强度）。
 * 用 optionalNum 会把 0.85 抹成 1、0.5 抹成 1 —— 三档强度会退化成两档，
 * 而且是最强那两档，界面上的选择等于失效。
 */
function optionalFloat(value: unknown, min: number, max: number): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, n));
}

function messageList(
  value: unknown,
): { role: "system" | "user" | "assistant"; content: string }[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 40)
    .map((m) => {
      const item = m as { role?: unknown; content?: unknown };
      const role: "system" | "user" | "assistant" =
        item?.role === "system" || item?.role === "assistant" ? item.role : "user";
      return { role, content: str(item?.content, 20_000) };
    })
    .filter((m) => m.content.length > 0);
}

// ---------------------------------------------------------------------------
// 宿主侧：执行
// ---------------------------------------------------------------------------

export interface MiniAppHostDeps {
  appId: string;
  /** 调用主进程 RPC（生产环境里就是 `rpcClient[method](params)`）。 */
  call: <T = unknown>(method: string, params?: unknown) => Promise<T>;
  /** 当前语言（小应用据此渲染中英文案）。 */
  lang: () => UILang;
  /** 当前主题：小应用与宿主跨源，读不到宿主的 `<html class="dark">`。 */
  theme: () => "light" | "dark";
  /** 能力快照；未提供时现读一次 RPC。 */
  capabilities: () => Promise<MiniAppCapabilitySnapshot>;
  /** 小应用请求跳设置页（缺模型时给用户一条出路）。 */
  openSettings: (tab?: string) => void;
  /**
   * 宿主侧录音（小应用自己在 iframe 里拿不到麦克风）。
   * 实现见 `lib/mic-record.ts`；这里只声明协议，方便测试替换。
   */
  record: (op: "start" | "stop" | "cancel") => Promise<unknown>;
  /** 产物落盘成功后的通知（宿主在工具条上显示"已保存到 …"）。 */
  onSaved: (info: { name: string; path: string }) => void;
}

/** 生图记录 → 给小应用的形态：只要 URL 与尺寸，不给它数据库行。 */
type ImageRecord = {
  imagePath?: string | null;
  imageUrl?: string | null;
  width?: number | null;
  height?: number | null;
};

function toImageResult(records: ImageRecord[] | undefined) {
  const first = records?.[0];
  // 记录的 imageUrl 是主进程算好的（媒体基址在网页端会被改写成网关的 /media 代理），
  // 这里不自己拼一遍 —— 拼错了小应用就拿到一个打不开的地址。
  const url = first?.imageUrl ?? (first?.imagePath ? chatImageUrl(first.imagePath) : null);
  if (!url) return null;
  return {
    url,
    ref: first?.imagePath ?? "",
    width: first?.width ?? null,
    height: first?.height ?? null,
  };
}

async function runAction(
  action: MiniAppAction,
  params: Record<string, unknown>,
  deps: MiniAppHostDeps,
): Promise<unknown> {
  switch (action) {
    case "host.ready":
    case "host.capabilities": {
      const payload: MiniAppReadyPayload = {
        appId: deps.appId,
        lang: deps.lang(),
        theme: deps.theme(),
        capabilities: await deps.capabilities(),
      };
      return payload;
    }

    case "host.openSettings": {
      deps.openSettings(str(params.tab, 60) || undefined);
      return { ok: true };
    }

    case "host.log":
      return await deps.call("miniappLog", {
        appId: deps.appId,
        event: str(params.event, 120) || "log",
        message: str(params.message, 500),
        detail: params.detail,
      });

    case "files.pick": {
      const multiple = params.multiple === true;
      const result = await deps.call<{ paths?: string[] }>("openFileDialog", {
        allowedFileTypes: str(params.types, 200) || undefined,
        canChooseFiles: true,
        allowsMultipleSelection: multiple,
      });
      return { paths: result?.paths ?? [] };
    }

    case "files.read": {
      const path = str(params.path, 4096);
      if (!path) throw new Error("缺少文件路径");
      const result = await deps.call<{
        ok: boolean;
        dataUrl?: string;
        name?: string;
        size?: number;
        error?: string;
      }>("miniappReadFile", { path });
      if (!result?.ok || !result.dataUrl) throw new Error(result?.error || "读取失败");
      return { dataUrl: result.dataUrl, name: result.name ?? "", size: result.size ?? 0 };
    }

    case "files.save": {
      const name = str(params.name, 120);
      const dataUrl = str(params.dataUrl, 40 * 1024 * 1024);
      if (!name || !dataUrl) throw new Error("缺少文件名或内容");
      const result = await deps.call<{ ok: boolean; path?: string; error?: string }>(
        "miniappSaveFile",
        { name, dataUrl },
      );
      if (!result?.ok) throw new Error(result?.error || "保存失败");
      deps.onSaved({ name, path: result.path ?? "" });
      return { path: result.path ?? "" };
    }

    case "image.generate": {
      const prompt = str(params.prompt, MAX_TEXT).trim();
      if (!prompt) throw new Error("缺少提示词");
      const result = await deps.call<{ records?: ImageRecord[]; error?: string }>(
        "generateImage",
        {
          prompt,
          negativePrompt: str(params.negativePrompt, MAX_TEXT) || undefined,
          width: num(params.width, 64, 4096, 1024),
          height: num(params.height, 64, 4096, 1024),
          count: 1,
          seed: optionalNum(params.seed, 0, 2 ** 31 - 1),
          // 小应用不该改写用户保存的生图配置（它给的是自己的预设参数）。
          persistConfig: false,
          source: "manual",
        },
      );
      if (result?.error) throw new Error(result.error);
      const image = toImageResult(result?.records);
      if (!image) throw new Error("生成失败：没有产出图片");
      return image;
    }

    case "image.edit": {
      const path = str(params.path, 4096).trim();
      const prompt = str(params.prompt, MAX_TEXT).trim();
      if (!path || !prompt) throw new Error("缺少参考图或提示词");
      // 参考图必须先经系统文件对话框选出来（stageEditImage 只认用户亲手选过的路径）。
      const staged = await deps.call<{ files?: { ref: string }[]; error?: string }>(
        "stageEditImage",
        { paths: [path] },
      );
      if (staged?.error) throw new Error(staged.error);
      const ref = staged?.files?.[0]?.ref;
      if (!ref) throw new Error("参考图暂存失败");
      const result = await deps.call<{ records?: ImageRecord[]; error?: string }>(
        "generateImage",
        {
          prompt,
          referenceImageRef: ref,
          count: 1,
          persistConfig: false,
          source: "manual",
        },
      );
      if (result?.error) throw new Error(result.error);
      const image = toImageResult(result?.records);
      if (!image) throw new Error("处理失败：没有产出图片");
      return image;
    }

    case "bg.status": {
      const result = await deps.call<{
        models?: {
          id: string;
          bytes: number;
          ready: boolean;
          tier: string;
          license: string;
          localBytes?: number;
        }[];
        defaultModel?: string;
        ready?: string | null;
      }>("bgRemoveModels", {});
      // 只把小应用需要的字段递过去。**localBytes 不能省**：小应用收不到宿主的推送，
      // 下载进度是轮询这个字段算出来的（页面写的是 `localBytes || 0`，漏了不报错，
      // 只是进度一直停在 0.0MB）。
      return {
        models: (result?.models ?? []).map((m) => ({
          id: m.id,
          bytes: m.bytes,
          localBytes: m.localBytes ?? 0,
          ready: m.ready,
          tier: m.tier,
          license: m.license,
        })),
        defaultModel: result?.defaultModel ?? "",
        ready: result?.ready ?? null,
      };
    }

    case "bg.download": {
      const model = str(params.model, 64).trim();
      if (!model) throw new Error("缺少模型名");
      const result = await deps.call<{ ok: boolean; error?: string }>("bgRemoveDownloadModel", {
        model,
      });
      if (!result?.ok) throw new Error(result?.error || "模型下载失败");
      return { ok: true };
    }

    case "bg.run": {
      const path = str(params.path, 4096).trim();
      if (!path) throw new Error("缺少图片路径");
      // 源图先落进 images/ 才能拿到 iframe 可加载的 URL（也是路径校验的那一步：
      // 只接受用户刚在系统对话框里选出来的文件）。
      const staged = await deps.call<{ ref?: string; url?: string; error?: string }>(
        "bgRemoveStageSource",
        { path },
      );
      if (staged?.error) throw new Error(staged.error);
      if (!staged?.ref || !staged?.url) throw new Error("图片暂存失败");
      const model = str(params.model, 64).trim();
      const refine = optionalFloat(params.refine, 0, 1);
      // maxSize 必须转发：小应用给的是「标准（长边 2048）/ 原图」，漏掉这一项会让
      // 4000px 的照片按原分辨率跑，界面上的选项等于没生效（慢 4 倍且文件巨大）。
      const maxSize = optionalNum(params.maxSize, 256, 8192);
      const result = await deps.call<{
        cutout?: { ref: string; url: string };
        mask?: { ref: string; url: string };
        width?: number;
        height?: number;
        model?: string;
        inferenceMs?: number;
        totalMs?: number;
        error?: string;
      }>("bgRemoveRun", {
        ref: staged.ref,
        model: model || undefined,
        refine,
        maxSize,
      });
      if (result?.error) throw new Error(result.error);
      if (!result?.cutout || !result?.mask) throw new Error("没有拿到抠图结果");
      return {
        source: { ref: staged.ref, url: staged.url },
        cutout: result.cutout,
        mask: result.mask,
        width: result.width ?? 0,
        height: result.height ?? 0,
        model: result.model ?? "",
        inferenceMs: result.inferenceMs ?? 0,
        totalMs: result.totalMs ?? 0,
      };
    }

    case "audio.record": {
      const op = str(params.op, 16) || "start";
      if (op !== "start" && op !== "stop" && op !== "cancel") {
        throw new Error(`不支持的录音操作：${op}`);
      }
      // 采集本身在宿主窗口里做（只有它有麦克风权限），这里只做动作白名单与转发。
      return await deps.record(op);
    }

    case "audio.transcribe": {
      const wavBase64 = str(params.wavBase64, 80 * 1024 * 1024);
      if (!wavBase64) throw new Error("没有拿到录音数据");
      const result = await deps.call<{
        text?: string;
        engine?: string;
        segments?: unknown;
        hasSpeakers?: boolean;
        error?: string;
      }>("transcribeAudio", {
        wavBase64,
        diarize: params.diarize === true,
        // 小应用的录音只是过程产物，不往"语音记录"里塞 —— 用户没在录音页里录过它。
        save: false,
      });
      if (result?.error) throw new Error(result.error);
      return {
        text: result?.text ?? "",
        engine: result?.engine ?? "",
        segments: result?.segments ?? [],
        hasSpeakers: result?.hasSpeakers === true,
      };
    }

    case "text.complete": {
      const messages = messageList(params.messages);
      const system = str(params.system, MAX_TEXT);
      if (messages.length === 0 && !system) throw new Error("缺少输入内容");
      const result = await deps.call<{ text: string; model?: string; error?: string }>(
        "miniappComplete",
        {
          system: system || undefined,
          messages,
          maxTokens: optionalNum(params.maxTokens, 64, 8192),
        },
      );
      if (result?.error) throw new Error(result.error);
      return { text: result.text, model: result.model ?? "" };
    }

    case "notes.list": {
      const result = await deps.call<{ notes?: unknown[]; stats?: unknown; agentAccess?: boolean }>(
        "miniappNotesList",
        undefined,
      );
      return {
        notes: result?.notes ?? [],
        stats: result?.stats ?? { notes: 0, images: 0, bytes: 0 },
        agentAccess: result?.agentAccess !== false,
      };
    }

    case "notes.save": {
      const id = optionalNum(params.id, 1, 2 ** 31 - 1);
      const title = str(params.title, MAX_NOTE_TITLE).trim();
      const body = str(params.body, MAX_NOTE_BODY).trim();
      // 空笔记在列表里就是一张点不出内容的卡片，主进程也会拒 —— 这里先拦一道，
      // 错误文案离用户更近，也不会白跑一趟 IPC。
      if (!title && !body) throw new Error("标题和正文不能都为空");
      const day = str(params.day, 10);
      const result = await deps.call<{ ok: boolean; note?: unknown; error?: string }>(
        "miniappNotesSave",
        {
          id,
          title,
          body,
          day: /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : localDay(),
          tags: stringList(params.tags, MAX_NOTE_TAGS, MAX_NOTE_TAG_CHARS),
          // 只放行自己形状的附件 ref：主进程按 ref 删文件，这里放进来的东西
          // 决定的是"删笔记时会不会碰到别的目录"。
          images: stringList(params.images, MAX_NOTE_IMAGES, 300).filter((ref) =>
            NOTE_IMAGE_REF.test(ref),
          ),
          pinned: params.pinned === true,
        },
      );
      if (!result?.ok) throw new Error(result?.error || "保存失败");
      return { note: result.note };
    }

    case "notes.remove": {
      const id = optionalNum(params.id, 1, 2 ** 31 - 1);
      if (!id) throw new Error("缺少笔记 id");
      const result = await deps.call<{ ok: boolean; error?: string }>("miniappNotesDelete", { id });
      if (!result?.ok) throw new Error(result?.error || "删除失败");
      return { ok: true };
    }

    case "notes.setAgentAccess": {
      const result = await deps.call<{ ok: boolean; enabled?: boolean }>(
        "miniappNotesSetAgentAccess",
        { enabled: params.enabled === true },
      );
      if (!result?.ok) throw new Error("设置失败");
      return { enabled: result.enabled === true };
    }

    case "notes.attach": {
      // base64 的长度上限给到 40MB：12MB 的图编码后约 16MB，留出富余，
      // 真正的体积判定在主进程按解码后的字节数做。
      const dataUrl = str(params.dataUrl, 40 * 1024 * 1024);
      if (!dataUrl) throw new Error("缺少图片数据");
      const result = await deps.call<{ ok: boolean; image?: unknown; error?: string }>(
        "miniappNotesAttach",
        { dataUrl, name: str(params.name, 120) },
      );
      if (!result?.ok || !result.image) throw new Error(result?.error || "图片保存失败");
      return { image: result.image };
    }

    default:
      // 认不出来的动作一律拒绝：这里绝不能退化成"按名字透传 RPC"。
      throw new Error(`不支持的动作：${String(action)}`);
  }
}

/** 执行一条小应用请求，返回可以直接 postMessage 回去的响应。 */
export async function dispatchMiniAppRequest(
  message: MiniAppRequestMessage,
  deps: MiniAppHostDeps,
): Promise<MiniAppResponseMessage> {
  const params = (message.params ?? {}) as Record<string, unknown>;
  try {
    const result = await runAction(message.action, params, deps);
    return { channel: MINIAPP_CHANNEL, kind: "response", id: message.id, ok: true, result };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    // 失败也写一条 app.log：小应用自己没报错时，这是唯一的线索来源。
    void deps
      .call("miniappLog", {
        appId: deps.appId,
        event: `action.failed.${String(message.action).slice(0, 60)}`,
        message: error,
        detail: { params: summarizeForLog(params) },
      })
      .catch(() => {});
    return {
      channel: MINIAPP_CHANNEL,
      kind: "response",
      id: message.id,
      ok: false,
      error,
    };
  }
}

/** 记日志用的参数摘要：大字段（base64 / 图片数据）只留长度，别把 app.log 撑爆。 */
function summarizeForLog(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") {
      out[key] = value.length > 200 ? `${value.slice(0, 200)}…(${value.length})` : value;
    } else if (Array.isArray(value)) {
      out[key] = `[${value.length} 项]`;
    } else {
      out[key] = value;
    }
  }
  return out;
}
