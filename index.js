import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { PRIORITY, SlotQueue, wrapStreamWithQueue } from "./queue.js";

const PLUGIN_ID = "arli-queue";
const DEFAULTS = { providers: ["arli"], maxConcurrent: 1, holdAfterAbortMs: 0 };

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
  return { providers, maxConcurrent, holdAfterAbortMs };
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
    log("ready", cfg);
  },
});
