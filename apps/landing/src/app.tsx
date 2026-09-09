import { GitHub } from "./components/github-icon";

import { Analytics } from "@vercel/analytics/react";

import { DemoVideo } from "./components/video";
import { GITHUB_URL } from "./lib/constants";
import { DownloadButton } from "./components/download-button";

export function App() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-5">
        <span className="font-semibold tracking-tight">OmniStudio</span>
        <a
          href={GITHUB_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 text-muted transition-colors hover:text-foreground"
        >
          <GitHub className="h-4 w-4" />
          GitHub
        </a>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center gap-10 px-6 pt-20 pb-24">
        <div className="flex max-w-2xl flex-col items-center gap-6 text-center">
          <picture>
            <source srcSet="/logo.webp" type="image/webp" />
            <img
              src="/logo.png"
              alt="OmniStudio"
              width={112}
              height={112}
              decoding="async"
              fetchPriority="high"
              className="size-28 shrink-0 object-contain"
            />
          </picture>
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl">
            A desktop workstation for{" "}
            <span className="bg-linear-to-r from-yellow-200 via-pink-300 to-fuchsia-300 bg-clip-text text-transparent">
              local LLMs
            </span>
          </h1>
          <p className="max-w-lg text-lg leading-relaxed text-muted">
            Manage models, run llama.cpp / vLLM / SGLang locally, and use Chat,
            Voice, Image and OCR apps — all on your machine.
          </p>
        </div>

        <DownloadButton />

        <DemoVideo />
      </main>

      <Analytics />
    </div>
  );
}
