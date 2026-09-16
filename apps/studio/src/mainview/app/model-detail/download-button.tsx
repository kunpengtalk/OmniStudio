import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DownloadIcon, CheckCircle2Icon, Loader2Icon } from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Badge } from "@ui/badge";
import { useT } from "@stores/ui-lang";
import { MODEL_SOURCE_META, fileBaseName, type MarketFile, type ModelSource } from "../../../shared/modelscope";
import { installedFileNames } from "@/mainview/lib/installed-models";
import { sortBySizeAsc } from "./parts";

export function DownloadRecommendedButton({
  repo,
  file,
  source,
  category,
  repoFiles,
}: {
  repo: string;
  file: MarketFile;
  source: ModelSource;
  category: import("../../../shared/modelscope").ModelCategory | null;
  /** 非 GGUF：整仓库一起下（分片 + config/tokenizer），否则引擎加载不了。 */
  repoFiles: MarketFile[];
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const installed = useQuery({
    queryKey: ["installed-models"],
    queryFn: () => rpcClient.listInstalledModels(),
  });
  const installedNames = installedFileNames(installed.data?.models ?? []);

  const singleFile = file.kind === "gguf";
  const targets = singleFile ? [file] : repoFiles.length > 0 ? repoFiles : [file];
  const isInstalled = targets.every((f) => installedNames.has(fileBaseName(f.name)));

  const mutation = useMutation({
    mutationFn: async () => {
      for (const f of sortBySizeAsc(targets)) {
        await rpcClient.startModelDownload({
          repo,
          fileName: f.name,
          category: category ?? undefined,
          source,
          size: f.size,
        });
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["model-downloads"] }),
  });

  if (isInstalled) {
    return (
      <Badge variant="default" className="h-8 gap-1.5 px-3 text-xs">
        <CheckCircle2Icon className="size-4" />
        {t("models.downloaded")} · {singleFile ? file.name : repo}
      </Badge>
    );
  }

  return (
    <Button size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
      {mutation.isPending ? (
        <Loader2Icon data-icon="inline-start" className="animate-spin" />
      ) : (
        <DownloadIcon data-icon="inline-start" />
      )}
      {singleFile
        ? `${t("market.downloadFrom", { source: MODEL_SOURCE_META[source].label })} · ${file.name}`
        : t("models.downloadRepoSet", { count: String(targets.length) })}
    </Button>
  );
}
