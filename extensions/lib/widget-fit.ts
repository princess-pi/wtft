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

/**
 * The widget's whole line array: `renderChart(rows)` is asked for fewer interval rows, oldest
 * first since the chart is newest-first, until the widget fits. `null` when there is no chart.
 */
export function fitWidget(
	renderChart: (rows: number) => string[] | null,
	status: string,
	width: number,
	tail: string[],
	limit: number,
	max = PI_WIDGET_MAX_LINES,
): string[] | null {
	// A widget line holds at most one row, so a limit above the cap can never fit.
	const start = Number.isFinite(limit) ? Math.max(1, Math.min(Math.floor(limit), max)) : max;
	for (let rows = start; rows >= 1; rows--) {
		const chart = renderChart(rows);
		if (!chart || chart.length === 0) return null;
		const lines = widgetLines(chart, status, width, tail);
		if (lines.length <= max || rows === 1) return keepTail(lines, tail.length, max);
	}
	return null;
}

/** Cut to `max` lines from the middle, so the provisional lines at the end are the last to go. */
export function keepTail(lines: string[], tailLength: number, max = PI_WIDGET_MAX_LINES): string[] {
	if (lines.length <= max) return lines;
	const keep = Math.min(tailLength, max);
	return [...lines.slice(0, max - keep), ...lines.slice(lines.length - keep)];
}
