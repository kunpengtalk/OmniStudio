/**
 * 小应用预览：把 `src/mainview/miniapps/*.html` 渲染成可在普通浏览器里打开的页面。
 *
 * 为什么需要：小应用跑在应用内的 sandbox iframe 里，改一行文案都要先起整个桌面应用
 * （Electrobun + vite + 主进程）才能看一眼，反馈太慢。这里把**同一份注入逻辑**
 * （`injectMiniAppRuntime`）用起来，只是把宿主换成一段浏览器内的假宿主：
 * 能力一律"就绪"，生图 / 转写 / 补全返回固定内容，选文件返回内置的占位人像，
 * 落盘只打印一行。于是布局、主题、交互状态都能在浏览器里直接看。
 *
 *   bun run miniapps:preview                  # 中文 + 深色，写到临时目录
 *   bun run miniapps:preview -- --lang en --theme light
 *
 * 它**不是**替代真机验证：真宿主的动作白名单、参数夹取、日志都在这段假宿主之外，
 * 真机行为以应用内为准（那条路径的测试见 mainview/lib/miniapp-bridge.test.ts）。
 */
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import sharp from "sharp";

import { injectMiniAppRuntime } from "../src/mainview/lib/miniapp-bridge";
import {
  MINIAPPS,
  MINIAPP_CHANNEL,
  type MiniAppCapabilitySnapshot,
} from "../src/shared/miniapps";

const args = process.argv.slice(2);
const readFlag = (name: string, fallback: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? (args[at + 1] ?? fallback) : fallback;
};

const lang = readFlag("lang", "zh") === "en" ? "en" : "zh";
const theme = readFlag("theme", "dark") === "light" ? "light" : "dark";

const READY: MiniAppCapabilitySnapshot = {
  image: { ready: true, label: "预览 · flux-schnell" },
  imageEdit: { ready: true, label: "预览 · flux-schnell" },
  chat: { ready: true, label: "预览 · qwen3-8b" },
  asr: { ready: true, label: "预览 · whisper-large-v3" },
  bgRemove: { ready: true, label: "预览 · 本地 silueta" },
  local: { ready: true, label: "预览 · 仅本机处理" },
};

/** 占位人像：证件照 / 抠图用得上，纯 SVG 不需要任何外部资源。 */
function placeholder(subject: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="640">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#7dd3fc"/><stop offset="1" stop-color="#a78bfa"/></linearGradient></defs>
<rect width="512" height="640" fill="url(#g)"/>
<circle cx="256" cy="250" r="96" fill="#1f2937" opacity="0.75"/>
<path d="M96 640c0-104 72-176 160-176s160 72 160 176z" fill="#1f2937" opacity="0.75"/>
<text x="256" y="600" text-anchor="middle" font-family="system-ui" font-size="26" fill="#ffffff" opacity="0.85">${subject}</text>
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

const STUB_IMAGE = placeholder("preview · 输出图");
const STUB_SOURCE = placeholder("preview · 原图");

/** 假宿主给"导入音频"的返回值：2 秒 16kHz 单声道的正弦音，能被 WebAudio 真的解码。 */
function stubWav(): string {
  const rate = 16000;
  const seconds = 2;
  const samples = rate * seconds;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    buffer.writeInt16LE(Math.round(Math.sin((i / rate) * 440 * 2 * Math.PI) * 8000), 44 + i * 2);
  }
  return `data:audio/wav;base64,${buffer.toString("base64")}`;
}

const STUB_AUDIO = stubWav();

/**
 * 抠图预览用的一对图：位图源图 + 灰度掩膜。
 *
 * 掩膜必须是真的位图（灰度 PNG）而不是 SVG：页面把掩膜读进 ImageData 当 alpha 平面用，
 * 拿 SVG 顶替就测不到"取 R 通道当 alpha"这条路径。这里用 sharp 现做一张
 * （白椭圆 = 前景），于是预览里换底色、笔刷涂抹都是真在跑画布管线。
 */
async function stubCutoutPair(): Promise<{ source: string; mask: string }> {
  const W = 512;
  const H = 640;
  const sourceSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<rect width="${W}" height="${H}" fill="#8ea3b8"/>
<ellipse cx="256" cy="300" rx="150" ry="220" fill="#a01f2e"/>
<circle cx="256" cy="190" r="86" fill="#f0c9a0"/>
<text x="256" y="615" text-anchor="middle" font-family="system-ui" font-size="24" fill="#ffffff">preview · 源图</text>
</svg>`;
  const maskSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<rect width="${W}" height="${H}" fill="#000000"/>
<ellipse cx="256" cy="300" rx="150" ry="220" fill="#ffffff"/>
<circle cx="256" cy="190" r="86" fill="#ffffff"/>
</svg>`;
  const toDataUrl = async (svg: string, grey: boolean) => {
    let pipe = sharp(Buffer.from(svg));
    if (grey) pipe = pipe.greyscale();
    const png = await pipe.png().toBuffer();
    return `data:image/png;base64,${png.toString("base64")}`;
  };
  return { source: await toDataUrl(sourceSvg, false), mask: await toDataUrl(maskSvg, true) };
}

const CUTOUT_PAIR = await stubCutoutPair();

/** 浏览器内的假宿主：协议与真宿主一致，只是动作换成固定结果。 */
const HOST_STUB = `
(function () {
  var CHANNEL = ${JSON.stringify(MINIAPP_CHANNEL)};
  var CAPS = ${JSON.stringify(READY)};
  var IMAGE = ${JSON.stringify(STUB_IMAGE)};
  var SOURCE = ${JSON.stringify(STUB_SOURCE)};
  var AUDIO = ${JSON.stringify(STUB_AUDIO)};
  var CUTOUT_SOURCE = ${JSON.stringify(CUTOUT_PAIR.source)};
  var CUTOUT_MASK = ${JSON.stringify(CUTOUT_PAIR.mask)};
  var lastPick = '';
  // 笔记的假数据：让列表 / 日历 / 标签 / 附件四个视图在预览里都有东西可看。
  // 真宿主把正文写进主库、附件写进数据目录，这里只存在内存里（刷新即回到初值）。
  var NOTES = [
    { id: 1, title: '周末爬山', body: '早上六点出门，山顶的云正好散开。\\n下次带上长焦。', tags: ['生活', '运动'], day: dayKey(0), images: [{ ref: 'notes/preview01/x.png', url: SOURCE, path: '/preview/x.png', width: 512, height: 640, bytes: 240000 }], pinned: true, createdAt: Date.now() - 3600e3, updatedAt: Date.now() - 600e3 },
    { id: 2, title: '读书笔记：深度工作', body: '把大块时间留给需要专注的事，碎片时间只处理不需要思考的杂事。', tags: ['读书'], day: dayKey(0), images: [], pinned: false, createdAt: Date.now() - 7200e3, updatedAt: Date.now() - 4200e3 },
    { id: 3, title: '会议要点', body: '1. 范围收敛到两个功能\\n2. 周三前给接口\\n3. 下周出内测版', tags: ['工作'], day: dayKey(-2), images: [], pinned: false, createdAt: Date.now() - 86400e3, updatedAt: Date.now() - 86400e3 },
    { id: 4, title: '菜单', body: '番茄牛腩、清炒时蔬、银耳汤。牛腩要提前一晚腌。', tags: ['生活', '做饭'], day: dayKey(-9), images: [], pinned: false, createdAt: Date.now() - 9 * 86400e3, updatedAt: Date.now() - 9 * 86400e3 }
  ];
  function dayKey(deltaDays) {
    var d = new Date();
    d.setDate(d.getDate() + deltaDays);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function noteStats(list) {
    var images = 0, bytes = 0;
    for (var i = 0; i < list.length; i++) {
      images += list[i].images.length;
      for (var j = 0; j < list[i].images.length; j++) bytes += list[i].images[j].bytes || 0;
    }
    return { notes: list.length, images: images, bytes: bytes };
  }
  function reply(id, result) {
    window.postMessage({ channel: CHANNEL, kind: 'response', id: id, ok: true, result: result }, '*');
  }
  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || msg.channel !== CHANNEL || msg.kind !== 'request') return;
    var p = msg.params || {};
    window.setTimeout(function () {
      switch (msg.action) {
        case 'host.ready':
        case 'host.capabilities':
          return reply(msg.id, { appId: 'preview', lang: ${JSON.stringify(lang)}, theme: ${JSON.stringify(theme)}, capabilities: CAPS });
        case 'host.openSettings':
          console.log('[preview] openSettings', p.tab);
          return reply(msg.id, { ok: true });
        case 'host.log':
          console.log('[preview] log', p.event, p.message);
          return reply(msg.id, { ok: true });
        case 'files.pick':
          // 选音频的页面给音频，选图的给图 —— 否则会议纪要在预览里第一步就解码失败。
          lastPick = /wav|mp3|m4a|audio/i.test(String(p.types || '')) ? '/preview/sample.wav' : '/preview/source.png';
          return reply(msg.id, { paths: [lastPick] });
        case 'files.read':
          return /\\.wav$/.test(String(p.path || lastPick))
            ? reply(msg.id, { dataUrl: AUDIO, name: 'sample.wav', size: 64000 })
            : reply(msg.id, { dataUrl: SOURCE, name: 'source.png', size: 240000 });
        case 'files.save':
          console.log('[preview] save', p.name);
          return reply(msg.id, { path: '/Downloads/' + p.name });
        case 'image.generate':
        case 'image.edit':
          return reply(msg.id, { url: IMAGE, ref: 'gen/preview.png', width: 512, height: 640 });
        case 'bg.status':
          // 一个已就绪 + 一个待下载：这样预览里既能试换底色/笔刷，也能看到下载卡片长什么样
          return reply(msg.id, {
            models: [
              { id: 'silueta', bytes: 44173029, localBytes: 44173029, ready: true, tier: 'balanced', license: 'Apache-2.0' },
              // 待下载的那个给一个"下一半"的 localBytes：下载进度条靠它算，写 0 就看不出区别
              { id: 'u2netp', bytes: 4574861, localBytes: 1900000, ready: false, tier: 'fast', license: 'Apache-2.0' },
            ],
            defaultModel: 'silueta',
            ready: 'silueta',
          });
        case 'bg.download':
          console.log('[preview] download model', p.model);
          return reply(msg.id, { ok: true });
        case 'bg.run':
          // 返回真位图：页面会把它读进 ImageData 当 alpha 平面，换底色与笔刷都是真跑画布管线
          return reply(msg.id, {
            source: { ref: 'bgremove/in/preview.png', url: CUTOUT_SOURCE },
            cutout: { ref: 'bgremove/preview-cutout.png', url: CUTOUT_SOURCE },
            mask: { ref: 'bgremove/preview-mask.png', url: CUTOUT_MASK },
            width: 512,
            height: 640,
            model: 'preview',
            inferenceMs: 900,
            totalMs: 1200,
          });
        case 'audio.record':
          // 录音由宿主采集：预览里回一段真能被解码的 WAV，走通"录完即转写"这条链路
          console.log('[preview] record', p.op);
          return reply(msg.id, p.op === 'stop' ? { ok: true, wavBase64: AUDIO.replace(/^data:audio\\/wav;base64,/, ''), seconds: 2 } : { ok: true });
        case 'audio.transcribe':
          return reply(msg.id, {
            text: '张伟：这次先把范围收敛到两个功能。\\n李娜：后端接口周三前给到。\\n张伟：下周出一版可用的内测。',
            engine: 'preview',
            hasSpeakers: true,
            segments: [
              { start: 3, end: 12, speaker: 0, text: '这次先把范围收敛到两个功能，其余的放到下个迭代。' },
              { start: 12, end: 21, speaker: 1, text: '后端接口我周三前给到，前端可以先接 mock。' },
              { start: 21, end: 30, speaker: 0, text: '那就下周出一版可用的内测，主要看稳定性。' },
            ],
          });
        case 'notes.list':
          return reply(msg.id, { notes: NOTES.slice(), stats: noteStats(NOTES) });
        case 'notes.save': {
          var now = Date.now();
          if (p.id) {
            for (var i = 0; i < NOTES.length; i++) {
              if (NOTES[i].id === p.id) {
                NOTES[i] = Object.assign({}, NOTES[i], {
                  title: p.title || '', body: p.body || '', tags: p.tags || [],
                  day: p.day || dayKey(0), pinned: !!p.pinned, updatedAt: now,
                  images: NOTES[i].images.filter(function (img) { return (p.images || []).indexOf(img.ref) >= 0; })
                });
                return reply(msg.id, { ok: true, note: NOTES[i] });
              }
            }
            return reply(msg.id, { ok: false, error: '这条笔记已经不存在了' });
          }
          var created = {
            id: NOTES.length + 1, title: p.title || '', body: p.body || '', tags: p.tags || [],
            day: p.day || dayKey(0), images: [], pinned: !!p.pinned, createdAt: now, updatedAt: now
          };
          NOTES.push(created);
          return reply(msg.id, { ok: true, note: created });
        }
        case 'notes.remove':
          NOTES = NOTES.filter(function (note) { return note.id !== p.id; });
          return reply(msg.id, { ok: true });
        case 'notes.attach':
          // 真宿主会把图压到 2048 并落盘；预览里直接复用那张占位图
          return reply(msg.id, { image: { ref: 'notes/preview0' + (msg.id % 9) + '/pick.png', url: SOURCE, path: '/preview/pick.png', width: 512, height: 640, bytes: 240000 } });
        case 'text.complete':
          return reply(msg.id, {
            text: '## 议题\\n- 本期范围收敛为两个功能\\n- 后端接口交付时间\\n\\n## 结论\\n- 其余需求顺延到下个迭代\\n\\n## 待办\\n| 事项 | 负责人 | 时间 |\\n| --- | --- | --- |\\n| 提供后端接口 | 李娜 | 周三前 |\\n| 出可用的内测版本 | 张伟 | 下周 |',
            model: 'preview',
          });
        default:
          window.postMessage({ channel: CHANNEL, kind: 'response', id: msg.id, ok: false, error: '预览宿主未实现：' + msg.action }, '*');
      }
    }, 220);
  });
  // 小应用加载完把能力推过去（真宿主在 iframe onLoad 时推 ready）。
  window.addEventListener('load', function () {
    window.setTimeout(function () {
      window.postMessage({ channel: CHANNEL, kind: 'event', event: 'ready',
        payload: { appId: 'preview', lang: ${JSON.stringify(lang)}, theme: ${JSON.stringify(theme)}, capabilities: CAPS } }, '*');
    }, 0);
  });
})();
`;

const outDir = join(tmpdir(), `omni-miniapp-preview-${lang}-${theme}`);
mkdirSync(outDir, { recursive: true });

// 小应用页面放在 src/mainview/miniapps/，文件名即登记表里的 id。
const sourceDir = join(import.meta.dir, "..", "src", "mainview", "miniapps");
const onDisk = new Set(readdirSync(sourceDir).filter((name) => name.endsWith(".html")));
const written: string[] = [];

for (const app of MINIAPPS) {
  const file = `${app.id}.html`;
  if (!onDisk.has(file)) {
    console.warn(`[preview] 跳过 ${app.id}：缺 ${file}`);
    continue;
  }
  const html = readFileSync(join(sourceDir, file), "utf8");
  const injected = injectMiniAppRuntime(html, {
    appId: app.id,
    lang,
    theme,
    capabilities: READY,
  });
  // 假宿主放在最前面：它要在运行时与业务脚本之前把 message 监听装好。
  const page = injected.replace(
    /<head>/,
    `<head>\n<script>${HOST_STUB}</script>\n<title>preview · ${app.id}</title>`,
  );
  const target = join(outDir, file);
  writeFileSync(target, page);
  written.push(`${app.id.padEnd(14)} ${target}`);
}

console.log(`[preview] ${lang} / ${theme} → ${outDir}`);
console.log(written.join("\n"));
