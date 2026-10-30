import type { SourceProvider } from "@/application/source-ports";
import type { SourceConfig } from "@/domain/source";
import { RssSourceProvider } from "@/infrastructure/feeds/rss-source-provider";
import { GithubReleaseSourceProvider } from "./github-release-provider";
import { KUNGalgameSourceProvider } from "./kungal-source-provider";
import { CopyMangaSourceProvider } from "./copymanga-source-provider";
import { JmComicSourceProvider } from "./jmcomic-source-provider";
import { MangaDexSourceProvider } from "./mangadex-source-provider";
import { MangabzSourceProvider } from "./mangabz-source-provider";
import { InternetArchiveSourceProvider } from "./internet-archive-source-provider";
import { LNovelSourceProvider } from "./lnovel-source-provider";
import { PublicVideoSourceProvider } from "./public-video-source-provider";
import type { ResourceItem } from "@/domain/resource";

export function createSourceProvider(config: SourceConfig, storedResources: ResourceItem[] = []): SourceProvider {
  let provider: SourceProvider & { restoreResource?: (resource: ResourceItem) => void };
  switch (config.type as string) {
    case "public_video": provider = new PublicVideoSourceProvider(config.url); break;
    case "github_release": provider = new GithubReleaseSourceProvider(config.url); break;
    case "kungal": provider = new KUNGalgameSourceProvider(config.url); break;
    case "copymanga": provider = new CopyMangaSourceProvider(config.url, { token: config.token }); break;
    case "jmcomic": provider = new JmComicSourceProvider(); break;
    case "mangadex": provider = new MangaDexSourceProvider(config.url); break;
    case "mangabz": provider = new MangabzSourceProvider(config.url); break;
    case "archive": provider = new InternetArchiveSourceProvider(config.url); break;
    case "lnovel": provider = new LNovelSourceProvider(config.url); break;
    case "rss":
    case "nyaa":
    case "anime_garden": provider = new RssSourceProvider(config.url); break;
    default: throw new Error(`来源类型 ${String(config.type)} 当前不受支持，请检查来源配置`);
  }
  for (const resource of storedResources) provider.restoreResource?.(resource);
  return provider;
}
