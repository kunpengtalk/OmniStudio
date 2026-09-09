import { DEMO_VIDEO_URL } from "../lib/constants";

export function DemoVideo() {
  return (
    <div className="bg-surface relative mx-auto w-full max-w-4xl overflow-hidden rounded-2xl border border-border">
      <video
        className="aspect-video w-full bg-black object-contain"
        controls
        playsInline
        preload="metadata"
      >
        <source src={DEMO_VIDEO_URL} type="video/mp4" />
      </video>
    </div>
  );
}
