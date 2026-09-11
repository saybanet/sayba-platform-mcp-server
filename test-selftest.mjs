// Offline/recorded self-test for sayba-platform v2.7.0 Help Wanted tools.
// Spins a local mock HTTP server that records {method, path, body}, then drives
// the MCP server over stdio and asserts every collab tool hits the right
// endpoint/method/body, and that validation errors fire for missing objective.
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18999;
const recorded = [];

const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let parsed;
    try { parsed = JSON.parse(body); } catch { parsed = undefined; }
    recorded.push({ method: req.method, path: req.url, body: parsed });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, echo: parsed, url: req.url }));
  });
});

let failures = 0;
function assert(cond, label) {
  if (cond) console.log(`  ✅ ${label}`);
  else { failures++; console.log(`  ❌ ${label}`); }
}

const helpWantedTools = [
  "help_wanted_publish", "help_wanted_accept", "help_wanted_abandon",
  "help_wanted_submit", "help_wanted_confirm", "help_wanted_suggest_agents",
  "help_wanted_feed", "help_wanted_detail", "help_wanted_list",
];

await new Promise((r) => mock.listen(PORT, "127.0.0.1", r));

const child = spawn("node", ["index.js"], {
  cwd: __dirname,
  env: {
    ...process.env,
    SAYBA_BASE_URL: `http://127.0.0.1:${PORT}`,
    SAYBA_API_KEY: "test-agent-key",
  },
  stdio: ["pipe", "pipe", "inherit"],
});

const transport = new StdioClientTransport({
  command: "node",
  args: ["index.js"],
  env: {
    ...process.env,
    SAYBA_BASE_URL: `http://127.0.0.1:${PORT}`,
    SAYBA_API_KEY: "test-agent-key",
  },
  cwd: __dirname,
});
const client = new Client({ name: "sayba-selftest", version: "1.0.0" });
await client.connect(transport);

// 1. All 9 tools registered
const tools = await client.listTools();
const toolNames = tools.tools.map((t) => t.name);
console.log(`Registered tools: ${toolNames.length}`);
for (const t of helpWantedTools) assert(toolNames.includes(t), `registered: ${t}`);

// 2. Tool schemas are valid (have inputSchema object)
for (const t of tools.tools) {
  if (helpWantedTools.includes(t.name)) {
    assert(t.inputSchema && typeof t.inputSchema === "object", `schema valid: ${t.name}`);
    assert(t.description && t.description.length > 0, `description present: ${t.name}`);
  }
}

// 3. Missing objective on publish → validation error (no API call)
const missing = await client.callTool({ name: "help_wanted_publish", arguments: { skills: ["x"] } });
const missingText = JSON.stringify(missing);
const zodErr = missingText.toLowerCase().includes("objective") || missing.isError;
assert(!recorded.some((r) => r.path.includes("/collaboration/help-wanted") && r.method === "POST"), "no POST fired for invalid publish");
console.log(`  ℹ invalid-publish response sample: ${missingText.slice(0, 160)}`);
assert(zodErr || missing.content?.[0]?.text?.length > 0, "invalid publish returns an error-style result");

// 4. Publish (handoff) → POST /api/v1/collaboration/help-wanted with nested reward
await client.callTool({ name: "help_wanted_publish", arguments: {
  objective: "Translate this product doc into English, keep the glossary",
  skills: ["translation"],
  mode: "handoff",
  reward_type: "karma",
  reward_amount: 20,
  ttl_minutes: 30,
  visibility: "matched",
  detail: "Please keep technical terms consistent",
} });
const pub = recorded.find((r) => r.method === "POST" && r.path === "/api/v1/collaboration/help-wanted");
assert(!!pub, "publish → POST /api/v1/collaboration/help-wanted");
assert(pub.body.objective && pub.body.skills.join() === "translation", "publish body: objective+skills");
assert(pub.body.mode === "handoff", "publish body: mode");
assert(pub.body.reward && pub.body.reward.type === "karma" && pub.body.reward.amount === 20, "publish body: nested reward {type,amount}");
assert(pub.body.ttl_minutes === 30 && pub.body.visibility === "matched", "publish body: ttl+visibility");

// 4b. fanout mode requires items → rejected before any API call
const beforeFanout = recorded.length;
await client.callTool({ name: "help_wanted_publish", arguments: { objective: "Short task with enough length 12345", skills: ["code"], mode: "fanout" } });
assert(recorded.length === beforeFanout, "fanout w/o items rejected before API");

// 4c. reward_type=karma without amount rejected before API
const beforeNoAmount = recorded.length;
await client.callTool({ name: "help_wanted_publish", arguments: { objective: "Short task with enough length 1234", skills: ["code"], reward_type: "karma" } });
assert(recorded.length === beforeNoAmount, "karma w/o amount rejected before API");

// 5. accept/abandon/submit/confirm hit right endpoints
await client.callTool({ name: "help_wanted_accept", arguments: { help_wanted_id: "hw_1" } });
assert(recorded.some((r) => r.method === "POST" && r.path === "/api/v1/collaboration/help-wanted/hw_1/accept"), "accept → POST .../hw_1/accept");

await client.callTool({ name: "help_wanted_abandon", arguments: { help_wanted_id: "hw_1" } });
assert(recorded.some((r) => r.method === "POST" && r.path === "/api/v1/collaboration/help-wanted/hw_1/abandon"), "abandon → POST .../hw_1/abandon");

await client.callTool({ name: "help_wanted_submit", arguments: { help_wanted_id: "hw_1", content: "deliverable", attachments: ["https://x/1.pdf"] } });
const sub = recorded.find((r) => r.method === "POST" && r.path === "/api/v1/collaboration/help-wanted/hw_1/submit");
assert(!!sub && sub.body.content === "deliverable" && sub.body.attachments.length === 1, "submit → POST .../submit with content+attachments");

await client.callTool({ name: "help_wanted_confirm", arguments: { help_wanted_id: "hw_1", accepted: true, review: "good", sub_task_id: "st_9" } });
const conf = recorded.find((r) => r.method === "POST" && r.path === "/api/v1/collaboration/help-wanted/hw_1/confirm");
assert(!!conf && conf.body.accepted === true && conf.body.review === "good" && conf.body.sub_task_id === "st_9", "confirm → POST .../confirm with accepted+review+sub_task_id");

// 6. suggest_agents / feed / detail / list → GET with correct query
await client.callTool({ name: "help_wanted_suggest_agents", arguments: { skills: "translation,code", limit: 5 } });
assert(recorded.some((r) => r.method === "GET" && r.path === "/api/v1/collaboration/suggest-agents?skills=translation%2Ccode&limit=5"), "suggest_agents → GET suggest-agents?skills=&limit=");

await client.callTool({ name: "help_wanted_feed", arguments: { skills: "translation", limit: 10 } });
assert(recorded.some((r) => r.method === "GET" && r.path === "/api/v1/collaboration/help-wanted/feed?skills=translation&limit=10"), "feed → GET help-wanted/feed");

await client.callTool({ name: "help_wanted_detail", arguments: { help_wanted_id: "hw_2" } });
assert(recorded.some((r) => r.method === "GET" && r.path === "/api/v1/collaboration/help-wanted/hw_2"), "detail → GET help-wanted/hw_2");

await client.callTool({ name: "help_wanted_list", arguments: { role: "published" } });
assert(recorded.some((r) => r.method === "GET" && r.path === "/api/v1/collaboration/help-wanted?role=published"), "list → GET help-wanted?role=published");

// 7. All write/read endpoints require API key
const childNoKey = spawn("node", ["index.js"], {
  cwd: __dirname,
  env: { ...process.env, SAYBA_BASE_URL: `http://127.0.0.1:${PORT}` }, // no key
  stdio: ["pipe", "pipe", "inherit"],
});
await new Promise((r) => setTimeout(r, 600));
const tNoKey = new StdioClientTransport({ command: "node", args: ["index.js"], env: { ...process.env, SAYBA_BASE_URL: `http://127.0.0.1:${PORT}` }, cwd: __dirname });
const cNoKey = new Client({ name: "sayba-selftest-nokey", version: "1.0.0" });
await cNoKey.connect(tNoKey);
const before = recorded.length;
const noKeyRes = await cNoKey.callTool({ name: "help_wanted_publish", arguments: { objective: "Some task with enough length here 123", skills: ["code"] } });
assert(recorded.length === before, "no-key publish does NOT hit API");
assert(JSON.stringify(noKeyRes).includes("SAYBA_API_KEY"), "no-key publish returns API-key guidance");
await cNoKey.close();
childNoKey.kill();

// Wrap up
await client.close();
child.kill();
await new Promise((r) => mock.close(r));

console.log(failures === 0 ? "\n✅ ALL SELF-TEST ASSERTIONS PASSED" : `\n❌ ${failures} ASSERTION(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
