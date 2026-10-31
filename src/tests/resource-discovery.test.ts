import { describe, expect, it, vi } from "vitest";
import { discoverResources, getResourceWarnings, loadSourceItemResources, searchSourceCandidates } from "@/application/resource-discovery";
import { rankSourceCandidates, resourceTitleLabels, sourceSearchTerms } from "@/infrastructure/sources/source-matching";
import { LNovelSourceProvider } from "@/infrastructure/sources/lnovel-source-provider";
import { RssAtomProvider } from "@/infrastructure/feeds/rss-atom-provider";
import { RssSourceProvider } from "@/infrastructure/feeds/rss-source-provider";
import { sourceSupportsType } from "@/infrastructure/sources/source-catalog";
import { PublicVideoSourceProvider } from "@/infrastructure/sources/public-video-source-provider";
import { InternetArchiveSourceProvider } from "@/infrastructure/sources/internet-archive-source-provider";
import type { SourceProvider, SourceSearchResult } from "@/application/source-ports";
import type { SourceConfig } from "@/domain/source";
import type { ResourceItem } from "@/domain/resource";

// Titles/IDs observed in the public read-only audit; no chapter bodies or credentials.
const source: SourceConfig = { id: "copy", type: "copymanga", name: "漫画来源", url: "https://api.example", enabled: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
const observed: SourceSearchResult[] = [
  { sourceId: "copy", sourceItemId: "zangsongdefulilianheji", title: "葬送的芙莉莲合集" },
  { sourceId: "copy", sourceItemId: "zangsongdefulilian", title: "葬送的芙莉蓮" },
  { sourceId: "copy", sourceItemId: "zsdfllzpj", title: "葬送的芙莉蓮 作品集 ~享受各種旅行的魔法~" },
];
function providerFixture() {
  const resource: ResourceItem = { id: "chapter", sourceId: "copy", sourceItemId: "zangsongdefulilian", title: "葬送的芙莉蓮 · 第1话", protocol: "http", targetUrl: "https://api.example/chapter", metadata: { downloadMode: "manga_cbz" }, createdAt: "2026-01-01" };
  const provider: SourceProvider = { id: "copy", name: "Copy", supportedTypes: ["manga"], search: vi.fn(async () => observed),
    listResources: vi.fn(async () => [resource]), resolve: vi.fn(), healthCheck: vi.fn() };
  return provider;
}

const archiveSource: SourceConfig = { ...source, id: "archive", type: "archive", name: "公开档案", url: "https://archive.org" };
function archiveDurationFixture() {
  return new InternetArchiveSourceProvider(undefined, { fetcher: async (url) => ({ status: 200, json: async () => url.includes("/advancedsearch.php")
    ? { response: { docs: [{ identifier: "duration-warning-fixture", title: "Big Buck Bunny" }] } }
    : { metadata: { identifier: "duration-warning-fixture", title: "Big Buck Bunny" }, files: [
      { name: "ten.mp4", format: "MPEG4", length: "10", size: "1000000" },
      { name: "feature.avi", format: "AVI", length: "596.5", size: "332243668" },
      { name: "book.txt", format: "Text", size: "20000" },
    ] } }) });
}

describe("source work discovery", () => {
  it("keeps Archive duration warnings on the short file during broad discovery without contaminating other files", async () => {
    const provider = archiveDurationFixture();
    const result = await discoverResources({ keyword: "Big Buck Bunny", mediaType: "anime", sources: [archiveSource] }, () => provider);
    expect(result.failures).toEqual([]);
    expect(result.items).toHaveLength(3);
    const short = result.items.find((item) => item.resource.metadata.fileName === "ten.mp4")!;
    expect(short.warnings).toHaveLength(1);
    expect(short.warnings[0]).toContain("视频时长不足 2 分钟");
    expect(short.resource.metadata.matchWarnings).toEqual(short.warnings);
    expect(short.resource.metadata.resourceLabel).toBe("短视频直链 · 片段/样片待核对");
    for (const item of result.items.filter((item) => item !== short)) {
      expect(item.warnings).toEqual([]);
      expect(item.resource.metadata.matchWarnings).toEqual([]);
      expect(item.resource.metadata.warnings).toBeUndefined();
    }
  });

  it("preserves Archive file warnings through exact-source loading and the detail page warning merge", async () => {
    const provider = archiveDurationFixture();
    const result = await loadSourceItemResources({ config: archiveSource, sourceItemId: "duration-warning-fixture", title: "Big Buck Bunny" }, () => provider);
    expect(result.resources).toHaveLength(3);
    // Group-level status stays independent from per-file content warnings.
    expect(result.warnings).toEqual([]);
    const short = result.resources.find((item) => item.metadata.fileName === "ten.mp4")!;
    const detailWarnings = getResourceWarnings(short, result.warnings);
    expect(detailWarnings).toHaveLength(1);
    expect(detailWarnings[0]).toContain("不能据此认定完整正片");
    expect(short.metadata.matchWarnings).toEqual(detailWarnings);
    for (const resource of result.resources.filter((item) => item !== short)) expect(getResourceWarnings(resource, result.warnings)).toEqual([]);
  });

  it("merges provider and match warnings once, ignores empty/malformed entries and retains original metadata", async () => {
    const provider = providerFixture();
    const original = (await provider.listResources("zangsongdefulilian"))[0];
    const metadata = { ...original.metadata, warnings: [null, "", "  图片完整性需核对  ", "图片完整性需核对", 7], matchWarnings: [false, "旧匹配提示", " "] };
    vi.mocked(provider.search).mockResolvedValue([{ ...observed[1], raw: { warnings: ["来源内容需核对", " ", false] } }]);
    vi.mocked(provider.listResources).mockResolvedValue([{ ...original, metadata }]);
    const snapshot = JSON.stringify(metadata);
    const result = await discoverResources({ keyword: "葬送的芙莉莲", mediaType: "manga", sources: [source] }, () => provider);
    expect(result.items[0].warnings).toEqual(["来源内容需核对", "图片完整性需核对", "旧匹配提示"]);
    expect(result.items[0].resource.metadata.matchWarnings).toEqual(result.items[0].warnings);
    expect(JSON.stringify(metadata)).toBe(snapshot);
  });

  it("keeps a provider-confirmed manga identity when its display title differs from the exact ID", async () => {
    const mangaId = "a1c7c817-4e59-43b7-9365-09675a149a6f";
    const provider = providerFixture();
    vi.mocked(provider.search).mockResolvedValue([{ sourceId: "mangadex", sourceItemId: mangaId, title: "Frieren: Beyond Journey's End" }]);
    const result = await searchSourceCandidates({ keyword: mangaId, mediaType: "manga", sources: [{ ...source, type: "mangadex" }] }, () => provider);
    expect(result.candidates).toMatchObject([{ score: 100, candidate: { sourceItemId: mangaId } }]);
  });
  const publicVideoSource: SourceConfig = { ...source, id: "public-video", type: "public_video", name: "B站公开投稿", url: "https://www.bilibili.com" };

  it.each([
    ["BV1UqHi6uEie", "BV1UqHi6uEie"],
    ["BV1UqHi6uEie?p=1", "BV1UqHi6uEie"],
    ["BV1UqHi6uEie?p=1000", "BV1UqHi6uEie?p=1000"],
    ["https://www.bilibili.com/video/BV1UqHi6uEie/?p=2", "BV1UqHi6uEie?p=2"],
    ["http://bilibili.com/video/BV1UqHi6uEie/?p=2&vd_source=tracking", "BV1UqHi6uEie?p=2"],
  ])("keeps an inspected explicit video %s whose display title is unrelated, including its warnings", async (keyword, sourceItemId) => {
    const inspect = vi.fn(async () => ({ id: "BV1UqHi6uEie", title: "完全不同的投稿标题", duration: 25, playable: true, formats: [] }));
    const fetcher = vi.fn(async () => { throw new Error("An explicit BV must not run a keyword search"); });
    const provider = new PublicVideoSourceProvider(undefined, { inspect, fetcher });
    const listResources = vi.spyOn(provider, "listResources");
    const result = await searchSourceCandidates({ keyword, mediaType: "anime", sources: [publicVideoSource] }, () => provider);
    expect(result.failures).toEqual([]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ score: 100, candidate: { sourceItemId, title: "完全不同的投稿标题" } });
    expect(result.candidates[0].warnings).toContain("时长不足 10 分钟，可能是预告、片段或二创，不能当作完整正片");
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(listResources).not.toHaveBeenCalled();
  });

  it.each([
    "BV1UqHi6uEi", "BV1UqHi6uEie?p=0", "BV1UqHi6uEie?p=1001",
    "https://www.bilibili.com/video/BV1UqHi6uEie/?p=1&p=2",
    "https://unrelated.example/video/BV1UqHi6uEie/",
    "https://www.bilibili.com:8443/video/BV1UqHi6uEie/",
    "BV1A11111111",
  ])("does not fall back to an unrelated public-video candidate for invalid or unmatched input %s", async (keyword) => {
    const provider = providerFixture();
    vi.mocked(provider.search).mockResolvedValue([{ sourceId: "public-video", sourceItemId: "BV1UqHi6uEie", title: "完全不同的投稿标题", raw: { warnings: ["需核对内容"] } }]);
    const result = await searchSourceCandidates({ keyword, mediaType: "anime", sources: [publicVideoSource] }, () => provider);
    expect(result.candidates).toEqual([]);
    expect(provider.listResources).not.toHaveBeenCalled();
  });

  it("preserves provider warnings when an explicit numeric source ID bypasses title matching", async () => {
    const provider = providerFixture();
    vi.mocked(provider.search).mockResolvedValue([{ sourceId: "lnovel", sourceItemId: "7", title: "与数字ID无关的作品名", raw: { warnings: ["分卷可能不完整", "分卷可能不完整", 7] } }]);
    const result = await searchSourceCandidates({ keyword: "7", mediaType: "novel", sources: [{ ...source, type: "lnovel" }] }, () => provider);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].warnings).toEqual(["分卷可能不完整"]);
  });

  it("does not offer anime-only RSS presets as a manga or novel source", () => {
    const animeFeed = { ...source, type: "rss" as const, url: "https://mikanani.me/RSS/Classic" };
    expect(sourceSupportsType(animeFeed, "anime")).toBe(true);
    expect(sourceSupportsType(animeFeed, "manga")).toBe(false);
    expect(sourceSupportsType(animeFeed, "novel")).toBe(false);
    expect(sourceSupportsType({ ...animeFeed, url: "https://example.org/books.xml" }, "novel")).toBe(true);
  });
  it("ranks the exact traditional-Chinese original before a same-title collection", () => {
    const ranked = rankSourceCandidates(observed, "葬送的芙莉莲");
    expect(ranked[0].candidate.sourceItemId).toBe("zangsongdefulilian");
    expect(ranked[0].score).toBe(100);
    expect(ranked[1].warnings).toContain("同人、合集或衍生篇，请确认是否为所需作品");
  });

  it("matches the user's exact manga title across traditional glyphs and comma-delimited aliases", () => {
    const ranked = rankSourceCandidates([
      { sourceId: "copy", sourceItemId: "artbook", title: "腦洞學生會！官方插畫集『藤成學園活動日誌』", raw: { alias: "脑洞学生会！官方插画集" } },
      { sourceId: "copy", sourceItemId: "naoodngxueshenghui", title: "腦洞學生會", raw: { alias: "脑洞学生会,脑洞学生会！,学生会也有洞！" } },
    ], "脑洞学生会");
    expect(ranked[0]).toMatchObject({ score: 100, candidate: { sourceItemId: "naoodngxueshenghui" } });
    expect(ranked[1].warnings.length).toBeGreaterThan(0);
  });

  it("identifies an archived OST cover as related content instead of an anime episode", () => {
    const candidates = [
      { sourceId: "archive", sourceItemId: "cover", title: "Frieren Episode 9 OST - Fern's Magic (HQ Cover) 『葬送的芙莉莲』第9话 背景音乐" },
      { sourceId: "archive", sourceItemId: "episode", title: "葬送的芙莉莲 第9话" },
    ];
    const ranked = rankSourceCandidates(candidates, "葬送的芙莉莲");
    expect(ranked[0].candidate.sourceItemId).toBe("episode");
    expect(ranked[1].warnings).toContain("音乐、片段或二创内容，不是正片剧集");
  });

  it("does not label the requested show's 25-second Media History or CM as a full episode", () => {
    const candidates = [
      { sourceId: "archive", sourceItemId: "history", title: "Even The Student Council Has Its Holes! Media History" },
      { sourceId: "archive", sourceItemId: "cm", title: "TVアニメ『生徒会にも穴はある！』番宣CM" },
    ];
    const ranked = rankSourceCandidates(candidates, "生徒会にも穴はある！", ["Even the Student Council Has Its Holes!"]);
    expect(ranked).toHaveLength(2);
    expect(ranked.every((item) => item.warnings.includes("音乐、片段或二创内容，不是正片剧集"))).toBe(true);
  });

  it("shows source work choices without loading any chapter list", async () => {
    const provider = providerFixture();
    const found = await searchSourceCandidates({ keyword: "葬送的芙莉莲", mediaType: "manga", sources: [source] }, () => provider);
    expect(found.candidates).toHaveLength(3);
    expect(provider.listResources).not.toHaveBeenCalled();
    expect(found.candidates[0].candidate.sourceItemId).toBe("zangsongdefulilian");
  });

  it("does not flatten all matching derivative works into a metadata work's chapters", async () => {
    const provider = providerFixture();
    const result = await discoverResources({ keyword: "葬送的芙莉莲", mediaType: "manga", sources: [source] }, () => provider);
    expect(provider.listResources).toHaveBeenCalledExactlyOnceWith("zangsongdefulilian");
    expect(result.items[0]).toMatchObject({ score: 100, sourceItemTitle: "葬送的芙莉蓮", warnings: [] });
  });

  it("loads the confirmed source ID without another fuzzy title search", async () => {
    const provider = providerFixture();
    const result = await loadSourceItemResources({ config: source, sourceItemId: "zangsongdefulilian", title: "葬送的芙莉蓮" }, () => provider);
    expect(provider.search).not.toHaveBeenCalled();
    expect(provider.listResources).toHaveBeenCalledExactlyOnceWith("zangsongdefulilian");
    expect(result.resources).toHaveLength(1);
  });

  it("keeps both same-title manga editions rather than silently choosing the first short edition", async () => {
    const provider = providerFixture();
    vi.mocked(provider.search).mockResolvedValue([
      { sourceId: "copy", sourceItemId: "old", title: "安達與島村" },
      { sourceId: "copy", sourceItemId: "new", title: "安達與島村" },
    ]);
    vi.mocked(provider.listResources).mockImplementation(async (id) => [{ id: id + "-chapter", sourceId: "copy", sourceItemId: id,
      title: "安達與島村 · " + (id === "old" ? "第18話" : "第60話"), protocol: "http", targetUrl: `https://api.example/${id}/chapter`, createdAt: "2026-01-01", metadata: {} }]);
    const result = await discoverResources({ keyword: "安达与岛村", mediaType: "manga", sources: [source] }, () => provider);
    expect(provider.listResources).toHaveBeenCalledWith("old");
    expect(provider.listResources).toHaveBeenCalledWith("new");
    expect(result.items.map((item) => item.resource.sourceItemId)).toEqual(["old", "new"]);
    expect(result.items[1].resource.title).toContain("第60話");
  });

  it("keeps the first season before a newer second-season release after service ranking", async () => {
    const provider = providerFixture();
    provider.supportedTypes.splice(0, 1, "anime");
    vi.mocked(provider.search).mockResolvedValue([
      { sourceId: "rss", sourceItemId: "season-two", title: "葬送的芙莉莲 第二季 1080p" },
      { sourceId: "rss", sourceItemId: "season-one", title: "葬送的芙莉莲 S01 [01-28] 1080p" },
    ]);
    const result = await searchSourceCandidates({ keyword: "葬送的芙莉莲", mediaType: "anime", sources: [{ ...source, type: "rss" }] }, () => provider);
    expect(result.candidates[0].candidate.sourceItemId).toBe("season-one");
    expect(result.candidates[1].warnings.join(" ")).toContain("第 2 季");
  });

  it("warns about a continuous second-season range even if the publisher labels it S01", () => {
    const title = "[7³ACG] 葬送的芙莉莲/Sousou no Frieren S01 | 29-38+SPx11 [简繁字幕] BDrip 1080p";
    expect(resourceTitleLabels(title, "葬送的芙莉莲", 28).warnings).toContain("集数 29–38 超出本作 28 集，请核对季度");
  });

  it("normalizes a Japanese volume title and never matches novels through generic synopsis words", async () => {
    expect(sourceSearchTerms("無職転生 ~異世界行ったら本気だす~ (1)")).toContain("无职转生");
    const provider = new LNovelSourceProvider("https://novel.example", { fetcher: async () => ({ status: 200, json: async () => ({ ok: true, data: [
      { nid: 4325, name: "无职转生 ～蛇足篇～" },
      { nid: 5, name: "问题儿童都来自异世界?", description: "无职转生类似的异世界轻小说" },
      { nid: 71, name: "平凡职业造就世界最强", description: "无职转生" },
    ] }) }) });
    const results = await provider.search({ keyword: "無職転生 ~異世界行ったら本気だす~ (1)", aliases: [], mediaType: "novel" });
    expect(results.map((item) => item.sourceItemId)).toEqual(["4325"]);
    const ranked = rankSourceCandidates(results, "无职转生");
    expect(ranked[0].warnings.length).toBeGreaterThan(0);
  });

  it("checks the Mikan index's Bangumi ID before reading its season feed", async () => {
    const searched: string[] = [];
    const textFetcher = async (url: string) => {
      searched.push(url);
      return { status: 200, text: async () => url.includes("/Home/Bangumi/")
        ? '<a href="https://bgm.tv/subject/400602">Bangumi番组计划链接</a>'
        : '<a href="/Home/Bangumi/3060"><span class="an-info">葬送的芙莉莲</span></a>' };
    };
    const xml = '<rss version="2.0"><channel><title>第一季</title><item><title>葬送的芙莉莲 S01 [01-28] 1080p</title><link>https://mikanani.me/Home/Episode/one</link><enclosure url="https://example.com/season-one.torrent" /></item></channel></rss>';
    const feeds: string[] = [];
    const feedProvider = new RssAtomProvider({ minIntervalMs: 0, maxRetries: 0, fetcher: async (url) => {
      feeds.push(url); return { status: 200, text: async () => xml };
    } });
    const provider = new RssSourceProvider("https://mikanani.me/RSS/Classic", feedProvider, textFetcher);
    const matches = await provider.search({ keyword: "葬送的芙莉莲", aliases: [], mediaType: "anime", subjectId: "400602" });
    expect(searched).toHaveLength(2);
    expect(feeds).toEqual(["https://mikanani.me/RSS/Search?searchstr=%E8%91%AC%E9%80%81%E7%9A%84%E8%8A%99%E8%8E%89%E8%8E%B2", "https://mikanani.me/RSS/Bangumi?bangumiId=3060"]);
    expect(matches).toHaveLength(1);
    expect((await provider.listResources(matches[0].sourceItemId))[0].metadata.seasonLabel).toBe("第 1 季");
  });
});
