function slugify(value) {
  return String(value || "").toLowerCase().trim()
    .replace(/[`*_[\]()]/g, "")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 60);
}

export function headingDomId(text, count) {
  const slug = slugify(text) || "section";
  const id = count > 1 ? `${slug}-${count}` : slug;
  return "doc-" + id;
}

export function splitFrontmatter(text) {
  const nl = text.indexOf("\n");
  const first = (nl === -1 ? text : text.slice(0, nl)).replace(/\r$/, "");
  if (first !== "---") return { meta: {}, body: text };
  if (nl === -1) return { meta: {}, body: text };
  const lines = text.slice(nl + 1).split("\n");
  const close = lines.findIndex((line) => line.replace(/\r$/, "").trim() === "---");
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

export function pageTitle(meta, fallback) {
  return (meta && meta.title) || fallback;
}

export function parseRoute(hash) {
  let raw = hash.startsWith("#") ? hash.slice(1) : hash;
  try {
    raw = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const cut = raw.indexOf("#");
  let path = cut === -1 ? raw : raw.slice(0, cut);
  const frag = cut === -1 ? "" : raw.slice(cut + 1);
  const q = path.indexOf("?");
  if (q !== -1) path = path.slice(0, q);
  return { path, frag };
}

export function resolveRelative(basePath, href) {
  const baseDir = basePath.includes("/") ? basePath.replace(/\/[^/]*$/, "/") : "";
  const url = new URL(baseDir + href, "https://assets.invalid/");
  return url.pathname.replace(/^\//, "") + url.search + url.hash;
}

export function rewriteHref(basePath, href, known) {
  if (!href || /^([a-z]+:|\/\/)/i.test(href)) return href;
  if (href.startsWith("#")) {
    const frag = href.slice(1);
    const id = frag.startsWith("doc-") ? frag : headingDomId(frag, 1);
    return "#" + basePath + "#" + id;
  }
  const [file, frag] = href.split("#");
  if (!file) return href;
  const resolved = resolveRelative(basePath, file);
  const pathOnly = resolved.split("?")[0].split("#")[0];
  const query = resolved.includes("?") ? resolved.slice(resolved.indexOf("?")) : "";
  if (known.has(pathOnly) || file.endsWith(".md") || file.endsWith(".mdx")) {
    const id = !frag ? "" : (frag.startsWith("doc-") ? frag : headingDomId(frag, 1));
    return "#" + pathOnly + query + (id ? "#" + id : "");
  }
  return resolved;
}
