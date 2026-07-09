/**
 * @package princess-pi-packages
 * @module wtft-shared
 * @deprecated Import directly from the deep modules:
 *   wtft-cost.ts       — Pure cost calculation
 *   wtft-parser.ts     — Session parsing + classification
 *   wtft-renderer.ts   — Bar charts, histograms, terminal utilities
 *   wtft-daemon-lib.ts — Tag file I/O, daemon health, watch mode
 *
 * This barrel is kept temporarily for backward compatibility.
 */

// Re-export all public API from deep modules
export * from "./wtft-cost.js";
export * from "./wtft-parser.js";
export * from "./wtft-renderer.js";
export * from "./wtft-daemon-lib.js";
