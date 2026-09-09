import { Electroview } from "electrobun/view";
import type { AppRPC } from "../../bun/rpc";
import { queryClient } from "../components/providers";
import { useUpdateStore } from "./update-store";
import { useServerStore } from "../stores/server";
import { useChatStore } from "../stores/chat";
import { useModelDownloadStore } from "../stores/model-download";

const knownCompletedIds = new Set<string>();

const rpc = Electroview.defineRPC<AppRPC>({
  maxRequestTime: 600_000,
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
      chatChunk: ({ conversationId, messageId, delta }) => {
        useChatStore.getState().appendChunk(conversationId, messageId, delta);
      },
      chatDone: ({ conversationId, messageId, content, error }) => {
        useChatStore.getState().finalizeMessage(
          conversationId,
          messageId,
          content || (error ? `⚠️ ${error}` : ""),
        );
        queryClient.invalidateQueries({ queryKey: ["conversations"] });
        queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
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
    },
  },
});

const electrobun = new Electroview({ rpc });

export const rpcClient = electrobun.rpc!.request;
