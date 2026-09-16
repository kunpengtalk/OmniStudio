# 本地抠图（去背景 / 换底色）

> 对标产品：BgSub（zh.bgsub.com/webapp）。本文分两部分：先记录**它是怎么做的**
> （从线上产物读出来的结构，不含任何反编译代码），再说**我们是怎么做的、为什么不一样**。
> 代码入口：`apps/studio/src/bun/bg-remove.ts` + `apps/studio/src/mainview/miniapps/bg-remove.html`。

---

## 一、BgSub 的架构

### 1. 形态

Vue 3 + Quasar 的 PWA（`#q-app` 挂载点、Quasar boot 文件、service worker、可安装
manifest），前端资源在 `/webapp/` 下按 chunk 懒加载，i18n 只有 zh-CN / en-US 两套。
它同时有一个移动端精简版（页面上明确写着"这是为移动端设计的精简版本，使用电脑或者
平板可以使用更多强大功能"）。

**全部计算在浏览器内完成**，这是它的核心卖点（页面标题就写着"无需上传图像"）。
服务端只承担两件事：账号（`api.bgsub.com/accounts`）与用户主动捐赠的样本
（`api.bgsub.com/image/contribute`）。

### 2. 推理：Web Worker + 自编译的 WASM 运行时

- 主线程把图片交给名为 `RmbgWasmWorker` 的 **Web Worker**，推理不阻塞界面。
- Worker 里加载的是一份 Emscripten 编译的 WASM 运行时。产物里有 **4 份 wasm**，
  按「是否支持 SIMD × 是否支持多线程」组合，运行时探测能力后挑一份
  （页面会把结果显示成 `[Instruction, Multi-Core]` 这样的加速标签存进 sessionStorage）。
  从二进制里的符号看，运行时带 **XNNPACK**（卷积算子库）与 pthread。
- Worker 与主线程之间是结构化消息 + **Transferable**（`ImageData.data.buffer` 直接转移，
  不复制）：`{cmd:"Init"}`、`{cmd:"predict", width, height, data, params}`、
  `{cmd:"predictHarm"}`、`{cmd:"edgeEnhance"}`；回程是 `predictFinish` /
  `edgeEnhanceFinish` / `error`，外加 `progressCB` 进度回调。

### 3. 权重：两个不可读的 blob

- 权重是**运行时才下的两个文件**（约 11.2MB 的 `Rmbg` 与 8.7MB 的 `Harm`），
  XHR 带进度条（进度上限常量 1657）。名字带哈希、扩展名 `.tf`。
- 两个文件熵接近 8 bit/byte、开头没有 ONNX protobuf 的特征，是**自家封装的格式**
  （即权重被加密/编码过），由 Worker 读进 `Uint8Array` 后经 `__malloc` 交给 WASM
  侧的 `setParams(ptr, len)` 解析。也就是说：**模型结构写在 C++ 侧，权重只是数据**。
- `Harm` 是第二个模型，对应界面上的 "AI 调色"（把抠出来的人像与新背景做**和谐化**，
  让光照/色调一致）——这是它相对普通抠图工具多出来的一步。

### 4. 分辨率分层

界面里有 `FullSize` 概念，且这条路径**要求一个 id token**（`getIdToken()`）。
也就是说免费/未登录拿到的是降采样结果，全分辨率要账号。
配合"评价这次结果 / 是否愿意捐赠此图片帮助我们优化"的流程，构成了它的数据闭环。

### 5. 编辑能力（都是纯前端画布操作，不再跑模型）

去背景（`Rmbg`）、换背景（纯色 / 渐变 / 证件照 / 调色板）、编辑（擦除[E] / 复原[R] /
调整[A]）、尺寸形状（圆形 / 方形 / 水平 / 垂直 / 翻转 / 保持比例）、撤销重做、
滤镜（无 / 模糊 / 灰度 / 深褐，可分别作用于前景 / 背景 / 全部 + 强度）、
边缘优化（`edgeEnhance`，可取消）、AI 调色、保存。

关键点：**模型只跑一次，之后所有编辑都在画布上完成**。这是它手感跟手的原因，
也是任何抠图工具都得这么做的地方。

---

## 二、我们的实现

同样的路线（本地分割模型 + 一次推理 + 画布编辑），但有三处刻意不同。

### 1. 运行时：WASM 而不是原生绑定

`onnxruntime-web` 的 **WASM 后端，跑在主进程里**。

先试过 `onnxruntime-node`（N-API）：在 Bun 下确实能跑，且快得多 —— 320×320
一次 57ms，WASM 是 900ms，差 17 倍。放弃它的原因是打包：

- 一个包 **291MB**，因为里面塞了全平台运行时（darwin 43MB dylib、linux 44MB so、
  Windows 28MB dll + DirectML 18MB）；
- 它的 `bin/napi-v6/<平台>/libonnxruntime.so.1` 在载荷里的路径会越过
  `electrobun.config.ts` 的 **100 字符 tar 上限**，Linux / Windows 会直接构建失败。

WASM 一份 14MB 全平台通用、无原生绑定、路径短。900ms 对抠图这个场景完全够用
（BgSub 自己也是 WASM，它宣传的是"5 秒内"）。

两个打包上的坑（都在 `electrobun.config.ts` 的 copy 清单里注释了）：

- glue `.mjs` 与 `.wasm` **必须复制到 `bun/`**（主进程合成单个 `bun/index.js` 后
  `import.meta.dir` 就是那里），打包环境没有 `node_modules`；
- **不能依赖 ort 自己推导 glue 路径**：它在 Node 分支下直接返回 undefined，必须由
  我们显式喂 `env.wasm.wasmPaths.mjs`，它才会去 `import()` 那个 URL；`.wasm` 干脆
  自己读字节传给 `wasmBinary`，省掉一次 14MB 的 fetch。

### 2. 权重：用 Apache-2.0 的公开模型

不去碰 BgSub 那份加密封装（既没必要也不合适）。用 rembg 的 u2net 家族
（**Apache-2.0，可商用**），4 档可选，权重从 GitHub release / hf-mirror / HF 官方
三源轮换下载，带断点续传与进度：

| id | 大小 | 输入 | 档位 |
|---|---|---|---|
| `u2netp` | 4.5MB | 320 | 最快 |
| `silueta` | 44MB | 320 | **默认**，均衡 |
| `u2net` | 176MB | 320 | 高质量 |
| `isnet-general-use` | 178MB | 1024 | 最细 |

默认给 `silueta` 而不是最快的 `u2netp`：后者只有 4.5MB，发丝和半透明边缘会成块状，
抠图工具第一次用就出这种结果等于劝退。

注意 `inputSize` **不是可调参数**：导出图把 batch/height/width 写死了，喂别的尺寸
ONNX 会直接报 `Got invalid dimensions for input`。u2net 系固定 320（与图片本身多大
无关），isnet 系固定 1024。

### 3. 边缘优化：引导滤波，不是第二个模型

BgSub 的 `edgeEnhance` 走的是另一条模型路径。我们用**引导滤波**
（He et al.，`refineMask()`）：以原图灰度为导向图、模型掩膜为输入，在局部窗口内做
线性拟合后取均值 —— 窗口内方差大的地方（真实轮廓）几乎不糊，平坦区才被平均掉。

之所以需要这一步：模型输入固定 320×320，掩膜升采样回 4000px 的图必然是一圈厚过渡带。
引导滤波把边缘重新贴回原图的真实轮廓，这就是各家"边缘优化"按钮的实质。
可分离盒式滤波（滑动窗口，每像素 O(1)）保证全分辨率下也够快。强度 0/0.5/0.85 三档
在界面上暴露；过大会把模型本来判断对的半透明区域（纱、烟、玻璃）也切成硬边，
所以默认 0.5 而不是拉满。

### 4. 两段式：一次推理，编辑零成本

```
选图 → bgRemoveStageSource（收进 images/，拿到 iframe 可加载的 URL）
     → bgRemoveRun（跑模型）
         ↓ 返回 cutout（带 alpha 的 PNG）+ mask（灰度 PNG）
     → 之后换底色 / 擦除 / 复原全在小应用画布上做
```

`mask` 就是 alpha 平面：小应用把它读进 `ImageData`，笔刷直接改 alpha，
换底色只是重画底再 `destination-in` 合成一次。**笔刷不回去跑模型**，
所以涂抹是跟手的（这一点与 BgSub 一致）。

笔刷实现上的两个细节：
- 每次操作记成一个 `{x, y, r, shape, mode}`，撤销是"从原始掩膜重放剩余操作"
  而不是给每次涂抹存快照（后者在 4000×4000 上一次就是 64MB）；
- 落笔带 1px 覆盖度抗锯齿（`cov = r - dist + 0.5`），硬边看着才不毛。

### 5. 界面：升级现有小应用

`bg-remove` 小应用原本走**云端生图**（`image.edit`，让图像模型"重画"一张，
10 秒起步、要配厂商、返回不透明图、边缘不可控）。现在改为本地引擎，
所以它不再需要任何云端配置 —— 缺的只是权重，而权重就在这个页面里下载。
能力登记改成 `bgRemove` 且**永远 ready**（`bun/miniapps.ts`）：若按"权重已下载"
判定，没下过模型的用户会在应用中心就被拦在门外，而门里正是那个下载按钮。

新增的三条小应用动作：`bg.status` / `bg.download` / `bg.run`（`shared/miniapps.ts`
的动作清单是**唯一**的放行面，不能开"任意方法名透传"的口子）。

### 与 BgSub 的功能对照

| 能力 | BgSub | 我们 |
|---|---|---|
| 本地推理、不上传 | ✅ | ✅ |
| 多线程 / SIMD 加速 | ✅（4 份 wasm 按能力挑） | ⚠️ 单线程（Bun 主进程里没有浏览器 Worker 池） |
| 换背景：纯色 / 渐变 | ✅ | ✅ |
| 换背景：图片 | ✅ | ❌（换底色场景用不到，需要时用画布叠图） |
| 擦除 / 复原笔刷 | ✅（含形状与尺寸） | ✅（圆形 / 方形 + 尺寸） |
| 撤销 / 重做 | ✅ | ✅ |
| 边缘优化 | ✅（独立模型） | ✅（引导滤波，三档） |
| 滤镜（模糊 / 灰度 / 深褐） | ✅ | ❌ 未做 |
| AI 调色（前景与背景和谐化） | ✅（第二个模型） | ❌ 未做（本仓库有生图/修图能力，可作后续） |
| 全分辨率 | 🔒 要登录 | ✅ 直接给（可选 2048 / 原图） |
| 模型的许可 | 闭源、权重加密 | Apache-2.0，可商用 |

---

## 三、代码地图与扩展点

| 关注点 | 位置 |
|---|---|
| 引擎（模型清单 / 下载 / 推理 / 掩膜后处理） | `src/bun/bg-remove.ts` |
| 纯函数测试（掩膜归一化、盒式滤波、引导滤波） | `src/bun/bg-remove.test.ts` |
| 端到端冒烟（真下载 + 真推理 + 校验掩膜） | `scripts/bg-remove-smoke.ts` |
| RPC：`bgRemoveModels` / `bgRemoveDownloadModel` / `bgRemoveStageSource` / `bgRemoveRun` | `src/bun/rpc/index.ts` |
| 小应用动作 → RPC 的翻译 | `src/mainview/lib/miniapp-bridge.ts` |
| 界面（画布、笔刷、换底色） | `src/mainview/miniapps/bg-remove.html` |
| 运行时资源的打包 | `electrobun.config.ts`（glue `.mjs` + `.wasm` → `bun/`） |

加一个模型：往 `BG_MODELS` 里加一条（`file` / `bytes` / `inputSize` / `tier` / `license`），
`downloadBgModel` 的三源轮换与界面上的下载卡片会自动带上它。

加一条小应用能做的动作：必须先在 `src/shared/miniapps.ts` 的 `MiniAppAction` 里登记，
再在 `miniapp-bridge.ts` 里翻译成具体 RPC —— 两步都做才算放行。

### 已知取舍

- **单线程**：`ort.env.wasm.numThreads = 1`。ort 的多线程要 SharedArrayBuffer +
  Worker 池，Bun 主进程里没有浏览器那套 worker。要提速得把推理挪进 webview，
  或走 `onnxruntime-node` + 首次使用时下载运行时到 `engines/`。
- **掩膜只有 320×320**（u2net 系），高分辨率下细节靠引导滤波补，不是原生高分辨率
  matting（如 BiRefNet 那类）。想更细可以上 `isnet-general-use`（1024，但慢）。
- **不做云端**：所有推理在主进程，图片不出本机；需要"重画式"换背景（把主体放到
  另一个场景里）应继续用 `image.edit` 那条生成路线。
