import { createHash } from "crypto";

/**
 * Microsoft Edge 在线 TTS 客户端（完全免费、无需任何 API Key）。
 * 协议基于 edge-tts（https://github.com/rany2/edge-tts）：
 *  WSS 握手 -> speech.config -> ssml -> 收集 audio/mpeg 二进制分片。
 */

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const CHROMIUM_FULL_VERSION = "143.0.3650.75";
const CHROMIUM_MAJOR = CHROMIUM_FULL_VERSION.split(".")[0];
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;
const WSS_BASE =
  "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=" +
  TRUSTED_CLIENT_TOKEN;

/** 生成 Sec-MS-GEC 令牌（Windows 文件时间按 5 分钟取整 + 固定 client token 做 SHA-256）。 */
function generateSecMsGec(): string {
  let ticks = Date.now() / 1000;
  ticks += 11644473600; // Unix -> Windows 文件时间纪元
  ticks -= ticks % 300; // 向下取整到最近 5 分钟
  ticks *= 1e9 / 100; // 秒 -> 100ns 间隔
  const str = `${Math.round(ticks)}${TRUSTED_CLIENT_TOKEN}`;
  return createHash("sha256").update(str, "ascii").digest("hex").toUpperCase();
}

function connectId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 与 edge-tts 的 date_to_string() 一致的 JS 风格日期串。 */
function dateString(): string {
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${p2(d.getUTCDate())} ${d.getUTCFullYear()} ${p2(
    d.getUTCHours(),
  )}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function cleanText(s: string): string {
  // 服务端不支持控制字符范围（尤其竖制表符），替换为空格。
  return Array.from(s)
    .map((ch) => {
      const code = ch.codePointAt(0)!;
      if (code <= 8 || (code >= 11 && code <= 12) || (code >= 14 && code <= 31)) return " ";
      return ch;
    })
    .join("");
}

function buildSpeechConfig(): string {
  return (
    `X-Timestamp:${dateString()}\r\n` +
    "Content-Type:application/json; charset=utf-8\r\n" +
    "Path:speech.config\r\n\r\n" +
    '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"true","wordBoundaryEnabled":"false"},' +
    '"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n'
  );
}

function buildSsml(text: string, voice: string): string {
  const ssml =
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${voice.slice(0, 5)}'>` +
    `<voice name='${voice}'>` +
    `<prosody pitch='+0Hz' rate='+0%' volume='+0%'>${escapeXml(cleanText(text))}</prosody>` +
    `</voice></speak>`;
  return (
    `X-RequestId:${connectId()}\r\n` +
    "Content-Type:application/ssml+xml\r\n" +
    `X-Timestamp:${dateString()}Z\r\n` +
    `Path:ssml\r\n\r\n${ssml}`
  );
}

const WSS_HEADERS = {
  Pragma: "no-cache",
  "Cache-Control": "no-cache",
  Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
  "User-Agent":
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
    `(KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR}.0.0.0`,
  "Accept-Language": "en-US,en;q=0.9",
};

export type EdgeSynthesizeOptions = {
  voice?: string;
  rate?: string;
  timeoutMs?: number;
  onProgress?: (received: number) => void;
};

/**
 * 合成一段文本为 mp3。
 * @param text 要朗读的文本
 * @param voice Edge 音色 id，如 "zh-CN-XiaoxiaoNeural"
 */
export function edgeSynthesize(text: string, voice: string, opts: EdgeSynthesizeOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const url =
      `${WSS_BASE}&ConnectionId=${connectId()}` +
      `&Sec-MS-GEC=${generateSecMsGec()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;

    let ws: WebSocket;
    try {
      // Bun 的 WebSocket 支持自定义 headers，但 DOM 类型签名没有，故此处断言。
      ws = new WebSocket(url, {
        headers: WSS_HEADERS,
      } as unknown as string | string[] | undefined);
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }

    const chunks: Buffer[] = [];
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      fn();
    };

    const timeoutMs = opts.timeoutMs ?? 90_000;
    const timer = setTimeout(() => {
      finish(() => reject(new Error("Edge TTS 合成超时")));
    }, timeoutMs);

    ws.onopen = () => {
      try {
        ws.send(buildSpeechConfig());
        ws.send(buildSsml(text, voice));
      } catch (e) {
        finish(() => reject(e instanceof Error ? e : new Error(String(e))));
      }
    };

    ws.onerror = () => finish(() => reject(new Error("Edge TTS 连接失败，请检查网络")));

    ws.onmessage = (ev) => {
      const d = ev.data;
      if (typeof d === "string") {
        const buf = Buffer.from(d, "utf-8");
        const path = parsePath(buf);
        if (path === "turn.end") {
          finish(() => {
            if (chunks.length === 0) reject(new Error("Edge TTS 未收到音频"));
            else resolve(Buffer.concat(chunks));
          });
        }
        return;
      }
      // 二进制帧：[2 字节 header length][headers][\r\n][payload]
      const buf = Buffer.isBuffer(d) ? d : Buffer.from(d as Uint8Array);
      if (buf.length < 4) return;
      const hlen = buf.readUInt16BE(0);
      const head = buf.subarray(2, 2 + hlen).toString();
      const payload = buf.subarray(2 + hlen);
      if (head.includes("Path:audio") && payload.length > 0) {
        chunks.push(Buffer.from(payload));
        opts.onProgress?.(payload.length);
      }
    };

    ws.onclose = () => {
      clearTimeout(timer);
      if (!settled) {
        if (chunks.length > 0) resolve(Buffer.concat(chunks));
        else reject(new Error("Edge TTS 连接已关闭"));
      }
    };
  });
}

function parsePath(textBuf: Buffer): string | null {
  const idx = textBuf.indexOf(Buffer.from("\r\n\r\n"));
  if (idx < 0) return null;
  const head = textBuf.subarray(0, idx).toString();
  const line = head.split("\r\n").find((l) => l.startsWith("Path:"));
  return line ? line.slice(5) : null;
}

// ---------------------------------------------------------------------------
// 音色清单
// ---------------------------------------------------------------------------

export type EdgeVoice = {
  id: string;
  name: string;
  locale: string;
  gender: string;
  desc?: string;
};

export const EDGE_VOICES: EdgeVoice[] = [
  // 简体中文
  { id: "zh-CN-XiaoxiaoNeural", name: "晓晓", locale: "zh-CN", gender: "女", desc: "温暖活泼，日常/播报" },
  { id: "zh-CN-XiaoyiNeural", name: "晓伊", locale: "zh-CN", gender: "女", desc: "活泼" },
  { id: "zh-CN-XiaochenNeural", name: "晓辰", locale: "zh-CN", gender: "女", desc: "成熟干练" },
  { id: "zh-CN-XiaohanNeural", name: "晓涵", locale: "zh-CN", gender: "女", desc: "温柔" },
  { id: "zh-CN-XiaomengNeural", name: "晓梦", locale: "zh-CN", gender: "女", desc: "软萌" },
  { id: "zh-CN-XiaomoNeural", name: "晓墨", locale: "zh-CN", gender: "女", desc: "情绪丰富" },
  { id: "zh-CN-XiaoqiuNeural", name: "晓秋", locale: "zh-CN", gender: "女", desc: "可爱" },
  { id: "zh-CN-XiaoruiNeural", name: "晓睿", locale: "zh-CN", gender: "男", desc: "老年男声" },
  { id: "zh-CN-XiaoshuangNeural", name: "晓双", locale: "zh-CN", gender: "男孩", desc: "童声" },
  { id: "zh-CN-XiaoxuanNeural", name: "晓萱", locale: "zh-CN", gender: "女" },
  { id: "zh-CN-XiaoyanNeural", name: "晓颜", locale: "zh-CN", gender: "女" },
  { id: "zh-CN-XiaoyouNeural", name: "晓悠", locale: "zh-CN", gender: "儿童", desc: "童声" },
  { id: "zh-CN-YunxiNeural", name: "云希", locale: "zh-CN", gender: "男", desc: "阳光少年，有声书/短视频" },
  { id: "zh-CN-YunyangNeural", name: "云扬", locale: "zh-CN", gender: "男", desc: "新闻播报" },
  { id: "zh-CN-YunjianNeural", name: "云健", locale: "zh-CN", gender: "男", desc: "低沉成熟" },
  { id: "zh-CN-YunfengNeural", name: "云枫", locale: "zh-CN", gender: "男", desc: "情感丰富" },
  { id: "zh-CN-YunxiaNeural", name: "云夏", locale: "zh-CN", gender: "男", desc: "少年感" },
  { id: "zh-CN-YunzeNeural", name: "云泽", locale: "zh-CN", gender: "男" },
  // 繁体中文
  { id: "zh-TW-HsiaoChenNeural", name: "曉臻", locale: "zh-TW", gender: "女" },
  { id: "zh-TW-HsiaoYuNeural", name: "曉雨", locale: "zh-TW", gender: "女" },
  { id: "zh-TW-YunJheNeural", name: "雲哲", locale: "zh-TW", gender: "男" },
  // 英语
  { id: "en-US-JennyNeural", name: "Jenny", locale: "en-US", gender: "女", desc: "自然，最受欢迎" },
  { id: "en-US-AriaNeural", name: "Aria", locale: "en-US", gender: "女" },
  { id: "en-US-MichelleNeural", name: "Michelle", locale: "en-US", gender: "女" },
  { id: "en-US-AnalyzerNeural", name: "Analyzer", locale: "en-US", gender: "女" },
  { id: "en-US-GuyNeural", name: "Guy", locale: "en-US", gender: "男" },
  { id: "en-US-ChristopherNeural", name: "Christopher", locale: "en-US", gender: "男" },
  { id: "en-US-EricNeural", name: "Eric", locale: "en-US", gender: "男" },
  { id: "en-US-RogerNeural", name: "Roger", locale: "en-US", gender: "男" },
  { id: "en-US-SteffanNeural", name: "Steffan", locale: "en-US", gender: "男" },
  { id: "en-GB-SoniaNeural", name: "Sonia", locale: "en-GB", gender: "女" },
  { id: "en-GB-RyanNeural", name: "Ryan", locale: "en-GB", gender: "男" },
  { id: "en-AU-NatashaNeural", name: "Natasha", locale: "en-AU", gender: "女" },
  { id: "en-AU-WilliamNeural", name: "William", locale: "en-AU", gender: "男" },
  { id: "en-IN-NeerjaNeural", name: "Neerja", locale: "en-IN", gender: "女" },
  // 多语种（多语言女声/男声，可读多种语言）
  { id: "en-US-EmmaMultilingualNeural", name: "Emma (Multilingual)", locale: "en-US", gender: "女" },
  { id: "en-US-BrianMultilingualNeural", name: "Brian (Multilingual)", locale: "en-US", gender: "男" },
  // 日语
  { id: "ja-JP-NanamiNeural", name: "Nanami", locale: "ja-JP", gender: "女" },
  { id: "ja-JP-KeitaNeural", name: "Keita", locale: "ja-JP", gender: "男" },
  // 韩语
  { id: "ko-KR-SunHiNeural", name: "SunHi", locale: "ko-KR", gender: "女" },
  { id: "ko-KR-InJoonNeural", name: "InJoon", locale: "ko-KR", gender: "男" },
  // 其他
  { id: "fr-FR-DeniseNeural", name: "Denise", locale: "fr-FR", gender: "女" },
  { id: "fr-FR-HenriNeural", name: "Henri", locale: "fr-FR", gender: "男" },
  { id: "de-DE-KatjaNeural", name: "Katja", locale: "de-DE", gender: "女" },
  { id: "de-DE-ConradNeural", name: "Conrad", locale: "de-DE", gender: "男" },
  { id: "es-ES-ElviraNeural", name: "Elvira", locale: "es-ES", gender: "女" },
  { id: "es-ES-AlvaroNeural", name: "Alvaro", locale: "es-ES", gender: "男" },
  { id: "ru-RU-SvetlanaNeural", name: "Svetlana", locale: "ru-RU", gender: "女" },
  { id: "ru-RU-DmitryNeural", name: "Dmitry", locale: "ru-RU", gender: "男" },
  { id: "it-IT-ElsaNeural", name: "Elsa", locale: "it-IT", gender: "女" },
  { id: "pt-BR-FranciscaNeural", name: "Francisca", locale: "pt-BR", gender: "女" },
];

export function listEdgeVoices(): EdgeVoice[] {
  return EDGE_VOICES;
}

/** 快速自检：合成一句极短文本，验证服务可用。 */
export async function testEdgeTTS(): Promise<{ ok: boolean; error?: string }> {
  try {
    const buf = await edgeSynthesize("Hi.", "en-US-AriaNeural", { timeoutMs: 20_000 });
    return { ok: buf.length > 0 };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}