/**
 * One live spec per module: docs/spec-<module>.md states the behaviour of
 * extensions/lib/<module>.ts, and a per-issue spec whose behaviour moved there
 * says so in its header.
 */

import * as assert from "node:assert";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const DOCS = path.join(REPO, "docs");
const specs = fs.readdirSync(DOCS).filter(f => /^spec-.*\.md$/.test(f));
const read = (f: string) => fs.readFileSync(path.join(DOCS, f), "utf8");
// An unnumbered spec that says so; a numbered one may quote a PR body's Module line.
const moduleSpecs = specs.filter(f => !/^spec-\d/.test(f) && /^Module: `extensions\/lib\//m.test(read(f)));
const header = (f: string) => read(f).split("\n").slice(0, 15).join("\n");

describe("module specs", () => {
	it("exist", () => {
		assert.ok(moduleSpecs.includes("spec-daemon-health.md"), `module specs: ${moduleSpecs.join(", ")}`);
	});

	for (const f of moduleSpecs) {
		const name = f.slice("spec-".length, -".md".length);
		const source = path.join(REPO, "extensions", "lib", `${name}.ts`);

		it(`${f} names its module, and the module exists`, () => {
			assert.ok(fs.existsSync(source), `${f} has no extensions/lib/${name}.ts`);
			assert.ok(read(f).includes(`Module: \`extensions/lib/${name}.ts\``), `${f}'s Module line does not name extensions/lib/${name}.ts`);
		});

		it(`${f}'s seam is exported by the module and tested by a suite that exists`, () => {
			const m = read(f).match(/Seam: `(\w+)`, tested in `(tests\/[^`]+)`/);
			assert.ok(m, `${f} has no "Seam: \`fn\`, tested in \`tests/...\`" line`);
			assert.match(fs.readFileSync(source, "utf8"), new RegExp(`export function ${m![1]}\\b`));
			assert.ok(fs.existsSync(path.join(REPO, m![2])), `${m![2]} does not exist`);
		});

		it(`every change record ${f} lists says so in its own header`, () => {
			const section = read(f).split(/^## \d+\. Change records$/m)[1]?.split(/^## /m)[0];
			assert.ok(section, `${f} has no "Change records" section`);
			const records = [...section.matchAll(/`docs\/(spec-\d[^`]+\.md)`/g)].map(r => r[1]);
			assert.ok(records.length > 0);
			for (const r of records) {
				assert.ok(specs.includes(r), `${r} does not exist`);
				assert.match(header(r), new RegExp(`Superseded[^\\n]*${f.replace(/[.-]/g, "\\$&")}`), `${r}'s header does not point at ${f}`);
			}
		});
	}
});
