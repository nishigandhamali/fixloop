import { expect, test } from "@playwright/test";
import { launch, say } from "./helpers";

test("mobile: conversation works and nothing overflows horizontally", async ({ page }) => {
  await launch(page, "dishwasher_leak");
  await say(page, "my dishwasher is leaking");
  const reply = await say(page, "no");
  await expect(reply.getByRole("button", { name: "Approve this request" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  const box = await reply.getByRole("button", { name: "Approve this request" }).boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
});
