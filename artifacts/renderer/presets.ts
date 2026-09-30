export interface Preset {
	label: string;
	argv: string[];
}

const COMMON = ["--tz", "UTC", "-i", "1h", "-l", "10"];

/** The chart's four pictures as wtft command lines. */
export const PRESETS: Record<string, Preset> = {
	"cost-cumulative": { label: "Cost, cumulative", argv: ["-c", "--cost", ...COMMON] },
	"cost-bucket": { label: "Cost, bucket", argv: ["-b", "--cost", ...COMMON] },
	"tokens-cumulative": { label: "Tokens, cumulative", argv: ["-c", "--tokens", ...COMMON] },
	"tokens-bucket": { label: "Tokens, bucket", argv: ["-b", "--tokens", ...COMMON] },
};

/** What the spec page's four blocks and the picker's first view are drawn under. */
export const SPEC_PIN = {
	columns: 160,
	now: Date.UTC(2026, 8, 26, 15, 30),
	model: "claude-sonnet-5-5",
	sessionFile: "/home/dupp/.claude/projects/-home-dupp-git-projects-wtft/f53ecbb3-93ab-4c1e-9d21-7be0d0a0ee07.jsonl",
};
