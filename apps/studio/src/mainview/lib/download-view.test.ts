import { describe, expect, test } from "bun:test";

import { formatEta, queuePositionOf, summarizeDownloads, taskEta } from "./download-view";
import type { DownloadTask } from "../../bun/download-manager";
import { translate } from "../../shared/i18n";

const t = (key: string, params?: Record<string, string>) => translate("zh", key, params);

function task(patch: Partial<DownloadTask>): DownloadTask {
  return {
    id: patch.id ?? "id",
    repo: "some/repo",
    fileName: patch.fileName ?? "model.safetensors",
    source: "modelscope",
    status: "queued",
    received: 0,
    total: null,
    percent: null,
    speed: 0,
    createdAt: 0,
    size: null,
    order: 0,
    ...patch,
  };
}

describe("剩余时间", () => {
  test("按速度与剩余字节给出秒/分/小时", () => {
    expect(formatEta(0, 1000, t)).toBeNull();
    expect(formatEta(1000, 0, t)).toBeNull();
    expect(formatEta(5_000, 1_000, t)).toBe("约 5 秒");
    expect(formatEta(300_000, 1_000, t)).toBe("约 5 分钟"); // 300s = 5min
    expect(formatEta(3 * 3600 * 1_000_000, 1_000_000, t)).toBe("约 3 小时 0 分钟"); // 3h
  });

  test("只有正在下载且总量已知才给任务级剩余时间", () => {
    const downloading = task({ status: "downloading", received: 1_000, total: 11_000, speed: 1_000 });
    expect(taskEta(downloading, t)).toBe("约 10 秒");
    // 排队中还没有速度，不显示剩余时间（显示的是「前面还有几个」）。
    expect(taskEta(task({ status: "queued", total: 100, speed: 500 }), t)).toBeNull();
    // 总量未知。
    expect(taskEta(task({ status: "downloading", received: 10, total: null, speed: 5 }), t)).toBeNull();
    // size 也能当总量用（市场列表给的，还没探测）。
    expect(taskEta(task({ status: "downloading", received: 0, size: 4_000, speed: 1_000 }), t)).toBe(
      "约 4 秒",
    );
  });
});

describe("排队位置", () => {
  test("小文件优先：体积小的排在前面，位置从 1 数起", () => {
    const big = task({ id: "big", size: 4_000_000_000, createdAt: 1 });
    const small = task({ id: "small", size: 1_000, createdAt: 2 });
    const mid = task({ id: "mid", size: 20_000, createdAt: 3 });
    const all = [big, small, mid];

    expect(queuePositionOf(small, all)).toBe(1);
    expect(queuePositionOf(mid, all)).toBe(2);
    expect(queuePositionOf(big, all)).toBe(3);
  });

  test("显式点击的任务排在最前，未知体积排在同类末尾", () => {
    const explicit = task({ id: "explicit", size: 9_000_000_000, createdAt: 9, order: -1 });
    const small = task({ id: "small", size: 100, createdAt: 1 });
    const unknown = task({ id: "unknown", size: null, createdAt: 2 });
    const all = [small, unknown, explicit];

    expect(queuePositionOf(explicit, all)).toBe(1);
    expect(queuePositionOf(small, all)).toBe(2);
    expect(queuePositionOf(unknown, all)).toBe(3);
  });

  test("正在下载/已暂停/已完成不算排队", () => {
    const running = task({ id: "run", status: "downloading" });
    const paused = task({ id: "pause", status: "paused" });
    expect(queuePositionOf(running, [running, paused])).toBeNull();
    expect(queuePositionOf(paused, [running, paused])).toBeNull();
  });
});

describe("聚合进度", () => {
  test("合计已下/总量、速度与剩余字节（总量未知的任务不计入比例）", () => {
    const tasks = [
      task({ id: "a", status: "downloading", received: 100, total: 400, speed: 100 }),
      task({ id: "b", status: "queued", received: 0, total: 100, speed: 0 }),
      // 总量未知：计入已下与活跃数，但不计入比例。
      task({ id: "c", status: "downloading", received: 50, total: null, speed: 50, size: null }),
      // 已完成的不算活跃。
      task({ id: "d", status: "completed", received: 999, total: 999, speed: 0 }),
    ];
    const summary = summarizeDownloads(tasks);
    expect(summary.activeCount).toBe(3);
    expect(summary.received).toBe(150);
    expect(summary.total).toBe(500);
    expect(summary.remainingBytes).toBe(400); // (400-100) + (100-0)
    expect(summary.speed).toBe(150);
    expect(summary.percent).toBe(30);
  });

  test("没有任何已知总量时不给百分比", () => {
    const summary = summarizeDownloads([
      task({ id: "a", status: "downloading", received: 10, total: null, size: null, speed: 10 }),
    ]);
    expect(summary.percent).toBeNull();
    expect(summary.activeCount).toBe(1);
    expect(summary.received).toBe(10);
  });

  test("空闲时全为零", () => {
    const summary = summarizeDownloads([task({ id: "d", status: "completed" })]);
    expect(summary).toEqual({
      speed: 0,
      received: 0,
      total: 0,
      remainingBytes: 0,
      percent: null,
      activeCount: 0,
    });
  });
});
