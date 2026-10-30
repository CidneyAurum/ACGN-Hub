import type { FeedDocument } from "@/domain/feed";

export interface TextResponse {
  status: number;
  text(): Promise<string>;
}

export type TextFetcher = (url: string, init?: RequestInit) => Promise<TextResponse>;

export interface FeedProvider {
  readonly id: string;
  read(url: string): Promise<FeedDocument>;
}
