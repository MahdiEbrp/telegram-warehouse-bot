// Optional local-docs check, not part of the bot runtime or proof of a Telegram client render.
// Install separately: npm install --no-save --package-lock=false playwright && npx playwright install chromium
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const transcript = JSON.parse(await readFile("docs/verification/ui-transcript.json", "utf8"));
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const errors = [],
  requests = [];
let validated = 0;
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, deviceScaleFactor: 1 });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (/^https?:/.test(request.url())) requests.push(request.url());
    });
    await page.route(/^https?:\/\//, (route) => route.abort());
    await page.goto(pathToFileURL(resolve("docs/ui-preview.html")).href);
    assert.equal(await page.locator("#select option").count(), transcript.shots.length);
    for (let i = 0; i < transcript.shots.length; i++) {
      await page.selectOption("#select", String(i));
      const shot = transcript.shots[i],
        keys = shot.keyboard.flat();
      assert.equal(await page.locator("#message").textContent(), shot.text);
      assert.equal(await page.locator(".key").count(), keys.length);
      assert.equal(
        await page.locator(".key:disabled").count(),
        keys.filter((key) => "disabled" in key).length,
      );
      assert(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        `Horizontal overflow at ${width}px / ${shot.id}`,
      );
      validated++;
    }
    await page.selectOption("#select", "1");
    assert.equal(await page.locator("#prev").isDisabled(), false);
    await page.click("#prev");
    assert.equal(await page.locator("#prev").isDisabled(), true);
    await page.click("#next");
    assert.equal(await page.locator("#select").inputValue(), "1");
    await page.locator(".key:not(:disabled)").first().click();
    assert((await page.locator("#toast").textContent()).includes("این دکمه"));
    await page.selectOption("#select", "6");
    await mkdir("docs/verification", { recursive: true });
    await page.screenshot({
      path: `docs/verification/ui-${width === 1280 ? "desktop" : "mobile"}.png`,
      fullPage: true,
    });
    await page.close();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
  const report = {
    release: "1.3.0",
    checkedAt: new Date().toISOString(),
    browser: await browser.version(),
    screens: transcript.shots.length,
    widths: [1280, 390],
    validatedScreens: validated,
    pageErrors: errors,
    httpRequests: requests,
    passed: true,
    scope: "Offline HTML approximation of real TestBot captures, not the Telegram native client",
  };
  await writeFile(
    "docs/verification/ui-browser-check.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
