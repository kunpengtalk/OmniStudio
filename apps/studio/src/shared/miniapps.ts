/**
 * 小应用（Mini Apps）注册表与 IPC 协议 —— 全应用关于"有哪些小应用、它们能干什么"的唯一真源。
 *
 * 设计取舍：
 *   - **小应用就是一份自包含的 HTML**（`src/mainview/miniapps/<id>.html`），不参与主前端的
 *     构建、不共享 React 组件。宿主把它塞进 `sandbox` 的 iframe（`srcDoc`），
 *     于是小应用既碰不到宿主 DOM / store，也不需要为每个新应用改构建配置。
 *   - **能力走宿主转发，不给小应用 RPC 直连**：小应用只会说本文件里列的那几个动作
 *     （生图 / 修图 / 转写 / 一次性文本 / 选文件 / 存文件 / 打开设置 / 记日志），
 *     由宿主翻译成具体的 RPC 调用。想加能力必须在这里加一条 —— 而不是给小应用
 *     开一个"任意方法名透传"的口子（那等于把整个 RPC 面暴露给 iframe 里的脚本）。
 *   - 小应用的界面文案（nameKey/descKey）走 i18n，与主界面同一份字典，切换语言时一起变。
 */

export type MiniAppCategory = "image" | "audio" | "text";

export const MINIAPP_CATEGORIES: MiniAppCategory[] = ["image", "audio", "text"];

/** 运行小应用需要的主进程能力；缺哪个就在卡片上标出来（而不是进去才报错）。 */
export type MiniAppCapability = "image" | "imageEdit" | "chat" | "asr" | "bgRemove" | "local";

/** 卡片图标：只存名字，UI 侧映射成 lucide 组件（shared 不能 import JSX）。 */
export type MiniAppIcon =
  | "scissors"
  | "idCard"
  | "userRound"
  | "audioLines"
  | "penLine"
  | "grid"
  | "notebook";

/**
 * 卡片封面的配色：同样只存名字。
 *
 * 这里**不能直接写 Tailwind 类串**：Tailwind 只扫描 vite root（`src/mainview`）下的源码，
 * 写在 `shared/` 里的 `from-violet-500/25` 不会被生成成 CSS —— 表现是封面一片空白，
 * 而且构建不报错。类串放 `mainview/app/apps/accents.ts`（扫描范围内），这里只管语义。
 */
export type MiniAppAccent = "violet" | "sky" | "amber" | "emerald" | "indigo" | "rose";

export interface MiniAppSpec {
  id: string;
  /** i18n key：小应用名（`miniapps.<id>.name`）。 */
  nameKey: string;
  /** i18n key：一句话说明（`miniapps.<id>.desc`）。 */
  descKey: string;
  category: MiniAppCategory;
  icon: MiniAppIcon;
  /** 封面配色（语义名；具体类串在 UI 侧，见 MiniAppAccent 的说明）。 */
  accent: MiniAppAccent;
  requires: MiniAppCapability[];
  /** 搜索关键词：中英都塞，命中标题/说明之外的叫法（"抠图"、"换底色"…）。 */
  keywords: string[];
}

/**
 * 首批小应用。
 *
 * 每一个都对着真实能力落地的（没有"演示用假数据"）：去背景走**本地**分割模型
 * （模型可在这个小应用里自己下载，所以它不依赖任何云端配置）、证件照/形象照走生图，
 * 会议纪要走 ASR + 一次性文本，文案助手走一次性文本。
 */
export const MINIAPPS: MiniAppSpec[] = [
  {
    id: "bg-remove",
    nameKey: "miniapps.bgremove.name",
    descKey: "miniapps.bgremove.desc",
    category: "image",
    icon: "scissors",
    accent: "violet",
    // 本地引擎内置、模型在小应用里就能下，所以它没有"要先配好某个厂商"这回事：
    // 能力永远 ready（见 bun/miniapps.ts 的说明），label 只用来提示模型在不在本地。
    requires: ["bgRemove"],
    keywords: ["抠图", "去背景", "透明背景", "remove background", "cutout", "transparent"],
  },
  {
    id: "id-photo",
    nameKey: "miniapps.idphoto.name",
    descKey: "miniapps.idphoto.desc",
    category: "image",
    icon: "idCard",
    accent: "sky",
    // 换底色走本地分割模型（与抠图同一个引擎），裁剪与排版全在本页画布上做 ——
    // 所以它和抠图一样，不依赖任何云端厂商；缺的只是权重，而权重能在应用里下载。
    requires: ["bgRemove"],
    keywords: ["证件照", "一寸", "二寸", "签证照", "换底色", "id photo", "passport"],
  },
  {
    id: "mosaic",
    nameKey: "miniapps.mosaic.name",
    descKey: "miniapps.mosaic.desc",
    category: "image",
    icon: "grid",
    accent: "emerald",
    // 纯画布处理：不跑模型、不连网，唯一用到宿主的是"选文件 / 存文件"。
    // 仍然登记一条能力是为了让卡片说清楚它在本机完成（也避免"没有依赖"看起来像漏填）。
    requires: ["local"],
    keywords: [
      "马赛克",
      "打码",
      "涂抹",
      "遮挡",
      "隐私",
      "手机号",
      "地址",
      "mosaic",
      "pixelate",
      "redact",
    ],
  },
  {
    id: "portrait",
    nameKey: "miniapps.portrait.name",
    descKey: "miniapps.portrait.desc",
    category: "image",
    icon: "userRound",
    accent: "amber",
    requires: ["image"],
    keywords: ["形象照", "职业照", "人像", "头像", "portrait", "headshot", "avatar"],
  },
  {
    id: "meeting-notes",
    nameKey: "miniapps.meeting.name",
    descKey: "miniapps.meeting.desc",
    category: "audio",
    icon: "audioLines",
    accent: "emerald",
    requires: ["asr", "chat"],
    keywords: ["会议纪要", "录音转写", "说话人", "待办", "meeting notes", "transcribe", "minutes"],
  },
  {
    id: "copywriter",
    nameKey: "miniapps.copy.name",
    descKey: "miniapps.copy.desc",
    category: "text",
    icon: "penLine",
    accent: "indigo",
    requires: ["chat"],
    keywords: ["文案", "小红书", "标题", "朋友圈", "营销", "copywriter", "caption", "slogan"],
  },
  {
    id: "notes",
    nameKey: "miniapps.notes.name",
    descKey: "miniapps.notes.desc",
    category: "text",
    icon: "notebook",
    accent: "rose",
    // 笔记的读写在主库与数据目录里（见 bun/notes.ts），不依赖任何模型或厂商，
    // 所以永远是 ready；页内的「AI 助手」（润色 / 续写）只是可选加成，
    // 没配对话模型时它自己给一条"去配置"的路，而不是让整个应用进不去。
    requires: ["local"],
    keywords: [
      "笔记",
      "日记",
      "备忘录",
      "随手记",
      "记事",
      "日历",
      "标签",
      "notes",
      "journal",
      "diary",
      "memo",
    ],
  },
];

export function miniAppById(id: string): MiniAppSpec | undefined {
  return MINIAPPS.find((app) => app.id === id);
}

/** 能力的中文/英文名（卡片上的「需要 XX」标签，宿主与小应用共用）。 */
export const MINIAPP_CAPABILITY_LABEL_KEY: Record<MiniAppCapability, string> = {
  image: "miniapps.cap.image",
  imageEdit: "miniapps.cap.imageEdit",
  chat: "miniapps.cap.chat",
  asr: "miniapps.cap.asr",
  bgRemove: "miniapps.cap.bgRemove",
  local: "miniapps.cap.local",
};

// ---------------------------------------------------------------------------
// iframe ↔ 宿主 的消息协议
// ---------------------------------------------------------------------------

/** 所有消息都带这个字段，宿主据此过滤同页面里其它来源的 postMessage。 */
export const MINIAPP_CHANNEL = "omni-miniapp";

/** 小应用请求的动作名（`omni.<ns>.<action>` 里的 `<ns>.<action>`）。 */
export type MiniAppAction =
  | "host.ready"
  | "host.capabilities"
  | "host.openSettings"
  | "host.log"
  | "files.pick"
  | "files.read"
  | "files.save"
  | "image.generate"
  | "image.edit"
  | "bg.status"
  | "bg.download"
  | "bg.run"
  | "audio.record"
  | "audio.transcribe"
  | "text.complete"
  | "notes.list"
  | "notes.save"
  | "notes.remove"
  | "notes.attach"
  | "notes.setAgentAccess";

export interface MiniAppRequestMessage {
  channel: typeof MINIAPP_CHANNEL;
  kind: "request";
  /** 请求序号：并发请求靠它配对响应。 */
  id: number;
  action: MiniAppAction;
  params?: unknown;
}

export interface MiniAppResponseMessage {
  channel: typeof MINIAPP_CHANNEL;
  kind: "response";
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** 宿主 → 小应用的主动事件（小应用加载完先收到一次 ready，拿到语言与能力快照）。 */
export interface MiniAppEventMessage {
  channel: typeof MINIAPP_CHANNEL;
  kind: "event";
  event: "ready" | "capabilities";
  payload: MiniAppReadyPayload;
}

export interface MiniAppReadyPayload {
  appId: string;
  lang: "zh" | "en";
  /** 宿主当前主题：小应用在沙箱里读不到宿主 DOM，主题只能这样传进去。 */
  theme: "light" | "dark";
  capabilities: MiniAppCapabilitySnapshot;
}

export type MiniAppMessage =
  | MiniAppRequestMessage
  | MiniAppResponseMessage
  | MiniAppEventMessage;

export function isMiniAppChannelMessage(value: unknown): value is MiniAppMessage {
  if (!value || typeof value !== "object") return false;
  const msg = value as { channel?: unknown; kind?: unknown };
  return msg.channel === MINIAPP_CHANNEL && typeof msg.kind === "string";
}

// ---------------------------------------------------------------------------
// 能力快照（主进程 getMiniAppCapabilities 返回的形态）
// ---------------------------------------------------------------------------

export interface MiniAppCapabilityState {
  ready: boolean;
  /** 就绪时是"用哪个后端/模型"，未就绪时是"缺什么"——卡片与站内提示直接显示这句。 */
  label: string;
}

export type MiniAppCapabilitySnapshot = Record<MiniAppCapability, MiniAppCapabilityState>;

// ---------------------------------------------------------------------------
// 宿主能力（小应用可以调用的全部动作）
// ---------------------------------------------------------------------------

/** 小应用能做的事：动作 → 一句话说明（也用于生成给小应用开发者看的接口清单）。 */
export const MINIAPP_ACTIONS: Record<MiniAppAction, string> = {
  "host.ready": "拿语言 / 能力快照（runtime 自己会先调一次）",
  "host.capabilities": "重新读取能力快照（用户在设置里刚配置完）",
  "host.openSettings": "让宿主跳到设置页（缺模型时给用户一条出路）",
  "host.log": "写一条 app.log（小应用里的失败必须能事后排查）",
  "files.pick": "打开系统文件选择框，返回真实路径",
  "files.read": "把刚选出来的文件读成 dataUrl（沙箱里没法直接显示本地路径）",
  "files.save": "把 dataUrl 存到下载目录，返回落盘路径",
  "image.generate": "文生图，返回媒体 URL",
  "image.edit": "以图改图（参考图必须是 files.pick 选出来的路径）",
  "bg.status": "本地抠图：模型清单与下载状态",
  "bg.download": "本地抠图：下载某个模型的权重（首次使用需要）",
  "bg.run": "本地抠图：跑一次去背景，返回剪切图与掩膜 URL（源图必须是 files.pick 选出来的路径）",
  "audio.record": "麦克风录音（宿主采集，op = start / stop / cancel；沙箱页本身拿不到麦克风）",
  "audio.transcribe": "语音转文字（可带说话人分段）",
  "text.complete": "一次性文本补全（总结 / 改写 / 起标题）",
  "notes.list": "笔记：读全部笔记（正文 / 标签 / 日期 / 附件）与统计",
  "notes.save": "笔记：新建或更新一条（正文进主库，不是文件）",
  "notes.remove": "笔记：删除一条，连同它的附件文件",
  "notes.attach": "笔记：把一张图片存进数据目录，返回可预览的 ref 与地址",
  "notes.setAgentAccess": "笔记：开关「对 Agent 可见」（沉淀记忆 + 可读正文），只影响之后的保存",
};
