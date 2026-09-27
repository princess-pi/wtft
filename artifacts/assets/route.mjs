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
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const cut = raw.indexOf("#");
  const pathPart = cut === -1 ? raw : raw.slice(0, cut);
  let frag = cut === -1 ? "" : raw.slice(cut + 1);
  const q = pathPart.indexOf("?");
  const search = q === -1 ? "" : pathPart.slice(q);
  let path = q === -1 ? pathPart : pathPart.slice(0, q);
  try {
    path = decodeURIComponent(path);
    if (frag) frag = decodeURIComponent(frag);
  } catch {
    return null;
  }
  return { path, frag, search };
}

function decodePart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function headingFrag(frag) {
  if (!frag) return "";
  return headingDomId(decodePart(frag), 1);
}

export function resolveRelative(basePath, href) {
  if (href.startsWith("?") || href.startsWith("#")) return basePath + href;
  const baseDir = basePath.includes("/") ? basePath.replace(/\/[^/]*$/, "/") : "";
  const url = new URL(baseDir + href, "https://assets.invalid/");
  return url.pathname.replace(/^\//, "") + url.search + url.hash;
}

export function rewriteHref(basePath, href, known, htmlPaths) {
  if (!href || /^([a-z]+:|\/\/)/i.test(href) || href.startsWith("/")) return href;
  if (href.startsWith("#")) {
    return "#" + basePath + "#" + headingFrag(href.slice(1));
  }
  const hash = href.indexOf("#");
  const file = hash === -1 ? href : href.slice(0, hash);
  const frag = hash === -1 ? "" : decodePart(href.slice(hash + 1));
  if (!file) return href;
  const resolved = resolveRelative(basePath, file);
  const pathOnly = resolved.split("?")[0].split("#")[0];
  const query = resolved.includes("?") ? resolved.slice(resolved.indexOf("?")).split("#")[0] : "";
  if (known.has(pathOnly) || pathOnly.endsWith(".md") || pathOnly.endsWith(".mdx")) {
    const html = htmlPaths && htmlPaths.has(pathOnly);
    const id = !frag ? "" : html ? frag : headingFrag(frag);
    return "#" + pathOnly + query + (id ? "#" + id : "");
  }
  return pathOnly + query + (frag ? "#" + frag : "");
}
