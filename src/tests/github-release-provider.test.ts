import { describe, expect, it, vi, type MockedFunction } from "vitest";
import { GithubReleaseSourceProvider, parseGithubRepositoryUrl } from "@/infrastructure/sources/github-release-provider";
import type { JsonFetcher } from "@/infrastructure/metadata/json-transport";
import type { TextFetcher } from "@/application/feed-ports";

function response(status: number, body: unknown) {
  return { status, json: async () => body };
}

function fetcher(body: unknown): MockedFunction<JsonFetcher> {
  return vi.fn().mockResolvedValue(response(200, body)) as MockedFunction<JsonFetcher>;
}

function textResponse(status: number, body: string) {
  return { status, text: async () => body };
}

const releases = [{
  id: 42,
  tag_name: "v1.2.0",
  name: "Open VN 1.2.0",
  body: "Windows release",
  html_url: "https://github.com/example/open-vn/releases/tag/v1.2.0",
  published_at: "2026-08-17T00:00:00.000Z",
  assets: [{
    id: 7,
    name: "open-vn-win.zip",
    browser_download_url: "https://github.com/example/open-vn/releases/download/v1.2.0/open-vn-win.zip",
    size: 1024,
    content_type: "application/zip",
  }],
}];

describe("GitHub Release source", () => {
  it("parses only a public repository URL", () => {
    expect(parseGithubRepositoryUrl("https://github.com/example/open-vn/")).toEqual({ owner: "example", repo: "open-vn" });
    expect(() => parseGithubRepositoryUrl("http://github.com/example/open-vn")).toThrow();
    expect(() => parseGithubRepositoryUrl("https://github.com/example/open-vn/releases")).toThrow();
  });

  it("searches releases and exposes downloadable assets", async () => {
    const request = fetcher(releases);
    const provider = new GithubReleaseSourceProvider("https://github.com/example/open-vn", { fetcher: request, maxRetries: 0 });

    const matches = await provider.search({ keyword: "open vn", aliases: [], mediaType: "visual_novel" });
    const resources = await provider.listResources(matches[0].sourceItemId);

    expect(matches[0]).toMatchObject({ sourceId: "github:example/open-vn", sourceItemId: "42", title: "Open VN 1.2.0" });
    expect(resources[0]).toMatchObject({ protocol: "http", format: "zip", sizeBytes: 1024 });
    await expect(provider.resolve(resources[0].id)).resolves.toMatchObject({ protocol: "http" });
    expect(request).toHaveBeenCalledWith("https://api.github.com/repos/example/open-vn/releases?per_page=20", expect.objectContaining({ method: "GET" }));
  });

  it("falls back to Releases Atom and HTML assets after GitHub API 403", async () => {
    const request = vi.fn().mockResolvedValue(response(403, { message: "rate limit" })) as MockedFunction<JsonFetcher>;
    const atom = '<?xml version="1.0"?>' +
      '<feed xmlns="http://www.w3.org/2005/Atom">' +
      '<title>Open VN releases</title>' +
      '<entry><id>tag:github.com,2008:Repository/1/v1.2.0</id>' +
      '<title>Open VN 1.2.0</title>' +
      '<link href="https://github.com/example/open-vn/releases/tag/v1.2.0" rel="alternate" />' +
      '<published>2026-08-17T00:00:00Z</published></entry></feed>';
    const html = '<a href="/example/open-vn/releases/download/v1.2.0/open-vn-win.zip">open-vn-win.zip</a>';
    const textRequest = vi.fn()
      .mockResolvedValueOnce(textResponse(200, atom))
      .mockResolvedValueOnce(textResponse(200, html)) as MockedFunction<TextFetcher>;
    const provider = new GithubReleaseSourceProvider("https://github.com/example/open-vn", {
      fetcher: request,
      textFetcher: textRequest,
      maxRetries: 0,
    });

    const matches = await provider.search({ keyword: "open vn", aliases: [], mediaType: "visual_novel" });
    const resources = await provider.listResources(matches[0].sourceItemId);

    expect(matches[0]).toMatchObject({ sourceItemId: "atom:https://github.com/example/open-vn/releases.atom::tag:github.com,2008:Repository/1/v1.2.0", title: "Open VN 1.2.0" });
    expect(resources[0]).toMatchObject({ format: "zip", targetUrl: "https://github.com/example/open-vn/releases/download/v1.2.0/open-vn-win.zip" });
    expect(textRequest).toHaveBeenNthCalledWith(1, "https://github.com/example/open-vn/releases.atom", expect.objectContaining({ method: "GET" }));
    expect(textRequest).toHaveBeenNthCalledWith(2, "https://github.com/example/open-vn/releases/tag/v1.2.0", expect.objectContaining({ method: "GET" }));
  });
});
