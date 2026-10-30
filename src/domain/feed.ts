export type FeedFormat = "rss2" | "atom";

export interface FeedEnclosure {
  url: string;
  type?: string;
  length?: number;
}

export interface FeedItem {
  id: string;
  title: string;
  sourceUrl: string;
  url?: string;
  publishedAt?: string;
  updatedAt?: string;
  description?: string;
  author?: string;
  categories: string[];
  enclosure?: FeedEnclosure;
  metadata: Record<string, unknown>;
}

export interface FeedDocument {
  title: string;
  sourceUrl: string;
  format: FeedFormat;
  url?: string;
  description?: string;
  items: FeedItem[];
  fetchedAt: string;
}
