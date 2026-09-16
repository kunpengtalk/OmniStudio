import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Loader2Icon,
  PhoneIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { SingleToolEntry } from "@components/sidebar-parts";
import { Badge } from "@ui/badge";
import { Button } from "@ui/button";
import { ScrollArea } from "@ui/scroll-area";
import { Spinner } from "@ui/spinner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@ui/dialog";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@ui/sidebar";
import { Label } from "@ui/label";
import type { AppId } from "@stores/app";
import { useChatStore } from "@stores/chat";
import { useT } from "@stores/ui-lang";

/** 对话 / Agent / 通话三个应用共用的会话列表（标题与新建按钮按 app 微调）。 */
export function ConversationRecordList({ app }: { app: AppId }) {
  const queryClient = useQueryClient();
  const t = useT();
  const conversations = useChatStore((s) => s.conversations);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  useEffect(() => {
    const timeout = setTimeout(() => setDebouncedSearch(search), 200);
    return () => clearTimeout(timeout);
  }, [search]);

  const listQuery = useQuery({
    queryKey: ["conversations", app],
    queryFn: () => rpcClient.listConversations({ app }),
  });

  useEffect(() => {
    if (listQuery.data) {
      useChatStore.getState().setConversations(listQuery.data.conversations);
    }
  }, [listQuery.data]);

  const createMutation = useMutation({
    mutationFn: () => rpcClient.createConversation({ app }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      useChatStore.getState().upsertConversation(data.conversation);
      useChatStore.getState().setActiveConversation(data.conversation.id);
      useChatStore.getState().setActiveMessages([]);
    },
  });

  const pinMutation = useMutation({
    mutationFn: (id: number) => rpcClient.togglePinConversation({ id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["conversations", app] }),
  });
  const deleteMutation = useMutation({
    mutationFn: (id: number) => rpcClient.deleteConversation({ id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["conversations", app] }),
  });

  const needle = debouncedSearch.trim().toLowerCase();
  const filtered = needle
    ? conversations.filter((c) => c.title.toLowerCase().includes(needle))
    : conversations;

  const confirmDelete = confirmDeleteId != null
    ? conversations.find((c) => c.id === confirmDeleteId)
    : undefined;

  return (
    <SidebarGroup className="min-h-0 flex-1">
      {/* 单工具页的入口位：与其他工具页侧栏顶部入口对齐 */}
      {app === "voicecall" && (
        <SingleToolEntry icon={<PhoneIcon className="size-4" />} label={t("apps.voicecall")} />
      )}
      {/* 顶部一行：标题 + 浅色数量标识 + 新建对话按钮（最右侧，后面无数字） */}
      <SidebarGroupLabel>
        <span className="flex items-center gap-1.5">
          {app === "voicecall"
            ? t("voicecall.history")
            : app === "agent"
              ? t("agent.sessions")
              : t("chat.chats")}
          <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
            {conversations.length}
          </Badge>
        </span>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto h-6 shrink-0 gap-1 px-2 text-[11px]"
          onClick={() => createMutation.mutate()}
          disabled={createMutation.isPending}
        >
          {createMutation.isPending ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <PlusIcon className="size-3.5" />
          )}
          {t("chat.newChat")}
        </Button>
      </SidebarGroupLabel>

      {/* 搜索框 */}
      <SidebarGroupContent className="relative">
        <Label htmlFor="conversation-search" className="sr-only">
          {t("chat.search")}
        </Label>
        <SidebarInput
          id="conversation-search"
          placeholder={t("chat.search")}
          className="pl-8 h-7 text-xs"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 opacity-50 select-none" />
      </SidebarGroupContent>

      <ScrollArea className="min-h-0 flex-1">
        <SidebarMenu className="gap-0.5">
          {listQuery.isLoading ? (
            <div className="flex justify-center py-6">
              <Spinner className="size-3.5" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-6 text-center text-xs text-muted-foreground">
              {needle ? t("chat.noSearchResults") : t("chat.noConversations")}
            </div>
          ) : (
            filtered.map((c) => {
              const isActive = c.id === activeConversationId;
              return (
                <SidebarMenuItem key={c.id} className="group/conversation">
                  <SidebarMenuButton
                    isActive={isActive}
                    onClick={() => useChatStore.getState().setActiveConversation(c.id)}
                    tooltip={c.title}
                  >
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">
                      {c.title}
                    </span>
                    {!!c.pinned && (
                      <PinIcon className="size-3.5 shrink-0 fill-primary text-primary/70" />
                    )}
                    <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/conversation:opacity-100">
                      <button
                        type="button"
                        disabled={pinMutation.isPending}
                        onClick={(e) => {
                          e.stopPropagation();
                          pinMutation.mutate(c.id);
                        }}
                        title={c.pinned ? t("chat.unpin") : t("chat.pin")}
                        className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-primary"
                      >
                        {c.pinned ? (
                          <PinOffIcon className="size-3.5" />
                        ) : (
                          <PinIcon className="size-3.5" />
                        )}
                      </button>
                      <button
                        type="button"
                        disabled={deleteMutation.isPending}
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmDeleteId(c.id);
                        }}
                        title={t("chat.deleteConversation")}
                        className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-destructive"
                      >
                        <Trash2Icon className="size-3.5" />
                      </button>
                    </span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })
          )}
        </SidebarMenu>
      </ScrollArea>

      {confirmDelete && (
        <Dialog
          open={confirmDeleteId != null}
          onOpenChange={(open) => {
            if (!open) setConfirmDeleteId(null);
          }}
        >
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>{t("chat.deleteConversationConfirmTitle")}</DialogTitle>
              <DialogDescription>
                {t("chat.deleteConversationConfirmBody")}{" "}
                <span className="font-medium text-foreground">「{confirmDelete.title}」</span>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmDeleteId(null)}
              >
                {t("common.cancel")}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={deleteMutation.isPending}
                onClick={() => {
                  if (confirmDeleteId == null) return;
                  deleteMutation.mutate(confirmDeleteId, {
                    onSuccess: () => setConfirmDeleteId(null),
                  });
                }}
              >
                {deleteMutation.isPending ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  <Trash2Icon className="size-3.5" />
                )}
                {t("common.delete")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </SidebarGroup>
  );
}
