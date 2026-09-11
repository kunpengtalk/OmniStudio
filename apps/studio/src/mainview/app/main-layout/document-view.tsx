import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeftIcon,
  FileTextIcon,
  Loader2Icon,
  XCircleIcon,
  RefreshCwIcon,
  CopyIcon,
  CheckIcon,
  TrashIcon,
  FileIcon,
  FolderOpenIcon,
  AlertTriangleIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { rpcClient } from "@lib/rpc";
import { formatRaw, formatSize, friendlyType, getRawLanguage, formatDuration } from "@lib/format";
import { Badge } from "@ui/badge";
import { Button } from "@ui/button";
import { ScrollArea } from "@ui/scroll-area";
import { Skeleton } from "@ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/tabs";
import { Markdown } from "@components/markdown";

import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/ai-elements/code-block";
import {
  StackTrace,
  StackTraceHeader,
  StackTraceError,
  StackTraceErrorType,
  StackTraceErrorMessage,
  StackTraceActions,
  StackTraceCopyButton,
  StackTraceExpandButton,
  StackTraceContent,
  StackTraceFrames,
} from "@/components/ai-elements/stack-trace";
import { useRouter } from "@stores/router";

function useElapsedTime(startMs: number | null | undefined, active: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active || !startMs) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active, startMs]);
  if (!startMs) return null;
  return now - startMs;
}

export function DocumentView({ id: documentId }: { id: number }) {
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState("markdown");
  const setRoute = useRouter((s) => s.setRoute);

  const { data, isLoading } = useQuery({
    queryKey: ["document", documentId],
    queryFn: () => rpcClient.getDocument({ id: documentId }),
  });

  const retryMutation = useMutation({
    mutationFn: async () => {
      await rpcClient.processDocument({ id: documentId });
      queryClient.invalidateQueries({ queryKey: ["document", documentId] });
      queryClient.invalidateQueries({ queryKey: ["documents"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      await rpcClient.deleteDocument({ id: documentId });
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      setRoute({ path: "index" });
    },
  });

  const doc = data?.document;

  const liveElapsed = useElapsedTime(
    doc?.processingStartedAt,
    doc?.status === "processing",
  );

  const completedPages = useMemo(
    () => doc?.pages?.filter((p) => p.status === "completed") ?? [],
    [doc?.pages],
  );

  const allMarkdown = useMemo(() => {
    if (!completedPages.length) return "";
    if (completedPages.length === 1) return completedPages[0]!.markdown ?? "";
    return completedPages
      .map((p) => `${p.markdown ?? ""}\n\nPage ${p.pageNumber + 1}\n\n---`)
      .join("\n\n");
  }, [completedPages]);

  const allRaw = useMemo(() => {
    if (!completedPages.length) return "";
    return completedPages.map((p) => p.raw ?? "").join("\n\n<!-- page break -->\n\n");
  }, [completedPages]);

  const rawLanguage = useMemo(() => getRawLanguage(allRaw), [allRaw]);

  const markdownAvailable = useMemo(
    () => completedPages.some((p) => p.markdown?.trim()),
    [completedPages],
  );
  // raw 为空（如纯文本识别记录）时禁用 Raw/HTML 页签，避免点开一片空白。
  const rawAvailable = useMemo(
    () => completedPages.some((p) => p.raw?.trim()),
    [completedPages],
  );

  // Auto-switch to raw tab when markdown is unavailable (raw-only mode)
  const effectiveTab = !markdownAvailable && tab === "markdown" ? "html" : tab;

  if (isLoading) {
    return (
      <div className="flex flex-1 flex-col gap-3 p-5">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!doc) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        Document not found
      </div>
    );
  }

  const handleCopy = async () => {
    const content = effectiveTab === "markdown" ? allMarkdown : allRaw;
    if (content) {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const hasContent = completedPages.length > 0;
  const isStillProcessing = doc.status === "processing" || doc.status === "pending";
  const failedPages = doc?.pages?.filter((p) => p.status === "failed") ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex max-w-full items-center justify-between gap-2 border-b px-3 pb-1.5">
        <div className="flex min-w-0 items-center gap-2">
          {/* 返回上一个界面（OCR 识别页等）；route "chat" 会按当前 activeApp 渲染。 */}
          <Button
            variant="ghost"
            size="icon-sm"
            className="shrink-0"
            onClick={() => setRoute({ path: "chat" })}
            tooltip="Back"
          >
            <ChevronLeftIcon />
          </Button>
          <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-xs font-medium">{doc.name}</span>
          <Badge
            className="electrobun-webkit-app-region-no-drag text-[10px]"
            variant={
              doc.status === "completed"
                ? "default"
                : doc.status === "failed"
                  ? "destructive"
                  : "secondary"
            }
          >
            {doc.status}
          </Badge>

          <span className="shrink-0 text-[11px] text-muted-foreground">
            {friendlyType(doc.type)} · {formatSize(doc.size)}
            {doc.status === "processing" && liveElapsed != null && ` · ${formatDuration(liveElapsed)}`}
            {doc.status === "completed" && doc.completedAt && doc.processingStartedAt &&
              ` · ${formatDuration(doc.completedAt - doc.processingStartedAt)}`}
            {doc.status === "failed" && doc.failedAt && doc.processingStartedAt &&
              ` · ${formatDuration(doc.failedAt - doc.processingStartedAt)}`}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {hasContent && (
            <Button variant="ghost" size="icon-sm" onClick={handleCopy} tooltip="Copy to clipboard">
              {copied ? <CheckIcon /> : <CopyIcon />}
            </Button>
          )}

          {(doc.status === "failed" || doc.status === "completed") && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => retryMutation.mutate()}
              disabled={retryMutation.isPending}
              tooltip="Retry processing"
            >
              <RefreshCwIcon className={retryMutation.isPending ? "animate-spin" : ""} />
            </Button>
          )}

          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => rpcClient.showInExplorer({ filePath: doc.path })}
            tooltip="Show in file explorer"
          >
            <FolderOpenIcon />
          </Button>

          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => deleteMutation.mutate()}
            disabled={deleteMutation.isPending}
            tooltip="Delete document"
          >
            <TrashIcon />
          </Button>
        </div>
      </div>

      {doc.status === "failed" && !hasContent ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6">
          <XCircleIcon className="size-7 text-destructive" />
          <div className="flex flex-col items-center gap-0.5">
            <p className="text-xs font-medium">Processing failed</p>
            <p className="text-[11px] text-muted-foreground">
              Check your vLLM server connection and try again
            </p>
          </div>
          {doc.error && (
            <StackTrace trace={doc.error} className="w-full max-w-lg text-xs">
              <StackTraceHeader>
                <StackTraceError>
                  <StackTraceErrorType />
                  <StackTraceErrorMessage />
                </StackTraceError>
                <StackTraceActions>
                  <StackTraceCopyButton />
                  <StackTraceExpandButton />
                </StackTraceActions>
              </StackTraceHeader>
              <StackTraceContent>
                <StackTraceFrames showInternalFrames={false} />
              </StackTraceContent>
            </StackTrace>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => retryMutation.mutate()}
            disabled={retryMutation.isPending}
          >
            <RefreshCwIcon data-icon="inline-start" />
            Retry
          </Button>
        </div>
      ) : isStillProcessing && !hasContent ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2.5">
          <Loader2Icon className="size-7 animate-spin text-primary" />
          <div className="flex flex-col items-center gap-0.5">
            <p className="text-xs font-medium">
              {doc.status === "pending" ? "Queued for processing" : "Processing document…"}
            </p>
            {doc.status === "processing" && doc.totalPages && doc.totalPages > 0 ? (
              <p className="text-[11px] text-muted-foreground">
                Page {doc.processedPages ?? 0} of {doc.totalPages}
              </p>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                This may take a moment depending on document size
              </p>
            )}
          </div>
        </div>
      ) : (
        <Tabs value={effectiveTab} onValueChange={setTab} className="flex flex-1 flex-col overflow-hidden">
          {failedPages.length > 0 && (
            <div className="border-b px-3 py-2">
              <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2">
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0 text-destructive" />
                <div className="flex flex-col gap-1.5 overflow-hidden">
                  <p className="text-[11px] font-medium text-destructive">
                    {failedPages.length} page{failedPages.length > 1 ? "s" : ""} failed
                  </p>
                  {failedPages.map((p) =>
                    p.error ? (
                      <StackTrace key={p.pageNumber} trace={p.error} className="text-xs">
                        <StackTraceHeader>
                          <StackTraceError>
                            <span className="shrink-0 text-[11px] font-medium text-destructive">
                              Page {p.pageNumber + 1}
                            </span>
                            <StackTraceErrorMessage />
                          </StackTraceError>
                          <StackTraceActions>
                            <StackTraceCopyButton />
                            <StackTraceExpandButton />
                          </StackTraceActions>
                        </StackTraceHeader>
                        <StackTraceContent>
                          <StackTraceFrames showInternalFrames={false} />
                        </StackTraceContent>
                      </StackTrace>
                    ) : (
                      <p key={p.pageNumber} className="text-[11px] text-muted-foreground">
                        Page {p.pageNumber + 1} — unknown error
                      </p>
                    ),
                  )}
                </div>
              </div>
            </div>
          )}
          <div className="flex items-center justify-between border-b px-3 py-1.5">
            <TabsList>
              <TabsTrigger value="markdown" disabled={!markdownAvailable}>
                Markdown
              </TabsTrigger>
              <TabsTrigger value="html" disabled={!rawAvailable}>
                {rawLanguage === "html" ? "HTML" : "Raw"}
              </TabsTrigger>
            </TabsList>
            {isStillProcessing && doc.totalPages && doc.totalPages > 1 && (
              <Badge variant="secondary" className="gap-1.5 text-[10px]">
                <Loader2Icon className="size-3 animate-spin" />
                Processed {doc.processedPages ?? 0} / {doc.totalPages}
              </Badge>
            )}
          </div>
          <TabsContent value="markdown" className="mt-0 flex-1 overflow-hidden">
            <ScrollArea className="h-full">
              <div className="w-full min-w-0 overflow-hidden px-5 pt-4 pb-16">
                {completedPages.length === 1 ? (
                  <Markdown content={completedPages[0]!.markdown ?? ""} />
                ) : (
                  completedPages.map((p) => (
                    <div key={p.pageNumber}>
                      <Markdown content={p.markdown ?? ""} />
                      <div className="mx-auto max-w-3xl">
                        <p className="mt-6 text-center text-[11px] text-muted-foreground">
                          Page {p.pageNumber + 1}
                        </p>
                        <hr className="mt-1.5 mb-6 border-border" />
                      </div>
                    </div>
                  ))
                )}
              </div>
            </ScrollArea>
          </TabsContent>
          <TabsContent value="html" className="mt-0 flex-1 overflow-hidden">
            <ScrollArea className="h-full">
              <div className="px-4 pt-4 pb-16">
                <CodeBlock code={formatRaw(allRaw)} language={rawLanguage}>
                  <CodeBlockHeader>
                    <CodeBlockTitle>
                      <FileIcon size={14} />
                    </CodeBlockTitle>
                    <CodeBlockActions>
                      <CodeBlockCopyButton />
                    </CodeBlockActions>
                  </CodeBlockHeader>
                </CodeBlock>
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
