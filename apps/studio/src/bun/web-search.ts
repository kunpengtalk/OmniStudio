import { getSetting } from "./db/settings";

export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
};

export type WebSearchOutcome = {
  ok: boolean;
  provider: string;
  results: WebSearchResult[];
  error?: string;
};

/** 读取设置里的联网检索配置（provider / api key / max results）。 */
function getSearchConfig() {
  const provider = getSetting("WEB_SEARCH_PROVIDER") || "bing";
  const apiKey = getSetting("WEB_SEARCH_API_KEY") || "";
  const maxResults = Math.min(10, Math.max(1, Number(getSetting("WEB_SEARCH_MAX_RESULTS")) || 5));
  return { provider, apiKey, maxResults };
}

function decodeEntities(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&nbsp;|&ensp;|&emsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)));
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

/** 还原 DuckDuckGo 跳转链接（//duckduckgo.com/l/?uddg=<encoded>&…）里的真实 URL。 */
function resolveDdgHref(href: string): string {
  const match = href.match(/[?&]uddg=([^&]+)/);
  const encoded = match?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      // fall through
    }
  }
  return href.startsWith("//") ? `https:${href}` : href;
}

/**
 * Bing 网页搜索（国内可直连，无需 API Key；fetch 自动跟随到 cn.bing.com 的重定向）。
 * 解析结果页里 class="b_algo" 的每个结果块：h2>a 是标题+链接，p 是摘要。
 */
async function bingSearch(query: string, maxResults: number): Promise<WebSearchResult[]> {
  const res = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}`, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Bing HTTP ${res.status}`);
  const html = await res.text();

  const blockRe =
    /<li class="b_algo"[\s\S]*?<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/g;

  const results: WebSearchResult[] = [];
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(html)) && results.length < maxResults) {
    const url = decodeEntities(match[1] ?? "");
    const title = stripTags(match[2] ?? "");
    if (!title || !/^https?:\/\//.test(url)) continue;
    results.push({ title, url, snippet: stripTags(match[3] ?? "") });
  }
  return results;
}

/**
 * DuckDuckGo HTML 版搜索（无需 API Key）。
 * 解析 html.duckduckgo.com/html/ 返回的结果页：result__a 是标题+链接，result__snippet 是摘要。
 */
async function duckDuckGoSearch(query: string, maxResults: number): Promise<WebSearchResult[]> {
  const res = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    },
    body: new URLSearchParams({ q: query, kl: "wt-wt" }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);
  const html = await res.text();

  const anchors = [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  const snippets = [
    ...html.matchAll(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g),
  ];

  const results: WebSearchResult[] = [];
  for (let i = 0; i < anchors.length && results.length < maxResults; i++) {
    const anchor = anchors[i];
    const url = resolveDdgHref(anchor?.[1] ?? "");
    const title = stripTags(anchor?.[2] ?? "");
    if (!title || !/^https?:\/\//.test(url)) continue;
    const rawSnippet = snippets[i]?.[1];
    const snippet = rawSnippet ? stripTags(rawSnippet) : "";
    results.push({ title, url, snippet });
  }
  return results;
}

/** Tavily 搜索 API（需要免费申请的 API Key）。 */
async function tavilySearch(
  query: string,
  maxResults: number,
  apiKey: string,
): Promise<WebSearchResult[]> {
  if (!apiKey) throw new Error("Tavily API key is not configured");
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey, query, max_results: maxResults }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Tavily HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  const json = (await res.json()) as {
    results?: { title?: string; url?: string; content?: string }[];
  };
  return (json.results ?? [])
    .filter((r) => r.url)
    .slice(0, maxResults)
    .map((r) => ({
      title: r.title ?? r.url ?? "",
      url: r.url ?? "",
      snippet: r.content ?? "",
    }));
}

/**
 * 执行一次联网检索。opts 未提供的字段回落到设置项；
 * 失败时不抛异常，返回 ok: false + error，由调用方决定如何提示模型。
 */
export async function webSearch(
  query: string,
  opts?: { provider?: string; maxResults?: number; apiKey?: string },
): Promise<WebSearchOutcome> {
  const config = getSearchConfig();
  const provider = opts?.provider ?? config.provider;
  const maxResults = opts?.maxResults ?? config.maxResults;
  const apiKey = opts?.apiKey ?? config.apiKey;
  const trimmed = query.trim();
  if (!trimmed) return { ok: false, provider, results: [], error: "Empty query" };

  try {
    const results =
      provider === "tavily"
        ? await tavilySearch(trimmed, maxResults, apiKey)
        : provider === "duckduckgo"
          ? await duckDuckGoSearch(trimmed, maxResults)
          : await bingSearch(trimmed, maxResults);
    return { ok: results.length > 0, provider, results, error: results.length === 0 ? "No results" : undefined };
  } catch (e) {
    return {
      ok: false,
      provider,
      results: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
