import {
  isModelWeightExt,
  type MarketFile,
  type MarketSearchResult,
  type SearchFormat,
} from "../shared/modelscope";

/**
 * HuggingFace 检索 / 列仓库文件。
 *
 * 与下载路径同策略：优先国内镜像 hf-mirror.com（API 与官方同构），失败回退
 * huggingface.co —— 官方域在国内多数网络下不可达，只用官方会让市场直接不可用。
 *
 * 格式过滤走平台自己的元数据维度（`?filter=gguf|safetensors|mlx`），
 * 不靠模型名做字符串判断：平台返回的 tags / siblings 就是权威来源。
 */
const HF_HOSTS = ["https://hf-mirror.com", "https://huggingface.co"] as const;

/** 依次尝试镜像与官方，返回第一个成功的结果；全部失败时抛出最后一个错误。 */
async function fetchFromHosts(
  buildUrl: (host: string) => string,
  init: RequestInit & { timeoutMs: number },
): Promise<unknown> {
  const { timeoutMs, ...rest } = init;
  let lastError: Error | null = null;
  for (const host of HF_HOSTS) {
    const url = buildUrl(host);
    try {
      const res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) {
        // 401/403/404/451：仓库私有、需要授权或不存在 —— 换域名结果一样，
        // 立刻抛出，不要再去打另一个域名白等一轮超时。
        if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 451) {
          throw new Error(`HuggingFace 返回 ${res.status}（${new URL(url).pathname}）`);
        }
        lastError = new Error(`HuggingFace API failed: ${res.status} (${host})`);
        continue;
      }
      return (await res.json()) as unknown;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      if (err.message.startsWith("HuggingFace 返回")) throw err;
      lastError = err;
    }
  }
  throw lastError ?? new Error("HuggingFace request failed");
}

type HfModel = {
  id?: string;
  modelId?: string;
  author?: string;
  downloads?: number;
  likes?: number;
  tags?: string[];
  pipeline_tag?: string | null;
  library_name?: string | null;
  private?: boolean;
  gated?: boolean | string;
  createdAt?: string;
  lastModified?: string;
  siblings?: Array<{ rfilename?: string }>;
};

/** 权重文件后缀 → 格式；只看真正的权重文件，config/README 不参与判断。 */
function weightFileFormat(name: string): SearchFormat | null {
  const n = name.toLowerCase();
  if (n.endsWith(".gguf") || n.endsWith(".ggml")) return "gguf";
  if (n.endsWith(".safetensors")) return "safetensors";
  return null;
}

function formatsOf(model: HfModel): SearchFormat[] {
  const tags = (model.tags ?? []).map((t) => t.toLowerCase());
  const formats = new Set<SearchFormat>();
  if (tags.includes("gguf") || model.library_name === "gguf") formats.add("gguf");
  if (tags.includes("mlx") || model.library_name === "mlx") formats.add("mlx");
  if (tags.includes("safetensors") || model.library_name === "safetensors") formats.add("safetensors");
  // siblings 是仓库里真实存在的文件清单，比标签更硬。
  for (const s of model.siblings ?? []) {
    const f = s.rfilename ? weightFileFormat(s.rfilename) : null;
    if (f) formats.add(f);
  }
  return (["gguf", "safetensors", "mlx"] as SearchFormat[]).filter((f) => formats.has(f));
}

function licenseOf(tags: string[]): string {
  const hit = tags.find((t) => t.toLowerCase().startsWith("license:"));
  return hit ? hit.slice("license:".length) : "";
}

/**
 * HF 搜索 URL。格式过滤走平台的 `filter` 参数（gguf / safetensors / mlx），
 * 由服务端过滤；分页用 `limit` + `skip`（HF 没有 offset/cursor，也没有总数）。
 * `full=true` 才会带上 siblings（仓库文件清单）：用它给出文件数并核对格式，
 * 20 条结果约 45KB，代价可接受。
 */
export function buildSearchUrl(
  host: string,
  query: string,
  page: number,
  pageSize: number,
  format?: SearchFormat,
): string {
  const params = new URLSearchParams({
    search: query,
    limit: String(pageSize),
    skip: String((page - 1) * pageSize),
    sort: "downloads",
    direction: "-1",
    full: "true",
  });
  if (format) params.append("filter", format);
  return `${host}/api/models?${params.toString()}`;
}

/**
 * 搜索 HuggingFace 模型。`format` 直接映射到平台的 `filter` 参数。
 *
 * 分页：HF 的 /api/models 只支持 `limit`/`skip`，也不返回总数，所以
 * `total` 只是"已取到的条数"下界（`totalExact: false`），是否还有更多由
 * `hasMore`（本页是否取满）回答，UI 据此显示"加载更多"而不是假的总数。
 */
export async function searchModels(
  query: string,
  page = 1,
  pageSize = 20,
  format?: SearchFormat,
): Promise<MarketSearchResult> {
  const body = await fetchFromHosts((host) => buildSearchUrl(host, query, page, pageSize, format), {
    timeoutMs: 20_000,
  });

  const list = Array.isArray(body) ? (body as HfModel[]) : [];
  const models = list
    // private 拿不到；gated 需要登录并接受协议，而下载链路没有 token，
    // 列出来只会让用户点了下载才撞 401 —— 直接不展示。
    .filter((m) => !m.private && !m.gated && m.id)
    .map((m) => {
      const tags = m.tags ?? [];
      return {
        id: m.id!,
        name: m.id!,
        description: "",
        downloads: m.downloads ?? 0,
        likes: m.likes ?? 0,
        license: licenseOf(tags),
        tasks: m.pipeline_tag ? [m.pipeline_tag] : [],
        tags,
        // HF 列表接口不返回仓库体积，留 0 让 UI 不显示体积（文件数用 siblings 给）。
        fileSize: 0,
        params: 0,
        createdAt: m.createdAt ?? "",
        lastModified: m.lastModified ?? "",
        source: "huggingface" as const,
        formats: formatsOf(m),
        fileCount: (m.siblings ?? []).filter((s) => !!s.rfilename).length,
      };
    });

  const total = (page - 1) * pageSize + models.length;
  return { models, total, totalExact: false, hasMore: models.length >= pageSize };
}

type HfTreeEntry = {
  type?: string;
  path?: string;
  size?: number;
  lfs?: { size?: number };
};

/** 仓库文件列表 URL：带 blobs=true 才返回体积，否则每项 size 都是 null。 */
export function buildTreeUrl(host: string, repo: string): string {
  return `${host}/api/models/${repo}/tree/main?recursive=true&blobs=true`;
}

/** 列出仓库文件（含体积）。走 tree 接口并带 blobs=true，否则大小是 null。 */
export async function listRepoFiles(repo: string): Promise<MarketFile[]> {
  const body = await fetchFromHosts((host) => buildTreeUrl(host, repo), { timeoutMs: 20_000 });

  const entries = Array.isArray(body) ? (body as HfTreeEntry[]) : [];
  return entries
    .filter((e) => e.type === "file" && !!e.path)
    .map((e) => {
      const name = e.path!;
      const lower = name.toLowerCase();
      return {
        name,
        path: name,
        size: e.lfs?.size ?? e.size ?? 0,
        isLfs: !!e.lfs,
        kind: lower.endsWith(".gguf") || lower.endsWith(".ggml")
          ? ("gguf" as const)
          : lower.endsWith(".safetensors")
            ? ("safetensors" as const)
            : ("other" as const),
        isWeight: isModelWeightExt(name),
      };
    })
    .sort((a, b) => (a.isWeight === b.isWeight ? b.size - a.size : a.isWeight ? -1 : 1));
}
