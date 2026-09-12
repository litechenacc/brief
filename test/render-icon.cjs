const { chromium } = require("playwright");
const { readFileSync } = require("node:fs");

(async () => {
  const svg = readFileSync("media/icon.svg", "utf8");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    for (const size of [512, 256, 128, 64, 32]) {
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(`<!doctype html><style>body{margin:0}svg{display:block;width:100vw;height:100vh}</style>${svg}`);
      await page.screenshot({ path: size === 512 ? "media/icon.png" : `media/icon-${size}.png`, omitBackground: true });
    }
  } finally {
    await browser.close();
  }
  console.log("Rendered Brief app icons: 512, 256, 128, 64, 32 px");
})().catch((error) => { console.error(error); process.exitCode = 1; });
