import * as assert from "node:assert";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(REPO, "docs", "manifests", "wtft-cmd.json"), "utf8"));
const html = fs.readFileSync(path.join(REPO, "docs", "wtft.html"), "utf8");
const watchLib = fs.readFileSync(path.join(REPO, "extensions", "lib", "wtft-daemon-lib.ts"), "utf8");
const whyText = manifest.why.map((w: { result?: string }) => w.result ?? "").join("\n");
const watchFlag = manifest.usage.find((f: { flags: string }) => f.flags === "-W, --watch");

describe("#518 the docs say what --watch and the Pi widget do", () => {
	it("--watch is documented as watching the tag file, needing a TTY, with an r restart key", () => {
		assert.match(watchLib, /fs\.watch\(tagPath/);
		assert.match(watchLib, /requires a real terminal \(TTY\)/);
		assert.match(watchFlag.desc, /tag file/);
		assert.match(watchFlag.desc, /TTY/);
		assert.match(watchFlag.desc, /\br restarts/);
	});

	it("no text claims the Pi widget ignores --watch or --json, or that the CLI prints no daemon status", () => {
		for (const stale of ["the Pi widget ignores --watch", "the Pi widget ignores --json", "the CLI prints no daemon status"]) {
			assert.ok(!whyText.includes(stale) && !watchFlag.desc.includes(stale), `still claims: ${stale}`);
		}
		assert.match(watchLib, /renderDaemonStatus\(daemonStatus\)/);
	});

	it("wtft.html caps width at 1023 only under --watch", () => {
		assert.ok(!html.includes("on each side, capped at 1023"), "wtft.html still caps the one-shot chart");
	});
});
