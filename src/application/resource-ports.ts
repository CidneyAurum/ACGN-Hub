import type { ResourceItem } from "@/domain/resource";

export interface ResourceRepository {
  initialize(): Promise<void>;
  upsert(resource: ResourceItem): Promise<void>;
  remove(id: string): Promise<void>;
  list(): Promise<ResourceItem[]>;
  findById(id: string): Promise<ResourceItem | undefined>;
}
