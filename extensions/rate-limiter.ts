import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * @package princess-pi-packages
 * @module rate-limiter
 * @description Dynamic Token-Bucket Rate Limiter extension for Pi Coding Agent.
 *              Intercepts the before_provider_request hook, sums up input token spend
 *              over the sliding 60-second window, and enforces a flat 40-second 
 *              "coffee break" pause if token velocity exceeds 2.5M to prevent Gemini 429s.
 */

const INPUT_TOKEN_LIMIT_PER_MIN = 2500000; // 2.5M (Safety ceiling for Gemini's 3.0M limit)
const COOLDOWN_DURATION_MS = 40000; // 40 seconds flat "coffee break"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default function rateLimiterExtension(pi: ExtensionAPI) {
  pi.on("before_provider_request", async (_event, ctx) => {
    try {
      const now = Date.now();
      const branch = ctx.sessionManager.getBranch();
      
      let rollingInputTokens = 0;
      
      for (const entry of branch) {
        if (!entry) continue;
        
        // 1. Resolve entry timestamp
        const msg = entry.message;
        const timestampStr = msg?.timestamp || entry.timestamp;
        let timestamp = 0;
        
        if (typeof timestampStr === "string") {
          timestamp = new Date(timestampStr).getTime();
        } else if (typeof timestampStr === "number") {
          timestamp = timestampStr;
        }
        
        if (!timestamp) continue;
        
        // 2. Filter to sliding 60-second window
        if (now - timestamp > 60000) continue;
        
        // 3. Extract input tokens from assistant messages (where API usage resides)
        let inputTokens = 0;
        const isAssistant = msg?.role === "assistant" || entry.type === "assistant";
        
        if (isAssistant && msg?.usage) {
          inputTokens = 
            msg.usage.input_tokens || 
            msg.usage.input_token_count || 
            msg.usage.prompt_tokens || 
            0;
        }
        
        rollingInputTokens += inputTokens;
      }
      
      // 4. If rolling input tokens exceed our 2.5M ceiling, trigger the 40s coffee break
      if (rollingInputTokens > INPUT_TOKEN_LIMIT_PER_MIN) {
        ctx.ui.notify(
          `⚠️ [Rate Limiter] Sliding window has consumed ${rollingInputTokens.toLocaleString()} input tokens. ` +
          `Initiating a 40-second "coffee break" to let Gemini quota reset...`,
          "warning"
        );
        
        // Sleep blocks the before_provider_request loop asynchronously
        await sleep(COOLDOWN_DURATION_MS);
        ctx.ui.notify("☕ [Rate Limiter] Cooldown complete. Resuming turn execution.", "success");
      }
    } catch (err: any) {
      // Degrade gracefully to prevent breaking the developer session on error
      ctx.ui.notify(`⚠️ [Rate Limiter Error] Failed to compute token limit: ${err.message}`, "error");
    }
  });
}
