/**
 * @package princess-pi-tools
 * @module wtft-shared
 * @deprecated Import directly from the deep modules:
 *   wtft-cost.ts           — Pure cost calculation
 *   wtft-command-shapes.ts — What a bash command string is made of
 *   wtft-parser.ts         — Session parsing + classification
 *   wtft-renderer.ts   — Bar charts, histograms, terminal utilities
 *   wtft-daemon-lib.ts — Tag file I/O, daemon health, watch mode
 *
 * This barrel is kept temporarily for backward compatibility.
 */

// Re-export all public API from deep modules
export * from "./wtft-cost.js";
// Bash command shapes (#106) — segmentation the classifier and the daemon
// BOTH read, so neither can carry its own transcription of the other's rules.
export * from "./wtft-command-shapes.js";
export * from "./wtft-pricing-config.js";
export * from "./wtft-parser.js";
export * from "./wtft-renderer.js";
export * from "./wtft-daemon-lib.js";
// Machine-readable session summary (#26).
export * from "./wtft-json.js";
// Harness seam (#156) — registry lookups + the out-of-tree loader.
export * from "./harness/registry.ts";
export * from "./harness/session-cwd.ts";
