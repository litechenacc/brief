import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const browser = await chromium.launch({headless:true});
try {
 const page = await browser.newPage();
 await page.setContent(`<div class="messages"><div class="row row-assistant" id="thought"><div class="row-body"><details class="thinking"><summary>Thought process</summary>thinking</details><div class="usage-line"><details class="model-usage"><summary>用量明細</summary></details><button class="usage-copy">copy</button></div></div></div><div class="row row-assistant" id="reply"><div class="row-body"><div class="md">Answer</div><div class="usage-line"><details class="model-usage"><summary>用量明細</summary></details><button class="usage-copy">copy</button></div></div></div><div class="row row-assistant" id="error"><div class="row-body"><div class="usage-line"><span class="usage-status">request failed</span></div></div></div></div>`);
 await page.addStyleTag({content: readFileSync("media/main.css","utf8")});
 assert.equal(await page.locator("#thought").evaluate(e=>e.getBoundingClientRect().height),0);
 assert.equal(await page.locator("#reply .usage-line").evaluate(e=>getComputedStyle(e).position),"absolute");
 assert.equal(await page.locator("#reply").evaluate(e=>e.getBoundingClientRect().height),await page.locator("#reply .md").evaluate(e=>e.getBoundingClientRect().height));
 assert.ok(await page.locator("#error").evaluate(e=>e.getBoundingClientRect().height)>0);
 await page.locator(".messages").evaluate(e=>e.classList.add("show-thought-process"));
 assert.ok(await page.locator("#thought").evaluate(e=>e.getBoundingClientRect().height)>0);
 await page.locator(".messages").evaluate(e=>{e.classList.remove("show-thought-process");e.classList.add("show-usage-details")});
 assert.ok(await page.locator("#thought").evaluate(e=>e.getBoundingClientRect().height)>0);
 assert.equal(await page.locator("#reply .usage-line").evaluate(e=>getComputedStyle(e).position),"static");
 console.log("PASS hidden thought rows have zero layout height; copy has no footer space; errors and toggles preserved");
} finally {await browser.close();}
