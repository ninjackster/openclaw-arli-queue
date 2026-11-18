// Mock OpenAI-compatible chat completions server with ONE request slot.
// A second concurrent request gets HTTP 429, like Arli AI Plus.
import http from "node:http";
const port = Number(process.argv[2] || 18796);
const streamMs = Number(process.argv[3] || 4000);
let inFlight = 0;
const stats = { total: 0, accepted: 0, rejected429: 0, maxInFlight: 0, log: [] };
const stamp = () => new Date().toISOString().slice(11, 23);

http.createServer((req, res) => {
  if (req.method === "GET" && req.url.startsWith("/stats")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ...stats, inFlight }));
  }
  if (req.method === "GET" && req.url.startsWith("/v1/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model" }] }));
  }
  if (req.method !== "POST" || !req.url.startsWith("/v1/chat/completions")) {
    res.writeHead(404); return res.end();
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    stats.total += 1;
    if (inFlight >= 1) {
      stats.rejected429 += 1;
      stats.log.push(`${stamp()} 429 (inFlight=${inFlight})`);
      res.writeHead(429, { "content-type": "application/json" });
      return res.end(JSON.stringify({ message: "User test has exceeded the maximum number of parallel requests for PLUS (2/1). Please upgrade your plan!" }));
    }
    inFlight += 1; stats.accepted += 1;
    stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
    const n = stats.accepted;
    stats.log.push(`${stamp()} start #${n}`);
    let done = false;
    const finish = (why) => { if (done) return; done = true; inFlight -= 1; stats.log.push(`${stamp()} end #${n} (${why})`); };
    res.on("close", () => finish("closed"));
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const id = `chatcmpl-mock-${n}`;
    const chunk = (delta, finishReason = null) =>
      res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "mock-model", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
    chunk({ role: "assistant", content: "" });
    const words = `mock reply number ${n} ok`.split(" ");
    let i = 0;
    const timer = setInterval(() => {
      if (done) return clearInterval(timer);
      if (i < words.length) { chunk({ content: (i ? " " : "") + words[i] }); i += 1; return; }
      clearInterval(timer);
      chunk({}, "stop");
      res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "mock-model", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end(); finish("complete");
    }, Math.max(50, Math.floor(streamMs / (words.length + 1))));
  });
}).listen(port, "127.0.0.1", () => console.log(`mock one-slot server on 127.0.0.1:${port}, stream ${streamMs}ms`));
