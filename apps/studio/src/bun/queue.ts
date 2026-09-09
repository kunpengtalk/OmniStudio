import path from "path";
import { and, eq } from "drizzle-orm";
import { mkdirSync, existsSync } from "fs";

import { db } from "./db";
import { documents, pages } from "./db/schema";
import { getNumericSetting } from "./db/settings";
import { getImagesBaseDir, imageUrl } from "./image-server";
import { convertFileToImages, generate } from "./vllm";
import { getWindowRef } from "./window";

function notifyDocumentChanged(id: number) {
  getWindowRef().webview.rpc?.send.documentChanged({ id });
}

class Semaphore {
  private queue: (() => void)[] = [];
  private active = 0;

  constructor(private max: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.active--;
    }
  }

  resize(newMax: number): void {
    this.max = newMax;
    while (this.active < this.max && this.queue.length > 0) {
      this.active++;
      this.queue.shift()!();
    }
  }
}

let pageSemaphore: Semaphore | null = null;
let lastConcurrency = 0;

function getPageSemaphore(): Semaphore {
  const concurrency = getNumericSetting("PAGE_CONCURRENCY");
  if (!pageSemaphore || concurrency !== lastConcurrency) {
    if (pageSemaphore) {
      pageSemaphore.resize(concurrency);
    } else {
      pageSemaphore = new Semaphore(concurrency);
    }
    lastConcurrency = concurrency;
  }
  return pageSemaphore;
}

export async function processDocumentPages(id: number): Promise<void> {
  const doc = db.select().from(documents).where(eq(documents.id, id)).get();
  if (!doc) return;

  const imagesDir = path.join(getImagesBaseDir(), String(id));
  if (!existsSync(imagesDir)) mkdirSync(imagesDir, { recursive: true });

  // Clean up old pages from previous processing attempts
  db.delete(pages).where(eq(pages.documentId, id)).run();

  db.update(documents)
    .set({ status: "processing", imagesDir, error: null, processingStartedAt: Date.now(), updatedAt: Date.now() })
    .where(eq(documents.id, id))
    .run();
  notifyDocumentChanged(id);

  try {
    const images = await convertFileToImages(Bun.file(doc.path));

    for (let i = 0; i < images.length; i++) {
      db.insert(pages).values({ documentId: id, pageNumber: i, status: "pending" }).run();
    }

    db.update(documents)
      .set({ totalPages: images.length, processedPages: 0, updatedAt: Date.now() })
      .where(eq(documents.id, id))
      .run();
    notifyDocumentChanged(id);

    let hasError = false;
    let processedCount = 0;

    const semaphore = getPageSemaphore();

    const pagePromises = images.map((image, i) =>
      (async () => {
        await semaphore.acquire();
        const pageWhere = and(eq(pages.documentId, id), eq(pages.pageNumber, i));

        db.update(pages).set({ startedAt: Date.now() }).where(pageWhere).run();

        try {
          const results = await generate([image], {
            include_images: true,
            include_headers_footers: true,
          });
          const result = results[0]!;

          if (result.error) {
            hasError = true;
            db.update(pages)
              .set({ status: "failed", failedAt: Date.now(), error: result.errorMessage ?? "Unknown VLM error" })
              .where(pageWhere)
              .run();
          } else {
            let pageMarkdown = result.markdown;
            for (const [imgName, imgSharp] of Object.entries(result.images)) {
              await imgSharp.webp().toFile(path.join(imagesDir, imgName));
              pageMarkdown = pageMarkdown.replace(imgName, imageUrl(id, imgName));
            }

            db.update(pages)
              .set({ markdown: pageMarkdown, raw: result.raw, status: "completed", completedAt: Date.now() })
              .where(pageWhere)
              .run();
          }
        } finally {
          semaphore.release();
          processedCount++;
          db.update(documents)
            .set({ processedPages: processedCount, updatedAt: Date.now() })
            .where(eq(documents.id, id))
            .run();
          notifyDocumentChanged(id);
        }
      })(),
    );

    await Promise.all(pagePromises);

    const completedPages = db
      .select({ markdown: pages.markdown })
      .from(pages)
      .where(and(eq(pages.documentId, id), eq(pages.status, "completed")))
      .all();

    if (hasError && completedPages.every((p) => !p.markdown?.trim())) {
      db.update(documents)
        .set({ status: "failed", failedAt: Date.now(), updatedAt: Date.now() })
        .where(eq(documents.id, id))
        .run();
      notifyDocumentChanged(id);
      return;
    }

    db.update(documents)
      .set({
        status: "completed",
        completedAt: Date.now(),
        updatedAt: Date.now(),
      })
      .where(eq(documents.id, id))
      .run();
    notifyDocumentChanged(id);
  } catch (e) {
    const errorMsg = e instanceof Error ? (e.stack ?? String(e)) : String(e);
    console.error(`Document ${id} processing failed:`, e);
    db.update(documents)
      .set({ status: "failed", failedAt: Date.now(), error: errorMsg, updatedAt: Date.now() })
      .where(eq(documents.id, id))
      .run();
    notifyDocumentChanged(id);
  }
}
