import type { DetailedHTMLProps, ImgHTMLAttributes } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { rpcClient } from "../lib/rpc";
import { DownloadIcon } from "lucide-react";

const fileExtensionPattern = /\.[^/.]+$/;

type ImageComponentProps = DetailedHTMLProps<
  ImgHTMLAttributes<HTMLImageElement>,
  HTMLImageElement
> & { node?: unknown };

export const ImageComponent = ({
  node: _node,
  className,
  src,
  alt,
  onLoad: onLoadProp,
  onError: onErrorProp,
  ...props
}: ImageComponentProps) => {
  const imgRef = useRef<HTMLImageElement>(null);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageError, setImageError] = useState(false);

  const hasExplicitDimensions = props.width != null || props.height != null;
  const showDownload = (imageLoaded || hasExplicitDimensions) && !imageError;
  const showFallback = imageError && !hasExplicitDimensions;

  // Handle images already complete before React attaches event handlers (e.g. cached or SSR hydration)
  useEffect(() => {
    const img = imgRef.current;
    if (img?.complete) {
      const loaded = img.naturalWidth > 0;
      setImageLoaded(loaded);
      setImageError(!loaded);
    }
  }, []);

  const handleLoad = useCallback<React.ReactEventHandler<HTMLImageElement>>(
    (event) => {
      setImageLoaded(true);
      setImageError(false);
      onLoadProp?.(event);
    },
    [onLoadProp],
  );

  const handleError = useCallback<React.ReactEventHandler<HTMLImageElement>>(
    (event) => {
      setImageLoaded(false);
      setImageError(true);
      onErrorProp?.(event);
    },
    [onErrorProp],
  );

  const downloadImage = async () => {
    if (!src) return;

    try {
      const urlPath = new URL(src, window.location.origin).pathname;
      const originalFilename = urlPath.split("/").pop() || "image.webp";
      const filename = alt
        ? `${alt.replace(fileExtensionPattern, "")}.${originalFilename.split(".").pop() || "webp"}`
        : originalFilename;

      await rpcClient.saveImageToDownloads({ url: src, filename });
    } catch {
      window.open(src, "_blank");
    }
  };

  if (!src) {
    return null;
  }

  return (
    <div className={cn("relative my-4 inline-block")} data-streamdown="image-wrapper">
      <div className="group relative">
        {/** biome-ignore lint/performance/noImgElement: "streamdown is framework-agnostic" */}
        {/** biome-ignore lint/correctness/useImageSize: "unknown size" */}
        {/** biome-ignore lint/a11y/noNoninteractiveElementInteractions: image overlay with intentional load/error handling */}
        <img
          alt={alt}
          className={cn("max-w-full rounded-lg", showFallback && "hidden", className)}
          data-streamdown="image"
          onError={handleError}
          onLoad={handleLoad}
          ref={imgRef}
          src={src}
          {...props}
        />

        <div
          className={cn(
            "pointer-events-none absolute inset-0 hidden rounded-lg bg-black/10 group-hover:block",
          )}
        />
        {showDownload && (
          <button
            className={cn(
              "absolute right-2 bottom-2 flex h-8 w-8 cursor-pointer items-center justify-center rounded-md border border-border bg-background/90 shadow-sm backdrop-blur-sm transition-all duration-200 hover:bg-background",
              "opacity-0 group-hover:opacity-100",
            )}
            onClick={downloadImage}
            title="Download image"
            type="button"
          >
            <DownloadIcon size={14} />
          </button>
        )}
      </div>

      {(alt || showFallback) && (
        <span
          className={cn("text-xs text-muted-foreground italic")}
          data-streamdown="image-fallback"
        >
          {showFallback ? "Image not available" : alt}
        </span>
      )}
    </div>
  );
};
