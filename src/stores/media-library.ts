import { computed, ref } from "vue";
import { defineStore } from "pinia";
import type { Media } from "@/domain/media";
import type { MediaLibraryRepository } from "@/application/library-ports";
import { createMediaLibraryRepository } from "@/infrastructure/library/create-media-library-repository";

export const useMediaLibraryStore = defineStore("media-library", () => {
  const items = ref<Media[]>([]);
  const loading = ref(false);
  const error = ref("");
  let repository: MediaLibraryRepository | undefined;
  let initializing: Promise<void> | undefined;

  const sortedItems = computed(() => [...items.value].sort((a, b) => a.title.localeCompare(b.title)));

  async function initialize(): Promise<void> {
    if (initializing) return initializing;
    if (repository) return;
    loading.value = true;
    initializing = (async () => {
      try {
        repository = await createMediaLibraryRepository();
        items.value = await repository.list();
        error.value = "";
      } catch (cause) {
        repository = undefined;
        error.value = cause instanceof Error ? cause.message : "本地作品库读取失败，请重试";
      } finally {
        loading.value = false;
      }
    })();
    try {
      await initializing;
    } finally {
      initializing = undefined;
    }
  }

  async function save(media: Media): Promise<void> {
    await initialize();
    if (!repository) throw new Error("本地作品库尚未初始化");
    await repository.upsert(media);
    items.value = [media, ...items.value.filter((item) => item.id !== media.id)];
  }

  async function remove(mediaId: string): Promise<void> {
    await initialize();
    if (!repository) throw new Error("本地作品库尚未初始化");
    await repository.remove(mediaId);
    items.value = items.value.filter((item) => item.id !== mediaId);
  }

  function isSaved(mediaId: string): boolean {
    return items.value.some((item) => item.id === mediaId);
  }

  return { items: sortedItems, loading, error, initialize, save, remove, isSaved };
});
