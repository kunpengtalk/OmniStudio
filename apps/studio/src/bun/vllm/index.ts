import type { Sharp } from "sharp";

import { getCurrentModelProfile } from "./model-profile";
import type { ModelEndpoint } from "./model";
import type { BatchOutputItem } from "./utils";
import { generateVllm } from "./vllm";

export type { BatchOutputItem, Sharp, ModelEndpoint };
export { convertFileToImages } from "./input";

export const generate = async (
  images: Sharp[],
  {
    include_images,
    include_headers_footers,
  }: {
    include_images?: boolean;
    include_headers_footers?: boolean;
  } = {},
  endpoint?: ModelEndpoint,
): Promise<BatchOutputItem[]> => {
  const profile = getCurrentModelProfile();
  const scale = profile.processingArgs.bboxScale;
  const results = await generateVllm(images, endpoint);

  const opts = { include_headers_footers, include_images };

  const output: BatchOutputItem[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    const image = images[i]!;
    const { width = 0, height = 0 } = await image.metadata();

    const processed = await profile.processRawOutput(result.raw, image, opts, scale);

    output.push({
      markdown: processed.markdown,
      raw: result.raw,
      page_box: [0, 0, width, height],
      token_count: result.token_count,
      images: processed.images,
      error: result.error,
      errorMessage: result.errorMessage,
    });
  }

  return output;
};
