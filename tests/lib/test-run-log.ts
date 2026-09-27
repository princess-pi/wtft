/**
 * One line per `bun run test` run, read by `pr-cost.ts`. docs/spec-277-pr-cost.md § 4.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface SuiteOutcome { name: string; ok: boolean }

export function appendTestRun(file: string, suites: SuiteOutcome[]): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, JSON.stringify({ utc: new Date().toISOString(), suites }) + "\n");
}
