import { useState, useCallback, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UploadIcon, WifiOffIcon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Spinner } from "@ui/spinner";
import { useRouter } from "@/mainview/stores/router";

export function DropZone() {
  const setRoute = useRouter((s) => s.setRoute);
  const [isDragging, setIsDragging] = useState(false);
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
      const { id } = await rpcClient.addDocument({ filePath });
      await processAfterAdd(id);
      return id;
    },
  });

  const addByUpload = useMutation({
    mutationFn: async (file: File) => {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
      const data = btoa(binary);
      const { id } = await rpcClient.addDocumentByUpload({
        data,
        name: file.name,
        type: file.type,
      });
      await processAfterAdd(id);
      return id;
    },
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
    <div className="flex flex-1 flex-col">
      <div className="flex flex-1 items-center justify-center p-6 pt-0">
        <div
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onClick={handleClick}
          className={`flex w-full max-w-sm flex-col items-center gap-3 rounded-xl border-2 border-dashed px-6 py-12 text-center transition-colors ${
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
                <p className="text-xs font-medium">Server not connected</p>
                <p className="text-[11px] text-muted-foreground">
                  Connect to a vLLM server to start uploading documents
                </p>
              </div>
            </>
          ) : isProcessing ? (
            <>
              <Spinner className="size-8 text-primary" />
              <div className="flex flex-col gap-0.5">
                <p className="text-xs font-medium">Adding documents…</p>
                <p className="text-[11px] text-muted-foreground">
                  Files are being queued for processing
                </p>
              </div>
            </>
          ) : (
            <>
              <div className="flex size-11 items-center justify-center rounded-xl bg-muted">
                <UploadIcon className="size-5 text-muted-foreground" />
              </div>
              <div className="flex flex-col gap-0.5">
                <p className="text-xs font-medium">Drop PDFs or images here</p>
                <p className="text-[11px] text-muted-foreground">
                  Supports PDF, PNG, JPG, WebP, TIFF, BMP, HEIC
                </p>
              </div>
              <p className="text-[11px] font-medium text-primary">Click to browse files</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
