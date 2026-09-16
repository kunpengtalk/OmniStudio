// 对话输入区：附件预览 + 多行输入 + 工具条（文件 / 图片 / 联网 / 知识库 / 模型 / 发送·停止）。
//
// 输入框的本地状态（草稿、附件、开关）全部收在这里；发送时只把「要发什么」交给上层，
// 上层负责写 store 与发 RPC。这样消息区与输入区不会互相读到对方的内部状态。
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowUpIcon,
  BookOpenIcon,
  CheckIcon,
  FileTextIcon,
  GlobeIcon,
  ImagePlusIcon,
  LibraryIcon,
  Loader2Icon,
  PaperclipIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { isRemoteClient } from "@lib/remote";
import { Button } from "@ui/button";
import { Textarea } from "@ui/textarea";
import { useChatStore } from "@stores/chat";
import { useT } from "@stores/ui-lang";
import { ModelPicker } from "@components/model-picker";
import { cn } from "@/mainview/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@ui/dialog";
import { useKbListQuery } from "../kb";

export type ChatAttachment = { ref: string; url: string };
export type ChatFileAttachment = { name: string; content: string };

export type ChatSendPayload = {
  content: string;
  images: string[];
  files: ChatFileAttachment[];
  search: boolean;
  kbIds: number[];
};

/** 知识库选择弹窗：多选，随消息发送做检索注入 + 引用溯源。 */
function KbPickerDialog({
  open,
  onOpenChange,
  selected,
  onChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selected: number[];
  onChange: (ids: number[]) => void;
}) {
  const t = useT();
  const listQuery = useKbListQuery();
  const kbs = listQuery.data?.kbs ?? [];

  const toggle = (id: number) => {
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("chat.kbPicker.title")}</DialogTitle>
          <DialogDescription>{t("chat.kbPicker.desc")}</DialogDescription>
        </DialogHeader>
        <div className="-mx-1 max-h-72 overflow-y-auto px-1">
          {listQuery.isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : kbs.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <LibraryIcon className="size-6 text-muted-foreground/60" />
              <p className="text-xs text-muted-foreground">{t("chat.kbPicker.empty")}</p>
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {kbs.map((kb) => {
                const active = selected.includes(kb.id);
                return (
                  <button
                    key={kb.id}
                    type="button"
                    onClick={() => toggle(kb.id)}
                    className={cn(
                      "flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors",
                      active
                        ? "border-primary/40 bg-primary/5"
                        : "hover:bg-muted/60",
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded border",
                        active ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40",
                      )}
                    >
                      {active && <CheckIcon className="size-3" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">{kb.name}</span>
                      <span className="block text-[10px] text-muted-foreground">
                        {t("kb.header.docs", { count: String(kb.docCount) })} ·{" "}
                        {kb.embeddingModel || t("kb.header.keywordOnly")}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <DialogFooter>
          {selected.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="mr-auto text-xs text-muted-foreground"
              onClick={() => onChange([])}
            >
              {t("chat.kbPicker.clear")}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t("common.done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ChatComposer({
  conversationId,
  streaming,
  sendPending,
  onSend,
  onStop,
  stopPending,
  notice,
}: {
  conversationId: number;
  streaming: boolean;
  sendPending: boolean;
  onSend: (payload: ChatSendPayload) => void;
  onStop: () => void;
  stopPending: boolean;
  /** 输入框上方的服务状态提示（由消息区根据服务状态计算后传入）。 */
  notice?: ReactNode;
}) {
  const t = useT();
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [fileAttachments, setFileAttachments] = useState<ChatFileAttachment[]>([]);
  const [webSearch, setWebSearch] = useState(false);
  const [kbIds, setKbIds] = useState<number[]>([]);
  const [kbPickerOpen, setKbPickerOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });
  const webSearchDefault = settingsQuery.data?.settings?.WEB_SEARCH_ENABLED === "1";

  // 联网检索开关的默认值跟随设置项（仅初始化一次，之后由用户在输入框里切换）。
  const webSearchDefaultRef = useRef(false);
  if (!webSearchDefaultRef.current && settingsQuery.isSuccess) {
    webSearchDefaultRef.current = true;
    setWebSearch(webSearchDefault);
  }

  // 切换会话时清掉待发附件：它们是上一个会话的上下文，跟过去会发错地方。
  useEffect(() => {
    setAttachments([]);
    setFileAttachments([]);
  }, [conversationId]);

  const autoResize = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  };

  // 提示词库「去试试」带入的草稿：挂载到会话时预填输入框。
  const pendingPrompt = useChatStore((s) => s.pendingPrompt);
  useEffect(() => {
    if (!pendingPrompt) return;
    setInput(pendingPrompt);
    useChatStore.getState().setPendingPrompt(null);
    requestAnimationFrame(autoResize);
  }, [pendingPrompt]);

  const attachMutation = useMutation({
    mutationFn: async () => {
      const { paths } = await rpcClient.openFileDialog({
        allowedFileTypes: "png,jpg,jpeg,webp,gif,bmp",
      });
      if (paths.length === 0) return;
      const { images } = await rpcClient.stageChatImages({ conversationId, paths });
      setAttachments((prev) => [...prev, ...images]);
    },
  });

  const attachFileMutation = useMutation({
    mutationFn: async () => {
      const { paths } = await rpcClient.openFileDialog({
        allowedFileTypes:
          "txt,md,markdown,json,csv,tsv,log,xml,yml,yaml,html,htm,js,jsx,ts,tsx,mjs,cjs,css,scss,less,py,rb,rs,go,java,kt,swift,c,h,cpp,hpp,cs,php,sh,bash,zsh,toml,ini,cfg,conf,sql,vue,svelte,graphql,proto",
      });
      if (paths.length === 0) return;
      const { files } = await rpcClient.stageChatFiles({ conversationId, paths });
      setFileAttachments((prev) => {
        const known = new Set(prev.map((f) => f.name));
        return [...prev, ...files.filter((f) => !known.has(f.name))];
      });
    },
  });

  const removeAttachment = async (attachment: ChatAttachment) => {
    setAttachments((prev) => prev.filter((a) => a.ref !== attachment.ref));
    try {
      await rpcClient.discardChatImage({ ref: attachment.ref });
    } catch {
      // ignore cleanup failures
    }
  };

  const handleSend = () => {
    const content = input.trim();
    const images = attachments.map((a) => a.ref);
    const files = fileAttachments;
    if ((!content && images.length === 0 && files.length === 0) || streaming) return;
    setInput("");
    setAttachments([]);
    setFileAttachments([]);
    requestAnimationFrame(autoResize);
    onSend({ content, images, files, search: webSearch, kbIds });
  };

  const canSend =
    (input.trim().length > 0 || attachments.length > 0 || fileAttachments.length > 0) &&
    !streaming;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
      {notice}

      {/* 大卡片式输入框：上方附件预览 + 多行输入区 + 底部工具条 */}
      <div
        className={cn(
          "flex flex-col rounded-2xl border bg-card shadow-sm transition-colors",
          "focus-within:border-primary/40 focus-within:shadow-md",
        )}
      >
        {(attachments.length > 0 || fileAttachments.length > 0) && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {attachments.map((a) => (
              <div key={a.ref} className="group relative">
                <img
                  src={a.url}
                  alt=""
                  className="h-16 w-16 rounded-lg border object-cover"
                />
                <button
                  type="button"
                  onClick={() => removeAttachment(a)}
                  className="absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full bg-destructive text-destructive-foreground opacity-0 transition-opacity group-hover:opacity-100"
                  title={t("chat.removeAttachment")}
                >
                  <XIcon className="size-3" />
                </button>
              </div>
            ))}
            {fileAttachments.map((f) => (
              <div
                key={f.name}
                className="group relative flex max-w-52 items-center gap-1.5 rounded-lg border bg-muted/50 px-2 py-1.5"
              >
                <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate text-xs">{f.name}</span>
                <button
                  type="button"
                  onClick={() =>
                    setFileAttachments((prev) => prev.filter((x) => x.name !== f.name))
                  }
                  className="absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full bg-destructive text-destructive-foreground opacity-0 transition-opacity group-hover:opacity-100"
                  title={t("chat.removeAttachment")}
                >
                  <XIcon className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        <Textarea
          ref={textareaRef}
          placeholder={t("chat.inputPlaceholder")}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            autoResize();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          className="max-h-56 min-h-16 resize-none border-none bg-transparent px-4 pt-3.5 text-[0.9rem] shadow-none focus-visible:ring-0 dark:bg-transparent"
          rows={2}
        />

        <div className="flex items-center gap-0.5 px-2.5 pb-2.5">
          {/* 附件要开宿主机的原生文件对话框 —— 网页端（/chat）没有这条通道，
              按钮先不显示，免得点了没反应。浏览器直传附件是后续单独的一件事。 */}
          {!isRemoteClient() && (
            <>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                tooltip={t("chat.attachFile")}
                onClick={() => attachFileMutation.mutate()}
                disabled={streaming || attachFileMutation.isPending}
              >
                {attachFileMutation.isPending ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : (
                  <PaperclipIcon className="size-4" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                tooltip={t("chat.attachImage")}
                onClick={() => attachMutation.mutate()}
                disabled={streaming || attachMutation.isPending}
              >
                {attachMutation.isPending ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : (
                  <ImagePlusIcon className="size-4" />
                )}
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-pressed={webSearch}
            className={cn(
              webSearch
                ? "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary"
                : "text-muted-foreground",
            )}
            tooltip={webSearch ? t("chat.webSearchOn") : t("chat.webSearchOff")}
            onClick={() => setWebSearch((v) => !v)}
            disabled={streaming}
          >
            <GlobeIcon className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-pressed={kbIds.length > 0}
            className={cn(
              kbIds.length > 0
                ? "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary"
                : "text-muted-foreground",
            )}
            tooltip={t("chat.kb")}
            onClick={() => setKbPickerOpen(true)}
            disabled={streaming}
          >
            <BookOpenIcon className="size-4" />
            {kbIds.length > 0 && (
              <span className="ml-0.5 font-mono text-[10px] tabular-nums">{kbIds.length}</span>
            )}
          </Button>

          <div className="ml-auto flex min-w-0 items-center gap-1.5">
            <ModelPicker disabled={streaming} />
            {/* 生成中：发送键变「停止」。本地模型一轮能跑几分钟，以前唯一的出路是等
                600s 超时或重启（Agent 页一直有停止，这里补齐同一件事）。 */}
            {streaming ? (
              <Button
                variant="outline"
                size="icon-lg"
                className="shrink-0 rounded-full"
                tooltip={t("chat.stop")}
                onClick={onStop}
                disabled={stopPending}
              >
                <SquareIcon className="size-4" />
              </Button>
            ) : (
              <Button
                variant="default"
                size="icon-lg"
                className="shrink-0 rounded-full"
                tooltip={`${t("chat.send")} · ${t("chat.enterHint")}`}
                onClick={handleSend}
                disabled={!canSend || sendPending}
              >
                {sendPending ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : (
                  <ArrowUpIcon className="size-4" />
                )}
              </Button>
            )}
          </div>
        </div>
      </div>

      <KbPickerDialog
        open={kbPickerOpen}
        onOpenChange={setKbPickerOpen}
        selected={kbIds}
        onChange={setKbIds}
      />
    </div>
  );
}
