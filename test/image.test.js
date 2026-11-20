import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPayload, chooseModel, createImageGenerator, parseModelList, pickDimensions } from "../image.js";

test("default dimensions are a 1024 square", () => {
  assert.deepEqual(pickDimensions(), { width: 1024, height: 1024 });
});

test("aspect ratio keeps about one megapixel in multiples of 64", () => {
  const { width, height } = pickDimensions({ aspectRatio: "9:16" });
  assert.equal(width % 64, 0);
  assert.equal(height % 64, 0);
  assert.ok(height > width);
  assert.ok(Math.abs(width * height - 1024 * 1024) < 200_000);
});

test("an explicit size wins and is capped at the pixel limit", () => {
  assert.deepEqual(pickDimensions({ size: "1536x1024", aspectRatio: "1:1" }), { width: 1536, height: 1024 });
  const big = pickDimensions({ size: "3840x2160" });
  assert.ok(big.width * big.height <= 3_000_000);
  assert.ok(big.width > big.height);
});

test("model list parsing accepts titles, names and plain strings", () => {
  assert.deepEqual(parseModelList([{ title: "A" }, { model_name: "B" }, "C", { title: "A" }]), ["A", "B", "C"]);
  assert.deepEqual(parseModelList({ data: [{ id: "X" }] }), ["X"]);
  assert.deepEqual(parseModelList(null), []);
});

test("model choice follows the preference order, then falls back to the first", () => {
  assert.equal(chooseModel(["SDXL-One", "Flux-Dev"], ["flux", "sdxl"]), "Flux-Dev");
  assert.equal(chooseModel(["SDXL-One"], ["flux"]), "SDXL-One");
  assert.equal(chooseModel([], ["flux"]), null);
  assert.equal(chooseModel(["Clip-ViT-L-Patch14", "Qwen-Image"], []), "Qwen-Image");
  assert.equal(chooseModel(["Qwen-Image-Edit-2511", "Qwen-Image"], ["qwen-image"]), "Qwen-Image");
});

test("payload only carries init_images for edits", () => {
  const base = { prompt: "p", model: "m", width: 64, height: 64, steps: 30, cfgScale: 7, negativePrompt: "n" };
  assert.equal("init_images" in buildPayload(base), false);
  const edit = buildPayload({ ...base, initImage: "abc", denoisingStrength: 0.5 });
  assert.deepEqual(edit.init_images, ["abc"]);
  assert.equal(edit.denoising_strength, 0.5);
});

function fakeFetch(calls) {
  return async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/sd-models")) {
      return { ok: true, status: 200, text: async () => JSON.stringify([{ title: "Plain" }, { title: "Flux-Fast" }]) };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ images: [Buffer.from("png-bytes").toString("base64")] }),
    };
  };
}

test("generator resolves 'auto', uses txt2img and releases the slot", async () => {
  const calls = [];
  let released = 0;
  const generate = createImageGenerator({
    getApiKey: async () => "k",
    acquire: async () => () => { released += 1; },
    preference: ["flux"],
    fetchFn: fakeFetch(calls),
  });
  const result = await generate({ model: "auto", prompt: "a cat" });
  assert.equal(result.model, "Flux-Fast");
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].buffer.toString(), "png-bytes");
  assert.ok(calls[1].url.endsWith("/sdapi/v1/txt2img"));
  assert.equal(JSON.parse(calls[1].init.body).sd_model_checkpoint, "Flux-Fast");
  assert.equal(released, 1);
});

test("generator uses img2img when a source image is supplied", async () => {
  const calls = [];
  const generate = createImageGenerator({ getApiKey: async () => "k", fetchFn: fakeFetch(calls) });
  await generate({ model: "Plain", prompt: "make it blue", inputImages: [{ buffer: Buffer.from("src"), mimeType: "image/png" }] });
  assert.ok(calls[0].url.endsWith("/sdapi/v1/img2img"));
  assert.deepEqual(JSON.parse(calls[0].init.body).init_images, [Buffer.from("src").toString("base64")]);
});

test("generator reports upstream errors and still releases the slot", async () => {
  let released = 0;
  const generate = createImageGenerator({
    getApiKey: async () => "k",
    acquire: async () => () => { released += 1; },
    fetchFn: async () => ({ ok: false, status: 429, text: async () => "too many" }),
  });
  await assert.rejects(generate({ model: "Plain", prompt: "x" }), /429/);
  assert.equal(released, 1);
});

test("an edit with model 'auto' prefers the edit model", async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/sd-models")) {
      return { ok: true, status: 200, text: async () => JSON.stringify(["Gen-Model", "Edit-Model"]) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ images: [Buffer.from("x").toString("base64")] }) };
  };
  const generate = createImageGenerator({
    getApiKey: async () => "k",
    preference: ["gen-model"],
    editPreference: ["edit-model"],
    fetchFn,
  });
  const edited = await generate({ model: "auto", prompt: "p", inputImages: [{ buffer: Buffer.from("s") }] });
  assert.equal(edited.model, "Edit-Model");
  const fresh = await generate({ model: "auto", prompt: "p" });
  assert.equal(fresh.model, "Gen-Model");
});
