/**
 * Nib — a small offline helper in Notible's corner (plugin API 1.22).
 *
 * It answers "how do I…" questions only from what this build has: Core's Help
 * pages and the guides of plugins that are on. A built-in that is off gets
 * "turn it on"; anything else gets "I don't have information about that yet".
 * No network, no model: retrieval over `context.help.topics()`.
 *
 * Design: docs/superpowers/specs/2026-10-02-nib-plugin-design.md (monorepo).
 * The engine below is pure (no DOM) and exported for self-check.mjs.
 */

// ---------- engine ----------

const STOP_EN = new Set("a an and are as at be by can could do does doing for from get got have how i if in into is it its me my of on or please should so some that the their them then there these this to use using want was we what when where which who why will with would you your about any all also am been being did don each else has just make more much need not now off one only other our out over same see such than too very way whats hows".split(" "));
const STOP_PL = new Set("a aby albo ale bo by czy co do dla gdy gdzie i ich jak jaki jakie jest jestem juz ktore ktory lub ma mam mi moge moj moja mozna na nie o od po pod przez sie sa ta tak tam te tego to tu w we z za ze zeby oraz czym jakos chce chcialbym".split(" "));

/** English groups; a hit through a synonym counts half. Grows from fixtures only. */
const SYNONYM_GROUPS = [
  ["delete", "remove", "trash", "bin", "erase"],
  ["shortcut", "hotkey", "keyboard", "key", "keybinding"],
  ["table", "spreadsheet", "grid"],
  ["export", "download", "pdf", "save"],
  ["find", "search", "filter", "look"],
  ["link", "backlink", "wikilink"],
  ["gantt", "timeline", "chart", "schedule"],
  ["kanban", "board"],
  ["image", "picture", "screenshot", "photo"],
  ["restore", "recover", "undo", "undelete"],
  ["folder", "container", "directory"],
  ["task", "todo"],
  ["issue", "bug"],
  ["plugin", "extension", "addon"],
  ["theme", "dark", "colour", "color"],
  ["setting", "preference", "option"],
  ["checklist", "checkbox", "tick"],
  ["heading", "title", "header"],
  ["diagram", "mermaid", "flowchart"],
  ["move", "drag"],
];
const SYNONYMS = new Map();
for (const group of SYNONYM_GROUPS) for (const word of group) SYNONYMS.set(word, group.filter((other) => other !== word));

/** Polish stems (folded, ≥ 4 chars), matched as substrings, so prefixes and endings do not matter. */
const POLISH = [
  ["notat", "note"], ["zadan", "task"], ["projekt", "project"], ["tabel", "table"], ["skrot", "shortcut"],
  ["klawisz", "shortcut"], ["wtyczk", "plugin"], ["plugin", "plugin"], ["eksport", "export"], ["pobier", "download"],
  ["szuka", "search"], ["wyszuk", "search"], ["znalez", "find"], ["usun", "delete"], ["kasow", "delete"],
  ["przywro", "restore"], ["odzysk", "restore"], ["kosz", "trash"], ["odnosnik", "link"], ["linku", "link"],
  ["obraz", "image"], ["zdjec", "image"], ["zrzut", "screenshot"], ["motyw", "theme"], ["ustawien", "setting"],
  ["folder", "folder"], ["katalog", "folder"], ["tablic", "whiteboard"], ["kopi", "backup"], ["kopii", "backup"],
  ["drukow", "print"], ["przenie", "move"], ["przesun", "move"], ["nagłow", "heading"], ["naglow", "heading"],
  ["list", "list"], ["kalendarz", "calendar"], ["termin", "due"], ["harmonogram", "timeline"], ["budzet", "budget"],
  ["koszt", "cost"], ["wykres", "diagram"], ["jezyk", "language"], ["aktualiz", "update"], ["przypomn", "reminder"],
  ["powiadom", "notification"], ["wlasciwos", "property"], ["widok", "view"], ["szablon", "template"], ["nazw", "rename"],
];

const W_CORE = { title: 6, heading: 5, keywords: 3, summary: 2, text: 1 };
const W_PLUGIN = { title: 3, heading: 3, keywords: 0, summary: 0, text: 1 };
export const LIMITS = { question: 200, tokens: 20, render: 4096, topic: 30720 };
export const THRESHOLDS = { confidence: 0.45, coverage: 0.6, margin: 1.15, related: 0.2 };

export function fold(value) {
  return String(value ?? "").normalize("NFKD").replace(/\p{M}/gu, "").replace(/[łŁ]/gu, "l").toLowerCase();
}

export function stem(token) {
  if (token.length >= 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length >= 4 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

/** Words of a text: folded, stop words and 1-char tokens dropped, plural -s removed. */
export function tokenize(text) {
  return fold(text).split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 2 && !STOP_EN.has(token) && !STOP_PL.has(token)).map(stem);
}

/** A question as English tokens. Polish words are mapped through their stems. */
export function questionTokens(question) {
  const raw = String(question ?? "").slice(0, LIMITS.question);
  const folded = fold(raw).split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 2);
  const polish = /[ąćęłńóśźż]/iu.test(raw) || folded.filter((token) => STOP_PL.has(token)).length >= 2;
  const out = [];
  for (const token of folded) {
    if (STOP_EN.has(token) || STOP_PL.has(token)) continue;
    const mapped = polish || !SYNONYMS.has(stem(token)) ? POLISH.find(([pl]) => token.length >= 4 && token.includes(pl)) : undefined;
    out.push(mapped ? mapped[1] : stem(token));
    if (out.length >= LIMITS.tokens) break;
  }
  return { tokens: out, polish };
}

/** Text safe to index and render: no images, help:/settings: links made inert-but-clickable, capped. */
export function cleanMarkdown(markdown, limit = LIMITS.render) {
  let text = String(markdown ?? "")
    .replace(/!\[[^\]\n]*\]\([^)\n]*\)/gu, "")
    .replace(/\[([^\]\n]+)\]\(help:([\w-]+)(?:#([\w-]+))?\)/gu, (_all, label, page, slug) => `[${label}](https://nib.invalid/help/${page}/${slug ?? ""})`)
    .replace(/\[([^\]\n]+)\]\(settings:[\w-]*\)/gu, (_all, label) => `[${label}](https://nib.invalid/settings)`)
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  if (text.length > limit) {
    const cut = text.lastIndexOf("\n\n", limit);
    text = text.slice(0, cut > limit / 2 ? cut : limit).trim();
  }
  return text;
}

/** The first block of a section: a paragraph, up to six list items, or a table. */
export function firstBlock(markdown) {
  const blocks = markdown.split(/\n\s*\n/u);
  const first = blocks[0] ?? "";
  const lines = first.split("\n");
  if (lines.every((line) => /^\s*([-*]|\d+\.)\s/u.test(line)) && lines.length > 6) return lines.slice(0, 6).join("\n");
  return first;
}

function addField(map, tokens, weight) {
  for (const token of tokens) if (weight > (map.get(token) ?? 0)) map.set(token, weight);
}

/**
 * Index the topics. Core pages: one doc per section of an enabled page, a
 * stub for a built-in that is off or failed. Plugin guides: only for enabled
 * plugins that have no Core page (third parties); a disabled third party is
 * not indexed at all, so it can never be offered as "turn it on".
 */
export function buildIndex(topics) {
  const docs = [];
  const builtins = new Set(topics.filter((topic) => topic.source === "core" && topic.pluginId).map((topic) => topic.pluginId));
  for (const topic of topics) {
    if (topic.source === "core") {
      const feature = topic.pluginId ?? topic.id;
      if (topic.state !== "enabled") {
        if (!topic.pluginId) continue;
        const fields = new Map();
        addField(fields, tokenize(topic.title), W_CORE.title);
        addField(fields, tokenize(topic.keywords), W_CORE.keywords);
        addField(fields, tokenize(cleanMarkdown(topic.summary, 400)), W_CORE.summary);
        docs.push({ kind: "stub", feature, topic, state: topic.state, pluginId: topic.pluginId, title: topic.title, heading: "", slug: "", text: cleanMarkdown(topic.summary, 400), fields, headingTokens: [] });
        continue;
      }
      let budget = LIMITS.topic;
      topic.sections.forEach((section, index) => {
        const text = cleanMarkdown(section.text, Math.max(0, budget));
        budget -= text.length;
        const fields = new Map();
        addField(fields, tokenize(topic.title), W_CORE.title);
        // The intro (no slug) carries the page keywords; a page without intro
        // text puts them on nothing rather than on its first real section.
        const intro = section.slug === "";
        const headingTokens = intro ? [] : tokenize(section.heading);
        addField(fields, headingTokens, W_CORE.heading);
        if (intro) addField(fields, tokenize(topic.keywords), W_CORE.keywords);
        addField(fields, tokenize(text), W_CORE.text);
        docs.push({ kind: "core", feature, topic, state: "enabled", pluginId: topic.pluginId, title: topic.title, heading: intro ? "" : section.heading, slug: section.slug, text, fields, headingTokens, order: index });
      });
    } else if (topic.state === "enabled" && !builtins.has(topic.pluginId)) {
      let budget = LIMITS.topic;
      const sections = topic.sections.length ? topic.sections : [{ heading: topic.title, slug: "", text: topic.summary }];
      sections.forEach((section, index) => {
        const text = cleanMarkdown(section.text, Math.max(0, budget));
        budget -= text.length;
        const fields = new Map();
        addField(fields, tokenize(topic.title), W_PLUGIN.title);
        const intro = section.slug === "";
        const headingTokens = intro ? [] : tokenize(section.heading);
        addField(fields, headingTokens, W_PLUGIN.heading);
        addField(fields, tokenize(text), W_PLUGIN.text);
        docs.push({ kind: "plugin", feature: topic.pluginId ?? topic.id, topic, state: "enabled", pluginId: topic.pluginId, title: topic.title, heading: intro ? "" : section.heading, slug: section.slug, text, fields, headingTokens, order: index });
      });
    }
  }
  const df = new Map();
  const best = new Map();
  for (const doc of docs) {
    for (const [token, weight] of doc.fields) {
      df.set(token, (df.get(token) ?? 0) + 1);
      if (weight > (best.get(token) ?? 0)) best.set(token, weight);
    }
  }
  return { docs, df, best, vocabulary: [...df.keys()], size: docs.length, topics };
}

/** Index tokens a question token can match, with how much each match counts. */
function candidatesFor(index, token) {
  const out = [];
  if (index.df.has(token)) out.push([token, 1]);
  if (token.length >= 4) {
    for (const word of index.vocabulary) {
      if (word !== token && word.length >= 4 && (word.startsWith(token) || token.startsWith(word))) out.push([word, 0.7]);
    }
  }
  for (const synonym of SYNONYMS.get(token) ?? []) if (index.df.has(synonym)) out.push([synonym, 0.5]);
  return out;
}

function idf(index, token) {
  return Math.log(1 + index.size / (index.df.get(token) ?? index.size));
}

function scoreDocs(index, tokens, docs) {
  const known = tokens.map((token) => ({ token, candidates: candidatesFor(index, token) })).filter((entry) => entry.candidates.length > 0);
  if (known.length === 0) return { known: 0, results: [] };
  const denominator = known.reduce((sum, entry) => sum + Math.max(...entry.candidates.map(([word]) => idf(index, word) * (index.best.get(word) ?? 1))), 0);
  const results = docs.map((doc) => {
    let score = 0;
    let matched = 0;
    for (const entry of known) {
      let tokenScore = 0;
      for (const [word, factor] of entry.candidates) {
        const weight = doc.fields.get(word);
        if (weight) tokenScore = Math.max(tokenScore, idf(index, word) * weight * factor);
      }
      if (tokenScore > 0) matched += 1;
      // A word in the section's own heading beats the same word in its page
      // title, which every section of the page shares.
      if (entry.candidates.some(([word, factor]) => factor >= 0.7 && doc.headingTokens.includes(word))) tokenScore += idf(index, entry.token) * 0.5;
      score += tokenScore;
    }
    for (let i = 0; i + 1 < tokens.length; i += 1) {
      const at = doc.headingTokens.indexOf(tokens[i]);
      if (at >= 0 && doc.headingTokens[at + 1] === tokens[i + 1]) score += idf(index, tokens[i + 1]);
    }
    return { doc, score, confidence: Math.min(1, score / denominator), coverage: matched / known.length };
  }).filter((result) => result.score > 0);
  // One result per feature: the best section (earlier on a tie).
  const byFeature = new Map();
  for (const result of results.sort((a, b) => b.score - a.score || (a.doc.order ?? 0) - (b.doc.order ?? 0))) {
    if (!byFeature.has(result.doc.feature)) byFeature.set(result.doc.feature, result);
  }
  return { known: known.length, results: [...byFeature.values()] };
}

function passes(first, second) {
  return first && first.confidence >= THRESHOLDS.confidence && first.coverage >= THRESHOLDS.coverage
    && (!second || first.score >= second.score * THRESHOLDS.margin);
}

const GREETING = /^(hi|hello|hey|help|what can you do|who are you|czesc|hej|witaj|pomoc|pomocy|co potrafisz)\b/u;
const WHICH_PLUGINS = /\b(which|what) plugins?\b|\bjakie (wtyczki|pluginy)\b|\bplugins? (are )?(on|installed)\b/u;
const THANKS = /^(thanks|thank you|thx|dzieki|dziekuje)\b/u;

/**
 * Answer a question. Returns data only; the UI turns it into DOM.
 * modes: answer | off | failed | related | dontknow | greeting | plugins | thanks
 */
export function ask(index, question) {
  const text = fold(String(question ?? "").slice(0, LIMITS.question)).trim();
  const { tokens, polish } = questionTokens(question);
  if (GREETING.test(text)) return { mode: "greeting", polish };
  if (THANKS.test(text)) return { mode: "thanks", polish };
  if (WHICH_PLUGINS.test(text)) {
    const builtins = new Set(index.topics.filter((topic) => topic.source === "core" && topic.pluginId).map((topic) => topic.pluginId));
    const plugins = index.topics.filter((topic) => topic.source === "plugin");
    return {
      mode: "plugins",
      polish,
      on: plugins.filter((topic) => topic.state === "enabled").map((topic) => ({ pluginId: topic.pluginId, title: topic.title, builtin: builtins.has(topic.pluginId) })),
      off: plugins.filter((topic) => topic.state !== "enabled" && builtins.has(topic.pluginId)).map((topic) => ({ pluginId: topic.pluginId, title: topic.title })),
    };
  }
  const core = scoreDocs(index, tokens, index.docs.filter((doc) => doc.kind !== "plugin"));
  if (core.known === 0) return { mode: "dontknow", polish };
  const [first, second] = core.results;
  const all = scoreDocs(index, tokens, index.docs);
  // A plugin guide is only suggested when it is as good a match as an answer:
  // a stranger's guide stuffed with Help words must not ride along everywhere.
  const also = (feature) => all.results.filter((result) => result.doc.feature !== feature && result.doc.state === "enabled"
    && result.confidence >= (result.doc.kind === "plugin" ? THRESHOLDS.confidence : THRESHOLDS.related)).slice(0, 2).map((result) => result.doc);
  if (passes(first, second)) {
    const mode = first.doc.state === "enabled" ? "answer" : first.doc.state === "failed" ? "failed" : "off";
    return { mode, polish, doc: first.doc, confidence: first.confidence, also: mode === "answer" ? also(first.doc.feature) : [] };
  }
  const [top, next] = all.results;
  if (top?.doc.kind === "plugin" && passes(top, next)) return { mode: "answer", polish, doc: top.doc, confidence: top.confidence, also: also(top.doc.feature) };
  if (top && top.confidence >= THRESHOLDS.related) return { mode: "related", polish, related: all.results.slice(0, 3).map((result) => result.doc) };
  return { mode: "dontknow", polish };
}

// ---------- UI ----------

/**
 * The fella: a folded note with a face, drawn on a 24×24 pixel grid into a
 * canvas (the character study: https://claude.ai/artifact/Sy8PJcCLqAfQSfW4Nq5tdh).
 * Seven moods; every motion is stepped frame by frame, like a sprite, and
 * "reduce motion" freezes them. Outline colours follow the theme; the face
 * stays dark because the paper stays light in both themes.
 */
export const MOODS = ["idle", "listening", "thinking", "working", "answering", "unsure", "sleeping", "unlocked"];

/** Draws one frame. ctx is a 2D context, t is milliseconds, c the colours, still=true freezes motion. */
export function drawNib(ctx, mood, t, c, still = false) {
  const size = ctx.canvas.width / 24;
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  const px = (x, y, w = 1, h = 1, colour = c.ink) => { ctx.fillStyle = colour; ctx.fillRect(Math.round(x * size), Math.round(y * size), Math.ceil(w * size), Math.ceil(h * size)); };
  const move = still ? 0 : 1;
  const state = mood === "listening" ? "idle" : mood;
  let dy = 0;
  if (state === "idle" || state === "thinking") dy = (Math.floor(t / 600) % 2) * move;
  if (state === "sleeping") dy = (Math.floor(t / 1100) % 2) * move;
  if (state === "unlocked") dy = move ? [0, -2, -3, -2, 0, 0][Math.floor(t / 110) % 6] : 0;
  if (state === "working") dy = (Math.floor(t / 180) % 2) * move;

  // Feet stay on the ground while the body jumps.
  const feetUp = state === "unlocked" && dy < 0 ? -1 : 0;
  px(8, 21 + feetUp, 2, 1); px(14, 21 + feetUp, 2, 1);

  // Body: a note with a folded top-right corner and two ruled lines.
  const top = 4 + dy;
  px(5, top, 11, 1); px(4, top + 1, 1, 15); px(19, top + 4, 1, 12); px(5, top + 16, 14, 1);
  px(16, top + 1, 1, 1); px(17, top + 2, 1, 1); px(18, top + 3, 1, 1);
  px(5, top + 1, 11, 15, c.paper); px(16, top + 4, 3, 12, c.paper);
  px(16, top + 2, 1, 2, c.paper); px(17, top + 3, 1, 1, c.paper);
  px(16, top + 1, 1, 3, c.shade); px(17, top + 3, 2, 1, c.shade);
  px(16, top + 1, 1, 1); px(16, top + 4, 3, 1);
  for (const line of [top + 12, top + 14]) px(7, line, 10, 1, c.shade);

  // Eyes.
  const blink = state === "idle" && move && Math.floor(t / 150) % 22 === 0;
  let eye = { dx: 0, dy: 0, shape: "open" };
  if (state === "thinking") eye = { dx: 1, dy: -1, shape: "open" };
  if (state === "working") eye = { dx: 0, dy: 1, shape: "open" };
  if (state === "sleeping" || blink) eye.shape = "closed";
  if (state === "unlocked") eye.shape = "happy";
  if (state === "unsure") eye.shape = "small";
  for (const ex of [8, 13]) {
    const x = ex + eye.dx;
    const y = top + 6 + eye.dy;
    if (eye.shape === "open") px(x, y, 2, 2, c.face);
    if (eye.shape === "small") px(x + 0.5, y + 0.5, 1, 1, c.face);
    if (eye.shape === "closed") px(x, y + 1, 2, 1, c.face);
    if (eye.shape === "happy") { px(x, y + 1, 1, 1, c.face); px(x + 1, y, 1, 1, c.face); px(x + 2, y + 1, 1, 1, c.face); }
  }
  px(7, top + 9, 1, 1, c.cheek); px(16, top + 9, 1, 1, c.cheek);

  // Mouth.
  const mouthY = top + 10;
  if (state === "answering") px(11, mouthY, 2, move && Math.floor(t / 160) % 2 ? 2 : 1, c.face);
  else if (state === "unsure") { px(10, mouthY, 1, 1, c.face); px(11, mouthY + 0.5, 1, 1, c.face); px(12, mouthY, 1, 1, c.face); px(13, mouthY + 0.5, 1, 1, c.face); }
  else if (state === "unlocked") { px(10, mouthY, 4, 1, c.face); px(11, mouthY + 1, 2, 1, c.face); }
  else if (state === "sleeping") px(11, mouthY, 2, 1, c.shade);
  else px(11, mouthY, 2, 1, c.face);

  // Arms and props.
  if (state === "thinking") { px(3, top + 10, 1, 2); px(13, mouthY + 2, 2, 1, c.face); px(15, mouthY + 1, 1, 1, c.face); }
  else if (state === "unsure") { const up = move ? Math.floor(t / 400) % 2 : 1; px(2, top + 6 - up, 1, 3); px(21, top + 6 - up, 1, 3); px(3, top + 9 - up, 1, 1); px(20, top + 9 - up, 1, 1); }
  else if (state === "unlocked") { px(2, top + 3, 1, 3); px(21, top + 3, 1, 3); }
  else if (state === "working") {
    // A scrap of paper and a pencil that scribbles on it.
    px(13, 19, 8, 3, c.paper); px(13, 19, 8, 1, c.shade);
    const reach = move ? Math.floor(t / 140) % 4 : 1;
    const scribble = move ? Math.floor(t / 140) % 8 : 3;
    for (let i = 0; i < scribble; i += 1) px(14 + (i % 6), 20 + (i % 2), 1, 1, c.muted);
    px(15 + reach, 15, 1, 4, c.pencil); px(15 + reach, 19, 1, 1, c.face); px(14 + reach, 15, 1, 1, c.accent);
    px(19, top + 11, 1, 1); px(20, top + 12, 1, 1);
  } else { px(3, top + 11, 1, 3); px(20, top + 11, 1, 3); }

  // Bubbles and effects.
  if (state === "thinking") {
    px(20, 3, 1, 1); px(21, 1, 1, 1);
    const dots = move ? Math.floor(t / 350) % 4 : 3;
    for (let i = 0; i < dots; i += 1) px(17 + i * 2, 0.5, 1, 1, c.accent);
  }
  if (state === "answering") {
    px(18, 0, 6, 4, c.surface); px(18, 0, 6, 1); px(18, 3, 6, 1); px(18, 0, 1, 4); px(23, 0, 1, 4); px(19, 4, 1, 1);
    const lines = move ? 1 + (Math.floor(t / 300) % 3) : 3;
    for (let i = 0; i < Math.min(lines, 2); i += 1) px(19.5, 1.2 + i, 3 - i, 0.6, c.accent);
  }
  if (state === "unsure" && (!move || Math.floor(t / 500) % 2 === 0)) {
    px(11, 0, 3, 1, c.accent); px(13, 1, 1, 1, c.accent); px(12, 2, 1, 1, c.accent); px(12, 3.5, 1, 1, c.accent);
  }
  if (state === "sleeping") {
    const phase = move ? (t / 1400) % 1 : 0.4;
    [[19, 4, 1], [20.5, 2, 1.4], [22, 0, 1.8]].forEach(([x, y, s], i) => {
      if (phase <= i * 0.25) return;
      const yy = y - phase * 1.5;
      px(x, yy, s, 0.4, c.muted); px(x + s - 0.4, yy, 0.4, s * 0.6, c.muted); px(x, yy + s * 0.6, s, 0.4, c.muted);
    });
  }
  if (state === "unlocked") {
    const phase = move ? Math.floor(t / 180) % 4 : 1;
    [[1, 2], [21, 1], [0, 12], [22, 13], [2, 20], [21, 20]].forEach(([x, y], i) => {
      if ((i + phase) % 2 === 0) { px(x, y + 1, 3, 1, c.accent); px(x + 1, y, 1, 3, c.accent); }
    });
  }
}

/** Colours from the running theme; the paper and the face are fixed so the face reads in both themes. */
function themeColours(element) {
  const css = getComputedStyle(element);
  const read = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  const dark = document.documentElement.getAttribute("data-notible-mode") === "dark";
  return {
    ink: read("--notible-text", dark ? "#e8ecf4" : "#18202e"),
    muted: read("--notible-muted", "#5b6577"),
    accent: read("--notible-accent", "#2e6be6"),
    surface: read("--notible-surface", dark ? "#171d28" : "#ffffff"),
    paper: dark ? "#f1f3f8" : "#ffffff",
    shade: dark ? "#aab4c8" : "#d8deea",
    face: "#18202e",
    cheek: dark ? "#f08c9a" : "#f3a6b0",
    pencil: "#f2b233",
  };
}

/**
 * One timer for every Nib canvas on screen, 10 frames a second (every step in
 * drawNib is 110 ms or longer). It stops when no canvas is connected and skips
 * frames while the corner is hidden or the window is in the background.
 */
const sprites = new Set();
let spriteTimer = 0;
function tick() {
  const now = performance.now();
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  for (const sprite of sprites) {
    if (!sprite.canvas.isConnected) { sprites.delete(sprite); continue; }
    if (document.hidden || sprite.canvas.getClientRects().length === 0) continue;
    drawNib(sprite.ctx, sprite.mood(), now, themeColours(sprite.canvas), still);
  }
  if (!sprites.size) { window.clearInterval(spriteTimer); spriteTimer = 0; }
}

/** A canvas showing Nib at `cssSize` px; mood() is read on every frame. */
export function nibSprite(cssSize, mood) {
  const canvas = document.createElement("canvas");
  canvas.className = "nib-face";
  canvas.setAttribute("aria-hidden", "true");
  const scale = Math.max(1, Math.round(window.devicePixelRatio || 1));
  canvas.width = canvas.height = cssSize * scale;
  canvas.style.width = canvas.style.height = `${cssSize}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  ctx.imageSmoothingEnabled = false;
  sprites.add({ canvas, ctx, mood });
  if (!spriteTimer) spriteTimer = window.setInterval(tick, 100);
  // First frame now, so it never flashes empty.
  queueMicrotask(tick);
  return canvas;
}

export const NIB_CSS = `
.nib{font-family:var(--notible-font-sans,inherit);font-size:13px;color:var(--notible-text);display:grid;gap:8px;justify-items:start}
.nib *{box-sizing:border-box}
.nib button{font:inherit;color:inherit;min-height:28px;cursor:pointer}
.nib button:focus-visible,.nib input:focus-visible{outline:2px solid var(--notible-accent);outline-offset:-2px}
.nib-wake{width:72px;height:72px;padding:0;border:0;border-radius:8px;background:transparent}
.nib-wake:hover .nib-face{transform:translateY(-1px)}
.nib-face{display:block;image-rendering:pixelated}
.nib-bubble{max-width:240px;padding:8px 10px;border:1px solid var(--notible-border);border-radius:10px;background:var(--notible-surface);font-size:12px}
.nib-panel{width:min(320px,40vw);max-height:min(400px,60vh);display:grid;grid-template-rows:auto minmax(0,1fr) auto;border:1px solid var(--notible-border);border-radius:10px;background:var(--notible-surface)}
.nib-head{display:flex;align-items:center;gap:8px;padding:4px 6px 4px 8px;border-bottom:1px solid var(--notible-border);height:36px}
.nib-head .nib-mini{width:24px;height:24px}
.nib-head strong{flex:1}
.nib-close{border:0;background:transparent;width:28px;border-radius:6px}
.nib-close:hover{background:var(--notible-hover)}
.nib-body-scroll{overflow-y:auto;padding:10px;display:grid;gap:8px;align-content:start}
.nib-body-scroll p{margin:0}
.nib-meta{color:var(--notible-muted);font-size:12px}
.nib-excerpt{line-height:1.5;overflow-wrap:anywhere}
.nib-excerpt p,.nib-excerpt ul,.nib-excerpt ol{margin:0 0 6px}
.nib-excerpt h1,.nib-excerpt h2,.nib-excerpt h3{font-size:13px;margin:0 0 4px}
.nib-excerpt table{border-collapse:collapse;font-size:12px}
.nib-excerpt td,.nib-excerpt th{border:1px solid var(--notible-border);padding:2px 5px}
.nib-excerpt .core-md-link-mark{display:none}
.nib-excerpt .core-md-link,.nib-excerpt .core-md-fnlink{color:var(--notible-accent);text-decoration:underline;cursor:pointer}
.nib-actions{display:flex;flex-wrap:wrap;gap:6px}
.nib-action{border:1px solid var(--notible-accent);border-radius:8px;background:transparent;color:var(--notible-accent)!important;padding:3px 10px}
.nib-action:hover{background:var(--notible-hover)}
.nib-link{border:0;background:transparent;padding:2px 0;color:var(--notible-accent)!important;text-align:left;text-decoration:underline}
.nib-ask{display:flex;gap:6px;padding:8px;border-top:1px solid var(--notible-border)}
.nib-ask input{flex:1;min-width:0;height:30px;border:1px solid var(--notible-border);border-radius:8px;padding:0 8px;background:var(--notible-surface);color:var(--notible-text);font:inherit}
.nib-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
`;

const RESERVED_NAME = /notible/iu;
const STARTERS = ["How do I link notes?", "Keyboard shortcuts", "How do I restore a deleted note?"];

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export default {
  manifest: {
    id: "notible.nib",
    name: "Nib",
    version: "0.2.1",
    apiVersion: "1.22",
    permissions: ["workspace.ui"],
  },
  onload(context) {
    const t = (key, values) => context.i18n.t(key, values);
    // Outside mount: a remount (Core may rebuild the corner) keeps the conversation.
    const state = { open: false, last: null, history: [], polishNoted: false, index: null, topicsRef: null, ui: null };

    function index() {
      const topics = context.help.topics();
      if (topics !== state.topicsRef || !state.index) {
        state.index = buildIndex(topics);
        state.topicsRef = topics;
      }
      return state.index;
    }

    /** A plugin name as Nib shows it: third parties always with their id. */
    function displayName(entry) {
      const builtin = index().topics.some((topic) => topic.source === "core" && topic.pluginId === entry.pluginId);
      if (builtin) return entry.title;
      const name = RESERVED_NAME.test(entry.title) ? t("Community plugin") : entry.title;
      return `${name} (${entry.pluginId})`;
    }

    context.commands.register({
      id: "ask",
      name: "Ask Nib",
      description: "Open Nib's question box.",
      hotkey: "Mod+Shift+H",
      execute: () => {
        if (!state.ui) {
          context.ui.notice(t("Nib isn't the corner helper. Choose it in Settings → Plugins → Corner helper."));
          return;
        }
        // Hidden (Settings, Help, a modal): Nib's own element has no boxes.
        // Not offsetParent (null for everything inside the fixed corner) and
        // not the container (Core's mount wrapper is display: contents).
        if (state.ui.root.getClientRects().length === 0) return;
        state.ui.returnTo = document.activeElement;
        state.open = true;
        state.ui.render();
        state.ui.focusInput();
      },
    });

    context.ui.registerSlot("workspace.corner", {
      id: "nib",
      mount: ({ container }) => {
        const root = node("div", "nib is-idle");
        const style = node("style");
        style.textContent = NIB_CSS;
        container.append(style, root);
        const ui = { container, root, returnTo: null, render: () => {}, focusInput: () => {} };
        state.ui = ui;
        let input = null;
        let thinking = false;
        let introTimer = 0;
        let introDismiss = null;

        // Where focus was before a click moved it into Nib (Escape returns there).
        const onPointerDown = () => { if (!root.contains(document.activeElement)) ui.returnTo = document.activeElement; };
        root.addEventListener("pointerdown", onPointerDown, true);

        // What the fella shows: the mood render() picked, a short-lived one
        // (working, unlocked) on top, and sleep after 20 s alone in the corner.
        let mood = "idle";
        let flash = "";
        let flashUntil = 0;
        let lastActive = performance.now();
        function setMood(next) {
          mood = next;
          lastActive = performance.now();
          root.className = `nib is-${next}`;
        }
        function flashMood(next, ms) { flash = next; flashUntil = performance.now() + ms; lastActive = performance.now(); }
        function face() {
          const now = performance.now();
          if (now < flashUntil) return flash;
          if (mood === "idle" && !state.open && now - lastActive > 20_000) return "sleeping";
          return mood;
        }

        function close() {
          state.open = false;
          render();
          const back = ui.returnTo;
          if (back && back.isConnected && typeof back.focus === "function") back.focus();
          else root.querySelector(".nib-wake")?.focus();
        }

        function announce(text) {
          const live = root.querySelector(".nib-live");
          if (live) live.textContent = text;
        }

        function excerpt(markdown) {
          const box = node("div", "nib-excerpt");
          const template = document.createElement("template");
          template.innerHTML = context.ui.renderMarkdown(cleanMarkdown(markdown));
          for (const image of template.content.querySelectorAll("img")) image.remove();
          box.append(template.content);
          return box;
        }

        function action(label, onClick, className = "nib-action") {
          const button = node("button", className, label);
          button.type = "button";
          button.addEventListener("click", onClick);
          return button;
        }

        function navigate(promise) {
          flashMood("working", 600);
          void Promise.resolve(promise).catch(() => announce(t("One moment, then try again.")));
        }

        function answerView(result) {
          const body = [];
          if (result.polish && !state.polishNoted && String(context.i18n.locale).startsWith("pl")) {
            state.polishNoted = true;
            body.push(node("p", "nib-meta", t("Help is in English for now.")));
          }
          if (result.mode === "greeting") {
            body.push(node("p", "", t("Ask me how to do something in Notible.")));
            const starters = node("div", "nib-actions");
            for (const question of STARTERS) starters.append(action(t(question), () => askNow(t(question))));
            body.push(starters);
            return body;
          }
          if (result.mode === "thanks") { body.push(node("p", "", t("Happy to help."))); return body; }
          if (result.mode === "plugins") {
            body.push(node("p", "nib-meta", t("Turned on:")));
            const on = node("p", "", result.on.map((entry) => displayName(entry)).join(", ") || "—");
            body.push(on);
            if (result.off.length) {
              body.push(node("p", "nib-meta", t("Built in, turned off:")));
              const list = node("div", "nib-actions");
              for (const entry of result.off) list.append(action(t("Turn on {name}", { name: entry.title }), () => navigate(context.ui.openPluginSettings(entry.pluginId))));
              body.push(list);
            }
            return body;
          }
          if (result.mode === "dontknow") {
            body.push(node("p", "", t("I don't have information about that yet.")));
            body.push(node("p", "nib-meta", t("Try other words, or browse Help.")));
            const actions = node("div", "nib-actions");
            actions.append(action(t("Open Help"), () => navigate(context.ui.openHelp())));
            body.push(actions);
            return body;
          }
          if (result.mode === "related") {
            body.push(node("p", "", t("I'm not sure. These might help:")));
            for (const doc of result.related) {
              const label = doc.kind === "plugin" ? `${t("Community plugin guide")} · ${displayName({ pluginId: doc.pluginId, title: doc.title })}` : doc.heading ? `${doc.title} › ${doc.heading}` : doc.title;
              body.push(action(label, () => askNow(doc.heading || doc.title), "nib-link"));
            }
            return body;
          }
          const doc = result.doc;
          if (result.mode === "off" || result.mode === "failed") {
            // Whole sentences with {name}, so a translator controls the word
            // order; the name goes in as its own <strong> via textContent.
            const line = node("p");
            const sentence = result.mode === "off" ? t("That's part of {name}, which is turned off.") : t("{name} is on but couldn't start.");
            const [before, after = ""] = sentence.split("{name}");
            line.append(before, node("strong", "", doc.title), after);
            body.push(line);
            if (result.mode === "off" && doc.text) body.push(node("p", "nib-meta", doc.text.replace(/[#*_`>[\]]/gu, "").slice(0, 200)));
            const actions = node("div", "nib-actions");
            actions.append(action(result.mode === "off" ? t("Turn on {name}", { name: doc.title }) : t("Open {name} in Settings", { name: doc.title }), () => navigate(context.ui.openPluginSettings(doc.pluginId))));
            body.push(actions);
            return body;
          }
          const source = doc.kind === "plugin"
            ? `${t("Community plugin guide")} · ${displayName({ pluginId: doc.pluginId, title: doc.title })}`
            : `${t("Help")} · ${doc.title}${doc.heading ? ` › ${doc.heading}` : ""}`;
          if (result.prefix) body.push(node("p", "", result.prefix));
          body.push(node("p", "nib-meta", source));
          const long = doc.text.length > 700;
          const text = node("div");
          text.append(excerpt(long ? firstBlock(doc.text) : doc.text));
          body.push(text);
          const actions = node("div", "nib-actions");
          if (long) actions.append(action(t("Show more"), (event) => { text.replaceChildren(excerpt(doc.text)); event.currentTarget.remove(); }));
          if (doc.kind === "plugin") actions.append(action(t("Open plugin details"), () => navigate(context.ui.openPluginSettings(doc.pluginId))));
          else actions.append(action(t("Open in Help"), () => navigate(context.ui.openHelp(doc.topic.helpPageId, doc.slug || undefined))));
          body.push(actions);
          if (result.also?.length) {
            body.push(node("p", "nib-meta", t("Also:")));
            for (const other of result.also) body.push(action(other.heading ? `${other.title} › ${other.heading}` : other.title, () => askNow(other.heading || other.title), "nib-link"));
          }
          return body;
        }

        function askNow(question) {
          const text = String(question).trim().slice(0, LIMITS.question);
          if (!text) return;
          state.history = [text, ...state.history.filter((entry) => entry !== text)].slice(0, 5);
          thinking = true;
          setMood("thinking");
          const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
          // Re-rendering replaces the question box; keep focus inside Nib if
          // it was there, so the next question and Escape still work.
          const hadFocus = root.contains(document.activeElement);
          window.setTimeout(() => {
            thinking = false;
            const result = ask(index(), text);
            result.question = text;
            state.last = result;
            render();
            if (hadFocus) focusInput();
            announce(result.mode === "answer" ? t("Answer: {title}", { title: result.doc.heading || result.doc.title }) : result.mode === "off" ? t("{name} is turned off", { name: result.doc.title }) : result.mode === "dontknow" ? t("No answer found") : "");
          }, reduced ? 0 : 250);
        }

        function render() {
          window.clearTimeout(introTimer);
          root.replaceChildren();
          const last = state.last;
          const next = thinking ? "thinking" : !state.open ? "idle" : !last ? "listening" : last.mode === "answer" ? "answering" : last.mode === "related" || last.mode === "dontknow" ? "unsure" : "idle";
          setMood(next);
          if (!state.open) {
            if (!context.storage.get("introSeen")) {
              const bubble = node("p", "nib-bubble", t("Hi, I'm Nib. Ask me how Notible works."));
              root.append(bubble);
              const dismiss = () => { context.storage.set("introSeen", true); context.storage.set("schema", 1); bubble.remove(); document.removeEventListener("pointerdown", dismiss, true); introDismiss = null; };
              if (introDismiss) document.removeEventListener("pointerdown", introDismiss, true);
              introDismiss = dismiss;
              document.addEventListener("pointerdown", dismiss, true);
              introTimer = window.setTimeout(() => { if (root.getClientRects().length > 0) dismiss(); }, 10_000);
            }
            const wake = node("button", "nib-wake");
            wake.type = "button";
            wake.setAttribute("aria-label", t("Ask Nib"));
            wake.setAttribute("aria-expanded", "false");
            wake.setAttribute("aria-controls", "nib-panel");
            wake.title = t("Ask Nib (Ctrl+Shift+H)");
            wake.append(nibSprite(72, face));
            wake.addEventListener("click", () => { state.open = true; render(); focusInput(); });
            root.append(wake);
            return;
          }
          const panel = node("section", "nib-panel");
          panel.id = "nib-panel";
          panel.setAttribute("role", "region");
          panel.setAttribute("aria-label", t("Nib, Notible helper"));
          const head = node("div", "nib-head");
          const mini = node("span", "nib-mini");
          mini.append(nibSprite(24, face));
          const close = action("×", () => closePanel(), "nib-close");
          close.setAttribute("aria-label", t("Close"));
          head.append(mini, node("strong", "", "Nib"), close);
          const bodyBox = node("div", "nib-body-scroll");
          bodyBox.addEventListener("click", (event) => {
            const link = event.target instanceof Element ? event.target.closest("[data-url]") : null;
            const url = link?.getAttribute("data-url") ?? "";
            if (url.startsWith("https://nib.invalid/help/")) {
              const [page, slug] = url.slice("https://nib.invalid/help/".length).split("/");
              navigate(context.ui.openHelp(page, slug || undefined));
            } else if (url === "https://nib.invalid/settings" && last?.doc?.pluginId) {
              navigate(context.ui.openPluginSettings(last.doc.pluginId));
            }
          });
          bodyBox.append(...answerView(last ?? { mode: "greeting" }));
          const form = node("form", "nib-ask");
          const label = node("label", "nib-sr", t("Ask about Notible"));
          label.htmlFor = "nib-question";
          input = node("input");
          input.id = "nib-question";
          input.type = "text";
          input.maxLength = LIMITS.question;
          input.placeholder = t("Ask about Notible…");
          input.autocomplete = "off";
          input.addEventListener("focus", () => { if (!thinking && !state.last) setMood("listening"); });
          input.addEventListener("keydown", (event) => {
            if (event.key === "ArrowUp" && !input.value && state.history.length) { event.preventDefault(); input.value = state.history[0]; }
          });
          const submit = node("button", "nib-action", t("Ask"));
          submit.type = "submit";
          form.addEventListener("submit", (event) => { event.preventDefault(); askNow(input.value); input.value = ""; });
          form.append(label, input, submit);
          const live = node("p", "nib-sr nib-live");
          live.setAttribute("aria-live", "polite");
          panel.append(head, bodyBox, form, live);
          root.append(panel);
        }

        function closePanel() { close(); }
        function focusInput() { input?.focus(); }
        ui.render = render;
        ui.focusInput = focusInput;

        const onKey = (event) => {
          if (event.key === "Escape" && state.open && root.contains(document.activeElement)) { event.stopPropagation(); close(); }
        };
        root.addEventListener("keydown", onKey);
        // The UI language can change while Nib is open: draw it again.
        const onLanguage = () => render();
        window.addEventListener("notible:preferences", onLanguage);

        // Re-answer after "Turn on": the topic may now be enabled.
        let rebuild = 0;
        // A plugin turned on brings new pages: a little jump for the new knowledge.
        const owners = () => new Set(context.help.topics().filter((topic) => topic.pluginId && (topic.state ?? "enabled") === "enabled").map((topic) => topic.pluginId)).size;
        let known = owners();
        const subscription = context.help.onChange(() => {
          const now = owners();
          if (now > known && state.open) flashMood("unlocked", 2400);
          known = now;
          window.clearTimeout(rebuild);
          rebuild = window.setTimeout(() => {
            const before = state.last;
            if (!state.open || !before?.question || (before.mode !== "off" && before.mode !== "failed")) return;
            const result = ask(index(), before.question);
            if (result.mode === "answer" && result.doc.feature === before.doc.feature) {
              result.question = before.question;
              result.prefix = t("{name} is on now.", { name: before.doc.title });
              state.last = result;
              render();
            }
          }, 300);
        });

        render();
        return {
          dispose: () => {
            window.clearTimeout(introTimer);
            if (introDismiss) document.removeEventListener("pointerdown", introDismiss, true);
            window.clearTimeout(rebuild);
            subscription.dispose();
            root.removeEventListener("pointerdown", onPointerDown, true);
            window.removeEventListener("notible:preferences", onLanguage);
            if (state.ui === ui) state.ui = null;
          },
        };
      },
    });
  },
};
