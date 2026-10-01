# Nib

A little pixel-art fella in the bottom-left corner of Notible. Click him (or press
**Ctrl+Shift+H** when you are not typing in a note) and ask how something works.

Nib answers only from what your copy of Notible has: its Help pages and the guides
of plugins that are turned on. If a feature belongs to a built-in plugin that is off,
it tells you and offers **Turn on**. If it has nothing, it says so. It works offline;
questions are not saved or sent anywhere.

Needs Notible 0.92.2 or newer (plugin API 1.22). Pick it in **Settings → Plugins →
Corner helper**.

## Files

| File | |
|---|---|
| `main.js` | The plugin: an offline retrieval engine over `context.help.topics()` and the corner UI. |
| `locales/pl.json` | Polish strings. |
| `self-check.mjs` | `node self-check.mjs` — engine fixtures, hostile plugins, cleaning, limits, i18n, DOM safety, manifest. |
| `fixtures/` | Frozen Help topics; `freeze-topics.mjs` rebuilds them from the Notible monorepo. |

Design: `docs/superpowers/specs/2026-10-02-nib-plugin-design.md` in the Notible repository.
