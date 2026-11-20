// Image generation through an SDNext-style API (Arli AI: /sdapi/v1/txt2img and /sdapi/v1/img2img).
// Pure helpers plus one factory; the OpenClaw-specific wiring lives in index.js.

export const DEFAULT_IMAGE_BASE_URL = "https://api.arliai.com";
const STEP = 64;

const round64 = (n) => Math.max(STEP, Math.round(n / STEP) * STEP);

/**
 * Turn an optional "WxH" size or "W:H" aspect ratio into width/height that are
 * multiples of 64 and stay within `maxPixels`. Size wins over aspect ratio.
 */
export function pickDimensions({ size, aspectRatio, basePixels = 1024 * 1024, maxPixels = 3_000_000 } = {}) {
  let width;
  let height;
  const sizeMatch = typeof size === "string" ? size.trim().match(/^(\d{2,5})\s*[xX×]\s*(\d{2,5})$/) : null;
  const ratioMatch =
    typeof aspectRatio === "string" ? aspectRatio.trim().match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/) : null;
  if (sizeMatch) {
    width = Number(sizeMatch[1]);
    height = Number(sizeMatch[2]);
  } else if (ratioMatch && Number(ratioMatch[1]) > 0 && Number(ratioMatch[2]) > 0) {
    const ratio = Number(ratioMatch[1]) / Number(ratioMatch[2]);
    width = Math.sqrt(basePixels * ratio);
    height = width / ratio;
  } else {
    width = Math.sqrt(basePixels);
    height = width;
  }
  if (width * height > maxPixels) {
    const scale = Math.sqrt(maxPixels / (width * height));
    width *= scale;
    height *= scale;
  }
  width = round64(width);
  height = round64(height);
  // Rounding up can step just over the cap; shave the longer side until it fits.
  while (width * height > maxPixels && Math.max(width, height) > STEP) {
    if (width >= height) width -= STEP;
    else height -= STEP;
  }
  return { width, height };
}

/** Pull model names out of the shapes an SDNext/A1111 model list can take. */
export function parseModelList(payload) {
  const list = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
  const names = [];
  for (const item of list) {
    const name =
      typeof item === "string" ? item : item?.title ?? item?.model_name ?? item?.name ?? item?.id ?? null;
    if (typeof name === "string" && name.trim() && !names.includes(name.trim())) names.push(name.trim());
  }
  return names;
}

// Entries in the model list that are not image generators (text encoders, upscalers).
const NOT_A_GENERATOR = /^(clip|t5|vae|esrgan|r-esrgan|upscal)/i;

/**
 * First available model matching the preference list (case-insensitive
 * substring), else the first one that looks like an image generator.
 */
export function chooseModel(available, preference = []) {
  for (const wanted of preference) {
    const needle = String(wanted).toLowerCase();
    const hit = available.find((name) => name.toLowerCase() === needle)
      ?? available.find((name) => name.toLowerCase().includes(needle));
    if (hit) return hit;
  }
  return available.find((name) => !NOT_A_GENERATOR.test(name)) ?? null;
}

export function buildPayload({ prompt, model, width, height, steps, cfgScale, negativePrompt, initImage, denoisingStrength }) {
  const body = {
    prompt,
    negative_prompt: negativePrompt,
    steps,
    sampler_name: "Default",
    width,
    height,
    sd_model_checkpoint: model,
    seed: -1,
    cfg_scale: cfgScale,
  };
  if (initImage) {
    body.init_images = [initImage];
    body.denoising_strength = denoisingStrength;
  }
  return body;
}

function stripDataUri(value) {
  const text = String(value);
  const comma = text.startsWith("data:") ? text.indexOf(",") : -1;
  return comma === -1 ? text : text.slice(comma + 1);
}

/**
 * Build the generateImage function. `getApiKey(req)` resolves the key at call
 * time; `acquire(signal)` optionally waits for a provider slot and returns a
 * release function.
 */
export function createImageGenerator({
  baseUrl = DEFAULT_IMAGE_BASE_URL,
  getApiKey,
  acquire,
  preference = [],
  editPreference = [],
  steps = 30,
  cfgScale = 7,
  negativePrompt = "blurry, low quality, distorted, watermark",
  denoisingStrength = 0.65,
  maxPixels = 3_000_000,
  defaultTimeoutMs = 240_000,
  fetchFn = fetch,
  log = () => {},
} = {}) {
  let cachedModels = null;

  async function call(path, { apiKey, body, signal }) {
    const response = await fetchFn(`${baseUrl}${path}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${apiKey}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Arli image API ${path} returned ${response.status}: ${text.slice(0, 300)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Arli image API ${path} returned a non-JSON body: ${text.slice(0, 200)}`);
    }
  }

  async function listModels(apiKey, signal) {
    if (cachedModels) return cachedModels;
    const names = parseModelList(await call("/sdapi/v1/sd-models", { apiKey, signal }));
    if (names.length > 0) {
      cachedModels = names;
      log("image models available", { models: names });
    }
    return names;
  }

  return async function generateImage(req) {
    const apiKey = await getApiKey(req);
    if (!apiKey) throw new Error("No API key is configured for the Arli image provider.");
    const signal = AbortSignal.timeout(req.timeoutMs ?? defaultTimeoutMs);
    const release = acquire ? await acquire(signal) : null;
    try {
      const source = req.inputImages?.find((image) => image?.buffer?.length > 0);
      let model = req.model;
      if (!model || model === "auto") {
        // Edits prefer an edit model when one is configured and available.
        const wanted = source ? [...editPreference, ...preference] : preference;
        model = chooseModel(await listModels(apiKey, signal), wanted);
        if (!model) throw new Error("The Arli image API listed no image models for this account.");
      }
      const { width, height } = pickDimensions({ size: req.size, aspectRatio: req.aspectRatio, maxPixels });
      const body = buildPayload({
        prompt: req.prompt,
        model,
        width,
        height,
        steps,
        cfgScale,
        negativePrompt,
        initImage: source ? source.buffer.toString("base64") : undefined,
        denoisingStrength,
      });
      const count = Math.min(Math.max(Number(req.count) || 1, 1), 2);
      const images = [];
      const startedAt = Date.now();
      for (let i = 0; i < count; i += 1) {
        const result = await call(source ? "/sdapi/v1/img2img" : "/sdapi/v1/txt2img", { apiKey, body, signal });
        const encoded = Array.isArray(result?.images) ? result.images : result?.image ? [result.image] : [];
        for (const item of encoded) {
          const buffer = Buffer.from(stripDataUri(item), "base64");
          if (buffer.length > 0) {
            images.push({ buffer, mimeType: "image/png", fileName: `arli-${Date.now()}-${images.length + 1}.png` });
          }
        }
      }
      if (images.length === 0) throw new Error("The Arli image API returned no image data.");
      log("image generated", { model, width, height, mode: source ? "edit" : "generate", ms: Date.now() - startedAt });
      return { images, model, metadata: { width, height, steps, mode: source ? "img2img" : "txt2img" } };
    } finally {
      release?.();
    }
  };
}
