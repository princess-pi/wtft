export function splitFrontmatter(text) {
  if (!text.startsWith("---")) return { meta: {}, body: text };
  const nl = text.indexOf("\n");
  if (nl === -1) return { meta: {}, body: text };
  const lines = text.slice(nl + 1).split("\n");
  const close = lines.findIndex((line) => line.trim() === "---");
  if (close === -1) return { meta: {}, body: text };
  const raw = lines.slice(0, close).join("\n");
  const body = lines.slice(close + 1).join("\n");
  const meta = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (match) meta[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body };
}

export function parseRoute(hash) {
  let raw = hash.startsWith("#") ? hash.slice(1) : hash;
  try {
    raw = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const cut = raw.indexOf("#");
  return {
    path: cut === -1 ? raw : raw.slice(0, cut),
    frag: cut === -1 ? "" : raw.slice(cut + 1),
  };
}

export function resolveRelative(basePath, href) {
  const baseDir = basePath.includes("/") ? basePath.replace(/\/[^/]*$/, "/") : "";
  return new URL(baseDir + href, "https://assets.invalid/").pathname.replace(/^\//, "");
}
