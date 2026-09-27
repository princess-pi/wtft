/**
 * One session tagged in this process, poll by poll, with the clock the test
 * advances: what the daemon does for a session, minus the process (#279).
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { newTaggerState, fsWorld, stepTagger, type LogLine, type StepResult, type TaggerState, type World } from "../../extensions/lib/session-tagger.ts";
import { getCurrentVersionTagPath } from "../../extensions/lib/wtft-daemon-lib.ts";

/** The daemon's poll interval. */
export const POLL_MS = 667;

export interface TaggedSession {
	tagPath: string;
	state: TaggerState;
	world: World;
	/** Every poll's log lines, in order: what the daemon prints under WTFT_DAEMON_DEBUG. */
	log: LogLine[];
	/** One poll: step, append the records to the tag as the daemon does, advance the clock. */
	poll(ms?: number): StepResult;
	/** Polls until `done()` holds, at most `max` times. */
	until(done: () => boolean, max?: number): boolean;
	/** Moves the clock without polling. */
	advance(ms: number): void;
}

export function tagSession(sessionPath: string, opts: { start?: number; tagPath?: string } = {}): TaggedSession {
	const tagPath = opts.tagPath ?? getCurrentVersionTagPath(sessionPath);
	fs.mkdirSync(path.dirname(tagPath), { recursive: true });
	if (!fs.existsSync(tagPath)) fs.writeFileSync(tagPath, "");
	let now = opts.start ?? Date.now();
	const world = fsWorld(() => now);
	const state = newTaggerState(sessionPath, tagPath);
	const session: TaggedSession = {
		tagPath,
		state,
		world,
		log: [],
		poll(ms = POLL_MS) {
			const r = stepTagger(state, world, { flush: true });
			session.log.push(...r.log);
			if (r.records) fs.appendFileSync(tagPath, r.records);
			now += ms;
			return r;
		},
		until(done, max = 12) {
			for (let i = 0; i < max; i++) {
				session.poll();
				if (done()) return true;
			}
			return false;
		},
		advance(ms) { now += ms; },
	};
	return session;
}
