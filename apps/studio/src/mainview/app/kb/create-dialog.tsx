// 新建知识库弹窗（侧栏「新建」与主页空状态共用，开关在 kb store）。
// 嵌入/重排模型可创建时就选（默认「不使用」），候选来自本地推理服务与云端配置。
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2Icon, PlusIcon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@ui/dialog";
import { Input } from "@ui/input";
import { Label } from "@ui/label";
import { Textarea } from "@ui/textarea";
import { useKbStore } from "@stores/kb";
import { useT } from "@stores/ui-lang";
import { KbModelSelect, useKbModelCandidates } from "./model-select";

export function KbCreateDialog() {
  const t = useT();
  const queryClient = useQueryClient();
  const open = useKbStore((s) => s.createOpen);
  const setOpen = useKbStore((s) => s.setCreateOpen);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [embeddingModel, setEmbeddingModel] = useState("");
  const [rerankModel, setRerankModel] = useState("");
  // 模态能力声明：勾选后该模态媒体文件走「媒体 + OCR 文本联合嵌入」入库。
  const [embedImage, setEmbedImage] = useState(false);
  const [embedAudio, setEmbedAudio] = useState(false);
  const [embedVideo, setEmbedVideo] = useState(false);

  // 探活全局默认嵌入配置（开窗后异步进行，弹窗照常秒开）：
  // configured/reachable 分离 —— 未配置 = 与今天一致；已配置但不可达 = 留空 + hint。
  // staleTime:0 + retry:false：每次开窗重新探活，探活失败也不重试打扰。
  const probe = useQuery({
    queryKey: ["kb-default-embed-probe"],
    queryFn: () => rpcClient.kbDefaultEmbeddingProbe(),
    enabled: open,
    staleTime: 0,
    retry: false,
  });

  // 弹窗常驻挂载（只有 DialogContent 卸载），state 会跨开合残留：
  // 每次开窗重置两个模型字段（探活预填从中接管）；name/description 的残留是既有行为，不动。
  // touchedRef：用户碰过嵌入下拉后，探活结果永不覆盖（含显式选「不使用」）。
  const touchedRef = useRef(false);
  useEffect(() => {
    if (open) {
      setEmbeddingModel("");
      setRerankModel("");
      setEmbedImage(false);
      setEmbedAudio(false);
      setEmbedVideo(false);
      touchedRef.current = false;
    }
  }, [open]);

  // 一次性预填：探活结论落定（!isFetching 避免重开时拿上一次的陈旧缓存数据预填）、
  // 可达且用户没碰过下拉时才填一次。用户已选（含「不使用」）时 touched 守卫直接否决。
  useEffect(() => {
    const d = probe.data;
    if (open && !probe.isFetching && d?.configured && d.reachable && d.model && !touchedRef.current) {
      setEmbeddingModel(d.model);
    }
  }, [probe.data, probe.isFetching, open]);

  // 弹窗打开时才拉模型候选（本地推理服务的 /v1/models + 设置里的云端模型）。
  const embedCandidates = useKbModelCandidates("embedding", "", "", open);
  const rerankCandidates = useKbModelCandidates("rerank", "", "", open);

  const createMutation = useMutation({
    mutationFn: () =>
      rpcClient.kbCreate({
        name,
        description,
        embeddingModel: embeddingModel || undefined,
        rerankModel: rerankModel || undefined,
        embedImage,
        embedAudio,
        embedVideo,
      }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["kb-list"] });
      useKbStore.getState().setSelectedKbId(data.kb.id);
      setOpen(false);
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setOpen(false);
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("kb.create.title")}</DialogTitle>
          <DialogDescription>{t("kb.create.desc")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-1">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="kb-name">{t("kb.create.name")}</Label>
            <Input
              id="kb-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("kb.create.namePlaceholder")}
              autoFocus
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="kb-desc">{t("kb.create.descLabel")}</Label>
            <Textarea
              id="kb-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("kb.create.descPlaceholder")}
              rows={2}
              className="resize-none"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="kb-embed-select">{t("kb.create.embedding")}</Label>
            <KbModelSelect
              id="kb-embed-select"
              value={embeddingModel}
              onChange={(model) => {
                // 用户主权：碰过下拉 = 字段被用户掌管，探活预填不再接管。
                touchedRef.current = true;
                setEmbeddingModel(model);
              }}
              candidates={embedCandidates.data}
              loading={embedCandidates.isLoading}
            />
            <p className="text-[10px] leading-4 text-muted-foreground/80">
              {t("kb.create.embeddingHint")}
            </p>
            {probe.data?.configured && !probe.data.reachable && !probe.isFetching && (
              <p className="text-[10px] leading-4 text-muted-foreground/80">
                {t("kb.create.embeddingDefaultUnreachable", { model: probe.data.model })}
              </p>
            )}
          </div>
          {/* 模态能力勾选：勾选后对应模态的媒体文件导入时走「媒体 + OCR 文本联合嵌入」
              （声明式能力，首次导入失败即暴露；设置页可改）。语音/视频本地暂不支持，
              勾选旁给静态 hint 指向远程嵌入服务，零逻辑。 */}
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
              <label className="flex cursor-pointer items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  className="size-3.5 accent-primary"
                  checked={embedImage}
                  onChange={(e) => setEmbedImage(e.target.checked)}
                />
                {t("kb.create.embedImage")}
              </label>
              <label className="flex cursor-pointer items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  className="size-3.5 accent-primary"
                  checked={embedAudio}
                  onChange={(e) => setEmbedAudio(e.target.checked)}
                />
                {t("kb.create.embedAudio")}
              </label>
              <label className="flex cursor-pointer items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  className="size-3.5 accent-primary"
                  checked={embedVideo}
                  onChange={(e) => setEmbedVideo(e.target.checked)}
                />
                {t("kb.create.embedVideo")}
              </label>
            </div>
            <p className="text-[10px] leading-4 text-muted-foreground/80">
              {t("kb.create.embedLocalOnlyHint")}
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="kb-rerank-select">{t("kb.create.rerank")}</Label>
            <KbModelSelect
              id="kb-rerank-select"
              value={rerankModel}
              onChange={setRerankModel}
              candidates={rerankCandidates.data}
              loading={rerankCandidates.isLoading}
            />
            <p className="text-[10px] leading-4 text-muted-foreground/80">
              {t("kb.create.rerankHint")}
            </p>
          </div>
        </div>
        {/* 创建失败必须可见：mutation 曾只有 onSuccess，RPC 拒绝时界面零反馈（线上
            「点击新建无响应」的直接帮凶）。 */}
        {createMutation.isError && (
          <p className="text-xs leading-4 text-destructive">
            {t("kb.create.error", {
              message:
                createMutation.error instanceof Error
                  ? createMutation.error.message
                  : String(createMutation.error),
            })}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            size="sm"
            disabled={!name.trim() || createMutation.isPending}
            onClick={() => createMutation.mutate()}
          >
            {createMutation.isPending ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <PlusIcon className="size-3.5" />
            )}
            {t("kb.create.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
