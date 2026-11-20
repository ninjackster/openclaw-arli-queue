import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { PRIORITY, SlotQueue, wrapStreamWithQueue } from "./queue.js";
import { cleanToolParams } from "./toolargs.js";
import { createImageGenerator, DEFAULT_IMAGE_BASE_URL } from "./image.js";

const PLUGIN_ID = "arli-queue";
const DEFAULTS = { providers: ["arli"], maxConcurrent: 1, holdAfterAbortMs: 0, cleanToolArgs: true };
const IMAGE_DEFAULTS = {
  enabled: true,
  provider: "arli",
  authProvider: "",
  baseUrl: DEFAULT_IMAGE_BASE_URL,
  queue: true,
  modelPreference: [],
  editModelPreference: [],
  steps: 30,
  denoisingStrength: 0.65,
  maxPixels: 3_000_000,
};

function readImageConfig(raw) {
  const cfg = raw && typeof raw === "object" ? raw : {};
  const out = { ...IMAGE_DEFAULTS };
  if (typeof cfg.enabled === "boolean") out.enabled = cfg.enabled;
  if (typeof cfg.provider === "string" && cfg.provider.trim()) out.provider = cfg.provider.trim().toLowerCase();
  // Arli issues separate keys for text and images; authProvider names the models.providers entry holding the image key.
  if (typeof cfg.authProvider === "string") out.authProvider = cfg.authProvider.trim().toLowerCase();
  if (typeof cfg.baseUrl === "string" && /^https:\/\//.test(cfg.baseUrl)) out.baseUrl = cfg.baseUrl.replace(/\/+$/, "");
  if (typeof cfg.queue === "boolean") out.queue = cfg.queue;
  if (Array.isArray(cfg.modelPreference)) out.modelPreference = cfg.modelPreference.map(String);
  if (Array.isArray(cfg.editModelPreference)) out.editModelPreference = cfg.editModelPreference.map(String);
  if (Number.isInteger(cfg.steps) && cfg.steps >= 1 && cfg.steps <= 40) out.steps = cfg.steps;
  if (Number.isFinite(cfg.denoisingStrength) && cfg.denoisingStrength > 0 && cfg.denoisingStrength <= 1) {
    out.denoisingStrength = cfg.denoisingStrength;
  }
  if (Number.isInteger(cfg.maxPixels) && cfg.maxPixels >= 262_144) out.maxPixels = cfg.maxPixels;
  return out;
}

function readConfig(raw) {
  const cfg = raw && typeof raw === "object" ? raw : {};
  const providers = Array.isArray(cfg.providers) && cfg.providers.length > 0
    ? cfg.providers.map((p) => String(p).trim().toLowerCase()).filter(Boolean)
    : DEFAULTS.providers;
  const maxConcurrent = Number.isInteger(cfg.maxConcurrent) && cfg.maxConcurrent >= 1
    ? cfg.maxConcurrent
    : DEFAULTS.maxConcurrent;
  const holdAfterAbortMs = Number.isFinite(cfg.holdAfterAbortMs) && cfg.holdAfterAbortMs >= 0
    ? cfg.holdAfterAbortMs
    : DEFAULTS.holdAfterAbortMs;
  const cleanToolArgs = typeof cfg.cleanToolArgs === "boolean" ? cfg.cleanToolArgs : DEFAULTS.cleanToolArgs;
  return { providers, maxConcurrent, holdAfterAbortMs, cleanToolArgs, images: readImageConfig(cfg.images) };
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Arli Queue",
  description: "Sends requests to a one-slot model provider one at a time instead of in parallel.",
  register(api) {
    const cfg = readConfig(api.pluginConfig);
    const log = (message, data) =>
      api.logger?.info?.(`[${PLUGIN_ID}] ${message}${data ? ` ${JSON.stringify(data)}` : ""}`);
    // One queue per provider id, shared by every agent and session in this Gateway.
    const queues = new Map(cfg.providers.map((id) => [id, new SlotQueue({ limit: cfg.maxConcurrent })]));

    for (const providerId of cfg.providers) {
      api.registerProvider({
        id: providerId,
        label: `${providerId} (queued)`,
        auth: [],
        wrapStreamFn(ctx) {
          const active = typeof ctx.provider === "string" ? ctx.provider.trim().toLowerCase() : "";
          const queue = queues.get(active);
          if (!queue || !ctx.streamFn) return undefined;
          const priority = PRIORITY[ctx.modelCallUrgency] ?? PRIORITY.normal;
          const wrapped = wrapStreamWithQueue(ctx.streamFn, queue, {
            priority,
            holdAfterAbortMs: cfg.holdAfterAbortMs,
            log,
          });
          return Object.assign(wrapped, { preservesGenericCompatibility: true });
        },
      });
    }
    if (cfg.cleanToolArgs) {
      // Strip stray leading/trailing whitespace from path arguments before a tool runs.
      api.on("before_tool_call", (event) => {
        const cleaned = cleanToolParams(event.toolName, event.params);
        if (!cleaned) return undefined;
        log("cleaned tool arguments", { tool: event.toolName });
        return { params: cleaned };
      });
    }
    if (cfg.images.enabled) {
      const img = cfg.images;
      const queue = img.queue ? queues.get(img.provider) : undefined;
      const authProvider = img.authProvider || img.provider;
      api.registerImageGenerationProvider({
        id: img.provider,
        label: `${img.provider} images`,
        defaultModel: "auto",
        defaultTimeoutMs: 240_000,
        capabilities: {
          generate: { maxCount: 2, supportsSize: true, supportsAspectRatio: true },
          edit: { enabled: true, maxCount: 1, maxInputImages: 1, supportsSize: true, supportsAspectRatio: true },
        },
        isConfiguredAsync: async (ctx) => {
          try {
            const auth = await api.runtime.modelAuth.resolveApiKeyForProvider({ provider: authProvider, cfg: ctx.cfg });
            return Boolean(auth?.apiKey);
          } catch {
            return false;
          }
        },
        generateImage: createImageGenerator({
          baseUrl: img.baseUrl,
          preference: img.modelPreference,
          editPreference: img.editModelPreference,
          steps: img.steps,
          denoisingStrength: img.denoisingStrength,
          maxPixels: img.maxPixels,
          log,
          getApiKey: async (req) =>
            (await api.runtime.modelAuth.resolveApiKeyForProvider({ provider: authProvider, cfg: req.cfg }))?.apiKey,
          // Image calls share the one provider slot with chat, at background priority.
          acquire: queue ? (signal) => queue.acquire({ signal, priority: PRIORITY.background }) : undefined,
        }),
      });
    }
    log("ready", cfg);
  },
});
