// runtime/markup.js — the rich-text representation, per RESOLVED (rich
// text is stored markup, rendered to content nodes, never HTML).
//
// The stored value of a rich-text field is a plain string of lightweight
// markup — a closed subset: blank-line paragraphs, #/##/### headings
// (a heading is a block of its own), '- ' unordered and '1. ' ordered
// list lines, '> ' quote lines, and inline **bold**, *italic*, `code`,
// [text](url). parseMarkup() turns that string into renderer-neutral
// content nodes; each renderer realizes the nodes natively (the web
// primitive via createElement — never innerHTML). Raw HTML has no
// pass-through: '<' is an ordinary character. Link hrefs pass a scheme
// allowlist; a disallowed scheme renders as plain text. Everything
// outside the subset is literal text.
//
// No imports — served to the browser unmodified, imported by Node tests.

const HEADING = /^(#{1,3})\s+(.*)$/;
const UNORDERED = /^-\s+(.*)$/;
const ORDERED = /^\d+\.\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;

// One alternation, earliest match wins; '**' before '*' so bold is not
// eaten as an empty italic, and bold's body is non-greedy so it may
// contain italics (the reverse nesting is outside the subset).
const INLINE = /`([^`]+)`|\*\*(.+?)\*\*|\*([^*]+?)\*|\[([^\]]+)\]\(([^()\s]+)\)/;

const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;
const ALLOWED_SCHEMES = new Set(["http", "https", "mailto"]);

export function parseMarkup(source) {
  const nodes = [];
  const blocks = String(source ?? "").split(/\n[ \t]*\n+/);
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    if (lines.length === 0) continue;
    const h = lines.length === 1 ? lines[0].match(HEADING) : null;
    if (h) {
      nodes.push({ type: "heading", level: h[1].length, inlines: parseInlines(h[2]) });
      continue;
    }
    if (lines.every((l) => UNORDERED.test(l))) {
      nodes.push({
        type: "list",
        ordered: false,
        items: lines.map((l) => parseInlines(l.match(UNORDERED)[1])),
      });
      continue;
    }
    if (lines.every((l) => ORDERED.test(l))) {
      nodes.push({
        type: "list",
        ordered: true,
        items: lines.map((l) => parseInlines(l.match(ORDERED)[1])),
      });
      continue;
    }
    if (lines.every((l) => QUOTE.test(l))) {
      nodes.push({
        type: "quote",
        inlines: parseInlines(lines.map((l) => l.match(QUOTE)[1]).join(" ")),
      });
      continue;
    }
    const inlines = [];
    lines.forEach((line, i) => {
      if (i > 0) inlines.push({ type: "break" });
      inlines.push(...parseInlines(line));
    });
    nodes.push({ type: "paragraph", inlines });
  }
  return nodes;
}

function parseInlines(text) {
  const out = [];
  let rest = text;
  while (rest !== "") {
    const m = rest.match(INLINE);
    if (!m) {
      out.push({ type: "text", text: rest });
      break;
    }
    if (m.index > 0) out.push({ type: "text", text: rest.slice(0, m.index) });
    if (m[1] !== undefined) {
      out.push({ type: "code", text: m[1] }); // code spans stay literal
    } else if (m[2] !== undefined) {
      out.push({ type: "bold", children: parseInlines(m[2]) });
    } else if (m[3] !== undefined) {
      out.push({ type: "italic", children: parseInlines(m[3]) });
    } else {
      const href = m[5];
      const scheme = href.match(SCHEME);
      if (scheme && !ALLOWED_SCHEMES.has(scheme[1].toLowerCase())) {
        // Disallowed scheme: the whole raw match renders as plain text —
        // injection is impossible by construction, not by sanitizing.
        out.push({ type: "text", text: m[0] });
      } else {
        out.push({ type: "link", text: m[4], href });
      }
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}
