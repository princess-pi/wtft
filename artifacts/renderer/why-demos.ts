import { renderReport } from "./report.ts";
import { wtftSession } from "./fake-session.ts";
import { SPEC_PIN } from "./presets.ts";

/** What every rendered `--why` demo is drawn under: the spec page's session and clock, a narrower terminal, UTC. */
export const WHY_DEMO_PIN = {
	columns: 120,
	now: SPEC_PIN.now,
	timezone: "UTC",
	model: SPEC_PIN.model,
	sessionFile: SPEC_PIN.sessionFile,
};

/** A `why[]` entry's `demo` rows for its first command, as the `wtft` report prints them under WHY_DEMO_PIN; `--watch` and `-p` draw other frames. Throws on a command the CLI would refuse. */
export function whyDemo(command: string): string[] {
	const argv = command.split(/\s+/).filter((word) => word.length > 0);
	const report = renderReport(argv, {
		columns: WHY_DEMO_PIN.columns,
		now: WHY_DEMO_PIN.now,
		sessionFile: WHY_DEMO_PIN.sessionFile,
		interactions: wtftSession(WHY_DEMO_PIN.model),
		config: { timezone: WHY_DEMO_PIN.timezone },
	});
	if (report.opts.usageError !== undefined) throw new Error(`--why demo "${command}": ${report.opts.usageError}`);
	return report.lines;
}
