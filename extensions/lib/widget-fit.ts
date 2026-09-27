/**
 * WidgetFit: the Pi widget's line array, fitted under Pi's cap. docs/spec-269-widget-fit.md.
 */

import { getVisualLength } from "./wtft-renderer.js";

/** Pi's `MAX_WIDGET_LINES` for a string-array widget (Pi 0.87.1); past it Pi prints "... (widget truncated)". */
export const PI_WIDGET_MAX_LINES = 10;

/** The chart with the daemon status on the title line when it fits, else under the legend, and `tail` last. */
export function widgetLines(chart: string[], status: string, width: number, tail: string[]): string[] {
	const lines = [...chart];
	if (status) {
		if (getVisualLength(lines[0]!) + getVisualLength(status) <= width - 2) lines[0] = lines[0] + status;
		else lines.splice(2, 0, status.trim());
	}
	lines.push(...tail);
	return lines;
}

/** Renders with fewer interval rows until the widget fits: rows go oldest-first, since the chart is newest-first. */
export function fitWidget(render: (limit: number) => string[] | null, limit: number, max = PI_WIDGET_MAX_LINES): string[] | null {
	// A widget line holds at most one row, so a limit above the cap can never fit.
	for (let rows = Math.max(1, Math.min(limit, max)); ; rows--) {
		const lines = render(rows);
		if (!lines) return null;
		if (lines.length <= max || rows <= 1) return lines.slice(0, max);
	}
}
