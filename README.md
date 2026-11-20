# openclaw-arli-queue

An OpenClaw provider plugin that sends requests to a one-slot model provider
one at a time. Built for Arli AI Plus, which allows one parallel request and
answers a second with HTTP 429 ("exceeded the maximum number of parallel
requests").

OpenClaw 2026.11.3 has no per-provider concurrency setting. Without this
plugin, two chats (or a chat plus a background job) both send at once, one is
rejected, retries run out and the turn falls through the fallback list.

## What it does

- Wraps the provider's stream function (`wrapStreamFn`) with a FIFO queue.
- A request waits for a free slot before it is sent. The slot is released
  when the response stream finishes, fails or is aborted.
- Foreground chats go ahead of background work (`modelCallUrgency`).
- Leaves the provider's config, key and models alone. It works with a
  provider defined in `models.providers.<id>`.
- Cleans tool arguments: some models (seen with GLM 4.6 Derestricted) start
  string arguments with stray newlines, so `"\n\n/Users/me/file"` is read as a
  relative path and the tool fails. A `before_tool_call` hook trims whitespace
  from path arguments and from the start of an `apply_patch` body. This applies
  to every agent on the Gateway, whatever model it uses.
- Adds image generation: registers an image provider for OpenClaw's
  `image_generate` tool, backed by Arli's SDNext-style API
  (`/sdapi/v1/txt2img`, and `/sdapi/v1/img2img` when a reference image is
  given). Image calls share the provider's one slot with chat, at background
  priority.

## Image generation

Arli issues separate API keys for text and images, so the image key goes in its
own provider entry and the plugin is pointed at it:

    openclaw secrets store set ARLI_IMAGE_API_KEY --kind secret --allow-host api.arliai.com --value-file -

```json5
{
  models: { providers: { "arli-image": {
    baseUrl: "https://api.arliai.com/v1",
    api: "openai-completions",
    apiKey: { source: "store", provider: "default", id: "ARLI_IMAGE_API_KEY" },
    models: [],
  } } },
  plugins: { entries: { "arli-queue": { config: { images: {
    authProvider: "arli-image",
    modelPreference: ["Qwen-Image-2512", "FLUX.2-klein-4B"],
    editModelPreference: ["Qwen-Image-Edit-2511"],
  } } } } },
  // An explicit empty fallback list keeps image requests on Arli.
  agents: { defaults: { mediaModels: { image: { primary: "arli/auto", fallbacks: [], timeoutMs: 600000 } } } },
}
```

`arli/auto` picks the first available model from the preference list (the edit
list first when a reference image is given). `arli/<model name>` asks for one
model exactly. `GET /sdapi/v1/sd-models` lists what the account can use.

## Config

Optional, under `plugins.entries.arli-queue.config`:

| Key | Default | Meaning |
|---|---|---|
| `providers` | `["arli"]` | Provider ids to queue. |
| `maxConcurrent` | `1` | Requests allowed at once per provider. |
| `holdAfterAbortMs` | `0` | Keep the slot this long after an aborted request, for upstreams that still count an abandoned request. |
| `cleanToolArgs` | `true` | Trim stray whitespace from path tool arguments. |
| `images.enabled` | `true` | Register the image provider. |
| `images.authProvider` | same as `images.provider` | Provider entry whose API key is used for images. |
| `images.modelPreference` | `[]` | Models tried in order for `arli/auto`. |
| `images.editModelPreference` | `[]` | Models tried first for edits. |
| `images.steps` | `30` | Sampling steps (Arli allows up to 40). |
| `images.denoisingStrength` | `0.65` | How far an edit may move from the reference image. |
| `images.maxPixels` | `3000000` | Size cap per image (Arli Plus allows 3 megapixels). |
| `images.queue` | `true` | Share the chat slot instead of sending image calls in parallel. |

Changing `providers` to an id other than `arli` also needs that id added to
`providers` in `openclaw.plugin.json` and `package.json`.

## Install

    npm pack --pack-destination ./dist-pack
    openclaw plugins install npm-pack:./dist-pack/openclaw-arli-queue-0.3.1.tgz --force --accept-capabilities --acknowledge-install-policy-warning
    openclaw plugins inspect arli-queue --runtime --json

The Gateway loads it without a restart. The log shows
`[arli-queue] ready {...}` and, when a request had to wait,
`[arli-queue] request waited for a slot {...}`.

## Remove

    openclaw plugins uninstall arli-queue

## Limits

- Time spent waiting in the queue counts against OpenClaw's model idle
  timeout for that provider (`models.providers.<id>.timeoutSeconds`). Keep it
  comfortably above the longest expected wait.
- The queue lives in one Gateway process. `openclaw agent --local` runs and
  other machines using the same key are not coordinated.
- It cannot shorten how long the upstream keeps a slot busy after OpenClaw
  abandons a request. `holdAfterAbortMs` only stops the next request from
  being sent into that window.
- Arli image calls can take several minutes, and the service sometimes stops
  answering for a while. A request with a valid key then waits instead of
  failing, so keep the image timeout generous.

## Tests

    npm test                       # queue, argument cleanup and image helpers, 24 tests
    node test/mock-one-slot-server.mjs 18796 6000   # mock upstream with one slot
    test/run-two.sh <label>        # two simultaneous turns through an isolated Gateway

Verified on OpenClaw 2026.11.3:

- Mock server, 2026-11-17: without the plugin, two simultaneous turns produced
  3 rejections; with it, two and then three simultaneous turns produced 0, with
  the key read from the secret store.
- Real Arli API (Plus plan), 2026-11-17: three requests competing for the slot,
  0 rejections; the two queued turns waited about 200 seconds and completed.
- Argument cleanup, 2026-11-18, mock server: a `read` call with a
  newline-prefixed absolute path failed without the hook and returned the file
  with it.
- Image generation, 2026-11-19, real Arli API (Plus plan): SDXL-ArliMix-v1 at
  768x768 returned in 147 seconds and was delivered to Telegram.
