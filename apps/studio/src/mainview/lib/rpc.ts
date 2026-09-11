import { Electroview } from "electrobun/view";
import type { AppRPC } from "../../bun/rpc";
import { queryClient } from "../components/providers";
import { useUpdateStore } from "./update-store";
import { useServerStore } from "../stores/server";
import { useChatStore } from "../stores/chat";
import { useAgentStore } from "../stores/agent";
import { useVoiceCallStore } from "../stores/voice-call";
import { useModelDownloadStore } from "../stores/model-download";
import { useGatewayStore } from "../stores/gateway";
import { useMlxInstallStore } from "../stores/mlx-install";
import { useMlxModelDownloadStore } from "../stores/mlx-model-download";
import { useMlxModelRunStore } from "../stores/mlx-model-run";
import { usePpOcrInstallStore } from "../stores/ppocr-install";
import { usePpOcrDownloadStore } from "../stores/ppocr-download";
import { useTessInstallStore } from "../stores/tess-install";
import { useRouter } from "../stores/router";

const knownCompletedIds = new Set<string>();

const rpc = Electroview.defineRPC<AppRPC>({
  // 大模型下载（MLX 本地生图可达 30+ GB）耗时可能远超普通请求，放宽上限到 60 分钟。
  maxRequestTime: 3_600_000,
  handlers: {
    requests: {},
    messages: {
      updateStatus: (updateState) => {
        useUpdateStore.getState().setUpdateState(updateState);
      },
      documentChanged: ({ id }) => {
        queryClient.invalidateQueries({ queryKey: ["document", id] });
        queryClient.invalidateQueries({ queryKey: ["documents"] });
      },
      serverLog: ({ text }) => {
        useServerStore.getState().appendLog(text);
      },
      serverStatusChanged: ({ status }) => {
        useServerStore.getState().setStatus(status);
      },
      chatChunk: ({ conversationId, messageId, delta, kind }) => {
        useChatStore.getState().appendChunk(conversationId, messageId, delta, kind ?? "content");
      },
      chatDone: ({ conversationId, messageId, content, reasoning, error }) => {
        useChatStore.getState().finalizeMessage(
          conversationId,
          messageId,
          content || (error ? `⚠️ ${error}` : ""),
          reasoning,
        );
        // Agent 的文本流也走这个通道：收尾时一并解除运行态。
        useAgentStore.getState().setRunning(false);
        queryClient.invalidateQueries({ queryKey: ["conversations"] });
        queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
      },
      chatStats: (stats) => {
        useChatStore.getState().setMessageStats(
          stats.conversationId,
          stats.messageId,
          stats,
        );
      },
      // Agent 运行轨迹：工具调用 / 状态 / 错误
      agentEvent: (event) => {
        useAgentStore.getState().appendEvent(event);
      },
      // 实时语音通话：增量字幕 / 定稿 / 阶段 / TTS 音频与打断
      voicecallPartial: ({ conversationId, text }) => {
        const vc = useVoiceCallStore.getState();
        if (vc.callConversationId !== conversationId) return;
        vc.setLiveText(text);
      },
      voicecallUtterance: ({ conversationId, messageId, text }) => {
        useVoiceCallStore.getState().commitUtterance(conversationId, messageId, text);
      },
      voicecallState: ({ conversationId, phase }) => {
        const vc = useVoiceCallStore.getState();
        if (vc.callConversationId !== conversationId) return;
        vc.setPhase(phase);
      },
      voicecallAudio: ({ conversationId, wavBase64, format }) => {
        useVoiceCallStore.getState().enqueueAudio({ conversationId, base64: wavBase64, format });
      },
      voicecallAudioStop: ({ conversationId }) => {
        const vc = useVoiceCallStore.getState();
        if (vc.callConversationId !== conversationId) return;
        vc.clearAudio();
      },
      voicecallError: ({ conversationId, message }) => {
        const vc = useVoiceCallStore.getState();
        if (vc.callConversationId !== conversationId) return;
        vc.setError(message);
        vc.setPhase("error");
      },
      modelDownloadProgress: ({ repo, fileName, progress }) => {
        useModelDownloadStore.getState().setProgress(repo, fileName, progress);
        queryClient.invalidateQueries({ queryKey: ["installed-models"] });
        queryClient.invalidateQueries({ queryKey: ["tts-local-models"] });
      },
      downloadsChanged: ({ tasks }) => {
        const store = useModelDownloadStore.getState();
        store.setTasks(tasks);
        for (const task of tasks) {
          if (task.status === "completed" && !knownCompletedIds.has(task.id)) {
            knownCompletedIds.add(task.id);
            queryClient.invalidateQueries({ queryKey: ["installed-models"] });
            queryClient.invalidateQueries({ queryKey: ["tts-local-models"] });
          }
        }
        const activeIds = new Set(tasks.map((t) => t.id));
        for (const id of knownCompletedIds) {
          if (!activeIds.has(id)) knownCompletedIds.delete(id);
        }
      },
      gatewayStatusChanged: ({ status }) => {
        useGatewayStore.getState().setStatus(status);
      },
      mlxInstallLog: ({ text }) => {
        useMlxInstallStore.getState().appendLog(text);
        // 安装完成（成功或失败）后刷新引擎状态；失败的日志形如「mflux 安装失败」。
        if (text.includes("安装成功") || text.includes("安装失败")) {
          queryClient.invalidateQueries({ queryKey: ["mlx-gen-status"] });
        }
      },
      mlxModelDownloadProgress: (p) => {
        useMlxModelDownloadStore.getState().setProgress(p);
        // 下载结束（成功/失败）后刷新「已下载模型」列表和「继续下载」状态，
        // UI 的下载按钮/徽章随之更新。
        if (p.stage !== "downloading") {
          queryClient.invalidateQueries({ queryKey: ["mlx-downloaded-models"] });
          queryClient.invalidateQueries({ queryKey: ["mlx-download-states"] });
        }
      },
      mlxGenPhase: (p) => {
        useMlxModelRunStore.getState().setPhase(p);
        // 阶段进入终态（已加载 / 空闲 / 出错）时刷新「已启动模型」查询。
        if (p.phase === "loaded" || p.phase === "idle" || p.phase === "error") {
          queryClient.invalidateQueries({ queryKey: ["mlx-active-model"] });
        }
      },
      ppOcrInstallLog: ({ text }) => {
        usePpOcrInstallStore.getState().appendLog(text);
        // 安装完成（成功或失败）后刷新引擎状态。
        if (text.includes("安装成功") || text.includes("安装失败")) {
          queryClient.invalidateQueries({ queryKey: ["ppocr-status"] });
        }
      },
      tesseractInstallLog: ({ text }) => {
        useTessInstallStore.getState().appendLog(text);
        // 安装完成（成功或失败）后刷新引擎状态。
        if (text.includes("安装成功") || text.includes("安装失败")) {
          queryClient.invalidateQueries({ queryKey: ["ocr-status"] });
        }
      },
      ppOcrPhase: ({ phase, message }) => {
        // 阶段进入终态（就绪 / 空闲 / 出错）时刷新引擎状态查询。
        if (phase === "ready" || phase === "idle" || phase === "error") {
          queryClient.invalidateQueries({ queryKey: ["ppocr-status"] });
        }
      },
      ppOcrModelProgress: ({ model, progress }) => {
        usePpOcrDownloadStore.getState().setProgress(model, progress);
        // 下载结束（100% 或取消）后刷新模型状态，进度条随之消失、徽章更新。
        if (progress.percent === 100 || progress.percent === null) {
          queryClient.invalidateQueries({ queryKey: ["ppocr-status"] });
        }
      },
      navigate: ({ path }) => {
        // 前端导航没有 URL 路由，全靠 router store；CLI 跳转只用到无参数路径。
        if (
          path === "models" ||
          path === "settings" ||
          path === "server" ||
          path === "stats" ||
          path === "chat" ||
          path === "index"
        ) {
          useRouter.getState().setRoute({ path });
        }
      },
    },
  },
});

const electrobun = new Electroview({ rpc });

export const rpcClient = electrobun.rpc!.request;
