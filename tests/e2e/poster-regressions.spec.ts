import { test, expect, type Page } from "@playwright/test";

interface PosterFixture { id: string; src: string; loading?: "eager" | "lazy"; top: number; left?: number }
interface NativeFixture { calls: string[]; gates: Map<string, Promise<void>>; broken: Set<string>; errors: string[] }
const cover = (name: string) => `https://covers.fixture.test/${name}.png`;
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="120"><path fill="#8460c7" d="M0 0h80v120H0z"/></svg>';

async function mountPosters(page: Page, posters: PosterFixture[], noObserver = false): Promise<NativeFixture> {
  const fixture: NativeFixture = { calls: [], gates: new Map(), broken: new Set(), errors: [] };
  page.on("pageerror", (error) => fixture.errors.push(error.message));
  await page.exposeFunction("__posterRequest", async (command: string, args: { url: string }) => {
    if (command !== "media_image_request") throw new Error("Unexpected native boundary: " + command);
    fixture.calls.push(args.url);
    await fixture.gates.get(args.url);
    return { cacheKey: fixture.broken.has(args.url) ? "bad" : fixture.calls.length.toString(16), mimeType: "image/png" };
  });
  await page.addInitScript(({ noObserver }) => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    if (noObserver) Object.defineProperty(window, "IntersectionObserver", { value: undefined, configurable: true });
  }, { noObserver });
  await page.route(/\/src\/infrastructure\/media\/image-loader\.ts(?:\?.*)?$/, async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const boundary = /import\s*\{[^}]*\binvoke\b[^}]*\}\s*from\s*["'][^"']+["'];?/;
    if (!boundary.test(source)) throw new Error("Image native boundary changed");
    await route.fulfill({ response, body: source.replace(boundary, "const invoke = (command, args) => window.__posterRequest(command, args); const convertFileSrc = (key, protocol) => 'http://' + protocol + '.localhost/' + key;") });
  });
  await page.route("http://acgn-image.localhost/**", (route) => route.fulfill({ status: 200, contentType: route.request().url().endsWith("/bad") ? "image/png" : "image/svg+xml", body: route.request().url().endsWith("/bad") ? "invalid image" : svg }));
  await page.route("https://covers.fixture.test/**", (route) => route.fulfill({ status: 200, contentType: fixture.broken.has(route.request().url()) ? "image/png" : "image/svg+xml", body: fixture.broken.has(route.request().url()) ? "invalid image" : svg }));
  await page.route("**/__poster_fixture__", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><link rel="icon" href="data:,"></head><body style="margin:0;height:5000px;background:#f8f7fb"><div id="app"></div><script type="module">
    import { createApp, h, reactive } from '/node_modules/.vite/deps/vue.js';
    import MediaPoster from '/src/components/MediaPoster.vue';
    const state = reactive({ posters: ${JSON.stringify(posters)} });
    window.__posterState = state;
    createApp({ render: () => h('main', state.posters.map(item => h('div', { key:item.id, id:item.id, style:{position:'absolute',top:item.top+'px',left:(item.left||30)+'px',width:'160px',height:'230px'} }, [h(MediaPoster, {src:item.src,loading:item.loading||'lazy',alt:item.id})]))) }).mount('#app');
  </script></body></html>` }));
  await page.goto("/__poster_fixture__");
  await expect(page.locator(".media-poster")).toHaveCount(posters.length);
  return fixture;
}

async function setSource(page: Page, src: string): Promise<void> {
  await page.evaluate((value) => { (window as unknown as { __posterState: { posters: PosterFixture[] } }).__posterState.posters[0].src = value; }, src);
}

test("48 lazy covers wait outside the viewport while an eager feature loads immediately", async ({ page }) => {
  const cards: PosterFixture[] = Array.from({ length: 48 }, (_, index) => ({ id: "book-" + index, src: cover("book-" + index), top: 1600 + Math.floor(index / 6) * 280, left: 30 + index % 6 * 180 }));
  const fixture = await mountPosters(page, [...cards, { id: "featured", src: cover("featured"), loading: "eager", top: 4300 }]);
  await expect.poll(() => fixture.calls).toEqual([cover("featured")]);
  await page.waitForTimeout(200);
  expect(fixture.calls).toEqual([cover("featured")]);
  await page.evaluate(() => window.scrollTo(0, 1600));
  await expect(page.locator("#book-0 .media-poster")).toHaveClass(/poster-loaded/);
  expect(fixture.calls.length).toBeGreaterThan(1);
  expect(fixture.calls.length).toBeLessThan(49);
  await page.screenshot({ path: ".work/e2e/poster-near-viewport.png", animations: "disabled" });
  expect(fixture.errors).toEqual([]);
});

test("missing IntersectionObserver falls back to loading and failed images can retry", async ({ page }) => {
  const fixture = await mountPosters(page, [{ id: "fallback", src: cover("initial"), top: 40 }], true);
  await expect(page.locator("#fallback .media-poster")).toHaveClass(/poster-loaded/);
  fixture.broken.add(cover("retry"));
  await setSource(page, cover("retry"));
  await expect(page.getByRole("button", { name: "重新加载" })).toBeVisible();
  expect(fixture.calls.filter((url) => url === cover("retry"))).toHaveLength(1);
  fixture.broken.delete(cover("retry"));
  await page.getByRole("button", { name: "重新加载" }).click();
  await expect(page.locator("#fallback .media-poster")).toHaveClass(/poster-loaded/);
  expect(fixture.calls.filter((url) => url === cover("retry"))).toHaveLength(2);
  expect(fixture.errors).toEqual([]);
});

test("old DOM events and delayed native responses cannot change a replacement cover or unmounted card", async ({ page }) => {
  const fixture = await mountPosters(page, [{ id: "race", src: cover("first"), loading: "eager", top: 40 }]);
  await expect(page.locator("#race .media-poster")).toHaveClass(/poster-loaded/);
  await page.evaluate(() => { (window as unknown as { __oldPosterImage: Element | null }).__oldPosterImage = document.querySelector("#race img"); });
  let releaseSecond = () => {};
  fixture.gates.set(cover("second"), new Promise<void>((resolve) => { releaseSecond = resolve; }));
  await setSource(page, cover("second"));
  await expect.poll(() => fixture.calls.includes(cover("second"))).toBe(true);
  await page.evaluate(() => {
    const previous = (window as unknown as { __oldPosterImage: Element }).__oldPosterImage;
    previous.dispatchEvent(new Event("load")); previous.dispatchEvent(new Event("error"));
  });
  await expect(page.locator("#race .media-poster")).toHaveClass(/poster-loading/);
  await setSource(page, cover("third"));
  await expect(page.locator("#race .media-poster")).toHaveClass(/poster-loaded/);
  const current = await page.locator("#race img").getAttribute("src");
  releaseSecond();
  await page.waitForTimeout(100);
  await expect(page.locator("#race img")).toHaveAttribute("src", current!);
  let releaseUnmounted = () => {};
  fixture.gates.set(cover("unmounted"), new Promise<void>((resolve) => { releaseUnmounted = resolve; }));
  await setSource(page, cover("unmounted"));
  await expect.poll(() => fixture.calls.includes(cover("unmounted"))).toBe(true);
  await page.evaluate(() => { (window as unknown as { __posterState: { posters: PosterFixture[] } }).__posterState.posters = []; });
  releaseUnmounted();
  await expect(page.locator(".media-poster")).toHaveCount(0);
  await page.waitForTimeout(100);
  expect(fixture.errors).toEqual([]);
});
