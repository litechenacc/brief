import { Window } from "happy-dom";
import { buildSync } from "esbuild";
import assert from "node:assert/strict";

const window = new Window({ url: "https://webview.local" });
for (const name of ["window", "document", "HTMLElement", "HTMLInputElement", "FileReader"]) {
	globalThis[name] = name === "window" ? window : window[name];
}
const built = buildSync({ entryPoints: ["webview/composer.ts"], bundle: true, platform: "browser", format: "esm", write: false });
const { Composer } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);
const models = [
 { provider: "anthropic", id: "claude", reasoning: true },
 { provider: "openai-codex", id: "gpt", reasoning: true },
 { provider: "opencode", id: "model" },
 { provider: "deepseek", id: "model" },
 { provider: "kimi", id: "model" },
 { provider: "qwen", id: "model" },
 { provider: "nvidia", id: "model" },
 { provider: "custom", id: "claude-gpt-deepseek" },
];
const selections = [], favorites = [];
const c = new Composer({
 onSend() {}, onStop() {}, onSearchFiles() {}, onPickImage() {}, onAttachSelection() {}, onAttachActiveFile() {},
 onSetModel: (...args) => selections.push(args), onSetThinking() {}, onToggleFavorite: (...args) => favorites.push(args),
 onOpenFile() {}, onDraftChanged() {}, onNewSession() {}, onCreateAttachment() {}, onOpenAttachment() {},
});
document.body.append(c.root);
c.setEnabled(true);
c.setModels(models);
const button = c.root.querySelector('.rail-pill.model');
const shape = node => node.querySelector('svg').innerHTML;
const fallback = shape(button);
const shapes = new Set();
for (const model of models) {
 c.setModel(`${model.provider}/${model.id}`, model.provider, model.id);
 const svg = button.querySelector('svg');
 assert.equal(button.querySelectorAll('svg').length, 1);
 assert.equal(svg.getAttribute('aria-hidden'), 'true');
 assert.equal(svg.getAttribute('focusable'), 'false');
 assert.equal(svg.getAttribute('width'), '14');
 assert.ok(button.textContent.includes(model.provider));
 if (model.provider === 'custom') assert.equal(shape(button), fallback, 'unknown provider does not guess from model id');
 else {
  assert.notEqual(shape(button), fallback, `${model.provider} has a brand icon`);
  shapes.add(shape(button));
 }
}
assert.equal(shapes.size, 7, 'all seven brands have distinct icons');
for (const [provider, alias] of [
 ['anthropic', 'claude'], ['openai-codex', 'openai'], ['opencode', 'opencode-go'],
 ['kimi', 'kimi-coding'], ['kimi', 'moonshotai'], ['kimi', 'moonshotai-cn'],
]) {
 c.setModel(`${provider}/model`, provider, 'model');
 const expected = shape(button);
 c.setModel(`${alias}/model`, alias, 'model');
 assert.equal(shape(button), expected, `${alias} shares its provider icon`);
}
for (const provider of ['', 'toString', '__proto__', 'custom-openai']) {
 c.setModel(`${provider}/model`, provider, 'model');
 assert.equal(shape(button), fallback, 'unknown IDs use Brief with exact matching');
}
c.setModel('restored', 'openai-codex', 'gpt');
const restored = shape(button);
c.setModel('unknown');
assert.equal(shape(button), fallback, 'missing provider resets icon');
c.setModel('restored', 'openai-codex', 'gpt');
assert.equal(shape(button), restored, 'restoring a provider restores its icon');
const unchanged = button.querySelector('svg');
c.setModel('restored', 'openai-codex', 'gpt');
assert.equal(button.querySelector('svg'), unchanged, 'unchanged status preserves icon node');
c.setFavorites([{ provider: 'anthropic', modelId: 'claude' }]);
button.click();
let rows = [...document.querySelectorAll('.dropdown-item')];
assert.equal(rows.length, models.length);
for (const row of rows) {
 const model = models.find(m => row.querySelector('.dropdown-text').textContent === `${m.provider}/${m.id}`);
 assert.ok(model);
 c.setModel(`${model.provider}/${model.id}`, model.provider, model.id);
 assert.equal(shape(row.querySelector('.dropdown-select')), shape(button), 'menu and pill use same icon');
 assert.equal(row.querySelectorAll('.provider-icon').length, 1);
}
const search = document.querySelector('.dropdown-search');
search.value = 'deepseek';
search.dispatchEvent(new window.Event('input', { bubbles: true }));
assert.equal(document.querySelectorAll('.dropdown-item').length, 2, 'search still matches text');
search.value = 'anthropic';
search.dispatchEvent(new window.Event('input', { bubbles: true }));
assert.equal(document.querySelectorAll('.provider-icon').length, 2, 'filter retains row icon plus pill');
document.querySelector('.dropdown-star').click();
assert.deepEqual(favorites.at(-1), ['anthropic', 'claude']);
assert.ok(document.querySelector('.dropdown-select .provider-icon'), 'favorite rebuild keeps icon');
document.querySelector('.dropdown-select').click();
assert.deepEqual(selections.at(-1), ['anthropic', 'claude']);
assert.equal(document.querySelector('.dropdown'), null);
assert.equal(document.querySelector('button button'), null);
console.log('PASS provider icons: seven brands, fallback, restore, filtering, favorites, selection');
await window.happyDOM.close();
