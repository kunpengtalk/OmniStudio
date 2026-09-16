import type { BenchmarkRecordRow, BenchmarkRunState, SpeedBenchRow } from "../../../bun/benchmark";
import type { EvalCategoryRow } from "../../../bun/eval";

export const WEIGHT_EXT_RE = /\.(gguf|safetensors|bin|pt|pth|ckpt|onnx|ggml)$/i;

export function fmtTime(ms: number) {
  const d = new Date(ms);
  const now = new Date();
  const md = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.getFullYear() === now.getFullYear() ? `${md} ${hm}` : `${d.getFullYear()}-${md} ${hm}`;
}

/** 一份可展示的测试结果：运行中任务或历史记录的统一视图。 */
export type DisplayResult = {
  source: "run" | "record";
  kind: "speed" | "eval";
  model: string;
  engine?: string | null;
  serverMode: string;
  status: BenchmarkRunState["status"];
  rows: SpeedBenchRow[];
  evalRows?: EvalCategoryRow[];
  eval?: BenchmarkRunState["eval"];
  summary?: BenchmarkRecordRow["summary"];
  params?: BenchmarkRecordRow["params"];
  createdAt: number;
  durationMs?: number | null;
  error?: string | null;
  progress?: BenchmarkRunState["progress"];
};

export function fmtMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
