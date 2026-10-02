// Nib self-check: the answering engine over frozen Help topics, hostile
// plugins, cleaning, limits, i18n, DOM safety and the manifest.
//   node self-check.mjs           (fixtures/topics.json)
//   node --experimental-strip-types self-check.mjs --live   (re-freeze from the monorepo's Help first)
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const engine = await import(pathToFileURL(join(here, "main.js")).href);
const { buildIndex, ask, cleanMarkdown, questionTokens, stem, tokenize, LIMITS } = engine;
const live = process.argv.includes("--live");
const topics = live
  ? (await import(pathToFileURL(join(here, "fixtures/freeze-topics.mjs")).href)).liveTopics()
  : JSON.parse(readFileSync(join(here, "fixtures/topics.json"), "utf8"));
const index = buildIndex(topics);
let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks += 1; };
const where = (result) => (result.doc ? `${result.doc.feature}#${result.doc.slug}` : "");

// 1. Fixtures — reviewed by hand from the prototype run (02.10), not written first.
const ANSWERS = [
  ["links between notes", "core:writing-notes#links-between-notes"],
  ["How do I link notes?", "core:writing-notes#links-between-notes"],
  ["how do I link to another note", "core:writing-notes#links-between-notes"],
  ["keyboard shortcuts", "core:commands-and-shortcuts#keyboard-shortcuts"],
  ["change a hotkey", "core:settings#hotkeys"],
  ["restore deleted note", "core:move-export-delete#delete-and-restore"],
  ["How do I restore a deleted note?", "core:move-export-delete#delete-and-restore"],
  ["jak przywrócić usuniętą notatkę", "core:move-export-delete#delete-and-restore"],
  ["what is a workspace", "core:containers#workspaces"],
  ["backup", "core:move-export-delete#backups"],
  ["move a note into a folder", "core:move-export-delete#move"],
  ["budget", "notible.finance#"],
  ["mermaid diagram", "notible.editor-extensions#"],
];
for (const [question, expected] of ANSWERS) {
  const result = ask(index, question);
  ok(result.mode === "answer" && where(result) === expected, `"${question}" → answer ${expected}, got ${result.mode} ${where(result)}`);
}
ok(ask(index, "gantt chart").mode === "off" && ask(index, "gantt chart").doc.pluginId === "notible.planning", "gantt chart → Planning is turned off");
ok(ask(index, "timeline").mode === "off", "timeline → turned off");
ok(ask(index, "whiteboard connectors").mode === "failed" && ask(index, "whiteboard connectors").doc.pluginId === "notible.whiteboard", "whiteboard connectors → Whiteboard failed");
const exportResult = ask(index, "export");
ok(exportResult.mode === "related" && new Set(exportResult.related.map((doc) => doc.feature)).size === 3 && exportResult.related[0].slug === "export", "export → related, 3 different features, the Export section first");
const polishExport = ask(index, "Jak wyeksportować notatkę?");
ok(polishExport.mode === "answer" ? polishExport.doc.slug === "export" : polishExport.related.some((doc) => doc.slug === "export"), "Polish export finds the Export section");
for (const question of ["asdf qwerty", "", "the of a", "   "]) ok(ask(index, question).mode === "dontknow", `"${question}" → don't know`);
const flash = ask(index, "flashcards review");
ok(flash.mode === "answer" && flash.doc.kind === "plugin" && flash.doc.pluginId === "acme.flashcards", "flashcards review → the community guide");
ok(ask(index, "hi").mode === "greeting" && ask(index, "cześć").mode === "greeting", "greetings");
ok(ask(index, "thanks").mode === "thanks" && ask(index, "dzięki").mode === "thanks", "thanks");
const plugins = ask(index, "which plugins are on");
ok(plugins.mode === "plugins" && plugins.off.some((entry) => entry.pluginId === "notible.planning"), "which plugins lists Planning as off");
for (const starter of ["How do I link notes?", "Keyboard shortcuts", "How do I restore a deleted note?"]) {
  const result = ask(index, starter);
  ok(result.mode === "answer" && result.doc.kind === "core", `starter "${starter}" answers from Core`);
}

// 2. Hostile plugins.
const coreQuestions = ANSWERS.map(([question]) => question).concat(["keyboard shortcuts", "links between notes", "restore deleted note"]);
for (const question of coreQuestions) {
  const result = ask(index, question);
  ok(!(result.doc?.pluginId ?? "").startsWith("evil."), `"${question}" is never answered by a hostile plugin`);
  const top = result.related ?? [result.doc, ...(result.also ?? [])].filter(Boolean);
  ok(top.filter((doc) => (doc.pluginId ?? "").startsWith("evil.")).length <= 1, `"${question}": at most one hostile plugin in the top 3`);
}
ok(!index.docs.some((doc) => doc.pluginId === "evil.offline"), "a disabled third party is not indexed");
ok(!plugins.off.some((entry) => entry.pluginId === "evil.offline"), "no Turn on for a disabled third party");
ok(index.docs.filter((doc) => doc.kind === "plugin").every((doc) => !["notible.planning", "notible.views"].includes(doc.pluginId)), "built-ins are never a separate plugin doc");

// 3–4. Merging and disabled stays untaught.
for (const doc of index.docs) {
  if (doc.state !== "enabled") ok(doc.kind === "stub", `${doc.feature} (${doc.state}) is only a stub`);
}
const features = ask(index, "export").related.map((doc) => doc.feature);
ok(new Set(features).size === features.length, "one result per feature");

// 5. Cleaning.
ok(index.docs.every((doc) => !doc.text.includes("![")), "no image syntax survives indexing");
ok(cleanMarkdown("a ![x](data:image/svg+xml,<svg/>) b ![y](help/p.webp)") === "a  b", "inline and data: images are stripped");
ok(cleanMarkdown("[Organising](help:containers#folders)") === "[Organising](https://nib.invalid/help/containers/folders)", "help: links become the nib.invalid marker");
ok(cleanMarkdown("[Plugins](settings:plugins)") === "[Plugins](https://nib.invalid/settings)", "settings: links become the marker");
ok(cleanMarkdown("x".repeat(10_000)).length <= LIMITS.render, "render input is capped at 4 KB");
ok(index.docs.filter((doc) => doc.pluginId === "evil.stuffer").reduce((sum, doc) => sum + doc.text.length, 0) <= LIMITS.topic, "a topic is capped at 30 KB of indexed text");
ok(index.docs.every((doc) => !/<[a-z]/iu.test(doc.text.replace(/<svg\/>/gu, ""))), "engine output is Markdown, not HTML");

// 6. Stemmer and limits.
for (const [word, stemmed] of [["notes", "note"], ["tables", "table"], ["images", "image"], ["entries", "entry"], ["class", "class"], ["is", "is"]]) ok(stem(word) === stemmed, `stem ${word} → ${stemmed}`);
const long = questionTokens("export ".repeat(400));
ok(long.tokens.length <= LIMITS.tokens, "a long question is cut to 20 tokens");
ok(tokenize("Notatki ŁÓDŹ Zażółć").includes("lodz"), "folding handles Polish letters");
const many = Array.from({ length: 30 }, (_, i) => ({ id: `plugin:big.${i}`, title: `Big ${i}`, source: "plugin", pluginId: `big.${i}`, state: "enabled", summary: "", keywords: "", sections: [{ heading: "All", slug: "all", text: `word${i} `.repeat(6000) }] }));
let started = performance.now();
const bigIndex = buildIndex([...topics, ...many]);
ok(performance.now() - started < 200, `indexing 30 × 30 KB guides is fast (${Math.round(performance.now() - started)} ms)`);
const times = [];
for (let i = 0; i < 50; i += 1) { started = performance.now(); ask(bigIndex, "how do I restore a deleted note"); times.push(performance.now() - started); }
times.sort((a, b) => a - b);
ok(times[25] < 20, `ask is fast (median ${times[25].toFixed(1)} ms)`);
started = performance.now();
cleanMarkdown(`**${"a".repeat(4000)}`);
ok(performance.now() - started < 50, "an unclosed ** line is cleaned quickly");

// 7. i18n: every t("…") key in main.js is in locales/pl.json with the same placeholders.
const source = readFileSync(join(here, "main.js"), "utf8");
const manifest = JSON.parse(readFileSync(join(here, "plugin.json"), "utf8"));
const localeFile = join(here, manifest.locales?.pl ?? "locales/pl.json");
ok(existsSync(localeFile), "the declared Polish locale exists");
const polish = JSON.parse(readFileSync(localeFile, "utf8")).strings;
ok(polish && typeof polish === "object", "locales/pl.json has { strings }");
const keys = new Set([...source.matchAll(/\bt\("((?:[^"\\]|\\.)*)"/gu)].map((match) => JSON.parse(`"${match[1]}"`)));
for (const key of [...keys, "How do I link notes?", "Keyboard shortcuts", "How do I restore a deleted note?"]) {
  ok(typeof polish[key] === "string", `pl.json translates "${key}"`);
  const placeholders = (value) => [...value.matchAll(/\{(\w+)\}/gu)].map((m) => m[1]).sort().join(",");
  ok(placeholders(polish[key] ?? "") === placeholders(key), `pl.json keeps the placeholders of "${key}"`);
}
for (const [key, value] of Object.entries(polish)) ok(key.length <= 300 && value.length <= 300, `"${key.slice(0, 30)}" is within 300 chars`);

// 8. DOM safety.
for (const match of source.matchAll(/innerHTML\s*=\s*([^;]+);/gu)) ok(/^(context\.ui\.renderMarkdown\(|NIB_SVG)/u.test(match[1].trim()), `innerHTML only from renderMarkdown or NIB_SVG (${match[1].trim().slice(0, 40)})`);
for (const banned of ["innerHTML +=", "outerHTML", "insertAdjacentHTML", "DOMParser", "document.body", "fetch(", "XMLHttpRequest", "WebSocket", "localStorage", "eval(", "new Function"]) ok(!source.includes(banned), `main.js does not use ${banned}`);

// 9. Manifest.
ok(JSON.stringify(manifest.permissions) === JSON.stringify(["workspace.ui"]), "permissions are exactly workspace.ui");
ok(!/notible/iu.test(manifest.name), "the name does not use the reserved word");
ok(manifest.apiVersion === "1.22" && engine.default.manifest.apiVersion === "1.22", "apiVersion 1.22");
ok(manifest.id === engine.default.manifest.id && manifest.version === engine.default.manifest.version, "plugin.json and main.js agree on id and version");
const RESERVED_HOTKEYS = ["mod+n", "mod+,", "mod+f", "mod+s", "mod+z", "alt+space", "f1"];
ok(!RESERVED_HOTKEYS.includes("mod+shift+h"), "Mod+Shift+H is not reserved by Core");
if (live) {
  const surfaces = readFileSync(join(here, "../../src/core/app/CorePluginSurfaces.tsx"), "utf8");
  const declared = surfaces.match(/RESERVED_HOTKEYS = new Set\(\[([^\]]*)\]/u)?.[1] ?? "";
  ok(!declared.includes('"mod+shift+h"'), "Core does not reserve mod+shift+h (live)");
}

// The sprite: every mood draws the paper body inside the 24×24 grid, and "reduce motion" means no motion.
{
  const colours = { ink: "#111", muted: "#555", accent: "#22f", surface: "#fff", paper: "#fefefe", shade: "#ccc", face: "#000", cheek: "#f99", pencil: "#fb3" };
  const recorder = () => { const calls = []; const ctx = { canvas: { width: 72, height: 72 }, fillStyle: "", clearRect() {}, fillRect(x, y, w, h) { calls.push([this.fillStyle, x, y, w, h].join()); } }; return { ctx, calls }; };
  for (const mood of engine.MOODS) {
    const a = recorder();
    engine.drawNib(a.ctx, mood, 1234, colours, false);
    ok(a.calls.some((call) => call.startsWith("#fefefe,")), `sprite: ${mood} draws the paper body`);
    ok(a.calls.every((call) => { const [, x, y, w] = call.split(",").map(Number); return x >= 0 && x + w <= 72 && y >= -6 && y < 72; }), `sprite: ${mood} stays on the canvas`);
    const s1 = recorder(); const s2 = recorder();
    engine.drawNib(s1.ctx, mood, 0, colours, true);
    engine.drawNib(s2.ctx, mood, 98765, colours, true);
    ok(s1.calls.join("|") === s2.calls.join("|"), `sprite: ${mood} is still with reduce motion`);
  }
}
console.log(`Nib self-check passed: ${checks} checks${live ? " (live Help)" : ""}.`);
