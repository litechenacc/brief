import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const browser = await chromium.launch({ headless: true });
try {
 const page = await browser.newPage();
 await page.setContent(`<div class="bubble bubble-user" style="width:280px"><div class="bubble-text">使用者 prompt 的文字不需要為右側兩個按鈕預留空間，換行也不應改變。</div><div class="user-footer"><button class="uf-icon" aria-label="Copy">C</button><button class="uf-icon" aria-label="Fork">F</button></div></div>`);
 await page.addStyleTag({ content: readFileSync("media/main.css", "utf8") });
 const bubble = page.locator(".bubble-user");
 const footer = page.locator(".user-footer");
 await page.mouse.move(700, 500);
 assert.equal(await bubble.evaluate(e => getComputedStyle(e).paddingRight), "11px");
 await page.waitForFunction(() => getComputedStyle(document.querySelector(".user-footer")).opacity === "0");
 assert.equal(await footer.evaluate(e => getComputedStyle(e).pointerEvents), "none");
 const before = await bubble.boundingBox();
 await bubble.hover();
 await page.waitForFunction(() => getComputedStyle(document.querySelector(".user-footer")).opacity === "1");
 assert.equal(await footer.evaluate(e => getComputedStyle(e).backdropFilter), "blur(5px)");
 assert.equal(await footer.evaluate(e => getComputedStyle(e).pointerEvents), "auto");
 assert.deepEqual(await bubble.boundingBox(), before);
 assert.ok((await footer.boundingBox()).width < before.width);
 await page.mouse.move(700, 500);
 await page.getByRole("button", { name: "Copy" }).focus();
 await page.waitForFunction(() => getComputedStyle(document.querySelector(".user-footer")).opacity === "1");
 await page.keyboard.press("Tab");
 assert.equal(await page.getByRole("button", { name: "Fork" }).evaluate(e => e === document.activeElement), true);
 console.log("PASS user actions overlay without reserved space or layout shift; hover blur and keyboard focus preserved");
} finally {
 await browser.close();
}
