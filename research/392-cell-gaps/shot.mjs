// node shot.mjs <url> <out.png> <waitSelector> [scrollSelector]
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const [url, out, waitFor, scrollTo] = process.argv.slice(2);
const HS = "/home/princess-pi/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell";
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(HS, ["--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1800,1400", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 50 && !target; i++) {
	await sleep(200);
	try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page"); } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
	const msg = JSON.parse(ev.data);
	if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
	if (msg.method === "Runtime.consoleAPICalled") console.error("console:", msg.params.args.map((a) => a.value ?? a.description).join(" "));
	if (msg.method === "Runtime.exceptionThrown") console.error("exception:", msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
});
const send = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1800, height: 1400, deviceScaleFactor: 1, mobile: false });
await send("Page.enable");
await send("Page.navigate", { url });
let found = false;
for (let i = 0; i < 100 && !found; i++) {
	await sleep(200);
	const r = await send("Runtime.evaluate", { expression: `!!document.querySelector(${JSON.stringify(waitFor)})`, returnByValue: true });
	found = r.result?.result?.value === true;
}
if (!found) console.error("never appeared:", waitFor);
if (scrollTo) await send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(scrollTo)})?.scrollIntoView()` });
await sleep(800);
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(out, Buffer.from(shot.result.data, "base64"));
ws.close();
chrome.kill();
