// Utility (not part of the test suite): SHOTS=1 pnpm exec playwright test  -> docs/submission/screenshots/*.png
import { test } from "@playwright/test";
import { launch, say } from "./helpers";
const out = (n: string) => `docs/submission/screenshots/${n}.png`;

test("capture screenshots from the real running app", async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, "speechSynthesis", { value: undefined, configurable: true }); });
  await page.setViewportSize({ width: 1360, height: 900 });
  await launch(page, "dishwasher_leak");
  await page.screenshot({ path: out("01-dashboard-empty"), fullPage: true });
  await say(page, "My dishwasher is leaking and I don't know what to do");
  await say(page, "No, none of those");
  await page.screenshot({ path: out("02-approval-and-evidence"), fullPage: true });
  await page.getByRole("button", { name: "Approve this request" }).last().click();
  await page.getByText("Approved. Say or type").last().waitFor();
  await say(page, "send it");
  await page.screenshot({ path: out("03-submitted"), fullPage: true });
  await page.getByRole("link", { name: /dishwasher is leaking/i }).first().click();
  await page.waitForSelector("text=Case timeline");
  await page.screenshot({ path: out("04-incident-detail"), fullPage: true });
  await launch(page, "emergency");
  await say(page, "There is water leaking near the outlet behind my dishwasher");
  await page.screenshot({ path: out("05-emergency"), fullPage: true });
  await page.goto("/demo"); await page.screenshot({ path: out("06-scenarios"), fullPage: true });
  await page.goto("/appliances"); await page.screenshot({ path: out("07-appliances"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await launch(page, "dishwasher_leak");
  await say(page, "my dishwasher is leaking"); await say(page, "no");
  await page.screenshot({ path: out("08-mobile-approval"), fullPage: true });
});
