import { test, expect, animeTitle } from "./fixtures";

test("mixed damaged session entries preserve valid search results and their detail navigation", async ({ page }) => {
  await page.addInitScript((title) => {
    const valid = { media: { id: "bangumi:12345", type: "anime", title, aliases: [], externalIds: [{ provider: "bangumi", value: "12345" }], metadata: {} }, score: 100, reason: "exact" };
    sessionStorage.setItem("acgn-hub.search-session.v1", JSON.stringify({ good: { ...valid, storedAt: Date.now() }, bad: { storedAt: Date.now() } }));
    sessionStorage.setItem("acgn-hub.search-view.v1", JSON.stringify({ keyword: title, type: "anime", candidates: [null, { media: null }, valid], storedAt: Date.now() }));
  }, animeTitle);
  await page.goto("/#/search");
  const result = page.locator(".poster-results-grid").getByRole("link", { name: "查看" + animeTitle, exact: true });
  await expect(result).toBeVisible();
  await expect(page.locator(".poster-results-grid article")).toHaveCount(1);
  await result.click();
  await expect(page).toHaveURL(/#\/media\/bangumi/);
  await expect(page.getByRole("heading", { name: animeTitle, exact: true })).toBeVisible();
});
