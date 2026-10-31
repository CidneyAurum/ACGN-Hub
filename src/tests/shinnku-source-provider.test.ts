import { describe, expect, it, vi } from "vitest";
import type { TextFetcher } from "@/application/feed-ports";
import { ShinnkuSourceProvider } from "@/infrastructure/sources/shinnku-source-provider";

const timestamp = 1_714_447_015_077;
function file(path = "0/win/CLANNAD/CLANNAD(官中).7z", size = 2_962_220_920) {
  return { file_path: path, file_size: size, upload_timestamp: timestamp };
}
function rsc(model: unknown, split = false): string {
  const text = `0:${JSON.stringify(model)}\n`;
  const chunks = split ? [text.slice(0, 27), text.slice(27)] : [text];
  return `<html>${chunks.map((chunk) => `<script>self.__next_f.push(${JSON.stringify([1, chunk])})</script>`).join("")}</html>`;
}
function searchHtml(files: ReturnType<typeof file>[]) { return rsc(["$", "component", null, { answer: files.map((info) => ({ id: info.file_path, info })) }]); }
function detailHtml(info: ReturnType<typeof file>) { return rsc(["$", "component", null, { info }]); }
function folderHtml(files: ReturnType<typeof file>[]) { return rsc(["$", "component", null, { inode: files.map((info) => ({ type: "file", name: info.file_path.split("/").at(-1), info })) }]); }
function text(body: string, status = 200) { return { status, text: async () => body }; }
const query = { keyword: "CLANNAD", aliases: [], mediaType: "visual_novel" as const };
const itemId = (path: string) => `file:${encodeURIComponent(path)}`;

describe("Shinnku public file catalog", () => {
  it("reads split JSON-only RSC records, removes semantic-search noise and retains distinct editions", async () => {
    const infos = [file(), file("0/win/CLANNAD/CLANNAD(汉化组).7z"), file("0/win/Unrelated Summer Story.7z")];
    const fetcher = vi.fn<TextFetcher>().mockResolvedValue(text(rsc({ answer: infos.map((info) => ({ id: info.file_path, info })) }, true)));
    const provider = new ShinnkuSourceProvider(undefined, { fetcher });
    const matches = await provider.search(query);
    expect(matches).toHaveLength(2);
    expect(matches[0]).toMatchObject({ sourceItemId: itemId(infos[0].file_path), title: "CLANNAD(官中)", aliases: ["CLANNAD(官中)", "CLANNAD"] });
    expect(fetcher.mock.calls[0][0]).toBe("https://www.shinnku.com/search?q=CLANNAD");
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "GET", headers: { Accept: "text/html" } });
    expect(fetcher.mock.calls[0][1]?.headers).not.toHaveProperty("Cookie");
  });

  it("loads a saved file without a warm search cache and returns an actual stable archive URL", async () => {
    const info = file();
    const fetcher = vi.fn<TextFetcher>().mockResolvedValue(text(detailHtml(info)));
    const provider = new ShinnkuSourceProvider(undefined, { fetcher });
    const resources = await provider.listResources(itemId(info.file_path));
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["https://www.shinnku.com/files/shinnku/0/win/CLANNAD/CLANNAD(%E5%AE%98%E4%B8%AD).7z"]);
    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({
      protocol: "http", targetUrl: "https://zd.shinnku.top/file/shinnku/0/win/CLANNAD/CLANNAD(%E5%AE%98%E4%B8%AD).7z",
      title: "CLANNAD(官中).7z", sizeBytes: 2_962_220_920, format: "7Z",
      metadata: { downloadMode: "direct_file", resourceType: "game", platforms: ["win"], languages: ["zh"], downloadFileName: "CLANNAD(官中).7z", rangeSupport: "unknown" },
    });
    const restored = new ShinnkuSourceProvider(undefined, { fetcher: vi.fn<TextFetcher>() });
    await expect(restored.resolve(resources[0].id)).resolves.toEqual({ protocol: "http", url: resources[0].targetUrl, filename: "CLANNAD(官中).7z" });
  });

  it("retains English/Japanese filename aliases and retries independent names without losing successful results", async () => {
    const fetcher = vi.fn<TextFetcher>().mockImplementation(async (url) => url.includes("ATRI") ? text(searchHtml([file("0/win/ATRI -My Dear Moments- v1.3.7z")])) : text("unavailable", 503));
    const matches = await new ShinnkuSourceProvider(undefined, { fetcher }).search({ keyword: "亚托莉", aliases: ["ATRI -My Dear Moments-"], mediaType: "visual_novel" });
    expect(matches).toHaveLength(1);
    expect(matches[0].aliases).toContain("ATRI -My Dear Moments-");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["ATRI", ["ATRI -My Dear Moments- v1.3.7z", "ATRI汉化版.7z", "ATRI_官中.7z"], ["magicha trial steam版 (files).rar", "ATRI2.7z", "éATRI.7z"]],
    ["AIR", ["AIR Standard Edition.7z", "AIR汉化版.7z"], ["Hair.zip", "Fairy Tale.7z", "GameAIR.7z"]],
  ])("requires Latin-letter/digit boundaries for short English query %s", async (keyword, accepted, rejected) => {
    const infos = [...accepted, ...rejected].map((name) => file(`0/win/${name}`));
    const fetcher = vi.fn<TextFetcher>().mockResolvedValue(text(searchHtml(infos)));
    const results = await new ShinnkuSourceProvider(undefined, { fetcher }).search({ ...query, keyword });
    expect(results.map((result) => result.sourceItemId).sort()).toEqual(accepted.map((name) => itemId(`0/win/${name}`)).sort());
  });

  it("retains a matching full English or original-title alias even when the short English query has no token match", async () => {
    const infos = [file("0/win/マイディアモーメンツ(汉化版).7z"), file("0/win/My Dear Moments(汉化版).7z"), file("0/win/magicha trial.7z")];
    const fetcher = vi.fn<TextFetcher>().mockResolvedValue(text(searchHtml(infos)));
    const results = await new ShinnkuSourceProvider(undefined, { fetcher }).search({ ...query, keyword: "ATRI", aliases: ["マイディアモーメンツ", "My Dear Moments"] });
    expect(results).toHaveLength(2);
    expect(results.every((result) => !result.title.includes("trial"))).toBe(true);
  });

  it("keeps Chinese substring matching and normalizes full-width short English queries", async () => {
    const infos = [file("0/win/ATRI汉化版.7z"), file("0/win/千恋万花(官中).7z"), file("0/win/Fairy Tale.7z")];
    const fetcher = vi.fn<TextFetcher>().mockResolvedValue(text(searchHtml(infos)));
    const provider = new ShinnkuSourceProvider(undefined, { fetcher });
    expect((await provider.search({ ...query, keyword: "ＡＴＲＩ" })).map((result) => result.title)).toEqual(["ATRI汉化版"]);
    expect((await provider.search({ ...query, keyword: "千恋万" })).map((result) => result.title)).toEqual(["千恋万花(官中)"]);
  });

  it("never executes source scripts or accepts standalone JavaScript as a catalog", async () => {
    const attack = `<script>globalThis.__shinnkuExecuted=true;self.__next_f.push([1,Function('return 1')()])</script>`;
    const fetcher = vi.fn<TextFetcher>().mockResolvedValue(text(attack));
    await expect(new ShinnkuSourceProvider(undefined, { fetcher }).search(query)).rejects.toThrow("公开目录格式发生变化");
    expect((globalThis as Record<string, unknown>).__shinnkuExecuted).toBeUndefined();
  });

  it("distinguishes an empty official result from an HTML access-challenge page", async () => {
    const fetcher = vi.fn<TextFetcher>().mockResolvedValueOnce(text(searchHtml([]))).mockResolvedValueOnce(text("<html>Please enable JavaScript</html>"));
    const provider = new ShinnkuSourceProvider(undefined, { fetcher });
    await expect(provider.search(query)).resolves.toEqual([]);
    await expect(provider.search(query)).rejects.toThrow("公开目录格式发生变化");
  });

  it("reports HTTP permission errors directly without switching to private routes", async () => {
    const fetcher = vi.fn<TextFetcher>().mockResolvedValue(text("Forbidden", 403));
    await expect(new ShinnkuSourceProvider(undefined, { fetcher }).search(query)).rejects.toThrow("HTTP 403");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps unlabelled Japanese-named archives unknown and identifies an explicitly labelled patch", async () => {
    const original = file("zd/1001-1500/[160722][ゆずソフト] 千恋万花.rar");
    const patch = file("zd/patch/千恋万花(简中补丁).zip", 12_345);
    const fetcher = vi.fn<TextFetcher>().mockResolvedValueOnce(text(detailHtml(original))).mockResolvedValueOnce(text(folderHtml([original]))).mockResolvedValueOnce(text(detailHtml(patch)));
    const provider = new ShinnkuSourceProvider(undefined, { fetcher });
    const [game] = await provider.listResources(itemId(original.file_path));
    expect(game.language).toBeUndefined();
    expect(game.metadata).toMatchObject({ languages: [], language: "unknown", languageLabels: ["语言待确认"], platforms: ["win"] });
    const [resource] = await provider.listResources(itemId(patch.file_path));
    expect(resource.metadata).toMatchObject({ resourceType: "patch", languages: ["zh"] });
    expect(resource.metadata.warnings).toContain("这是补丁，需要对应版本的游戏本体。");
  });

  it("does not infer Chinese from an arbitrary Chinese filename or a mobile directory", async () => {
    const info = file("0/krkr/千恋万花.zip");
    const fetcher = vi.fn<TextFetcher>().mockResolvedValue(text(detailHtml(info)));
    const [resource] = await new ShinnkuSourceProvider(undefined, { fetcher }).listResources(itemId(info.file_path));
    expect(resource.metadata).toMatchObject({ languages: [], platforms: ["and"], platformLabels: ["Android / 移植版"] });
  });

  it("honors an explicit original-Japanese label even inside the source's translated directory", async () => {
    const info = file("0/win/Game(日文原版).7z");
    const fetcher = vi.fn<TextFetcher>().mockResolvedValue(text(detailHtml(info)));
    const [resource] = await new ShinnkuSourceProvider(undefined, { fetcher }).listResources(itemId(info.file_path));
    expect(resource.metadata).toMatchObject({ languages: ["ja"], languageEvidence: "文件名标注日文原版" });
  });

  it.each(["已打修正补丁,H未汉", "集成1.1补丁", "自带汉化补丁", "含修正补丁"])("keeps a game bundled with an applied patch classified as a game: %s", async (annotation) => {
    const info = file(`0/win/77 And,two stars meet again(${annotation}).7z`);
    const fetcher = vi.fn<TextFetcher>().mockResolvedValue(text(detailHtml(info)));
    const [resource] = await new ShinnkuSourceProvider(undefined, { fetcher }).listResources(itemId(info.file_path));
    expect(resource.metadata.resourceType).toBe("game");
    expect(resource.metadata.warnings).not.toContain("这是补丁，需要对应版本的游戏本体。");
  });

  it("preserves a partial-translation disclosure instead of treating H-untranslated as fully Chinese", async () => {
    const info = file("0/win/77 ～And,two stars meet again(已打修正补丁,H未汉).7z");
    const fetcher = vi.fn<TextFetcher>().mockResolvedValue(text(detailHtml(info)));
    const [resource] = await new ShinnkuSourceProvider(undefined, { fetcher }).listResources(itemId(info.file_path));
    expect(resource.language).toBe("中文（部分内容未汉化）");
    expect(resource.metadata).toMatchObject({ resourceType: "game", partialTranslation: true, languageLabels: ["中文（部分内容未汉化）"] });
    expect(resource.metadata.warnings).toContain("来源文件名注明部分内容尚未汉化，不能视为完整中文版本。");
  });

  it.each(["汉化补丁", "仅含汉化补丁", "只含修正补丁"])("keeps a separate patch classified as a patch: %s", async (annotation) => {
    const info = file(`0/win/Game(${annotation}).zip`);
    const fetcher = vi.fn<TextFetcher>().mockResolvedValue(text(detailHtml(info)));
    const [resource] = await new ShinnkuSourceProvider(undefined, { fetcher }).listResources(itemId(info.file_path));
    expect(resource.metadata.resourceType).toBe("patch");
  });

  it("does not infer Chinese from the translated directory when the filename expressly says untranslated", async () => {
    const info = file("0/win/Game(未汉化).7z");
    const fetcher = vi.fn<TextFetcher>().mockResolvedValue(text(detailHtml(info)));
    const [resource] = await new ShinnkuSourceProvider(undefined, { fetcher }).listResources(itemId(info.file_path));
    expect(resource.language).toBeUndefined();
    expect(resource.metadata.languages).toEqual([]);
  });

  it.each([["0/win/Game OST.zip", "ost"], ["0/win/Game(体験版).7z", "trial"]])("keeps explicitly marked extras apart from the main game: %s", async (path, resourceType) => {
    const info = file(path);
    const fetcher = vi.fn<TextFetcher>().mockResolvedValue(text(detailHtml(info)));
    const [resource] = await new ShinnkuSourceProvider(undefined, { fetcher }).listResources(itemId(info.file_path));
    expect(resource.metadata.resourceType).toBe(resourceType);
  });

  it("rechecks a multipart parent folder after restart and preserves every required volume filename", async () => {
    const first = file("0/win/夏日口袋.7z.001", 1_000);
    const second = file("0/win/夏日口袋.7z.002", 500);
    const fetcher = vi.fn<TextFetcher>().mockResolvedValueOnce(text(detailHtml(first))).mockResolvedValueOnce(text(folderHtml([second, first, file("0/win/其他作品.7z")])));
    const provider = new ShinnkuSourceProvider(undefined, { fetcher });
    const resources = await provider.listResources(itemId(first.file_path));
    expect(resources.map((resource) => resource.title)).toEqual(["夏日口袋.7z.001", "夏日口袋.7z.002"]);
    expect(resources[0].metadata).toMatchObject({ multipart: true, partNumber: 1, totalParts: 2, requiredFiles: ["夏日口袋.7z.001", "夏日口袋.7z.002"], downloadFileName: "夏日口袋.7z.001" });
    expect(resources[1].metadata.partNumber).toBe(2);
    expect(fetcher.mock.calls[1][0]).toBe("https://www.shinnku.com/files/shinnku/0/win");
    await expect(provider.resolve(resources[1].id)).resolves.toMatchObject({ filename: "夏日口袋.7z.002" });
  });

  it.each([["001"], ["001", "003"], ["002", "003"]])("rejects incomplete split archives rather than presenting a lone part as usable: %j", async (...numbers) => {
    const files = numbers.map((number) => file(`0/win/Game.7z.${number}`));
    const fetcher = vi.fn<TextFetcher>().mockResolvedValueOnce(text(detailHtml(files[0]))).mockResolvedValueOnce(text(folderHtml(files)));
    await expect(new ShinnkuSourceProvider(undefined, { fetcher }).listResources(itemId(files[0].file_path))).rejects.toThrow("分卷目录缺少首卷");
  });

  it("includes the starting rar file alongside classic r00/r01 volumes", async () => {
    const files = [file("0/win/Game.rar"), file("0/win/Game.r00"), file("0/win/Game.r01")];
    const fetcher = vi.fn<TextFetcher>().mockResolvedValueOnce(text(detailHtml(files[1]))).mockResolvedValueOnce(text(folderHtml(files)));
    const resources = await new ShinnkuSourceProvider(undefined, { fetcher }).listResources(itemId(files[1].file_path));
    expect(resources).toHaveLength(3);
    expect(resources[0].metadata.requiredFiles).toEqual(expect.arrayContaining(["Game.rar", "Game.r00", "Game.r01"]));
  });

  it("discovers every classic RAR volume when restoring the persisted base .rar directly", async () => {
    const files = [file("0/win/Game.rar"), file("0/win/Game.r00"), file("0/win/Game.r01")];
    const fetcher = vi.fn<TextFetcher>().mockResolvedValueOnce(text(detailHtml(files[0]))).mockResolvedValueOnce(text(folderHtml([files[2], files[0], files[1]])));
    const resources = await new ShinnkuSourceProvider(undefined, { fetcher }).listResources(itemId(files[0].file_path));
    expect(resources.map((item) => item.title)).toEqual(["Game.rar", "Game.r00", "Game.r01"]);
    expect(resources.map((item) => item.metadata.partNumber)).toEqual([1, 2, 3]);
    expect(resources[0].metadata.requiredFiles).toEqual(["Game.rar", "Game.r00", "Game.r01"]);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["https://www.shinnku.com/files/shinnku/0/win/Game.rar", "https://www.shinnku.com/files/shinnku/0/win"]);
  });

  it("keeps a regular single RAR when the independently loaded parent has no split volumes", async () => {
    const info = file("0/win/Game.rar");
    const fetcher = vi.fn<TextFetcher>().mockResolvedValueOnce(text(detailHtml(info))).mockResolvedValueOnce(text(folderHtml([info, file("0/win/Other.r00")])));
    const resources = await new ShinnkuSourceProvider(undefined, { fetcher }).listResources(itemId(info.file_path));
    expect(resources).toHaveLength(1);
    expect(resources[0].metadata.multipart).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects a classic RAR whose base exists but r00 is missing", async () => {
    const first = file("0/win/Game.rar");
    const fetcher = vi.fn<TextFetcher>().mockResolvedValueOnce(text(detailHtml(first))).mockResolvedValueOnce(text(folderHtml([first, file("0/win/Game.r01")])));
    await expect(new ShinnkuSourceProvider(undefined, { fetcher }).listResources(itemId(first.file_path))).rejects.toThrow("分卷目录缺少首卷");
  });

  it("can inspect an ordinarily large parent folder without losing a legacy RAR volume group", async () => {
    const first = file("0/win/Game.rar");
    const siblings = [first, file("0/win/Game.r00"), ...Array.from({ length: 1_782 }, (_, index) => file(`0/win/Unrelated-${index}.7z`))];
    const fetcher = vi.fn<TextFetcher>().mockResolvedValueOnce(text(detailHtml(first))).mockResolvedValueOnce(text(folderHtml(siblings)));
    const resources = await new ShinnkuSourceProvider(undefined, { fetcher }).listResources(itemId(first.file_path));
    expect(resources.map((item) => item.title)).toEqual(["Game.rar", "Game.r00"]);
  });

  it("does not leak multipart siblings into separate matching works", async () => {
    const files = [file("0/win/Game.part2.rar"), file("0/win/Game.part1.rar")];
    const fetcher = vi.fn<TextFetcher>().mockResolvedValue(text(searchHtml(files)));
    const matches = await new ShinnkuSourceProvider(undefined, { fetcher }).search({ ...query, keyword: "Game" });
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ title: "Game", raw: { multipart: true, matchedParts: ["Game.part1.rar", "Game.part2.rar"] } });
  });

  it.each(["file:..%2F..%2Fsecret.7z", "file:0%2Fwin%2F..%2Fsecret.zip", "file:0%2Fwin%2FGame.torrent", "file:%", "https://evil.example/game.zip"])("rejects unsafe or unsupported persisted IDs before networking: %s", async (id) => {
    const fetcher = vi.fn<TextFetcher>();
    const provider = new ShinnkuSourceProvider(undefined, { fetcher });
    await expect(provider.listResources(id)).rejects.toThrow("文件 ID 无效");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("ignores the separate original-language collection and readme placeholders", async () => {
    const fetcher = vi.fn<TextFetcher>().mockResolvedValue(text(searchHtml([file("合集系列/浮士德galgame游戏合集/CLANNAD.rar"), file("0/win/CLANNAD/README.md", 55), file("0/win/CLANNAD(缺少).txt", 0)])));
    await expect(new ShinnkuSourceProvider(undefined, { fetcher }).search(query)).resolves.toEqual([]);
  });

  it("rejects mismatched or stale detail records", async () => {
    const fetcher = vi.fn<TextFetcher>().mockResolvedValue(text(detailHtml(file("0/win/Another.7z"))));
    await expect(new ShinnkuSourceProvider(undefined, { fetcher }).listResources(itemId(file().file_path))).rejects.toThrow("文件已移除");
  });

  it("bounds an oversized source response", async () => {
    const fetcher = vi.fn<TextFetcher>().mockResolvedValue(text("x".repeat(3 * 1024 * 1024 + 1)));
    await expect(new ShinnkuSourceProvider(undefined, { fetcher }).search(query)).rejects.toThrow("目录响应过大");
  });

  it("accepts only the official HTTPS base URLs", () => {
    for (const base of ["http://www.shinnku.com", "https://evil.example", "https://user:password@www.shinnku.com", "https://www.shinnku.com/path"]) {
      expect(() => new ShinnkuSourceProvider(base)).toThrow("官方 HTTPS");
    }
    expect(new ShinnkuSourceProvider("https://shinnku.com").id).toBe("shinnku:https://shinnku.com");
  });

  it("skips other media, blank queries and unavailable search pages without network activity", async () => {
    const fetcher = vi.fn<TextFetcher>();
    const provider = new ShinnkuSourceProvider(undefined, { fetcher });
    await expect(provider.search({ ...query, mediaType: "anime" })).resolves.toEqual([]);
    await expect(provider.search({ ...query, keyword: " " })).resolves.toEqual([]);
    await expect(provider.search({ ...query, page: 2 })).resolves.toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("honors an already aborted request without starting another source request", async () => {
    const controller = new AbortController(); controller.abort();
    const fetcher = vi.fn<TextFetcher>();
    await expect(new ShinnkuSourceProvider(undefined, { fetcher, signal: controller.signal }).search(query)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
