/** Tagger version stamped into tag filenames. Bump when tag semantics change so stale tags re-parse. */
export const WTFT_TAGGER_VERSION = "2.11.0";

/** Whether dotted version `a` is older than `b`; an empty `a` (no version
 *  file, so a build from before it existed) is older than anything. */
export function taggerIsOlder(a: string, b: string): boolean {
	if (!a) return true;
	const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
	for (let k = 0; k < Math.max(pa.length, pb.length); k++) {
		const x = pa[k] || 0, y = pb[k] || 0;
		if (x !== y) return x < y;
	}
	return false;
}
