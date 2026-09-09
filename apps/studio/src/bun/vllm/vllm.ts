import { generateText } from "ai";
import { sleep } from "bun";
import type { Sharp } from "sharp";

import { getNumericSetting } from "../db/settings";
import { getModel, type ModelEndpoint } from "./model";
import { getCurrentModelProfile } from "./model-profile";
import type { GenerationResult } from "./utils";
import { detectRepeatToken, imageToBase64 } from "./utils";
import { recordUsage } from "../stats";
import { getChatModelName } from "../chat-model";

async function callModel(
  image: Sharp,
  temperature?: number,
  topP?: number,
  endpoint?: ModelEndpoint,
): Promise<GenerationResult> {
  const profile = getCurrentModelProfile();
  const args = profile.processingArgs;
  const prompt = profile.buildUserPrompt(args.bboxScale);

  const scaled = profile.preprocessImage ? await profile.preprocessImage(image) : image;
  const b64 = await imageToBase64(scaled);

  const temp = temperature ?? args.temperature;
  const tp = topP ?? args.topP;

  try {
    const result = await generateText({
      model: getModel(endpoint),
      messages: [
        ...(profile.systemPrompt
          ? [{ role: "system" as const, content: profile.systemPrompt }]
          : []),
        {
          role: "user",
          content: [
            {
              type: "image",
              image: b64,
            },
            ...(prompt ? [{ type: "text" as const, text: prompt }] : []),
          ],
        },
      ],
      maxOutputTokens: args.maxOutputTokens,
      temperature: temp,
      topP: tp,
    });

    let raw = result.text ?? "";
    if (!raw.trim() && result.reasoning) {
      raw = result.reasoning.map((r) => r.text).join("\n");
    }
    raw = raw.replace(/ thinking[\s\S]*?<\/think>\s*/g, "").trim();

    recordUsage(getChatModelName(), result.usage?.inputTokens ?? 0, result.usage?.outputTokens ?? 0);

    return {
      raw,
      token_count: result.usage?.outputTokens ?? 0,
      error: false,
    };
  } catch (e) {
    const msg = e instanceof Error ? (e.stack ?? String(e)) : String(e);
    console.error(`vLLM generation error: ${msg}`);
    return { raw: "", token_count: 0, error: true, errorMessage: msg };
  }
}

function shouldRetry(result: GenerationResult, attempt: number): boolean {
  if (attempt >= getNumericSetting("MAX_VLLM_RETRIES")) return false;

  if (result.error) return true;

  const rd = getCurrentModelProfile().processingArgs.repeatDetection;
  if (!rd) return false;

  return (
    detectRepeatToken(result.raw, rd.baseMaxRepeats, rd.windowSize, 0, rd.scalingFactor) ||
    (result.raw.length > rd.cutFromEnd &&
      detectRepeatToken(
        result.raw,
        rd.baseMaxRepeats,
        rd.windowSize,
        rd.cutFromEnd,
        rd.scalingFactor,
      ))
  );
}

async function processItem(
  image: Sharp,
  endpoint?: ModelEndpoint,
): Promise<GenerationResult> {
  const { temperature, retryTempStep, retryTempMax } = getCurrentModelProfile().processingArgs;

  let result = await callModel(image, undefined, undefined, endpoint);
  let attempt = 0;

  while (shouldRetry(result, attempt)) {
    attempt += 1;
    if (result.error) await sleep(2000 * attempt);
    const retryTemp = Math.min(temperature + retryTempStep * attempt, retryTempMax);
    result = await callModel(image, retryTemp, 0.95, endpoint);
  }

  const maxFailureRetries = getNumericSetting("MAX_VLLM_FAILURE_RETRIES");
  if (result.error && maxFailureRetries > 0 && attempt < maxFailureRetries) {
    let failAttempt = attempt;
    while (result.error && failAttempt < maxFailureRetries) {
      failAttempt += 1;
      await sleep(2000 * failAttempt);
      const retryTemp = Math.min(temperature + retryTempStep * failAttempt, retryTempMax);
      result = await callModel(image, retryTemp, 0.95, endpoint);
    }
  }

  return result;
}

export async function generateVllm(
  images: Sharp[],
  endpoint?: ModelEndpoint,
): Promise<GenerationResult[]> {
  const results: GenerationResult[] = [];
  for (const image of images) {
    results.push(await processItem(image, endpoint));
  }

  return results;
}
