/** Real layout regression for the composer rail; DOM mocks do not lay out text. */
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { build } from "esbuild";

const bundle = await build({ entryPoints: ["webview/composer.ts"], bundle: true, format: "iife", globalName: "ComposerModule", platform: "browser", write: false });
const browser = await chromium.launch({ headless: true });
try {
 const page = await browser.newPage({ viewport: { width: 1600, height: 360 } });
 await page.setContent('<!doctype html><body style="--vscode-font-family: Arial, sans-serif; --vscode-foreground:#333; --vscode-sideBar-background:#f3f3f3; --vscode-input-background:#fff; --vscode-editorWidget-background:#fff; --vscode-widget-border:#ccc; --vscode-button-background:#0078d4; --vscode-button-foreground:#fff"></body>');
 await page.addStyleTag({ path: "media/main.css" });
 await page.addScriptTag({ content: bundle.outputFiles[0].text });
 await page.evaluate(() => {
  const noop = () => {};
  window.c = new ComposerModule.Composer({ onSend:noop, onStop:noop, onSearchFiles:noop, onPickImage:noop, onAttachSelection:noop, onAttachActiveFile:noop, onSetModel:noop, onSetThinking:noop, onToggleFavorite:noop, onOpenFile:noop, onDraftChanged:noop, onNewSession:noop, onCreateAttachment:noop, onOpenAttachment:noop });
  document.body.append(c.root);
  c.setEnabled(true);
  c.setModel('openai-codex/gpt-6-astra', 'openai-codex', 'gpt-6-astra');
  c.setThinking('medium');
  c.setSessionInfo('01a09943-test', '/session', 0.1, 8000);
  c.setContext(3, 8000, 272000, null, null);
  c.setText('Test');
 });
 for (const width of [900, 1600]) {
  await page.setViewportSize({ width, height: 360 });
  for (const state of ['send', 'queue', 'steer']) {
   await page.evaluate(state => { c.setStreaming(false); c.setSteerDefault(state === 'steer' ? 'steer' : 'followUp'); c.setStreaming(state !== 'send'); }, state);
   const layout = await page.evaluate(() => {
    const rail = document.querySelector('.composer-rail');
    const box = element => { const rect = element.getBoundingClientRect(); return { height:rect.height, center:rect.y + rect.height / 2 }; };
    return {
     rail:box(rail),
     controls:[...rail.children].filter(element => element.matches('.icon-btn, .rail-pill, .composer-meta, .send-btn, .send-control') && element.getBoundingClientRect().height > 0).map(element => ({ name:element.className, ...box(element) })),
     icons:[...rail.querySelectorAll('svg')].filter(element => element.getBoundingClientRect().height > 0).map(box),
     labels:[...rail.querySelectorAll('.pill-label, .brain span, .session-id, .stats-label summary, .context-label, .send-control > .send-btn')].map(element => ({ name:element.className || element.tagName, lineHeight:getComputedStyle(element).lineHeight })),
    };
   });
   for (const control of layout.controls) {
    assert.equal(control.height, 26, `${control.name} matches rail control height`);
    assert.ok(Math.abs(control.center - layout.rail.center) < 0.1, `${control.name} is centered`);
   }
   for (const icon of layout.icons) assert.ok(Math.abs(icon.center - layout.rail.center) < 0.1, 'icon box shares rail center');
   for (const label of layout.labels) assert.equal(label.lineHeight, '16px', `${label.name} uses common text line height`);
  }
 }
 // Check the actual fill geometry without waiting for animation timers.
 const meter = page.locator('.context-meter');
 assert.equal(await meter.evaluate(el => getComputedStyle(el, '::before').transitionDuration), '0.25s');
 await page.emulateMedia({ reducedMotion: 'reduce' });
 for (const [percent, expected] of [[0, 0], [7, 7], [52.5, 52.5], [100, 100], [120, 100], [-5, 0], [null, 0]]) {
  await page.evaluate(percent => c.setContext(percent, 18000, 272000, null, null), percent);
  const fill = await meter.evaluate(el => {
   const style = getComputedStyle(el, '::before');
   return { width:parseFloat(style.width), total:el.clientWidth, transition:style.transitionDuration,
    pointerEvents:style.pointerEvents, overflow:getComputedStyle(el).overflow,
    radius:getComputedStyle(el).borderRadius, text:el.textContent, title:el.title };
  });
  assert.ok(Math.abs(fill.width - fill.total * expected / 100) < 1, `fill matches ${percent}%`);
  assert.equal(fill.transition, '0s');
  assert.equal(fill.pointerEvents, 'none');
  assert.equal(fill.overflow, 'hidden');
  assert.notEqual(fill.radius, '0px');
  if (percent === 7) {
   assert.equal(fill.text, 'Context 7% · 18K / 272K');
   assert.equal(fill.title, 'Context 7% · 18,000 / 272,000 tokens');
  }
  if (percent === null) assert.match(fill.text, /Context pending/);
 }
 // Theme changes affect only the fill, not the existing text color.
 const textColor = await page.locator('.context-label').evaluate(el => getComputedStyle(el).color);
 const originalFill = await meter.evaluate(el => getComputedStyle(el, '::before').backgroundImage);
 await page.evaluate(() => document.body.style.setProperty('--vscode-button-background', '#9867c5'));
 assert.notEqual(await meter.evaluate(el => getComputedStyle(el, '::before').backgroundImage), originalFill);
 assert.equal(await page.locator('.context-label').evaluate(el => getComputedStyle(el).color), textColor);
 await page.evaluate(() => c.setContext(7, 18000, undefined, null, null));
 await meter.waitFor({ state:'hidden' });
 console.log('PASS composer rail alignment and theme-aware context fill, bounds, pending state and reduced motion');
} finally { await browser.close(); }
