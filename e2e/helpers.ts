import { expect, type Page } from "@playwright/test";

export async function openHome(page: Page) {
  await page.goto("/");
  await expect(page.getByText("Alexa+ concept simulation powered by FixLoop")).toBeVisible();
}
/** Configure REAL backend state through the same gateway the UI uses. */
export async function launch(page: Page, scenario: string) {
  await page.goto("/demo");
  const status = await page.evaluate(async (s) => {
    const csrf =
      document.cookie
        .split("; ")
        .find((c) => c.startsWith("fl_csrf="))
        ?.split("=")[1] ?? "";
    const r = await fetch("/api/gateway/demo/scenario", {
      method: "POST",
      headers: { "content-type": "application/json", "x-fixloop-csrf": csrf },
      body: JSON.stringify({ scenario: s }),
    });
    return r.status;
  }, scenario);
  expect(status).toBe(200);
  await openHome(page);
}
export async function say(page: Page, text: string) {
  const n = await page.locator('[data-role="assistant"]').count();
  await page.getByTestId("utterance").fill(text);
  await page.getByTestId("send").click();
  await expect(page.locator('[data-role="assistant"]')).toHaveCount(n + 1, { timeout: 20_000 });
  await expect(page.getByTestId("voice-state")).not.toHaveAttribute("data-state", "PROCESSING");
  return page.locator('[data-role="assistant"]').last();
}
