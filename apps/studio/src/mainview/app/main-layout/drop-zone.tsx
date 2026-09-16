import { useState, useCallback, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UploadIcon, WifiOffIcon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Spinner } from "@ui/spinner";
import { useRouter } from "@/mainview/stores/router";
import { useT } from "@/mainview/stores/ui-lang";
import { MAX_UPLOAD_BYTES, formatUploadLimit } from "@/shared/uploads";

/** `File` → 纯 base64（去掉 data URL 前缀）。 */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

export function DropZone() {
  const t = useT();
  const setRoute = useRouter((s) => s.setRoute);
  const [isDragging, setIsDragging] = useState(false);
  const [uploadError, setUploadError] = useState<string>();
  const queryClient = useQueryClient();
  const navigatedRef = useRef(false);

  const { data: connectionData } = useQuery({
    queryKey: ["connection-status"],
    queryFn: () => rpcClient.checkConnection(undefined),
    refetchInterval: 30_000,
  });

  const connected = connectionData?.connected ?? false;

  const processAfterAdd = useCallback(
    async (id: number) => {
      await queryClient.invalidateQueries({ queryKey: ["documents"] });
      if (!navigatedRef.current) {
        navigatedRef.current = true;
        setRoute({ path: "document", id });
      }
      rpcClient.processDocument({ id }).then(() => {
        queryClient.invalidateQueries({ queryKey: ["documents"] });
      });
    },
    [queryClient],
  );

  const addByPath = useMutation({
    mutationFn: async (filePath: string) => {
      const { id, error } = await rpcClient.addDocument({ filePath });
      // 主进程只会接受"用户刚在对话框里选过"的路径（bun/dialog-paths.ts）：
      // 被拒时 id 是 -1，不能拿着它去跑后续处理。
      if (id < 0) throw new Error(error ?? t("ocr.drop.uploadFailed"));
      await processAfterAdd(id);
      return id;
    },
    onError: (e) => setUploadError(e instanceof Error ? e.message : String(e)),
    onSuccess: () => setUploadError(undefined),
  });

  const addByUpload = useMutation({
    mutationFn: async (file: File) => {
      // 体积先判、再读文件：RPC 是整条在内存里编解码 base64 的，超限时连编码都不该开始
      // （几百 MB 的逐字节拼串能把界面卡死几十秒，最后才失败）。上限见 shared/uploads.ts。
      if (file.size > MAX_UPLOAD_BYTES) {
        throw new Error(t("ocr.drop.tooLarge", { limit: formatUploadLimit() }));
      }
      // 用 FileReader 拿 base64：它是浏览器原生实现，比在主线程逐字节拼串 + btoa 快得多。
      const data = await readAsBase64(file);
      const { id, error } = await rpcClient.addDocumentByUpload({
        data,
        name: file.name,
        type: file.type,
      });
      if (id < 0 || (error && !id)) {
        throw new Error(error ?? t("ocr.drop.uploadFailed"));
      }
      await processAfterAdd(id);
      return id;
    },
    onError: (e) => setUploadError(e instanceof Error ? e.message : String(e)),
    onSuccess: () => setUploadError(undefined),
  });

  const openDialog = useMutation({
    mutationFn: async () => {
      const { paths } = await rpcClient.openFileDialog(undefined);
      if (!paths.length) return;
      navigatedRef.current = false;
      for (const p of paths) {
        await addByPath.mutateAsync(p);
      }
    },
  });

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      if (!connected) return;
      navigatedRef.current = false;

      const files = Array.from(e.dataTransfer.files);
      for (const file of files) {
        await addByUpload.mutateAsync(file);
      }
    },
    [addByUpload, connected],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleClick = useCallback(() => {
    if (connected && !addByPath.isPending && !addByUpload.isPending) {
      openDialog.mutate();
    }
  }, [connected, addByPath.isPending, addByUpload.isPending, openDialog]);

  const isProcessing = addByPath.isPending || addByUpload.isPending;

  return (
    <div className="relative flex min-h-0 flex-1 items-center justify-center p-6">
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={handleClick}
        className={`flex w-full max-w-sm select-none flex-col items-center gap-3 rounded-xl border-2 border-dashed px-6 py-12 text-center transition-colors ${
          !connected
            ? "border-muted-foreground/10"
            : isDragging
              ? "border-primary bg-primary/5"
              : "cursor-pointer border-muted-foreground/20 hover:border-muted-foreground/40"
        }`}
      >
        {!connected ? (
          <>
            <div className="flex size-11 items-center justify-center rounded-xl bg-destructive/10">
              <WifiOffIcon className="size-5 text-destructive" />
            </div>
            <div className="flex flex-col gap-0.5">
              <p className="text-xs font-medium">{t("ocr.drop.offline")}</p>
              <p className="text-[11px] text-muted-foreground">{t("ocr.drop.offlineDesc")}</p>
            </div>
          </>
        ) : isProcessing ? (
          <>
            <Spinner className="size-8 text-primary" />
            <div className="flex flex-col gap-0.5">
              <p className="text-xs font-medium">{t("ocr.drop.adding")}</p>
              <p className="text-[11px] text-muted-foreground">{t("ocr.drop.addingDesc")}</p>
            </div>
          </>
        ) : (
          <>
            <div className="flex size-11 items-center justify-center rounded-xl bg-muted">
              <UploadIcon className="size-5 text-muted-foreground" />
            </div>
            <div className="flex flex-col gap-0.5">
              <p className="text-xs font-medium">{t("ocr.dropTitle")}</p>
              <p className="text-[11px] text-muted-foreground">{t("ocr.dropDesc")}</p>
            </div>
            <p className="text-[11px] font-medium text-primary">{t("ocr.browse")}</p>
          </>
        )}
      </div>

      {/* 上传失败此前是"点了/拖了没反应"：`addByUpload` 没有 onError，也不显示 error。 */}
      {uploadError && (
        <p className="absolute bottom-6 max-w-sm text-center text-[11px] text-destructive">
          {uploadError}
        </p>
      )}
    </div>
  );
}
