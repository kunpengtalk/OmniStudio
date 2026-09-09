import { freemem, loadavg, totalmem } from "node:os";
import { getSetting } from "./db/settings";
import { listInstalledModels } from "./model-store";

export type ActiveModel = {
  name: string;
  loaded: boolean;
  lastUsedAt: number;
};

export type ServerStats = {
  sessionStartedAt: number;
  serverStartedAt: number;
  prefillTokens: number;
  generationTokens: number;
  requests: number;
  prefillTokensPerSec: number;
  generationTokensPerSec: number;
  activeModels: ActiveModel[];
  system: {
    loadAvg: number[];
    totalMem: number;
    freeMem: number;
  };
  modelsSize: number;
};

const sessionStartedAt = Date.now();
let serverStartedAt = 0;
let prefillTokens = 0;
let generationTokens = 0;
let requests = 0;
const recentModels = new Map<string, number>();

/** Called when the local server reports ready so the dashboard can show server uptime. */
export function markServerStarted() {
  serverStartedAt = Date.now();
}

/** Accumulate token usage from every inference call (chat + OCR). */
export function recordUsage(modelId: string, promptTokens: number, completionTokens: number) {
  if (promptTokens > 0) prefillTokens += promptTokens;
  if (completionTokens > 0) generationTokens += completionTokens;
  requests += 1;
  if (modelId) recentModels.set(modelId, Date.now());
}

/** Query llama-server /slots for the models actually loaded in VRAM/RAM. */
async function fetchLoadedModels(): Promise<string[]> {
  try {
    const port = getSetting("SERVER_PORT");
    const res = await fetch(`http://localhost:${port}/slots`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as Array<{ model?: string }>;
    const names = new Set<string>();
    for (const slot of data) {
      if (slot?.model) names.add(slot.model);
    }
    return [...names];
  } catch {
    return [];
  }
}

export async function getServerStats(): Promise<ServerStats> {
  const loaded = await fetchLoadedModels();
  const loadedSet = new Set(loaded);

  const active: ActiveModel[] = [];
  for (const [name, lastUsedAt] of recentModels) {
    // If /slots is unavailable, treat recently used models as loaded.
    active.push({ name, loaded: loaded.length === 0 || loadedSet.has(name), lastUsedAt });
  }
  active.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  for (const name of loaded) {
    if (!active.some((m) => m.name === name)) {
      active.push({ name, loaded: true, lastUsedAt: 0 });
    }
  }

  const elapsed = Math.max((Date.now() - sessionStartedAt) / 1000, 1);
  const modelsSize = listInstalledModels().reduce((sum, m) => sum + (m.size || 0), 0);

  return {
    sessionStartedAt,
    serverStartedAt,
    prefillTokens,
    generationTokens,
    requests,
    prefillTokensPerSec: prefillTokens / elapsed,
    generationTokensPerSec: generationTokens / elapsed,
    activeModels: active,
    system: {
      loadAvg: loadavg(),
      totalMem: totalmem(),
      freeMem: freemem(),
    },
    modelsSize,
  };
}
