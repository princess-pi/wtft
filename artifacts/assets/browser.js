const nav = document.getElementById("nav-list");
const navTitle = document.querySelector(".nav-title");
const content = document.getElementById("content");
const md = window.markdownit({ html: true, linkify: true });

function hint(text) {
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

async function renderDoc(index, path) {
  const gen = ++renderGen;
  const doc = findDoc(index, path);
  if (!doc) {
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
    return;
  }
  if (doc.kind === "file") {
    if (gen !== renderGen) return;
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
  const text = await res.text();
  if (gen !== renderGen) return;
  content.innerHTML = md.render(text);
  content.querySelectorAll("pre code.language-mermaid").forEach((block) => {
    const div = document.createElement("div");
    div.className = "mermaid";
    div.textContent = block.textContent;
    block.closest("pre").replaceWith(div);
  });
  if (window.mermaid) window.mermaid.run({ querySelector: ".mermaid" });
}

async function main() {
  const index = await loadIndex();
  if (!index) return;
  renderNav(index);
  const go = () => {
    const path = decodeURIComponent(location.hash.slice(1));
    if (path) renderDoc(index, path);
  };
  window.addEventListener("hashchange", go);
  if (location.hash) go();
  else if (index.docs && index.docs.length) location.hash = index.docs[0].path;
}

main();
