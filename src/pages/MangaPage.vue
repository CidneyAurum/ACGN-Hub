<script setup lang="ts">
import { computed, ref } from "vue";
import { createMangaChapterService } from "@/infrastructure/manga/tauri-manga-chapter-service";
import { isTauriRuntime } from "@/shared/runtime";
import { joinWindowsPath, sanitizeFileName } from "@/domain/organization";
import { loadSettings } from "@/shared/settings";
import { useLocalDownloadStore } from "@/stores/local-download";

const title = ref("");
const chapter = ref("");
const imageText = ref("");
const referer = ref("");
const cookie = ref("");
const running = ref(false);
const error = ref("");
const result = ref("");
const completedTaskId = ref("");
const localDownloadStore = useLocalDownloadStore();

const imageUrls = computed(() => [...new Set(imageText.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))]);

async function packageChapter(): Promise<void> {
  error.value = "";
  result.value = "";
  completedTaskId.value = "";
  if (!isTauriRuntime()) {
    error.value = "漫画章节下载和 CBZ 打包只在桌面端可用";
    return;
  }
  const cleanTitle = title.value.trim();
  const cleanChapter = chapter.value.trim();
  if (!cleanTitle || !cleanChapter) {
    error.value = "请填写作品名和章节名";
    return;
  }
  if (!imageUrls.value.length || imageUrls.value.length > 1000) {
    error.value = "请提供 1 到 1000 个图片地址，每行一个";
    return;
  }
  const settings = loadSettings();
  if (!isAbsoluteWindowsPath(settings.obsidianEbookDirectory) || !isAbsoluteWindowsPath(settings.incomingDirectory)) {
    error.value = "请先在设置中填写有效的 Obsidian 电子书和 Incoming 绝对路径";
    return;
  }
  running.value = true;
  let localTaskId: string | undefined;
  try {
    const stamp = Date.now();
    const outputRoot = settings.obsidianEbookDirectory;
    const tempDirectory = joinWindowsPath(settings.incomingDirectory, "MangaTemp", String(stamp));
      const mangaFile = `${sanitizeFileName(`${cleanTitle} - ${cleanChapter}`).slice(0, 165)}.cbz`;
    const outputPath = joinWindowsPath(outputRoot, mangaFile);
    localTaskId = localDownloadStore.create({
      kind: "manga",
      title: `${cleanTitle} · ${cleanChapter}`,
      sourceName: "手动漫画章节",
      directory: outputRoot,
      outputPath,
      reading: { seriesTitle: cleanTitle, unitTitle: cleanChapter },
      cleanupPaths: [{ path: tempDirectory, allowedRoot: settings.incomingDirectory }],
      totalUnits: imageUrls.value.length,
    });
    const packaged = await createMangaChapterService().downloadAndPackage({
      imageUrls: imageUrls.value,
      incomingRoot: settings.incomingDirectory,
      tempDirectory,
      outputRoot,
      outputPath,
      isCancelled: () => localDownloadStore.isCancelled(localTaskId!),
      ...(referer.value.trim() ? { referer: referer.value.trim() } : {}),
      ...(cookie.value.trim() ? { cookie: cookie.value.trim() } : {}),
      onProgress: (progress) => localDownloadStore.update(localTaskId!, {
        stage: progress.stage,
        completedUnits: progress.completed,
        totalUnits: progress.total,
        detail: progress.detail,
      }),
    });
    if (!await localDownloadStore.complete(localTaskId!, outputPath)) {
      result.value = "任务已取消，已清理本次生成文件。";
      return;
    }
    result.value = `已下载 ${packaged.pageCount} 页 CBZ 到 Obsidian 电子书目录：${packaged.outputPath}`;
    completedTaskId.value = localTaskId!;
    cookie.value = "";
    referer.value = "";
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "漫画章节打包失败";
    if (localTaskId) {
      try { await localDownloadStore.fail(localTaskId, message); }
      catch { error.value = "任务已停止，但临时文件未能清理，请检查 Incoming 目录。"; }
    }
    error.value ||= message;
  } finally {
    running.value = false;
  }
}

function isAbsoluteWindowsPath(value: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\)/.test(value.trim());
}
</script>

<template>
  <section class="page-heading">
    <div>
      <p class="eyebrow">把一章漫画收进书架</p>
      <h2>漫画章节</h2>
      <p class="muted">已有章节图片清单时，在这里生成 CBZ；也可以从作品详情查找已配置来源的章节。Cookie 仅用于本次操作。</p>
    </div>
  </section>

  <section class="card">
    <form class="manga-form" @submit.prevent="packageChapter">
      <label><span>作品名</span><input v-model="title" type="text" placeholder="例如：作品名" required /></label>
      <label><span>章节名</span><input v-model="chapter" type="text" placeholder="例如：第 01 话" required /></label>
      <label class="wide-field"><span>图片地址（每行一个，按阅读顺序）</span><textarea v-model="imageText" rows="10" placeholder="https://example.com/page-001.jpg&#10;https://example.com/page-002.jpg" required></textarea></label>
      <label><span>Referer（可选，仅本次使用）</span><input v-model="referer" type="url" placeholder="https://example.com/" /></label>
      <label><span>Cookie（可选，仅本次使用）</span><input v-model="cookie" type="password" autocomplete="off" placeholder="不会保存或写入日志" /></label>
      <div class="form-footer"><button class="primary-button" :disabled="running" type="submit">{{ running ? "下载并打包中…" : "下载图片并生成 CBZ" }}</button><span class="muted">{{ imageUrls.length }} 页</span></div>
    </form>
    <p v-if="error" class="error-message">{{ error }}</p>
    <p v-if="result" class="success-message">{{ result }}</p>
    <RouterLink v-if="completedTaskId && localDownloadStore.ownedOutputPath(completedTaskId)" class="primary-button" :to="'/viewer/local/' + encodeURIComponent(completedTaskId)">立即阅读</RouterLink>
    <p class="hint">单页上限 50 MB，章节总上限 500 MB；成功后清理临时图片。已有同名文件不会覆盖，可在下载中心查看进度或请求取消。</p>
  </section>
</template>
