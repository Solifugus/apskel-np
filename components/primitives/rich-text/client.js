// rich-text primitive — per RESOLVED (rich-text primitive; mode is
// load-checked) and RESOLVED (rich text is stored markup, rendered to
// content nodes, never HTML). The value is the markup SOURCE string in
// every mode: 'edit' is a write-through textarea over the source
// (exactly text-area's valve), 'view' realizes the parsed content
// nodes, 'split' is both — the preview repaints on each write() push,
// so typing updates it through the ordinary store loop, never through
// anything the primitive kept. The realizer builds DOM with
// createElement/createTextNode only; user content never meets
// innerHTML.

import { parseMarkup } from "/runtime/markup.js";

export function create(ctx, el) {
  const mode = ctx.attrs.mode ?? "edit"; // load fills the default; ?? is belt
  if (mode !== "view") {
    const area = document.createElement("textarea");
    area.className = "apskel-rich-text-source";
    if (ctx.attrs.placeholder) area.placeholder = ctx.attrs.placeholder;
    if (ctx.attrs.rows) area.rows = Number(ctx.attrs.rows) || 10;
    area.addEventListener("input", () => ctx.input("field", area.value));
    el.appendChild(area);
    ctx.dom.area = area;
  }
  if (mode !== "edit") {
    const view = document.createElement("div");
    view.className = "apskel-rich-text-view";
    el.appendChild(view);
    ctx.dom.view = view;
  }
  el.classList.add(`apskel-rich-text-${mode}`);
}

export function write(ctx, field, value) {
  const text = value == null ? "" : String(value);
  if (ctx.dom.area && ctx.dom.area.value !== text) ctx.dom.area.value = text;
  if (ctx.dom.view) realize(ctx.dom.view, parseMarkup(text));
}

export function destroy(ctx) {}

// --- content-node realization (web renderer) -------------------------------

const BLOCK_TAGS = { paragraph: "p", quote: "blockquote" };

function realize(host, nodes) {
  host.textContent = "";
  for (const node of nodes) {
    if (node.type === "heading") {
      host.appendChild(inlineInto(document.createElement(`h${node.level}`), node.inlines));
    } else if (node.type === "list") {
      const list = document.createElement(node.ordered ? "ol" : "ul");
      for (const item of node.items) {
        list.appendChild(inlineInto(document.createElement("li"), item));
      }
      host.appendChild(list);
    } else {
      host.appendChild(inlineInto(document.createElement(BLOCK_TAGS[node.type] ?? "p"), node.inlines));
    }
  }
}

function inlineInto(el, inlines) {
  for (const node of inlines) {
    if (node.type === "text") {
      el.appendChild(document.createTextNode(node.text));
    } else if (node.type === "break") {
      el.appendChild(document.createElement("br"));
    } else if (node.type === "code") {
      const code = document.createElement("code");
      code.textContent = node.text;
      el.appendChild(code);
    } else if (node.type === "bold") {
      el.appendChild(inlineInto(document.createElement("strong"), node.children));
    } else if (node.type === "italic") {
      el.appendChild(inlineInto(document.createElement("em"), node.children));
    } else if (node.type === "link") {
      const a = document.createElement("a");
      a.href = node.href; // scheme-allowlisted by the parser
      a.textContent = node.text;
      a.rel = "noopener noreferrer";
      el.appendChild(a);
    }
  }
  return el;
}
