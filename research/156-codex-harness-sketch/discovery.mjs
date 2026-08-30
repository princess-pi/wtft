// ---
// research/156-codex-harness-sketch/discovery.mjs — the seam's acceptance test (#156)
//
// A third harness, written as new files only. Nothing in extensions/lib was
// edited to make this work: no renderer change, no cost change, no daemon
// change, no edit to the selector's shared logic. If that ever stops being
// true, the seam is in the wrong place.
//
// Written as .mjs on purpose — it exercises the out-of-tree channel, which
// loads through config with no rebuild. An in-repo harness would be the same
// code as extensions/lib/harness/codex/discovery.ts instead.
//
// Layout invented for the sketch: ~/.codex/sessions/<project-slug>/<id>.jsonl
// ---
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const ID = "codex";

function root() {
	return process.env.CODEX_SESSIONS_DIR || path.join(os.homedir(), ".codex", "sessions");
}

function listFiles() {
	const out = [];
	let dirs = [];
	try {
		dirs = fs.readdirSync(root(), { withFileTypes: true }).filter(e => e.isDirectory());
	} catch { return out; }
	for (const d of dirs) {
		let files = [];
		// withFileTypes + isFile(): the outer walk already filters to directories,
		// but the inner one used names only, so a DIRECTORY named `x.jsonl` was
		// returned as a transcript candidate and `discover()` would statSync it
		// happily and hand a directory to a consumer expecting JSONL. (#42 review.)
		try { files = fs.readdirSync(path.join(root(), d.name), { withFileTypes: true }); } catch { continue; }
		for (const f of files) {
			if (f.isFile() && f.name.endsWith(".jsonl")) out.push({ file: path.join(root(), d.name, f.name), slug: d.name });
		}
	}
	return out;
}

export const discovery = {
	id: ID,
	label: "Codex",

	discover(targetCwd) {
		const target = path.resolve(targetCwd || process.cwd());
		const targetSlug = target.replace(/[/\\]/g, "-");
		const out = [];
		for (const { file, slug } of listFiles()) {
			if (slug !== targetSlug) continue;
			let stat;
			try { stat = fs.statSync(file); } catch { continue; }
			out.push({
				path: file,
				harness: ID,
				timestamp: stat.mtimeMs,
				name: path.basename(file),
				displayPath: `codex:${path.basename(file).replace(/\.jsonl$/, "")}`,
			});
		}
		return out;
	},

	resolveSessionById(sessionId) {
		const wanted = sessionId.replace(/\.jsonl$/i, "");
		for (const { file } of listFiles()) {
			if (path.basename(file).replace(/\.jsonl$/i, "") === wanted) return file;
		}
		return null;
	},
};

export default discovery;
