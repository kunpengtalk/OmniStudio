import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { rpcClient } from "./rpc";
import type { InferenceEngine } from "../../shared/modelscope";

/**
 * Read the active inference engine from settings and switch it.
 * Shares the ["settings"] query key with the rest of the app, so the
 * selector here and the one in Settings stay in sync.
 */
export function useEngine() {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });

  const engine = (data?.settings.INFERENCE_ENGINE ?? "llama.cpp") as InferenceEngine;

  const saveMutation = useMutation({
    mutationFn: (next: InferenceEngine) =>
      rpcClient.updateSettings({ settings: { INFERENCE_ENGINE: next } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
  });

  return {
    engine,
    isSaving: saveMutation.isPending,
    setEngine: (next: InferenceEngine) => saveMutation.mutate(next),
  };
}
