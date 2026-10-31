import { test, expect } from "./fixtures";

test("both Adachi manga editions stay distinct and the longer edition exposes chapter 60", async ({ page }) => {
  const comics = [
    { name: "安達與島村", path_word: "andayudaocun", author: [{ name: "入間人間" }, { name: "まに" }], last_chapter: { name: "第18话" }, cover: "https://lain.bgm.tv/old-edition.jpg" },
    { name: "安達與島村", path_word: "andayudaocunnew", author: [{ name: "入間人間" }, { name: "柚原もけ" }], last_chapter: { name: "第60话" }, cover: "https://lain.bgm.tv/new-edition.jpg" },
  ];
  await page.addInitScript(() => {
    localStorage.setItem("acgn-hub.media-library.v1", JSON.stringify([{ id: "bangumi:990001", type: "manga", title: "安达与岛村", aliases: ["安達與島村"], externalIds: [], metadata: {} }]));
    localStorage.setItem("acgn-hub.source-configs.v1", JSON.stringify([{ id: "copy-variants", type: "copymanga", name: "拷贝漫画", url: "https://mapi.hotmangasg.com", enabled: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" }]));
  });
  await page.route("https://api.bgm.tv/**", async (route) => {
    const url = new URL(route.request().url());
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(url.pathname.endsWith("/characters") || url.pathname.endsWith("/persons") ? [] : { id: 990001, type: 1, platform: "漫画", name: "安達與島村", name_cn: "安达与岛村", images: null, infobox: [], tags: [] }) });
  });
  await page.route("https://mapi.hotmangasg.com/**", async (route) => {
    const url = new URL(route.request().url());
    let results: unknown;
    if (url.pathname.includes("/search/comic")) results = { list: comics };
    else if (url.pathname.includes("/comic2/")) {
      const comic = comics.find((item) => url.pathname.includes(item.path_word) && (item.path_word.endsWith("new") === url.pathname.includes("new")))!;
      results = { comic, groups: { default: { path_word: "default" } } };
    } else if (url.pathname.endsWith("/chapters")) {
      const newer = url.pathname.includes("andayudaocunnew");
      const count = newer ? 60 : 18;
      results = { total: count, list: Array.from({ length: count }, (_, index) => ({ uuid: `${newer ? 'new' : 'old'}-${index + 1}`, name: `第${index + 1}话`, index })) };
    } else throw new Error("Unexpected edition request: " + url.pathname);
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ code: 200, results }) });
  });
  await page.goto("/#/media/bangumi%3A990001");
  await page.getByRole("button", { name: /查找资源/ }).click();
  const edition = page.getByRole("combobox", { name: "作品改编版本", exact: true });
  await expect(edition).toBeVisible();
  await expect(edition.getByRole("option")).toContainText(["查看全部", "まに版", "柚原もけ版"]);
  await edition.selectOption("copymanga:https://mapi.hotmangasg.com:andayudaocunnew");
  await expect(page.locator(".resource-title-group")).toHaveCount(1);
  await expect(page.locator(".resource-group-heading")).toContainText("柚原もけ版");
  await expect(page.locator(".resource-pagination")).toContainText("60");
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.locator(".subject-resource-item strong").last()).toHaveText("安達與島村 · 第60话");
  await edition.selectOption("copymanga:https://mapi.hotmangasg.com:andayudaocun");
  await expect(page.locator(".resource-group-heading")).toContainText("まに版");
  await expect(page.locator(".subject-resource-item")).toHaveCount(18);
});
