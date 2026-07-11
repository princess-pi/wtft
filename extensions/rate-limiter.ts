import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadConfig, writeConfig } from "./lib/config.js";


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
  "g3.5pro": 1600000,  // gemini-3.5-pro (Tier 2 limit: 2.0M)
  "g1.5pro": 1600000,  // gemini-1.5-pro (Tier 2 limit: 2.0M)
  "glatpro": 1600000,  // gemini-pro-latest (Tier 2 limit: 2.0M)
  "c5.0son": 320000,   // claude-sonnet-5 (Tier 4 limit: 400K)
  "c3.5son": 320000,   // claude-3-5-sonnet / claude-sonnet-4-6 (Tier 4 limit: 400K)
  "c5.0fab": 80000,    // claude-fable-5 (Opus-equivalent Tier: 100K)
  "c3.5hai": 320000,   // claude-3-5-haiku (Tier 4 limit: 400K)
  "c5.0hai": 320000,   // claude-haiku-5 (Tier 4 limit: 400K)
  "c4.0opu": 80000,    // claude-opus-4-x (Opus standard limit)
  "c3.0opu": 80000,    // claude-3-opus (Opus standard limit)
  "d4.0fla": 2500000,  // deepseek-v4-flash (concurrency limit: 2500; no TPM limit — Gemini-equivalent ceiling for redline visibility)
  "d4.0pro": 1600000,  // deepseek-v4-pro (concurrency limit: 500; no TPM limit — Gemini-equivalent ceiling for redline visibility)
  // GPT-5.x: no hard TPM limits (RPM-limited instead), but register for visibility
  "gpt5sol": 1000000,  // gpt-5.6-sol (default ceiling for visibility)
  "gpt5ter": 1000000,  // gpt-5.6-terra
  "gpt5lun": 1000000,  // gpt-5.6-luna
  "gpt5.5": 1000000,   // gpt-5.5
  "gpt5.4": 1000000,   // gpt-5.4
};

const DEFAULT_CEILING = 1000000;
const BAR_WIDTH = 5;
const COOLDOWN_DURATION_MS = 40000; // 40 seconds flat "coffee break"
const STATS_CACHE_FILE = "/tmp/pi-rate-limit-stats.json";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let cooldownRemainingSecs: number | null = null;
let refreshInterval: ReturnType<typeof setInterval> | null = null;
let lastCtx: ExtensionContext | null = null;
let currentTickMs = 1000; // Default to 1 second

// ---
// HELPERS
// ---

function getModelShortName(modelName: string): string {
  if (!modelName) return "unknown";
  const m = modelName.toLowerCase();

  // Gemini
  if (m.includes("gemini-3.5-flash")) return "g3.5fla";
  if (m.includes("gemini-3.5-pro")) return "g3.5pro";
  if (m.includes("gemini-flash-latest")) return "glatfla";
  if (m.includes("gemini-3.5-flash-lite")) return "g3.5fli";
  if (m.includes("gemini-flash-lite-latest")) return "glatfli";
  if (m.includes("gemini-1.5-pro") || m.includes("gemini-pro-latest")) return "glatpro";

  // DeepSeek
  if (m.includes("deepseek-v4-pro")) return "d4.0pro";
  if (m.includes("deepseek-v4-flash") || m.includes("deepseek-chat") || m.includes("deepseek-reasoner")) return "d4.0fla";

  // Claude — check from most specific to least
  if (m.includes("claude-fable-5") || m.includes("fable-5")) return "c5.0fab";
  if (m.includes("claude-sonnet-5") || m.includes("sonnet-5")) return "c5.0son";
  if (m.includes("claude-haiku-5") || m.includes("haiku-5")) return "c5.0hai";
  if (m.includes("claude-opus-4") || m.includes("opus-4")) return "c4.0opu";
  if (m.includes("claude-3-5-sonnet") || m.includes("claude-sonnet-4-6") || m.includes("claude-sonnet-4-5") || m.includes("claude-3-5-sonnet-20240620") || m.includes("claude-3-5-sonnet-20241022")) {
    return "c3.5son";
  }
  if (m.includes("claude-3-5-haiku") || m.includes("claude-3-5-haiku-20241022")) {
    return "c3.5hai";
  }
  if (m.includes("claude-3-opus") || m.includes("claude-3-0-opus")) return "c3.0opu";
  // Generic Claude fallbacks: check specific model families before the generic opus catch-all
  if (m.includes("sonnet")) return "c3.5son"; // unknown sonnet variant → treat as Sonnet tier
  if (m.includes("haiku")) return "c3.5hai";
  if (m.includes("opus")) return "c4.0opu"; // unknown opus variant → treat as Opus 4 tier

  // GPT-5.x
  if (m.includes("gpt-5.6-sol")) return "gpt5sol";
  if (m.includes("gpt-5.6-terra")) return "gpt5ter";
  if (m.includes("gpt-5.6-luna")) return "gpt5lun";
  if (m.includes("gpt-5.6")) return "gpt5sol"; // generic gpt-5.6 → Sol pricing tier
  if (m.includes("gpt-5.5")) return "gpt5.5";
  if (m.includes("gpt-5.4")) return "gpt5.4";
  if (m.includes("gpt-5") || m.includes("gpt5")) return "gpt5sol"; // catch-all GPT-5 family

  // Fallback fixed-width 7-char encoder (P-VVV-MMM)
  // Prefix: g=Gemini/Google, c=Claude, d=DeepSeek, o=OpenAI/GPT
  let comp = "c";
  if (m.includes("gemini") || m.includes("google")) comp = "g";
  else if (m.includes("deepseek")) comp = "d";
  else if (m.includes("gpt") || m.includes("openai")) comp = "o";
  
  let ver = "3.5";
  if (m.includes("latest")) ver = "lat";
  else if (m.includes("5.6")) ver = "5.6";
  else if (m.includes("5.5")) ver = "5.5";
  else if (m.includes("5.4")) ver = "5.4";
  else if (m.includes("5.0") || m.includes("5-")) ver = "5.0";
  else if (m.includes("4.0") || m.includes("4-")) ver = "4.0";
  else if (m.includes("3.0") || m.includes("3-0")) ver = "3.0";
  else if (m.includes("1.5") || m.includes("1-5")) ver = "1.5";

  let modelPart = "unk";
  const parts = m.split("-");
  const lastPart = parts[parts.length - 1];
  if (lastPart) {
    if (lastPart === "lite" || (lastPart === "latest" && m.includes("lite"))) modelPart = "fli";
    else if (lastPart === "latest" && m.includes("flash")) modelPart = "fla";
    else if (lastPart === "latest" && m.includes("pro")) modelPart = "pro";
    else if (lastPart === "sol") modelPart = "sol";
    else if (lastPart === "terra") modelPart = "ter";
    else if (lastPart === "luna") modelPart = "lun";
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

  // Scan wtft-tags directories for classified tag files — harness-agnostic,
  // same source as the CLI, widget, and session selector. No raw .jsonl
  // parsing needed (#87 — Ports & Adapters seam).
  function scanDir(dir: string) {
    if (!fs.existsSync(dir)) return;
    try {
      const files = fs.readdirSync(dir);
      for (const f of files) {
        const fullPath = path.join(dir, f);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          // Look for wtft-tags subdirectory
          if (f === "wtft-tags") {
            const tagFiles = fs.readdirSync(fullPath);
            for (const tagFile of tagFiles) {
              if (tagFile.endsWith(".jsonl")) {
                const tagPath = path.join(fullPath, tagFile);
                const tagStat = fs.statSync(tagPath);
                if (now - tagStat.mtimeMs < TWO_MINUTES_MS) {
                  activeFiles.push({ path: tagPath, mtime: tagStat.mtimeMs });
                }
              }
            }
          } else {
            scanDir(fullPath);
          }
        }
      }
    } catch (err) {
      // ignore
    }
  }

  // Pi sessions dir contains per-session subdirs, each with a wtft-tags/ subdir
  scanDir(PI_DIR);
  // Claude Code projects dir contains per-project subdirs, each with session subdirs
  scanDir(CLAUDE_DIR);

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
    // Derive hosting session ID from the tag file path:
    // <sessionDir>/wtft-tags/<sessionId>.jsonl.wtft-tag.vX.Y.Z.jsonl
    const tagName = path.basename(filePath);
    const tagVersionIdx = tagName.indexOf(".wtft-tag.v");
    const sessionId = tagVersionIdx > 0 ? tagName.substring(0, tagVersionIdx) : "";
    const isHostingSession = hostingSessionId ? sessionId.includes(hostingSessionId) : false;

    try {
      const content = fs.readFileSync(filePath, "utf8");
      const lines = content.split("\n").filter(Boolean);

      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          // Skip heartbeat lines
          if (obj._hb) continue;
          // Classified format: { c, in, out, cr, cw, m, t, cat, f, cmd, ... }
          if (!obj.m || !obj.t) continue;

          const age = now - obj.t;
          if (age > 120000) continue;

          const shortCode = getModelShortName(obj.m);
          const inputTokens = (obj.in || 0) + (obj.cr || 0);

          if (!modelStats[shortCode]) {
            modelStats[shortCode] = { tpm: 0, lastActiveAge: 120000, sessionTpm: 0 };
          }

          modelStats[shortCode].lastActiveAge = Math.min(modelStats[shortCode].lastActiveAge, age);

          if (age <= 60000) {
            modelStats[shortCode].tpm += inputTokens;
            // If this is the hosting session, increment session-only TPM
            if (isHostingSession) {
              modelStats[shortCode].sessionTpm += inputTokens;
            }
          }
        } catch {
          // Skip unparseable lines
        }
      }
    } catch {
      // File may not exist or be unreadable
    }
  }

  return modelStats;
}

interface CacheSchema {
  timestamp: number;
  stats: Record<string, { tpm: number; lastActiveAge: number }>;
}

function parseIntervalToMs(val: string): number {
  const clean = val.trim().toLowerCase();
  if (clean.endsWith("ms")) {
    const num = parseFloat(clean.slice(0, -2));
    return isNaN(num) ? 1000 : num;
  }
  if (clean.endsWith("s")) {
    const num = parseFloat(clean.slice(0, -1));
    return isNaN(num) ? 1000 : num * 1000;
  }
  const num = parseFloat(clean);
  return isNaN(num) ? 1000 : num * 1000;
}

function getHostingSessionTpm(hostingSessionId: string, activeFiles: FileInfo[]): Record<string, number> {
  // Find the tag file for the hosting session — identified by session ID in the
  // tag filename: <sessionDir>/wtft-tags/<sessionId>.jsonl.wtft-tag.vX.Y.Z.jsonl
  const hostingFile = activeFiles.find(f => {
    const tagName = path.basename(f.path);
    const tagVersionIdx = tagName.indexOf(".wtft-tag.v");
    if (tagVersionIdx <= 0) return false;
    const sessionId = tagName.substring(0, tagVersionIdx);
    return sessionId.includes(hostingSessionId);
  });
  if (!hostingFile) return {};
  
  const sessionTpms: Record<string, number> = {};
  const now = Date.now();
  try {
    const content = fs.readFileSync(hostingFile.path, "utf8");
    const lines = content.split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj._hb) continue; // skip heartbeats
        if (!obj.m || !obj.t) continue;
        const age = now - obj.t;
        if (age > 60000) continue;
        const shortCode = getModelShortName(obj.m);

        const inputTokens = (obj.in || 0) + (obj.cr || 0);
        sessionTpms[shortCode] = (sessionTpms[shortCode] || 0) + inputTokens;
      } catch (e) {
        // ignore
      }
    }
  } catch (e) {
    // ignore
  }
  return sessionTpms;
}

function getOrUpdateStats(activeFiles: FileInfo[], hostingSessionId: string | null, tickMs: number): Record<string, ModelStats> {
  const now = Date.now();
  let cached: CacheSchema | null = null;

  if (fs.existsSync(STATS_CACHE_FILE)) {
    try {
      const content = fs.readFileSync(STATS_CACHE_FILE, "utf8");
      const data = JSON.parse(content) as CacheSchema;
      const freshWindow = Math.max(1000, tickMs);
      if (now - data.timestamp < freshWindow) {
        cached = data;
      }
    } catch (e) {
      // ignore
    }
  }

  let baseStats: Record<string, { tpm: number; lastActiveAge: number }> = {};

  if (cached) {
    baseStats = cached.stats;
  } else {
    const fullStats = aggregateActiveTpm(activeFiles, null);
    for (const [shortCode, data] of Object.entries(fullStats)) {
      baseStats[shortCode] = { tpm: data.tpm, lastActiveAge: data.lastActiveAge };
    }
    try {
      const cacheData: CacheSchema = {
        timestamp: now,
        stats: baseStats
      };
      fs.writeFileSync(STATS_CACHE_FILE, JSON.stringify(cacheData), "utf8");
    } catch (e) {
      // ignore
    }
  }

  const stats: Record<string, ModelStats> = {};
  for (const [shortCode, data] of Object.entries(baseStats)) {
    stats[shortCode] = {
      tpm: data.tpm,
      lastActiveAge: data.lastActiveAge,
      sessionTpm: 0
    };
  }

  if (hostingSessionId) {
    const sessionTpms = getHostingSessionTpm(hostingSessionId, activeFiles);
    for (const [shortCode, sessionTpm] of Object.entries(sessionTpms)) {
      if (!stats[shortCode]) {
        stats[shortCode] = { tpm: 0, lastActiveAge: 0, sessionTpm: 0 };
      }
      stats[shortCode].sessionTpm = sessionTpm;
    }
  }

  return stats;
}

// ---
// WIDGET RENDERER
// ---

interface TpmSettings {
  widget: boolean;
  footer: boolean;
}

function getTpmSettings(ctx?: any): TpmSettings {
  const cfg = loadConfig("tpm", { widget: true, footer: false });
  return {
    widget: cfg.widget !== false,
    footer: cfg.footer === true,
  };
}

function isEmojiDisabled(): boolean {
  const cfg = loadConfig("tpm", {});
  return cfg.emojiDisabled === true;
}

function updateRateLimiterWidget(ctx: ExtensionContext) {
  const settings = getTpmSettings();

  if (!settings.widget) {
    ctx.ui.setWidget("rate-limiter", undefined);
  }

  if (!settings.footer) {
    ctx.ui.setStatus("rate-limiter", undefined);
  }

  if (!settings.widget && !settings.footer) {
    return;
  }

  const emojiDisabled = isEmojiDisabled();

  try {
    const activeFiles = findActiveSessionFiles();
    const hostingSessionId = ctx.sessionManager.getSessionId() || null;
    
    // Always find current model of the hosting session
    const context = ctx.sessionManager.buildSessionContext();
    const currentModel = context.model?.modelId || "unknown";
    const hostingShortCode = getModelShortName(currentModel);

    const stats = getOrUpdateStats(activeFiles, hostingSessionId, currentTickMs);
    
    // Ensure hosting shortcode exists in our list even if 0 TPM
    if (!stats[hostingShortCode]) {
      stats[hostingShortCode] = { tpm: 0, lastActiveAge: 0, sessionTpm: 0 };
    }

    const hostingData = stats[hostingShortCode];
    const hostingCeiling = MODEL_QUOTA_REGISTRY[hostingShortCode] || DEFAULT_CEILING;

    const hSessionStr = getReadableSize(hostingData.sessionTpm);
    const hGlobalStr = getReadableSize(hostingData.tpm);
    const hLimitStr = getReadableSize(hostingCeiling);

    // 1. Render Footer Status Line 3 if enabled
    if (settings.footer) {
      let footerParts: string[] = [];
      if (cooldownRemainingSecs !== null) {
        const cooldownIcon = emojiDisabled ? "[!]" : "☕";
        footerParts.push(`\x1b[1;33m${cooldownIcon} Cooldown: ${cooldownRemainingSecs}s\x1b[0m`);
      } else {
        let hFilled = Math.min(Math.ceil((hostingData.tpm / hostingCeiling) * BAR_WIDTH), BAR_WIDTH);
        const hBar = "$".repeat(hFilled) + ".".repeat(BAR_WIDTH - hFilled);

        let hColor = "\x1b[32m"; // Green
        if (hostingData.tpm > hostingCeiling * 0.8) hColor = "\x1b[31;1m"; // Red
        else if (hostingData.tpm > hostingCeiling * 0.5) hColor = "\x1b[33m"; // Yellow
        else if (hostingData.tpm === 0) hColor = "\x1b[90m"; // Gray

        const sentinelIcon = emojiDisabled ? "[!]" : "🛡️";
        footerParts.push(`\x1b[1m${sentinelIcon} [${hColor}${hBar}\x1b[0m\x1b[1m] ${hostingShortCode}: ${hColor}${hGlobalStr}\x1b[0m\x1b[1m/${hLimitStr}\x1b[0m`);
      }
      ctx.ui.setStatus("rate-limiter", footerParts.join(" | "));
    }

    // 2. Render TUI Widget if enabled
    if (settings.widget) {
      const lines: string[] = [];
      const sentinelTitle = emojiDisabled ? "[!] Token Sentinel" : "🛡️  Token Sentinel";
      lines.push(`\x1b[1;36m${sentinelTitle} (TPM Active Monitors) ───────────────────\x1b[0m`);

      if (cooldownRemainingSecs !== null) {
        const remainingMs = cooldownRemainingSecs * 1000;
        const remainingCups = Math.max(0, Math.min(8, Math.ceil(remainingMs / 5000)));
        const cupsStr = emojiDisabled ? "#".repeat(remainingCups) + " ".repeat(8 - remainingCups) : "☕".repeat(remainingCups) + "  ".repeat(8 - remainingCups);
        lines.push(`\x1b[1;33m  [${cupsStr}] ${cooldownRemainingSecs}s remaining...\x1b[0m`);
      }

      // Render hosting session's ONLY TPM
      let sFilled = Math.min(Math.ceil((hostingData.sessionTpm / hostingCeiling) * BAR_WIDTH), BAR_WIDTH);
      if (hostingData.sessionTpm > 0 && sFilled === 0) {
        sFilled = 1;
      }
      const sBar = "$".repeat(sFilled) + ".".repeat(BAR_WIDTH - sFilled);
      
      let sColor = "\x1b[32m"; // Green
      if (hostingData.sessionTpm > hostingCeiling * 0.8) sColor = "\x1b[31;1m"; // Red
      else if (hostingData.sessionTpm > hostingCeiling * 0.5) sColor = "\x1b[33m"; // Yellow

      const fingerPointer = emojiDisabled ? "-> " : "👉 ";
      lines.push(`\x1b[1m  ${fingerPointer}${sColor}[${sBar}] ${hostingShortCode} (Session): ${hSessionStr} ses [max ${hLimitStr}]\x1b[0m`);

      // Render Global TPM Monitors (Non-bolded, auto-pruned)
      lines.push(`\x1b[1;36m  Global Multi-Model Status ───────────────────────\x1b[0m`);
      
      // Render hosting model global stats first under global list
      let hFilled = Math.min(Math.ceil((hostingData.tpm / hostingCeiling) * BAR_WIDTH), BAR_WIDTH);
      const hBar = "$".repeat(hFilled) + ".".repeat(BAR_WIDTH - hFilled);
      
      let hColor = "\x1b[32m"; // Green
      if (hostingData.tpm > hostingCeiling * 0.8) hColor = "\x1b[31;1m"; // Red
      else if (hostingData.tpm > hostingCeiling * 0.5) hColor = "\x1b[33m"; // Yellow

      const bullet = emojiDisabled ? "* " : "• ";
      lines.push(`\x1b[1m     ${bullet}${hColor}[${hBar}] ${hostingShortCode}: ${hGlobalStr} glo [max ${hLimitStr}]\x1b[0m`);

      // Render other active models
      for (const [shortCode, data] of Object.entries(stats)) {
        if (shortCode === hostingShortCode) continue; // Already rendered first

        // Only show global models with active non-zero TPM usage
        if (data.tpm === 0) {
          continue;
        }

        const ceiling = MODEL_QUOTA_REGISTRY[shortCode] || DEFAULT_CEILING;
        let filled = Math.min(Math.ceil((data.tpm / ceiling) * BAR_WIDTH), BAR_WIDTH);
        const bar = "$".repeat(filled) + ".".repeat(BAR_WIDTH - filled);

        let color = "\x1b[32m";
        if (data.tpm > ceiling * 0.8) color = "\x1b[31;1m";
        else if (data.tpm > ceiling * 0.5) color = "\x1b[33m";

        const globalStr = getReadableSize(data.tpm);
        const limitStr = getReadableSize(ceiling);

        lines.push(`     ${bullet}${color}[${bar}] ${shortCode}: ${globalStr} glo [max ${limitStr}]`);
      }

      ctx.ui.setWidget("rate-limiter", lines, { placement: "belowEditor" });
    }
  } catch (err: any) {
    const warningIcon = emojiDisabled ? "[!]" : "⚠️";
    if (settings.widget) {
      ctx.ui.setWidget("rate-limiter", [`${warningIcon} Rate Limiter Widget Error: ${err.message}`], { placement: "belowEditor" });
    }
    if (settings.footer) {
      ctx.ui.setStatus("rate-limiter", `${warningIcon} Rate Limiter Error`);
    }
  }
}

// ---
// EXTENSION DEFINITION
// ---

export default function rateLimiterExtension(pi: ExtensionAPI) {
  // Register flags for tick refresh rate
  pi.registerFlag("tick", {
    description: "Specify the refresh interval in s (seconds) or ms (milliseconds), e.g. '2' or '500ms'",
    type: "string",
    default: "1s",
  });
  pi.registerFlag("t", {
    description: "Specify the refresh interval in s (seconds) or ms (milliseconds), alias for --tick",
    type: "string",
  });

  function startBackgroundRefresh(ctx: ExtensionContext) {
    lastCtx = ctx;
    if (refreshInterval) {
      clearInterval(refreshInterval);
    }

    // Determine configured tick rate
    let tickStr = "1s";
    const flagT = pi.getFlag("t") as string | undefined;
    const flagTick = pi.getFlag("tick") as string | undefined;
    if (flagT !== undefined) {
      tickStr = flagT;
    } else if (flagTick !== undefined) {
      tickStr = flagTick;
    }
    
    currentTickMs = parseIntervalToMs(tickStr);

    let activeTickMs = cooldownRemainingSecs !== null ? 1000 : currentTickMs;

    const tick = () => {
      if (lastCtx) {
        updateRateLimiterWidget(lastCtx);
      }
      
      // Dynamic adjust: if we enter or leave cooldown, adjust the active tick rate!
      const targetTickMs = cooldownRemainingSecs !== null ? 1000 : currentTickMs;
      if (targetTickMs !== activeTickMs) {
        activeTickMs = targetTickMs;
        clearInterval(refreshInterval!);
        refreshInterval = setInterval(tick, activeTickMs);
      }
    };

    refreshInterval = setInterval(tick, activeTickMs);
  }

  function stopBackgroundRefresh() {
    if (refreshInterval) {
      clearInterval(refreshInterval);
      refreshInterval = null;
    }
  }

  // 1. On turn/session starts and ends, refresh the Pi status widget
  pi.on("session_start", async (_event, ctx) => {
    updateRateLimiterWidget(ctx);
    startBackgroundRefresh(ctx);
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    stopBackgroundRefresh();
  });

  pi.on("turn_start", async (_event, ctx) => {
    lastCtx = ctx;
    updateRateLimiterWidget(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    lastCtx = ctx;
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

      const stats = getOrUpdateStats(activeFiles, hostingSessionId, currentTickMs);
      const currentTpm = stats[shortCode]?.tpm || 0;

      // Update widget with pre-request metrics
      updateRateLimiterWidget(ctx);

      // If our specific active model is crossing its safety threshold:
      // DeepSeek models (prefix "d") are concurrency-limited, not TPM-limited —
      // redline the meter for visibility but never trigger a cooldown.
      const isDeepseek = shortCode.startsWith("d");
      if (currentTpm > ceiling && !isDeepseek) {
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

        // Sleep blocks the turn synchronously in the harness while live-refreshing the widget
        const endTime = Date.now() + COOLDOWN_DURATION_MS;
        while (Date.now() < endTime) {
          const remainingMs = endTime - Date.now();
          const remainingSecs = Math.ceil(remainingMs / 1000);
          cooldownRemainingSecs = remainingSecs;
          updateRateLimiterWidget(ctx);
          await sleep(1000);
        }
        cooldownRemainingSecs = null;
        updateRateLimiterWidget(ctx);

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

  // 3. Register '/tpm' slash command to manually toggle widget visibility and footer status
  pi.registerCommand("tpm", {
    description: "Configure TPM rate-limiter display options (e.g. /tpm --widget off --footer on)",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const current = getTpmSettings(ctx);

      if (trimmed === "--help" || trimmed === "-h") {
        let helpText = `\x1b[1m\x1b[36m/tpm\x1b[0m - Configure TPM Rate-Limiter Display Options\n\n`;
        helpText += `Control the visibility of the TPM floating widget box and the status bar footer.\n\n`;

        helpText += `\x1b[1mUsage:\x1b[0m\n`;
        helpText += `  /tpm                                    Toggle the floating widget panel on/off\n`;
        helpText += `  /tpm --widget [on|off]                  Explicitly enable or disable the floating widget panel\n`;
        helpText += `  /tpm --footer [on|off]                  Explicitly enable or disable the bottom footer line 3\n`;
        helpText += `  /tpm --emoji                            Enable emoji icons in widgets/footer\n`;
        helpText += `  /tpm --no-emoji                         Disable emoji icons in widgets/footer\n`;
        helpText += `  /tpm --why                              Explain why you'd run this tool, with user scenarios\n\n`;

        helpText += `\x1b[1mAliases:\x1b[0m\n`;
        helpText += `  -w for --widget, -f for --footer\n\n`;

        helpText += `\x1b[1mExamples:\x1b[0m\n`;
        helpText += `  /tpm --widget off --footer on\n`;
        helpText += `  /tpm --no-emoji\n`;

        ctx.ui.notify(helpText, "info");
        return;
      }

      if (trimmed === "--why") {
        let whyText = `\x1b[1m\x1b[36m/tpm\x1b[0m - Configure TPM Rate-Limiter Display Options\n\n`;
        whyText += `Control the visibility of the TPM floating widget box and the status bar footer.\n\n`;
        whyText += `\x1b[1mWhy run /tpm?\x1b[0m\n\n`;
        whyText += `  You're approaching your API rate limit and need to see your current usage at a glance.\n`;
        whyText += `    \x1b[33m$ /tpm\x1b[0m\n`;
        whyText += `    \x1b[32m→ A floating widget panel appears showing the current model's TPM usage as a colored bar, updated every second.\x1b[0m\n\n`;
        whyText += `  You want the rate info in the status bar but not as a floating widget box.\n`;
        whyText += `    \x1b[33m$ /tpm --widget off --footer on\x1b[0m\n`;
        whyText += `    \x1b[32m→ The widget box is hidden but the TPM status line remains visible in the footer.\x1b[0m\n\n`;
        whyText += `  Your terminal doesn't render emoji well and you need ASCII-only widgets.\n`;
        whyText += `    \x1b[33m$ /tpm --no-emoji\x1b[0m\n`;
        whyText += `    \x1b[32m→ All widget icons switch to single-width ASCII characters.\x1b[0m\n\n`;
        whyText += `  You want to increase your actual API quota or change provider rate limits.\n`;
        whyText += `    \x1b[33m$ /tpm  # won't help\x1b[0m\n`;
        whyText += `    \x1b[32m→ The TPM tool only displays and monitors usage — it cannot change provider quotas or API limits. Contact your provider to adjust tier limits.\x1b[0m\n\n`;
        whyText += `\x1b[2mRun \x1b[0m/tpm --help\x1b[2m for the full flag reference.\x1b[0m\n`;

        ctx.ui.notify(whyText, "info");
        return;
      }

      let newWidget = current.widget;
      let newFooter = current.footer;
      let handled = false;

      if (trimmed === "--reset") {
        writeConfig("tpm", { widget: null, footer: null });
        updateRateLimiterWidget(ctx);
        ctx.ui.notify("TPM settings reset. Edit ~/.config/princess-pi-packages/tpm.json for new defaults.", "info");
        return;
      }

      if (trimmed === "--no-emojii" || trimmed === "--no-emoji") {
        writeConfig("tpm", { emojiDisabled: true });
        updateRateLimiterWidget(ctx);
        ctx.ui.notify("Emoji icons in widgets have been disabled. (Persisted to tpm.json)", "info");
        return;
      } else if (trimmed === "--emojii" || trimmed === "--emoji") {
        writeConfig("tpm", { emojiDisabled: false });
        updateRateLimiterWidget(ctx);
        ctx.ui.notify("Emoji icons in widgets have been enabled. (Persisted to tpm.json)", "info");
        return;
      }

      if (trimmed.includes("--widget") || trimmed.includes("-w")) {
        const parts = trimmed.split(/\s+/);
        const idx = parts.findIndex(p => p === "--widget" || p === "-w");
        const next = parts[idx + 1];
        if (next === "on" || next === "true") {
          newWidget = true;
        } else if (next === "off" || next === "false") {
          newWidget = false;
        } else {
          newWidget = !current.widget;
        }
        handled = true;
      } else if (trimmed.includes("--no-widget")) {
        newWidget = false;
        handled = true;
      }

      if (trimmed.includes("--footer") || trimmed.includes("-f")) {
        const parts = trimmed.split(/\s+/);
        const idx = parts.findIndex(p => p === "--footer" || p === "-f");
        const next = parts[idx + 1];
        if (next === "on" || next === "true") {
          newFooter = true;
        } else if (next === "off" || next === "false") {
          newFooter = false;
        } else {
          newFooter = !current.footer;
        }
        handled = true;
      } else if (trimmed.includes("--no-footer")) {
        newFooter = false;
        handled = true;
      }

      if (!handled) {
        // Toggle widget by default if no flags passed
        newWidget = !current.widget;
      }

      writeConfig("tpm", { widget: newWidget, footer: newFooter });
      updateRateLimiterWidget(ctx);

      const statusMsgs: string[] = [];
      statusMsgs.push(`Widget Box: ${newWidget ? "ENABLED" : "DISABLED"}`);
      statusMsgs.push(`Footer Line 3 Status: ${newFooter ? "ENABLED" : "DISABLED"}`);
      ctx.ui.notify(`TPM Rate Limiter display settings updated: ${statusMsgs.join(" | ")}`, "info");
    }
  });
}
