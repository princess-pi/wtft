// usage: [CHROME=<path>] node shot.mjs <url> <out.png> <waitSelector> [scrollSelector]
// Screenshots <url> at 1800x1400 once <waitSelector> exists. Exits 1, writing nothing, when it
// never appears within 20 s. CHROME defaults to the first chrome-headless-shell under
// ~/.cache/ms-playwright.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function findChrome() {
	if (process.env.CHROME) return process.env.CHROME;
	const root = join(homedir(), ".cache", "ms-playwright");
	for (const dir of existsSync(root) ? readdirSync(root) : []) {
		if (!dir.startsWith("chromium_headless_shell")) continue;
		const bin = join(root, dir, "chrome-headless-shell-linux64", "chrome-headless-shell");
		if (existsSync(bin)) return bin;
	}
	throw new Error("no chrome-headless-shell found; set CHROME");
}

const [url, out, waitFor, scrollTo] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(findChrome(), ["--no-sandbox", `--remote-debugging-port=${port}`, "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
let ws;
try {
	let target;
	for (let i = 0; i < 50 && !target; i++) {
		await sleep(200);
		try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page"); } catch {}
	}
	if (!target) throw new Error("chrome never offered a page");
	ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => { ws.addEventListener("open", resolve); ws.addEventListener("error", reject); });
	let id = 0;
	const pending = new Map();
	ws.addEventListener("message", (ev) => {
		const msg = JSON.parse(ev.data);
		if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
	});
	const send = (method, params = {}) => Promise.race([
		new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); }),
		sleep(10000).then(() => { throw new Error(`${method} timed out`); }),
	]);
	await send("Emulation.setDeviceMetricsOverride", { width: 1800, height: 1400, deviceScaleFactor: 1, mobile: false });
	await send("Page.navigate", { url });
	let found = false;
	for (let i = 0; i < 100 && !found; i++) {
		await sleep(200);
		const r = await send("Runtime.evaluate", { expression: `!!document.querySelector(${JSON.stringify(waitFor)})`, returnByValue: true });
		found = r.result?.result?.value === true;
	}
	if (!found) throw new Error(`never appeared: ${waitFor}`);
	if (scrollTo) await send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(scrollTo)})?.scrollIntoView()` });
	await sleep(800);
	const shot = await send("Page.captureScreenshot", { format: "png" });
	writeFileSync(out, Buffer.from(shot.result.data, "base64"));
} catch (err) {
	console.error(err.message);
	process.exitCode = 1;
} finally {
	ws?.close();
	chrome.kill();
}
