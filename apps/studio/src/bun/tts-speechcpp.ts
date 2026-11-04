import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "fs";
import path from "path";
import { getSetting, updateSettings } from "./db/settings";
import { getDataDir } from "./paths";
import { removeManifest, writeManifest } from "./install-manifest";
import { installedModelSize, isModelInstalled, localModelPath } from "./modelscope";
import { logEvent } from "./app-log";
import { fetchAssetFromSources, githubReleaseUrls } from "./mirror-download";
import type { MediaSource } from "./db/schema";
import {
  SPEECHCPP_ENGINE_DIR,
  SPEECHCPP_ENGINE_ID,
  SPEECHCPP_ENGINE_VERSION,
  SPEECHCPP_RELEASE_TAG,
  SPEECHCPP_REPO,
  SPEECHCPP_TTS_CATALOG,
  SPEECHCPP_VOICES_SUBDIR,
  speechCppModelEntry,
  type SpeechCppTtsModel,
} from "../shared/speechcpp";
import {
  getAudioBaseDir,
  insertVoiceRecord,
  listVoiceClones,
  resolveAudioPath,
  voiceRecordToRow,
  type VoiceRecordRow,
} from "./voice";
import { languageCode, toWav } from "./tts-local";

/**
 * speech.cpp TTS 本地引擎。
 *
 * speech.cpp（github.com/nyosegawa/speech.cpp）是 ggml 系的语音推理引擎，一个 `speech`
 * 二进制同时管合成 / 识别 / VAD。本模块只用 TTS 一侧，单次调用合成：
 *
 *   speech tts <model.gguf> -o out.wav [--voice <name>] [--language <tag>]
 *     [--instructions "<怎么念>"] [--add-voice <name>=<voice.gguf>] "<text>"
 *
 * 与 audio.cpp 是**并列的两个本地 TTS 引擎**，由设置 `TTS_LOCAL_ENGINE` 二选一
 * （切换只写这一个键，模型权重互不影响）；引擎二进制各自独立托管：
 * audio.cpp 在 `<dataDir>/engines/audiocpp`，speech.cpp 在 `<dataDir>/engines/speechcpp`。
 *
 * 模型一个仓库一个（都在 HuggingFace 的 sakasegawa 名下），下载走 downloadManager 的
 * "huggingface" 源；二进制随 GitHub Release 发布（zip），可一键下载到本地。
 */

/** 一次合成请求的超时：大模型（Drama 3 20GB）首次要从磁盘加载，给足时间。 */
const SYNTH_TIMEOUT_MS = 20 * 60_000;

// ---------------------------------------------------------------------------
// 目录与二进制
// ---------------------------------------------------------------------------

export function speechCppEngineDir(): string {
  return getDataDir("engines", SPEECHCPP_ENGINE_DIR);
}

function speechCppVersionDir(): string {
  return path.join(speechCppEngineDir(), SPEECHCPP_ENGINE_VERSION);
}

function speechCppManagedBin(): string {
  return path.join(speechCppVersionDir(), "speech");
}

/** 托管目录 / 托管可执行文件 / 本平台有没有预编译包（引擎管理页探测用）。 */
export function speechCppEngineBin(): string {
  return speechCppManagedBin();
}

export function speechCppSupported(): boolean {
  return releaseAssetName() !== null;
}

function getSearchPath(): string {
  const home = process.env.HOME ?? "";
  const current = process.env.PATH ?? "";
  return [`/opt/homebrew/bin`, `/usr/local/bin`, home ? `${home}/.local/bin` : "", current]
    .filter(Boolean)
    .join(":");
}

async function findOnPath(): Promise<string | null> {
  return Bun.which("speech", { PATH: getSearchPath() }) ?? null;
}

/** 找到可用的 speech：优先随应用下载的引擎，其次 PATH（install.sh 装的那份）。 */
export async function resolveSpeechCppBinary(): Promise<string | null> {
  try {
    const managed = speechCppManagedBin();
    if (existsSync(managed)) return managed;
  } catch {}
  return await findOnPath();
}

/** GitHub Release 资产：当前平台 -> 下载文件名。资产名用不带 v 的版本号。 */
export function releaseAssetName(
  platform: string = process.platform,
  arch: string = process.arch,
): string | null {
  const v = SPEECHCPP_ENGINE_VERSION;
  if (platform === "darwin" && arch === "arm64") return `speech-${v}-macos-arm64-metal.zip`;
  // Intel Mac 没有预编译包（上游只发 Apple Silicon），走 PATH 或自行编译。
  if (platform === "linux" && arch === "x64") return `speech-${v}-linux-x64-cpu.zip`;
  if (platform === "win32" && arch === "x64") return `speech-${v}-windows-x64-vulkan.zip`;
  return null;
}

/** 后端标签（仅用于界面展示，与 speech.cpp 的 --device 无关）。 */
export function speechCppBackend(): "metal" | "vulkan" | "cpu" {
  if (process.platform === "darwin") return "metal";
  if (process.platform === "win32") return "vulkan";
  return "cpu";
}

// ---------------------------------------------------------------------------
// 模型清单与状态
// ---------------------------------------------------------------------------

export type SpeechCppModelInfo = SpeechCppTtsModel & {
  downloaded: boolean;
  installedSize: number | null;
  installedPath: string | null;
  active: boolean;
};

export type SpeechCppStatus = {
  engineInstalled: boolean;
  binaryPath: string | null;
  backend: "metal" | "vulkan" | "cpu";
  /** 引擎当前是否启用（TTS_LOCAL_ENGINE === "speech.cpp"）。 */
  active: boolean;
  activeModelId: string | null;
  activeModelPath: string | null;
  version: string;
};

function resolveModelPath(modelId: string | null | undefined): string | null {
  if (!modelId) return null;
  const entry = speechCppModelEntry(modelId);
  if (!entry) return null;
  const p = localModelPath(entry.repo, entry.repoPath);
  return existsSync(p) ? p : null;
}

export function listSpeechCppModels(): SpeechCppModelInfo[] {
  const activeModel = getSetting("TTS_SPEECHCPP_MODEL");
  return SPEECHCPP_TTS_CATALOG.map((m) => {
    const p = localModelPath(m.repo, m.repoPath);
    const downloaded = isModelInstalled(m.repo, m.repoPath);
    return {
      ...m,
      downloaded,
      installedSize: downloaded ? installedModelSize(m.repo, m.repoPath) : null,
      installedPath: downloaded ? p : null,
      active: downloaded && activeModel === m.id,
    };
  });
}

export async function getSpeechCppStatus(): Promise<SpeechCppStatus> {
  const bin = await resolveSpeechCppBinary();
  const active = getSetting("TTS_LOCAL_ENGINE") === "speech.cpp";
  const modelId = getSetting("TTS_SPEECHCPP_MODEL");
  return {
    engineInstalled: !!bin,
    binaryPath: bin,
    backend: speechCppBackend(),
    active,
    activeModelId: active ? modelId || null : null,
    activeModelPath: active ? resolveModelPath(modelId) : null,
    version: SPEECHCPP_ENGINE_VERSION,
  };
}

// ---------------------------------------------------------------------------
// 引擎安装（GitHub Release zip）
// ---------------------------------------------------------------------------

/**
 * 解 zip。macOS / Linux 用系统的 unzip（一定在），失败依次退到 bsdtar、
 * python3，Windows 上退到 PowerShell 的 Expand-Archive。
 * 失败返回错误串，由调用方清目录并换下一条下载链路。
 */
function extractZip(zip: string, targetDir: string): string | null {
  mkdirSync(targetDir, { recursive: true });
  const attempts: string[][] = [
    ["unzip", "-oq", zip, "-d", targetDir],
    // macOS 与 Win10+ 的 tar 是 bsdtar，能直接读 zip。
    ["tar", "-xf", zip, "-C", targetDir],
    ["python3", "-m", "zipfile", "-e", zip, targetDir],
    [
      "powershell",
      "-NoProfile",
      "-Command",
      `Expand-Archive -Force -LiteralPath '${zip}' -DestinationPath '${targetDir}'`,
    ],
  ];
  for (const args of attempts) {
    try {
      const p = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
      if (p.exitCode === 0 && findSpeechBinary(targetDir)) return null;
    } catch {
      // 这个解压工具不存在或不可用，试下一个
    }
  }
  return "解压失败：未找到可用的解压工具（unzip / tar / python3）或包内没有 speech 可执行文件";
}

/** 在解压结果里找 `speech`：zip 根目录，或包一层文件夹的情况。 */
function findSpeechBinary(dir: string): string | null {
  const direct = path.join(dir, "speech");
  if (existsSync(direct)) return direct;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const nested = path.join(dir, entry.name, "speech");
      if (existsSync(nested)) return nested;
    }
  } catch {
    // 读不到目录
  }
  return null;
}

/**
 * 下载 speech.cpp 推理引擎（GitHub Release zip，多链路回退）。
 * `upgrade` = 已经有一份了也重新下载（版本钉死，这一步等于修复安装）。
 */
export async function downloadSpeechCppEngine(
  options: { upgrade?: boolean } = {},
): Promise<{ ok: boolean; error?: string }> {
  const existing = options.upgrade ? null : await resolveSpeechCppBinary();
  if (existing) return { ok: true };

  if (!removeManifest(speechCppEngineDir())) {
    return {
      ok: false,
      error: `无法清除上次的安装记录，请检查 ${speechCppEngineDir()} 是否被占用或只读`,
    };
  }

  const asset = releaseAssetName();
  if (!asset) {
    return {
      ok: false,
      error: `当前平台（${process.platform}/${process.arch}）没有 speech.cpp 预编译包，请手动安装 speech 并加入 PATH`,
    };
  }

  const targetDir = speechCppVersionDir();
  const tmpZip = path.join(speechCppEngineDir(), `.${asset}`);
  const urls = await githubReleaseUrls(SPEECHCPP_REPO, SPEECHCPP_RELEASE_TAG, asset);

  const res = await fetchAssetFromSources({
    urls,
    dest: tmpZip,
    what: "speech.cpp 推理引擎",
    source: "tts",
    // 只有解压出 speech 才算这条链路可用：代理回错误页时解压会直接失败。
    accept: (file) => extractZip(file, targetDir),
  });
  rmSync(tmpZip, { force: true });
  if (res.ok) {
    const bin = findSpeechBinary(targetDir);
    if (bin && bin !== speechCppManagedBin()) {
      // 包内多套了一层目录：把内容提上来，托管路径才是稳定的。
      try {
        for (const entry of readdirSync(path.dirname(bin))) {
          const from = path.join(path.dirname(bin), entry);
          const to = path.join(targetDir, entry);
          if (from !== to && !existsSync(to))
            Bun.spawnSync(["mv", from, to], { stdout: "ignore", stderr: "ignore" });
        }
        rmSync(path.dirname(bin), { recursive: true, force: true });
      } catch {
        // 提不上来也能用（resolved 路径已经落进 manifest 之外的 findSpeechBinary），不阻断安装
      }
    }
    try {
      if (existsSync(speechCppManagedBin())) chmodSync(speechCppManagedBin(), 0o755);
    } catch {
      // chmod 失败时二进制通常仍可执行（zip 里已带可执行位）
    }
    writeManifest(speechCppEngineDir(), {
      engine: "speech.cpp",
      version: SPEECHCPP_ENGINE_VERSION,
      platform: process.platform,
      arch: process.arch,
      steps: 2,
    });
    logEvent({
      source: "tts",
      event: "tts.speechcpp.engine_installed",
      message: `speech.cpp 引擎已安装（${SPEECHCPP_ENGINE_VERSION}）`,
      detail: { version: SPEECHCPP_ENGINE_VERSION, dir: targetDir },
    });
  }
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

/** 启动/切换本地 TTS 引擎到 speech.cpp 的指定模型（下载完成后即可点启动）。 */
export async function startSpeechCpp(modelId: string): Promise<{ ok: boolean; error?: string }> {
  const entry = speechCppModelEntry(modelId);
  if (!entry) return { ok: false, error: "未知模型" };

  const modelPath = resolveModelPath(modelId);
  if (!modelPath) return { ok: false, error: "模型尚未下载，请先点击下载" };

  const bin = await resolveSpeechCppBinary();
  if (!bin) return { ok: false, error: "未找到 speech 可执行文件，请先下载 speech.cpp 推理引擎" };

  // 切换本地引擎只动这一个键：audio.cpp 的模型与设置保持原样，切回去还在。
  updateSettings({ TTS_LOCAL_ENGINE: SPEECHCPP_ENGINE_ID, TTS_SPEECHCPP_MODEL: modelId });
  logEvent({
    source: "tts",
    event: "tts.speechcpp.started",
    message: `speech.cpp 引擎已启用（${entry.name}）`,
    detail: { modelId },
  });
  return { ok: true };
}

export async function stopSpeechCpp(): Promise<void> {
  updateSettings({ TTS_LOCAL_ENGINE: "", TTS_SPEECHCPP_MODEL: "" });
  logEvent({ source: "tts", event: "tts.speechcpp.stopped", message: "speech.cpp 引擎已停止" });
}

export function isSpeechCppActive(): boolean {
  return getSetting("TTS_LOCAL_ENGINE") === SPEECHCPP_ENGINE_ID;
}

export function activeSpeechCppModelId(): string | null {
  return getSetting("TTS_SPEECHCPP_MODEL") || null;
}

/** 删除模型文件（只删 models/ 下的权重，从不碰引擎与已生成的音色文件）。 */
export function deleteSpeechCppModel(modelId: string): { ok: boolean } {
  const entry = speechCppModelEntry(modelId);
  if (!entry) return { ok: false };
  const p = localModelPath(entry.repo, entry.repoPath);
  try {
    rmSync(p, { force: true });
    let dir = path.dirname(p);
    while (dir && dir !== path.dirname(dir)) {
      try {
        const rest = readdirSync(dir);
        if (rest.length > 0) break;
        rmSync(dir, { force: true });
        dir = path.dirname(dir);
      } catch {
        break;
      }
    }
  } catch {
    // 删不掉就算了，文件仍在，下次还能用
  }
  if (getSetting("TTS_SPEECHCPP_MODEL") === modelId) {
    updateSettings({ TTS_SPEECHCPP_MODEL: "" });
  }
  return { ok: true };
}

/**
 * 卸载托管的 speech.cpp 引擎（PATH / install.sh 装的那份不碰），并清掉指向它的设置 ——
 * 留着 `TTS_LOCAL_ENGINE=speech.cpp` 的话界面上会一直显示「使用中」，直到下一次合成
 * 才报「未找到 speech」。已下载的模型与生成的音色文件都保留（各自单独管理）。
 */
export function removeSpeechCppEngine(): { ok: boolean; error?: string } {
  try {
    rmSync(speechCppEngineDir(), { recursive: true, force: true });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  try {
    if (getSetting("TTS_LOCAL_ENGINE") === SPEECHCPP_ENGINE_ID) {
      updateSettings({ TTS_LOCAL_ENGINE: "", TTS_SPEECHCPP_MODEL: "" });
    }
  } catch {
    // 设置清理失败不影响引擎已被删除的事实
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 合成
// ---------------------------------------------------------------------------

/** 克隆音色文件目录：`<engines>/speechcpp/voices/<modelId>/`。 */
function voiceFileDir(modelId: string): string {
  return path.join(speechCppEngineDir(), SPEECHCPP_VOICES_SUBDIR, modelId);
}

/** 克隆名 → 文件名（克隆名是用户输入，落盘前只留安全字符）。 */
function voiceFileName(cloneName: string): string {
  const safe = cloneName.replace(/[^\w\u4e00-\u9fff.-]+/g, "_").slice(0, 60) || "voice";
  return `${safe}.voice.gguf`;
}

/**
 * 用参考录音生成 speech.cpp 的音色文件（`speech voice` 的产物，缓存复用）。
 * 参考音频更新过（mtime 更新）就重新生成 —— 否则用户换了录音却听到旧音色。
 */
async function ensureVoiceFile(
  bin: string,
  entry: SpeechCppTtsModel,
  modelPath: string,
  cloneName: string,
  refPath: string,
): Promise<string> {
  const dir = voiceFileDir(entry.id);
  mkdirSync(dir, { recursive: true });
  const out = path.join(dir, voiceFileName(cloneName));
  try {
    if (existsSync(out) && statSync(out).mtimeMs >= statSync(refPath).mtimeMs) return out;
  } catch {
    // 读不到时间戳就重新生成
  }

  // `speech voice` 只读 WAVE（任意采样率），其余格式先转过来。
  const wavRef = path.extname(refPath).toLowerCase() === ".wav" ? refPath : await toWav(refPath);
  const proc = Bun.spawn([bin, "voice", modelPath, wavRef, out, "--device", "cpu"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr =
    proc.stderr && typeof proc.stderr !== "number" ? await new Response(proc.stderr).text() : "";
  const code = await proc.exited;

  if (code !== 0 || !existsSync(out) || statSync(out).size < 100) {
    rmSync(out, { force: true });
    const tail = stderr.trim().slice(-400);
    logEvent({
      source: "tts",
      event: "tts.speechcpp.voice_failed",
      message: `生成音色文件失败（退出码 ${code}）`,
      detail: { modelId: entry.id, cloneName, stderr: tail },
    });
    throw new Error(`生成克隆音色失败（退出码 ${code}）${tail ? `：${tail}` : ""}`);
  }
  return out;
}

export type SpeechCppSynthOptions = {
  voice?: string;
  emotion?: string;
  language?: string;
  instruct?: string;
};

/**
 * 组装 `speech tts` 参数（纯函数，便于测试）。不碰文件系统，voiceFile 由调用方解析好。
 *
 * 请求项必须逐模型对得上：speech.cpp 会**拒绝模型不认识的选项**（Drama 3 拒绝 --instructions，
 * Qwen3-TTS 只有 1.7B 认它），多传一个就是一次合成失败。所以这里一律先查模型上的能力位。
 */
export function buildSpeechCppArgs(input: {
  modelPath: string;
  outPath: string;
  entry: SpeechCppTtsModel;
  options: SpeechCppSynthOptions;
  /** `described` 类模型解析出来的音色文件（`--add-voice`）。 */
  voiceFile?: string | null;
  voiceName?: string | null;
}): string[] {
  const { entry, options, outPath, modelPath } = input;
  const args = ["tts", modelPath, "-o", outPath];
  const instruct = entry.supportsInstruct ? options.instruct?.trim() : "";

  if (entry.voiceKind === "preset") {
    // `--voice` 是必填项，缺省用模型自己的默认音色。
    args.push("--voice", options.voice || entry.defaultVoice || entry.presetVoices?.[0]?.id || "");
  } else {
    if (input.voiceFile && input.voiceName) {
      // 参考录音生成的音色文件：先注册再按名字引用。
      args.push("--add-voice", `${input.voiceName}=${input.voiceFile}`, "--voice", input.voiceName);
    } else {
      // 没有音色文件时 `--voice none` 表示"音色由模型自己挑 / 由 --instructions 描述"。
      args.push("--voice", "none");
    }
  }
  if (instruct) args.push("--instructions", instruct);

  const lang = languageCode(options.language);
  if (lang && entry.languageSupported) args.push("--language", lang);

  return args;
}

/** 调一次 `speech tts`，返回退出码与 stderr（退出码 3 = 文本被截到模型上限，仍算成功）。 */
async function runSpeechCli(
  bin: string,
  args: string[],
): Promise<{ code: number; stderr: string; timedOut: boolean }> {
  const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
  // 两个管道都必须一直读：写满 64KB 的管道会让子进程卡在写这一步，
  // 看起来就是"合成一直不结束"，最后被超时杀掉。stdout 的内容我们不用，读掉即可。
  const drain = (s: unknown): Promise<string> =>
    s && typeof s !== "number"
      ? new Response(s as ReadableStream<Uint8Array>).text()
      : Promise.resolve("");
  const stderrPromise = drain(proc.stderr);
  void drain(proc.stdout);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGKILL");
    } catch {
      // 已经退出了
    }
  }, SYNTH_TIMEOUT_MS);

  const code = await proc.exited;
  clearTimeout(timer);
  const stderr = await stderrPromise;
  return { code, stderr, timedOut };
}

export async function runTTSSpeechCpp(input: {
  text: string;
  model?: string;
  voice?: string;
  emotion?: string;
  language?: string;
  instruct?: string;
  source?: MediaSource;
}): Promise<VoiceRecordRow> {
  const modelId = input.model?.trim() || getSetting("TTS_SPEECHCPP_MODEL");
  const entry = speechCppModelEntry(modelId);
  if (!entry)
    return Promise.reject(new Error("请先在本地引擎中选择一个已启动的 speech.cpp TTS 模型"));
  if (!isSpeechCppActive()) {
    return Promise.reject(new Error("speech.cpp 引擎未启动，请先点击「启动」"));
  }

  const modelPath = resolveModelPath(modelId);
  if (!modelPath) return Promise.reject(new Error(`模型未下载：${entry.name}`));

  const bin = await resolveSpeechCppBinary();
  if (!bin) return Promise.reject(new Error("未找到 speech，请先下载 speech.cpp 推理引擎"));

  // described 类模型：给了克隆音色就用克隆，否则用一句话描述音色。
  let voiceFile: string | null = null;
  let voiceName: string | null = null;
  if (entry.voiceKind === "described" && input.voice) {
    const clone = listVoiceClones().find((c) => c.name === input.voice);
    const ref = clone?.refAudioPath ? resolveAudioPath(clone.refAudioPath) : null;
    if (!ref || !existsSync(ref)) {
      return Promise.reject(new Error("找不到所选克隆音色的参考音频"));
    }
    voiceFile = await ensureVoiceFile(bin, entry, modelPath, input.voice, ref);
    voiceName = voiceFileName(input.voice).replace(/\.voice\.gguf$/, "");
  }

  const outName = `tts-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.wav`;
  const outPath = path.join(getAudioBaseDir(), outName);

  const args = buildSpeechCppArgs({
    modelPath,
    outPath,
    entry,
    options: {
      voice: input.voice,
      emotion: input.emotion,
      language: input.language,
      instruct: input.instruct,
    },
    voiceFile,
    voiceName,
  });

  const { code, stderr, timedOut } = await runSpeechCli(bin, [...args, input.text]);

  // 退出码 3 = 某个文本停在了模型单次能说的最长长度（音频仍然完整写出），不算失败。
  const ok = code === 0 || code === 3;
  if (!ok || !existsSync(outPath) || statSync(outPath).size < 1000) {
    rmSync(outPath, { force: true });
    const tail = stderr.trim().slice(-500);
    const reason = timedOut ? "合成超时" : `退出码 ${code}`;
    logEvent({
      source: "tts",
      event: "tts.speechcpp.failed",
      message: `speech.cpp 合成失败（${reason}）`,
      detail: { modelId, code, timedOut, stderr: tail },
    });
    return Promise.reject(new Error(`本地合成失败（${reason}）${tail ? `：${tail}` : ""}`));
  }

  const record = insertVoiceRecord({
    kind: "tts",
    source: input.source,
    model: `${entry.name} (speech.cpp)`,
    voice: input.voice ?? null,
    text: input.text,
    audioPath: `audio/${outName}`,
  });
  return voiceRecordToRow(record);
}

/** 通话可用的本地 speech.cpp 模型，按优先级排序（支持中文且已下载 → 逐个兜底）。 */
function callLocalCandidates(): SpeechCppTtsModel[] {
  const downloaded = SPEECHCPP_TTS_CATALOG.filter((m) => isModelInstalled(m.repo, m.repoPath));
  const supportsZh = (m: SpeechCppTtsModel) => m.languages.some((l) => l.includes("中文"));
  const activeId = getSetting("TTS_SPEECHCPP_MODEL");
  const ordered: SpeechCppTtsModel[] = [];
  const active = downloaded.find((m) => m.id === activeId);
  if (active && supportsZh(active)) ordered.push(active);
  for (const id of ["qwen3-tts-1.7b", "qwen3-tts-0.6b"]) {
    const m = downloaded.find((x) => x.id === id);
    if (m && !ordered.includes(m)) ordered.push(m);
  }
  for (const m of downloaded) {
    if (supportsZh(m) && !ordered.includes(m)) ordered.push(m);
  }
  return ordered;
}

/** 用指定模型合成一句（失败返回 null，不抛错）。 */
async function synthesizeCallOne(
  entry: SpeechCppTtsModel,
  modelPath: string,
  text: string,
  bin: string,
): Promise<Buffer | null> {
  const outName = `call-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.wav`;
  const outPath = path.join(getAudioBaseDir(), outName);
  // 通话走预设音色的模型：described 类（Irodori / Drama 3）在通话里只会说日文或无音色可用，
  // 这里不给 --instructions，让它用自己的默认音色。
  const args = buildSpeechCppArgs({
    modelPath,
    outPath,
    entry,
    options: {
      voice: entry.defaultVoice,
      language: languageCode(getSetting("ASR_LANG")) || undefined,
    },
  });

  const { code, stderr } = await runSpeechCli(bin, [...args, text.trim()]);
  const ok = code === 0 || code === 3;
  if (!ok || !existsSync(outPath) || statSync(outPath).size < 1000) {
    const size = existsSync(outPath) ? statSync(outPath).size : 0;
    rmSync(outPath, { force: true });
    logEvent({
      level: "debug",
      source: "tts",
      event: "voicecall",
      message: `speech.cpp synthesize ${entry.id} FAILED code=${code} size=${size} stderr=${stderr.trim().slice(-300)}`,
    });
    return null;
  }
  const buffer = Buffer.from(await Bun.file(outPath).arrayBuffer());
  rmSync(outPath, { force: true });
  logEvent({
    level: "debug",
    source: "tts",
    event: "voicecall",
    message: `speech.cpp synthesize ${entry.id} OK ${buffer.byteLength}B`,
  });
  return buffer;
}

/**
 * 通话逐句本地合成（不落库）：用已下载的 speech.cpp 预设音色模型逐个尝试，
 * 全部失败返回 null（由调用方回退到 remote provider / Edge）。
 */
export async function synthesizeCallSpeechCpp(text: string): Promise<Buffer | null> {
  const bin = await resolveSpeechCppBinary();
  if (!bin) return null;
  for (const entry of callLocalCandidates()) {
    const modelPath = resolveModelPath(entry.id);
    if (!modelPath) continue;
    try {
      const buf = await synthesizeCallOne(entry, modelPath, text, bin);
      if (buf) return buf;
    } catch {
      // 该模型异常，尝试下一个可用模型。
    }
  }
  return null;
}
