import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2Icon } from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { Input } from "@ui/input";
import { Button } from "@ui/button";
import { Textarea } from "@ui/textarea";
import { Label } from "@ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@ui/dialog";
import { useT } from "@stores/ui-lang";
import { usePromptStore } from "@stores/prompt";
import { cn } from "@/mainview/lib/utils";
import { KINDS } from "./constants";
import type { PromptKind } from "../../../bun/prompt-library";

export function PromptEditDialog() {
  const t = useT();
  const queryClient = useQueryClient();
  const editor = usePromptStore((s) => s.editor);
  const closeEditor = usePromptStore((s) => s.closeEditor);
  const currentKind = usePromptStore((s) => s.kind);
  const isEdit = editor?.mode === "edit";

  const [kind, setKind] = useState<PromptKind>("image");
  const [category, setCategory] = useState("");
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [summary, setSummary] = useState("");
  const [ratio, setRatio] = useState("");

  useEffect(() => {
    if (!editor) return;
    if (editor.mode === "edit") {
      setKind(editor.item.kind);
      setCategory(editor.item.category === "未分类" ? "" : editor.item.category);
      setName(editor.item.name);
      setPrompt(editor.item.prompt);
      setSummary(editor.item.summary ?? "");
      setRatio(editor.item.ratio ?? "");
    } else {
      setKind(editor.kind ?? currentKind);
      setCategory("");
      setName("");
      setPrompt("");
      setSummary("");
      setRatio("");
    }
  }, [editor, currentKind]);

  const mutation = useMutation({
    mutationFn: async () => {
      if (editor?.mode === "edit") {
        return rpcClient.updateMyPrompt({
          id: editor.item.id,
          patch: { kind, category, name, prompt, summary, ratio },
        });
      }
      return rpcClient.createMyPrompt({ kind, category, name, prompt, summary, ratio });
    },
    onSuccess: () => {
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ["my-prompts"] }),
        queryClient.invalidateQueries({ queryKey: ["my-prompt-categories"] }),
        queryClient.invalidateQueries({ queryKey: ["my-prompt-stats"] }),
      ]);
      closeEditor();
    },
  });

  const canSave = name.trim().length > 0 && prompt.trim().length > 0;

  return (
    <Dialog open={!!editor} onOpenChange={(open) => !open && !mutation.isPending && closeEditor()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? t("prompt.edit") : t("prompt.new")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {/* 类型（大类型） */}
          <div className="flex items-center gap-3">
            <Label htmlFor="pe-kind" className="w-16 shrink-0 text-xs">
              {t("prompt.form.kind")}
            </Label>
            <div id="pe-kind" className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
              {KINDS.map((k) => (
                <button
                  key={k.kind}
                  type="button"
                  onClick={() => setKind(k.kind)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                    kind === k.kind
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {k.icon}
                  {t(k.labelKey)}
                </button>
              ))}
            </div>
          </div>

          {/* 分类（自定义） */}
          <div className="flex items-center gap-3">
            <Label htmlFor="pe-category" className="w-16 shrink-0 text-xs">
              {t("prompt.form.category")}
            </Label>
            <Input
              id="pe-category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder={t("prompt.form.categoryPlaceholder")}
              className="h-8 flex-1 text-xs"
            />
          </div>

          {/* 名称 */}
          <div className="flex items-center gap-3">
            <Label htmlFor="pe-name" className="w-16 shrink-0 text-xs">
              {t("prompt.form.name")}
            </Label>
            <Input
              id="pe-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("prompt.form.namePlaceholder")}
              className="h-8 flex-1 text-xs"
            />
          </div>

          {/* 简介 */}
          <div className="flex items-center gap-3">
            <Label htmlFor="pe-summary" className="w-16 shrink-0 text-xs">
              {t("prompt.form.summary")}
            </Label>
            <Input
              id="pe-summary"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder={t("prompt.form.summaryPlaceholder")}
              className="h-8 flex-1 text-xs"
            />
          </div>

          {/* 比例（图片/视频才有） */}
          {kind !== "llm" && (
            <div className="flex items-center gap-3">
              <Label htmlFor="pe-ratio" className="w-16 shrink-0 text-xs">
                {t("prompt.form.ratio")}
              </Label>
              <Input
                id="pe-ratio"
                value={ratio}
                onChange={(e) => setRatio(e.target.value)}
                placeholder={t("prompt.form.ratioPlaceholder")}
                className="h-8 flex-1 text-xs"
              />
            </div>
          )}

          {/* 提示词 */}
          <div className="flex gap-3">
            <Label htmlFor="pe-prompt" className="w-16 shrink-0 pt-1 text-xs">
              {t("prompt.form.prompt")}
            </Label>
            <Textarea
              id="pe-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={8}
              placeholder={t("prompt.form.promptPlaceholder")}
              className="min-h-0 flex-1 resize-none text-xs"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={closeEditor} disabled={mutation.isPending}>
            {t("prompt.cancel")}
          </Button>
          <Button size="sm" onClick={() => mutation.mutate()} disabled={!canSave || mutation.isPending}>
            {mutation.isPending ? (
              <Loader2Icon data-icon="inline-start" className="size-3.5 animate-spin" />
            ) : null}
            {t("prompt.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// 主界面
// ---------------------------------------------------------------------------

/** 滚动到底部自动加载更多（广场 / 我的 共用）。 */
