/**
 * The image-fit budget, on paper: one oversized image in the transcript
 * bricks a session forever, so the math that decides "send / resize / reject"
 * has to be exact. These checks run the pure half of webview/image-fit.ts
 * (no DOM) and pin the incident that motivated it: a 3292x3656 screenshot
 * whose 7.66 MB decode lands 10.21 MB on the wire — over the provider ceiling.
 */

import * as esbuild from "esbuild";
const result = await esbuild.build({ entryPoints: ["webview/image-fit.ts"], bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent" });
const fit = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);

let failed = 0;
function check(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!condition) failed += 1;
}

// The budget must sit under the provider wire ceiling with real headroom.
check("the decoded budget encodes under the provider ceiling", fit.base64Length(fit.MAX_DECODED_IMAGE_BYTES) < fit.PROVIDER_BASE64_LIMIT);
check("budget headroom is at least half a megabyte", fit.PROVIDER_BASE64_LIMIT - fit.base64Length(fit.MAX_DECODED_IMAGE_BYTES) >= 500_000);

check("base64Length of 7 MiB is ~9.79 MB", fit.base64Length(7 * 1024 * 1024) === 9_786_712);
const sample = Buffer.alloc(10_001, 7).toString("base64");
check("decodedLength inverts real base64", fit.decodedLength(sample) === 10_001 && fit.base64Length(10_001) === sample.length);

check("7 MiB fits", fit.fitsProvider(7 * 1024 * 1024));
check("the incident image (7.66 MB decoded -> 10.21 MB on the wire) does NOT fit", !fit.fitsProvider(8_032_770));

// fitRect preserves aspect and respects the edge.
const dims = fit.fitRect(3292, 3656, 1568);
check("the incident screenshot fits to 1412x1568", dims.width === 1412 && dims.height === 1568, JSON.stringify(dims));
const square = fit.fitRect(2000, 300, 1568);
check("wide images scale to the long edge, not the short one", square.width === 1568 && square.height === 235);
const small = fit.fitRect(800, 600, 1568);
check("small rectangles pass through untouched", small.width === 800 && small.height === 600);

// planImageFit: never re-encode what the provider accepts.
check("a 2 MB image is sent bit-identical", JSON.stringify(fit.planImageFit(2 * 1024 * 1024)) === JSON.stringify({ action: "send" }));
check("a 2 MB huge-dimension image is still sent (no pointless re-encode)", fit.planImageFit(2 * 1024 * 1024, 12000, 400).action === "send");

// planImageFit: the incident case plans a resize at the provider's long edge.
const incident = fit.planImageFit(8_032_770, 3292, 3656);
check("the incident screenshot plans a resize", incident.action === "resize");
check("the resize targets the provider long edge", incident.targetWidth === 1412 && incident.targetHeight === 1568);

// planImageFit: oversized and unreadable dimensions must reject, never pass.
const blind = fit.planImageFit(9 * 1024 * 1024);
check("oversized without dimensions rejects instead of bricking the session", JSON.stringify(blind) === JSON.stringify({ action: "reject", reason: "too-large-unfittable" }));

// The encoder half returns null without a DOM; callers then apply the hard cap.
const halo = "A".repeat(fit.base64Length(9 * 1024 * 1024));
const fitted = await fit.fitImageDataUrl({ data: halo, mimeType: "image/png" });
check("the DOM-less encoder declines (hard cap stays the backstop)", fitted === null);
const tiny = Buffer.from("AB").toString("base64");
const passthrough = await fit.fitImageDataUrl({ data: tiny, mimeType: "image/png" });
check("a fitting image passes through the encoder unchanged", passthrough !== null && passthrough.resized === false && passthrough.data === tiny);

console.log(failed === 0 ? "\nPASS image-fit" : `\nFAIL image-fit (${failed} checks)`);
process.exit(failed === 0 ? 0 : 1);
