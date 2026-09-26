const nav = document.getElementById("nav-list");
const navTitle = document.querySelector(".nav-title");
const content = document.getElementById("content");
const md = window.markdownit({ html: true, linkify: true });

async function loadIndex() {
  const res = await fetch("docs.json", { cache: "no-store" });
  if (!res.ok) {
    content.innerHTML = `<p class="hint">No docs.json found, or it failed to load (${res.status}).</p>`;
    return null;
  }
  return res.json();
}

function renderNav(index) {
  if (index.title) navTitle.textContent = index.title;
  const groups = new Map();
  for (const doc of index.docs || []) {
    const group = doc.group || "";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(doc);
  }
  nav.innerHTML = "";
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

async function renderDoc(index, path) {
  const doc = findDoc(index, path);
  if (!doc) {
    content.innerHTML = `<p class="hint">Not in docs.json: ${path}</p>`;
    return;
  }
  document.querySelectorAll("#nav-list a").forEach((a) => {
    a.classList.toggle("active", a.dataset.path === path);
  });

  if (doc.kind === "html") {
    content.innerHTML = `<iframe src="${path}" style="width:100%;height:80vh;border:1px solid var(--border);border-radius:6px;"></iframe>`;
    return;
  }
  if (doc.kind === "file") {
    content.innerHTML = `<p><a href="${path}" download>${doc.title || path}</a> (binary — download to view)</p>`;
    return;
  }

  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) {
    content.innerHTML = `<p class="hint">Failed to load ${path} (${res.status})</p>`;
    return;
  }
  const text = await res.text();
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
