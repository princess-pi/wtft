import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---
// CONFIGURATION
// ---

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, ".claude", "projects");
const PI_DIR = path.join(HOME, ".pi", "agent", "sessions");
const COFFEE_FILE = "/tmp/pi-rate-limit-coffee.json";

// Safe model-specific limit ceilings (80% of actual subscription quota)
const MODEL_QUOTA_REGISTRY: Record<string, number> = {
  "g3.5fla": 2500000,  // gemini-3.5-flash (Tier 2 limit: 3.0M)
  "glatfla": 2500000,  // gemini-flash-latest (Tier 2 limit: 3.0M)
  "g3.5fli": 2500000,  // gemini-3.5-flash-lite (Tier 2 limit: 3.0M)
  "glatfli": 2500000,  // gemini-flash-lite-latest (Tier 2 limit: 3.0M)
  "g1.5pro": 1600000,  // gemini-1.5-pro (Tier 2 limit: 2.0M)
  "glatpro": 1600000,  // gemini-pro-latest (Tier 2 limit: 2.0M)
  "c3.5son": 320000,   // claude-3-5-sonnet (Tier 4 limit: 400K)
  "c3.5hai": 320000,   // claude-3-5-haiku
  "c3.0opu": 80000,    // claude-3-opus (Opus standard limit)
};

const DEFAULT_CEILING = 1000000;
const BAR_WIDTH = 5;
const COOLDOWN_DURATION_MS = 40000; // 40 seconds flat "coffee break"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Keep track of widget visibility state in-memory
let isWidgetVisible = true;

// ---
// HELPERS
// ---

function getModelShortName(modelName: string): string {
  if (!modelName) return "unknown";
  const m = modelName.toLowerCase();

  if (m.includes("gemini-3.5-flash")) return "g3.5fla";
  if (m.includes("gemini-flash-latest")) return "glatfla";
  if (m.includes("gemini-3.5-flash-lite")) return "g3.5fli";
  if (m.includes("gemini-flash-lite-latest")) return "glatfli";
  if (m.includes("gemini-1.5-pro")) return "g1.5pro";
  if (m.includes("claude-3-5-sonnet") || m.includes("claude-sonnet-4-6") || m.includes("claude-3-5-sonnet-20240620") || m.includes("claude-3-5-sonnet-20241022")) {
    return "c3.5son";
  }
  if (m.includes("claude-3-5-haiku") || m.includes("claude-3-5-haiku-20241022")) {
    return "c3.5hai";
  }
  if (m.includes("claude-3-opus") || m.includes("claude-3-0-opus") || m.includes("opus")) {
    return "c3.0opu";
  }

  // Fallback fixed-width 7-char encoder (C-VVV-MMM)
  const comp = m.includes("gemini") || m.includes("google") ? "g" : "c";
  
  let ver = "3.5";
  if (m.includes("latest")) ver = "lat";
  else if (m.includes("3.0") || m.includes("3-0")) ver = "3.0";
  else if (m.includes("1.5") || m.includes("1-5")) ver = "1.5";

  let modelPart = "unk";
  const parts = m.split("-");
  const lastPart = parts[parts.length - 1];
  if (lastPart) {
    if (lastPart === "lite" || (lastPart === "latest" && m.includes("lite"))) modelPart = "fli";
    else if (lastPart === "latest" && m.includes("flash")) modelPart = "fla";
    else if (lastPart === "latest" && m.includes("pro")) modelPart = "pro";
    else modelPart = lastPart.slice(0, 3);
  }

  return (comp + ver + modelPart).padEnd(7, " ").slice(0, 7);
}

function getReadableSize(tokens: number): string {
  if (tokens >= 1000000) {
    return `${(tokens / 1000000).toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}K`;
  }
  return `${tokens}`;
}

interface FileInfo {
  path: string;
  mtime: number;
}

function findActiveSessionFiles(): FileInfo[] {
  const activeFiles: FileInfo[] = [];
  const now = Date.now();
  const TWO_MINUTES_MS = 2 * 60 * 1000;

  function scanDir(dir: string) {
    if (!fs.existsSync(dir)) return;
    try {
      const files = fs.readdirSync(dir);
      for (const f of files) {
        const fullPath = path.join(dir, f);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          scanDir(fullPath);
        } else if (f.endsWith(".jsonl")) {
          if (now - stat.mtimeMs < TWO_MINUTES_MS) {
            activeFiles.push({ path: fullPath, mtime: stat.mtimeMs });
          }
        }
      }
    } catch (err) {
      // ignore
    }
  }

  scanDir(CLAUDE_DIR);
  scanDir(PI_DIR);

  return activeFiles;
}

interface ModelStats {
  tpm: number;
  lastActiveAge: number;
  sessionTpm: number; // Tokens spent ONLY by the hosting session
}

function aggregateActiveTpm(activeFiles: FileInfo[], hostingSessionId: string | null): Record<string, ModelStats> {
  const modelStats: Record<string, ModelStats> = {};
  const now = Date.now();

  for (const { path: filePath } of activeFiles) {
    try {
      const isHostingSession = hostingSessionId && filePath.includes(hostingSessionId);
      const content = fs.readFileSync(filePath, "utf8");
      const lines = content.split("\n").filter(Boolean);

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (!entry) continue;

          const msg = entry.message;
          const timestampStr = msg?.timestamp || entry.timestamp;
          let timestamp = 0;
          if (typeof timestampStr === "string") {
            timestamp = new Date(timestampStr).getTime();
          } else if (typeof timestampStr === "number") {
            timestamp = timestampStr;
          }

          if (!timestamp) continue;

          const age = now - timestamp;
          if (age > 120000) continue;

          let modelName = "";
          if (msg?.model) {
            modelName = msg.model;
          } else if (entry.model) {
            modelName = entry.model;
          }

          if (!modelName) continue;
          const shortCode = getModelShortName(modelName);

          if (!modelStats[shortCode]) {
            modelStats[shortCode] = { tpm: 0, lastActiveAge: 120000, sessionTpm: 0 };
          }

          modelStats[shortCode].lastActiveAge = Math.min(modelStats[shortCode].lastActiveAge, age);

          if (age <= 60000) {
            let inputTokens = 0;
            if (entry.usage && typeof entry.usage.input_tokens === "number") {
              inputTokens = entry.usage.input_tokens;
            } else if (msg?.usage) {
              inputTokens = msg.usage.input_tokens || msg.usage.input_token_count || msg.usage.prompt_tokens || 0;
            }
            
            // Increment global TPM
            modelStats[shortCode].tpm += inputTokens;
            
            // If this is the hosting session, increment session-only TPM
            if (isHostingSession) {
              modelStats[shortCode].sessionTpm += inputTokens;
            }
          }
        } catch (e) {
          // ignore line parses
        }
      }
    } catch (err) {
      // ignore
    }
  }

  return modelStats;
}

// ---
// WIDGET RENDERER
// ---

function updateRateLimiterWidget(ctx: ExtensionContext) {
  if (!isWidgetVisible) {
    ctx.ui.setWidget("rate-limiter", undefined);
    return;
  }

  try {
    const activeFiles = findActiveSessionFiles();
    const hostingSessionId = ctx.sessionManager.getSessionId() || null;
    
    // Always find current model of the hosting session
    const context = ctx.sessionManager.buildSessionContext();
    const currentModel = context.model?.modelId || "unknown";
    const hostingShortCode = getModelShortName(currentModel);

    const stats = aggregateActiveTpm(activeFiles, hostingSessionId);
    
    // Ensure hosting shortcode exists in our list even if 0 TPM
    if (!stats[hostingShortCode]) {
      stats[hostingShortCode] = { tpm: 0, lastActiveAge: 0, sessionTpm: 0 };
    }

    const lines: string[] = [];
    lines.push(`\x1b[1;36m🛡️  Token Sentinel (TPM Active Monitors) ───────────────────\x1b[0m`);

    // Render hosting session's model FIRST and BOLDED
    const hostingData = stats[hostingShortCode];
    const hostingCeiling = MODEL_QUOTA_REGISTRY[hostingShortCode] || DEFAULT_CEILING;
    
    let hFilled = Math.min(Math.round((hostingData.tpm / hostingCeiling) * BAR_WIDTH), BAR_WIDTH);
    if (hostingData.tpm > 0 && hFilled === 0) {
      hFilled = 1;
    }
    const hBar = "$".repeat(hFilled) + " ".repeat(BAR_WIDTH - hFilled);
    
    let hColor = "\x1b[32m"; // Green
    if (hostingData.tpm > hostingCeiling * 0.8) hColor = "\x1b[31;1m"; // Red
    else if (hostingData.tpm > hostingCeiling * 0.5) hColor = "\x1b[33m"; // Yellow

    const hSessionStr = getReadableSize(hostingData.sessionTpm);
    const hGlobalStr = getReadableSize(hostingData.tpm);
    const hLimitStr = getReadableSize(hostingCeiling);

    lines.push(`\x1b[1m  👉 ${hColor}[${hBar}] ${hostingShortCode}\x1b[0m\x1b[1m: ${hSessionStr} (session) / ${hGlobalStr} (global) of ${hLimitStr} max\x1b[0m`);

    // Render other active models (non-bolded, auto-pruned)
    for (const [shortCode, data] of Object.entries(stats)) {
      if (shortCode === hostingShortCode) continue; // Already rendered first

      // Auto-prune other models if 0 TPM for >= 2 minutes
      if (data.tpm === 0 && data.lastActiveAge >= 120000) {
        continue;
      }

      const ceiling = MODEL_QUOTA_REGISTRY[shortCode] || DEFAULT_CEILING;
      let filled = Math.min(Math.round((data.tpm / ceiling) * BAR_WIDTH), BAR_WIDTH);
      if (data.tpm > 0 && filled === 0) {
        filled = 1;
      }
      const bar = "$".repeat(filled) + " ".repeat(BAR_WIDTH - filled);

      let color = "\x1b[32m";
      if (data.tpm > ceiling * 0.8) color = "\x1b[31;1m";
      else if (data.tpm > ceiling * 0.5) color = "\x1b[33m";
      else if (data.tpm === 0) color = "\x1b[90m"; // Gray

      const globalStr = getReadableSize(data.tpm);
      const limitStr = getReadableSize(ceiling);

      lines.push(`     ${color}[${bar}] ${shortCode}\x1b[0m: ${globalStr} (global) of ${limitStr} max`);
    }

    ctx.ui.setWidget("rate-limiter", lines, { placement: "belowEditor" });
  } catch (err: any) {
    ctx.ui.setWidget("rate-limiter", [`⚠️ Rate Limiter Widget Error: ${err.message}`], { placement: "belowEditor" });
  }
}

// ---
// EXTENSION DEFINITION
// ---

export default function rateLimiterExtension(pi: ExtensionAPI) {
  // 1. On turn/session starts and ends, refresh the Pi status widget
  pi.on("session_start", async (_event, ctx) => {
    updateRateLimiterWidget(ctx);
  });

  pi.on("turn_start", async (_event, ctx) => {
    updateRateLimiterWidget(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    updateRateLimiterWidget(ctx);
  });

  // 2. Intercept requests to verify rolling TPM rate-limit limits
  pi.on("before_provider_request", async (_event, ctx) => {
    try {
      const now = Date.now();
      const activeFiles = findActiveSessionFiles();
      const hostingSessionId = ctx.sessionManager.getSessionId() || null;
      
      const context = ctx.sessionManager.buildSessionContext();
      const currentModel = context.model?.modelId || "unknown";
      const shortCode = getModelShortName(currentModel);
      const ceiling = MODEL_QUOTA_REGISTRY[shortCode] || DEFAULT_CEILING;

      const stats = aggregateActiveTpm(activeFiles, hostingSessionId);
      const currentTpm = stats[shortCode]?.tpm || 0;

      // Update widget with pre-request metrics
      updateRateLimiterWidget(ctx);

      // If our specific active model is crossing its safety threshold:
      if (currentTpm > ceiling) {
        ctx.ui.notify(
          `⚠️ [Rate Limiter] ${shortCode} sliding window has consumed ${currentTpm.toLocaleString()} input tokens. ` +
          `Initiating a 40-second "coffee break" to let Gemini/Claude quota reset...`,
          "warning"
        );

        // Write the lockfile for external (tmux) status bar integration
        try {
          fs.writeFileSync(COFFEE_FILE, JSON.stringify({ startTime: now, endTime: now + COOLDOWN_DURATION_MS }), "utf8");
        } catch (e) {
          // ignore
        }

        // Sleep blocks the turn synchronously in the harness
        await sleep(COOLDOWN_DURATION_MS);

        // Clean up the lockfile
        try {
          if (fs.existsSync(COFFEE_FILE)) {
            fs.unlinkSync(COFFEE_FILE);
          }
        } catch (e) {
          // ignore
        }

        ctx.ui.notify("☕ [Rate Limiter] Cooldown complete. Resuming turn execution.", "success");
        updateRateLimiterWidget(ctx);
      }
    } catch (err: any) {
      ctx.ui.notify(`⚠️ [Rate Limiter Error] Failed to compute rate limit: ${err.message}`, "error");
    }
  });

  // 3. Register '/tpm' slash command to manually toggle widget visibility
  pi.registerCommand("tpm", {
    description: "Toggle visibility of the Tokens Per Minute (TPM) rate-limiter widget",
    handler: async (_args, ctx) => {
      isWidgetVisible = !isWidgetVisible;
      updateRateLimiterWidget(ctx);
      ctx.ui.notify(`TPM rate limiter widget is now ${isWidgetVisible ? "VISIBLE" : "HIDDEN"}.`, "info");
    }
  });
}
