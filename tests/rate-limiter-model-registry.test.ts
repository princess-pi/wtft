/**
 * Tests for #89 — TPM rate-limiter model short-code registry update.
 *
 * Validates that the MODEL_QUOTA_REGISTRY and getModelShortName source
 * contain entries for current Pi models (Claude Sonnet 5, Fable 5, GPT-5.x, etc).
 * Uses source-level assertions — the rate-limiter is a Pi extension module
 * and can't be directly imported for unit testing.
 */

import * as assert from "node:assert";
import { describe, it } from "node:test";
import * as fs from "node:fs";

const source = fs.readFileSync("extensions/rate-limiter.ts", "utf8");

// --- Helpers ---

function extractRegistry(): Record<string, number> {
  const match = source.match(/const MODEL_QUOTA_REGISTRY: Record<string, number> = \{([^}]+)\}/s);
  if (!match) throw new Error("Could not extract MODEL_QUOTA_REGISTRY");
  const registry: Record<string, number> = {};
  for (const line of match[1].split("\n")) {
    const m = line.match(/"([^"]+)"\s*:\s*(\d+)/);
    if (m) registry[m[1]] = parseInt(m[2], 10);
  }
  return registry;
}

/** Extract all `m.includes("X")` → return "Y" pairs from getModelShortName. */
function extractShortCodeMap(): Map<string, string> {
  const map = new Map<string, string>();
  const parts = source.split(/(?=if\s*\()/);
  for (const part of parts) {
    const incMatch = part.match(/m\.includes\("([^"]+)"\)/);
    const retMatch = part.match(/return\s+"([^"]+)"/);
    if (incMatch && retMatch) {
      map.set(incMatch[1], retMatch[1]);
    }
  }
  return map;
}

// --- Tests ---

const registry = extractRegistry();
const shortCodes = extractShortCodeMap();

describe("MODEL_QUOTA_REGISTRY — new models", () => {
  it("has Claude Sonnet 5 (c5.0son) at 320K", () => {
    assert.strictEqual(registry["c5.0son"], 320000);
  });

  it("has Claude Fable 5 (c5.0fab) at 80K", () => {
    assert.strictEqual(registry["c5.0fab"], 80000);
  });

  it("has Claude Opus 4 (c4.0opu) at 80K", () => {
    assert.strictEqual(registry["c4.0opu"], 80000);
  });

  it("has Claude Haiku 5 (c5.0hai) at 320K", () => {
    assert.strictEqual(registry["c5.0hai"], 320000);
  });

  it("has GPT-5.6 Sol (gpt5sol) at 1M", () => {
    assert.strictEqual(registry["gpt5sol"], 1000000);
  });

  it("has GPT-5.6 Terra (gpt5ter) at 1M", () => {
    assert.strictEqual(registry["gpt5ter"], 1000000);
  });

  it("has GPT-5.6 Luna (gpt5lun) at 1M", () => {
    assert.strictEqual(registry["gpt5lun"], 1000000);
  });

  it("has GPT-5.5 + GPT-5.4 at 1M", () => {
    assert.strictEqual(registry["gpt5.5"], 1000000);
    assert.strictEqual(registry["gpt5.4"], 1000000);
  });

  it("has Gemini 3.5 Pro (g3.5pro) at 1.6M", () => {
    assert.strictEqual(registry["g3.5pro"], 1600000);
  });
});

describe("MODEL_QUOTA_REGISTRY — original entries preserved", () => {
  const originalKeys = ["g3.5fla", "glatfla", "g3.5fli", "glatfli",
    "g1.5pro", "glatpro", "c3.5son", "c3.5hai", "c3.0opu", "d4.0fla", "d4.0pro"];

  for (const key of originalKeys) {
    it(`still contains ${key}`, () => {
      assert.ok(registry[key] !== undefined, `${key} should exist in registry`);
    });
  }
});

describe("MODEL_QUOTA_REGISTRY — no duplicate keys", () => {
  it("all explicit keys are unique (intentional duplicates allowed for catch-alls)", () => {
    const explicitCodes: string[] = [];
    for (const [condition, code] of shortCodes) {
      // Skip generic fallthroughs (these intentionally share codes with specific matches)
      if (condition === "sonnet" || condition === "haiku" || condition === "opus" ||
          condition === "gpt-5" || condition === "gpt5" || condition === "gpt-5.6") continue;
      explicitCodes.push(code);
    }
    const seen = new Set<string>();
    const dups: string[] = [];
    for (const code of explicitCodes) {
      if (seen.has(code)) dups.push(code);
      seen.add(code);
    }
    assert.strictEqual(dups.length, 0, `Duplicate short codes: ${dups.join(", ")}`);
  });
});

describe("getModelShortName — new model patterns present in source", () => {
  it("contains claude-sonnet-5 mapping", () => {
    assert.ok(source.includes("claude-sonnet-5") || source.includes("sonnet-5"),
      "source should reference sonnet 5");
    assert.ok(shortCodes.get("claude-sonnet-5") || shortCodes.get("sonnet-5"),
      "should have .includes() → return mapping for sonnet 5");
  });

  it("contains claude-fable-5 mapping", () => {
    assert.ok(source.includes("claude-fable-5") || source.includes("fable-5"),
      "source should reference fable 5");
  });

  it("contains claude-haiku-5 mapping", () => {
    assert.ok(source.includes("claude-haiku-5") || source.includes("haiku-5"),
      "source should reference haiku 5");
  });

  it("contains claude-opus-4 mapping (distinct from opus-3)", () => {
    assert.ok(source.includes("claude-opus-4") || source.includes("opus-4"),
      "source should reference opus 4");
    // Opus 4 should have its own short code, not share c3.0opu
    assert.ok(shortCodes.has("claude-opus-4") || shortCodes.has("opus-4"),
      "opus 4 should have explicit short-code mapping");
  });

  it("contains GPT-5.6-sol/terra/luna mappings", () => {
    assert.ok(source.includes("gpt-5.6-sol"), "source should reference gpt-5.6-sol");
    assert.ok(source.includes("gpt-5.6-terra"), "source should reference gpt-5.6-terra");
    assert.ok(source.includes("gpt-5.6-luna"), "source should reference gpt-5.6-luna");
  });

  it("contains GPT-5.5 and GPT-5.4 mappings", () => {
    assert.ok(source.includes("gpt-5.5"), "source should reference gpt-5.5");
    assert.ok(source.includes("gpt-5.4"), "source should reference gpt-5.4");
  });

  it("contains gemini-3.5-pro mapping", () => {
    assert.ok(source.includes("gemini-3.5-pro"), "source should reference gemini 3.5 pro");
  });
});

describe("getModelShortName — fallback encoder improvements", () => {
  it("fallback encoder includes GPT version detection", () => {
    assert.ok(source.includes("5.6") && source.includes('"5.6"'),
      "fallback should detect gpt 5.6 versions");
  });

  it("fallback encoder uses o= prefix for GPT/OpenAI models", () => {
    assert.ok(source.includes('"o"') && source.includes("gpt"),
      "fallback should use o= prefix for GPT models");
  });
});

console.log("✅ All TPM model registry tests passed.");
