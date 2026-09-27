import { splitFrontmatter, parseRoute, resolveRelative } from "./route.mjs";

const nav = document.getElementById("nav-list");
const navTitle = document.querySelector(".nav-title");
const content = document.getElementById("content");
const md = window.markdownit({ html: true, linkify: true });

function slugify(value) {
  return value.toLowerCase().trim()
    .replace(/[`*_[\]()]/g, "")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 60);
}

function clearToc() {
  document.getElementById("toc")?.replaceChildren();
}

function fillToc(root, basePath) {
  const toc = document.getElementById("toc");
  if (!toc) return;
  toc.replaceChildren();
  const seen = new Map();
  const items = [];
  for (const heading of root.querySelectorAll("h2, h3")) {
    let id = slugify(heading.textContent);
    const count = (seen.get(id) || 0) + 1;
    seen.set(id, count);
    if (count > 1) id += "-" + count;
    heading.id = id;
    items.push({ id, level: heading.tagName.toLowerCase(), text: heading.textContent.trim() });
  }
  if (items.length < 2) return;
  const list = document.createElement("ul");
  for (const item of items) {
    const li = document.createElement("li");
    li.className = item.level;
    const link = document.createElement("a");
    link.href = "#" + basePath + "#" + item.id;
    link.textContent = item.text;
    li.appendChild(link);
    list.appendChild(li);
  }
  toc.appendChild(list);
}

function rewriteDocLinks(root, basePath, index) {
  const known = new Set((index.docs || []).map((doc) => doc.path));
  for (const link of root.querySelectorAll("a[href]")) {
    const href = link.getAttribute("href");
    if (!href || /^([a-z]+:|\/\/)/i.test(href)) continue;
    if (href.startsWith("#")) {
      link.setAttribute("href", "#" + basePath + href);
      continue;
    }
    const [file, frag] = href.split("#");
    if (!file) continue;
    const resolved = resolveRelative(basePath, file);
    if (known.has(resolved) || file.endsWith(".md") || file.endsWith(".mdx")) {
      link.setAttribute("href", "#" + resolved + (frag ? "#" + frag : ""));
    }
  }
  for (const el of root.querySelectorAll("iframe[src], img[src]")) {
    const src = el.getAttribute("src");
    if (!src || /^([a-z]+:|\/\/|\/|#)/i.test(src)) continue;
    el.setAttribute("src", resolveRelative(basePath, src));
  }
}

function hint(text) {
  renderGen += 1;
  clearToc();
  document.querySelectorAll("#nav-list a").forEach((a) => a.classList.remove("active"));
  content.replaceChildren();
  const p = document.createElement("p");
  p.className = "hint";
  p.textContent = text;
  content.appendChild(p);
}

async function loadIndex() {
  let res;
  try {
    res = await fetch("docs.json", { cache: "no-store" });
  } catch (err) {
    hint(`docs.json failed to load (${err.message})`);
    return null;
  }
  if (!res.ok) {
    hint(`No docs.json found, or it failed to load (${res.status}).`);
    return null;
  }
  try {
    return await res.json();
  } catch (err) {
    hint(`docs.json did not parse (${err.message})`);
    return null;
  }
}

function renderNav(index) {
  if (index.title) navTitle.textContent = index.title;
  const groups = new Map();
  for (const doc of index.docs || []) {
    const group = doc.group || "";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(doc);
  }
  nav.replaceChildren();
  for (const [group, docs] of groups) {
    if (group) {
      const label = document.createElement("div");
      label.className = "nav-group";
      label.textContent = group;
      nav.appendChild(label);
    }
    for (const doc of docs) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = `#${doc.path}`;
      a.textContent = doc.title || doc.path;
      a.dataset.path = doc.path;
      a.dataset.kind = doc.kind || "";
      li.appendChild(a);
      nav.appendChild(li);
    }
  }
}

function findDoc(index, path) {
  return (index.docs || []).find((d) => d.path === path);
}

let renderGen = 0;

async function renderDoc(index, path, frag) {
  const gen = ++renderGen;
  const doc = findDoc(index, path);
  if (!doc) {
    document.querySelectorAll("#nav-list a").forEach((a) => a.classList.remove("active"));
    hint(`Not in docs.json: ${path}`);
    return;
  }
  document.querySelectorAll("#nav-list a").forEach((a) => {
    a.classList.toggle("active", a.dataset.path === path);
  });

  if (doc.kind === "html") {
    if (gen !== renderGen) return;
    content.replaceChildren();
    const frame = document.createElement("iframe");
    frame.src = path;
    frame.title = doc.title || path;
    frame.style.cssText = "width:100%;height:80vh;border:1px solid var(--border);border-radius:6px;";
    content.appendChild(frame);
    clearToc();
    return;
  }
  if (doc.kind === "file") {
    if (gen !== renderGen) return;
    clearToc();
    content.replaceChildren();
    const p = document.createElement("p");
    const a = document.createElement("a");
    a.href = path;
    a.download = "";
    a.textContent = doc.title || path;
    p.append(a, " (binary — download to view)");
    content.appendChild(p);
    return;
  }

  let res;
  try {
    res = await fetch(path, { cache: "no-store" });
  } catch (err) {
    if (gen !== renderGen) return;
    hint(`Failed to load ${path} (${err.message})`);
    return;
  }
  if (gen !== renderGen) return;
  if (!res.ok) {
    hint(`Failed to load ${path} (${res.status})`);
    return;
  }
  let text;
  try {
    text = await res.text();
  } catch (err) {
    if (gen !== renderGen) return;
    hint(`Failed to read ${path} (${err.message})`);
    return;
  }
  if (gen !== renderGen) return;
  const split = splitFrontmatter(text);
  content.innerHTML = md.render(split.body);
  fillToc(content, path);
  rewriteDocLinks(content, path, index);
  if (frag && gen === renderGen) document.getElementById(frag)?.scrollIntoView();
  content.querySelectorAll("pre code.language-mermaid").forEach((block) => {
    const div = document.createElement("div");
    div.className = "mermaid";
    div.textContent = block.textContent;
    block.closest("pre").replaceWith(div);
  });
  if (content.querySelector(".mermaid")) {
    for (let i = 0; i < 20 && !window.mermaid; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (gen !== renderGen) return;
    }
    if (!window.mermaid) {
      content.querySelectorAll(".mermaid").forEach((el) => {
        el.textContent = "Diagram did not load.";
      });
      return;
    }
    try {
      await window.mermaid.run({ querySelector: ".mermaid" });
    } catch {
      if (gen !== renderGen) return;
      content.querySelectorAll(".mermaid").forEach((el) => {
        if (!el.querySelector("svg")) el.textContent = "Diagram did not render.";
      });
    }
  }
}

async function main() {
  const index = await loadIndex();
  if (!index) return;
  renderNav(index);
  const go = () => {
    const route = parseRoute(location.hash);
    if (!route) {
      hint("That address did not decode.");
      return;
    }
    if (route.path) renderDoc(index, route.path, route.frag);
  };
  window.addEventListener("hashchange", go);
  if (location.hash) go();
  else if (index.docs && index.docs.length) location.hash = index.docs[0].path;
}

main();
