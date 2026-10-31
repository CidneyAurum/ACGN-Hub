<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { onBeforeRouteLeave, useRoute, useRouter } from "vue-router";
import { useDownloadStore } from "@/stores/download";
import { useLocalDownloadStore } from "@/stores/local-download";
import { loadSettings, SETTINGS_CHANGED_EVENT } from "@/shared/settings";
import { buildViewerSeries, type ViewerSeriesItem } from "@/domain/viewer-series";
import { canAutoContinueReading, parseNovelText } from "@/domain/novel-reader";
import {
  clampComicPage, clampVideoPosition, comicPageWindow, localViewerProgressKey, readLocalViewerProgress,
  resolveLocalViewerTarget, writeLocalViewerProgress, type LocalViewerSession, type LocalViewerTarget,
} from "@/domain/local-viewer";
import {
  closeLocalViewer, localViewerPageUrl, localViewerVideoUrl,
  openLocalViewerWithSystem, prepareLocalViewer,
} from "@/infrastructure/media/local-viewer-service";

const route = useRoute();
const router = useRouter();
const downloadStore = useDownloadStore();
const localStore = useLocalDownloadStore();
const stage = ref<HTMLElement>();
const surface = ref<HTMLElement>();
const video = ref<HTMLVideoElement>();
const textArea = ref<HTMLElement>();
const session = ref<LocalViewerSession>();
const target = ref<LocalViewerTarget>();
const loading = ref(false);
const error = ref("");
const actionError = ref("");
const storageWarning = ref(false);
const openingSystem = ref(false);
const page = ref(0);
const requestedPage = ref(1);
const pageLoaded = ref(false);
const pageError = ref(false);
const pageAttempt = ref(0);
const fit = ref<"width" | "height">("height");
const comicMode = ref<"continuous" | "single">("continuous");
const flowCenter = ref(0);
const flowStates = ref<Record<number, "loaded" | "error" | "loading">>({});
const flowSizes = ref<Record<number, { width: number; height: number }>>({});
const flowAttempts = ref<Record<number, number>>({});
const theme = ref<"dark" | "light">("dark");
const fontSize = ref(19);
const lineHeight = ref(2);
const paper = ref<"cream" | "night" | "sage">("cream");
const readingWidth = ref<"comfortable" | "wide">("comfortable");
const novelChapter = ref("");
const autoContinue = ref(true);
const autoCountdown = ref(0);
const autoCancelled = ref(false);
const readingInteracted = ref(false);
const chapterChanging = ref(false);
const videoError = ref("");
const fullScreen = ref(false);
const settingsRevision = ref(0);
const viewerReady = ref(false);
let generation = 0;
let disposed = false;
let progressKey = "";
let rememberedPosition: number | undefined;
let lastVideoSave = 0;
let textSaveTimer: ReturnType<typeof setTimeout> | undefined;
let prefetched: HTMLImageElement[] = [];
let flowObserver: IntersectionObserver | undefined;
let flowFrame = 0;
let autoTimer: ReturnType<typeof setInterval> | undefined;
let autoCheckTimer: ReturnType<typeof setTimeout> | undefined;
let suppressReadingScrollUntil = 0;
let userReadingInputUntil = 0;
const flowElements = new Map<number, HTMLElement>();

const kindLabel = computed(() => session.value?.kind === "comic" ? "漫画阅读" : session.value?.kind === "text" ? "轻小说阅读" : "本地视频");
const pageCount = computed(() => session.value?.pageCount ?? 0);
const novel = computed(() => parseNovelText(session.value?.kind === "text" ? session.value.text ?? "" : ""));
const series = computed(() => {
  settingsRevision.value;
  try {
    const settings = loadSettings();
    return buildViewerSeries({
      localTasks: localStore.tasks, engineTasks: downloadStore.tasks,
      ownedLocalOutput: (id) => localStore.ownedOutputPath(id),
      configuredRoots: [settings.libraryDirectory, settings.incomingDirectory, settings.downloadDirectory].filter(Boolean),
      current: { collection: route.params.collection, id: route.params.id, file: route.query.file },
    });
  } catch { return { title: "本地观看", items: [] as ViewerSeriesItem[], currentIndex: -1, next: undefined, previous: undefined }; }
});
const flowPages = computed(() => Array.from({ length: pageCount.value }, (_, index) => index));
const flowWindow = computed(() => new Set(comicPageWindow(flowCenter.value, pageCount.value)));
const pageSource = computed(() => session.value?.kind === "comic" ? localViewerPageUrl(session.value.sessionId, page.value) : "");
const videoSource = computed(() => session.value?.kind === "video" ? localViewerVideoUrl(session.value.sessionId) : "");
const imageKey = computed(() => `${session.value?.sessionId}:${page.value}:${pageAttempt.value}`);
// Freeze the identity in the rendered handler: a late old image event must not
// mark a newer page as loaded, even while the route/session is changing.
const pageEvents = computed(() => {
  const key = imageKey.value;
  return { load: () => imageFinished(key, false), error: () => imageFinished(key, true) };
});
const taskFingerprint = computed(() => {
  const id = route.params.id;
  if (route.params.collection === "local") {
    const current = localStore.tasks.find((item) => item.id === id);
    return JSON.stringify(current ? [current.id, current.stage, current.outputPath, current.directory, current.cleanupPaths,
      localStore.ownedOutputPath(current.id), localStore.isRunning(current.id)] : null);
  }
  const current = downloadStore.tasks.find((item) => item.id === id);
  return JSON.stringify(current ? [current.id, current.state, current.directory, current.finalPath, current.files, downloadStore.namingBusy.has(current.id)] : null);
});

function resolveTarget(): LocalViewerTarget {
  const settings = loadSettings();
  if (route.params.collection === "engine" && typeof route.params.id === "string" && downloadStore.namingBusy.has(route.params.id)) {
    throw new Error("正在保存此任务的成品名称，请稍后重新打开。");
  }
  return resolveLocalViewerTarget({
    collection: route.params.collection, id: route.params.id, file: route.query.file,
    localTasks: localStore.tasks, engineTasks: downloadStore.tasks,
    ownedLocalOutput: (id) => localStore.ownedOutputPath(id),
    configuredRoots: [settings.libraryDirectory, settings.incomingDirectory, settings.downloadDirectory].filter(Boolean),
  });
}

function clearPrefetch(): void {
  for (const image of prefetched) { image.onload = null; image.onerror = null; image.removeAttribute("src"); }
  prefetched = [];
}

function prefetchAdjacent(): void {
  clearPrefetch();
  const current = session.value;
  if (current?.kind !== "comic") return;
  // Only the two neighbours are prefetched; an entire CBZ is never decoded at once.
  for (const index of [page.value - 1, page.value + 1]) {
    if (index < 0 || index >= pageCount.value) continue;
    const image = new Image();
    image.decoding = "async";
    image.src = localViewerPageUrl(current.sessionId, index);
    prefetched.push(image);
  }
}

function imageFinished(key: string, failed: boolean): void {
  if (disposed || key !== imageKey.value) return;
  pageLoaded.value = !failed;
  pageError.value = failed;
  if (!failed) { persistPosition(page.value); prefetchAdjacent(); }
}

function cancelAutoContinue(userCancelled = false): void {
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = undefined; autoCountdown.value = 0;
  if (userCancelled) autoCancelled.value = true;
}

function atReadingEnd(): boolean {
  if (session.value?.kind === "comic") {
    if (comicMode.value !== "continuous" || !stage.value || page.value < pageCount.value - 1) return false;
    return stage.value.scrollHeight - stage.value.clientHeight - stage.value.scrollTop <= 18;
  }
  const element = textArea.value;
  return session.value?.kind === "text" && Boolean(element) && element!.scrollHeight - element!.clientHeight - element!.scrollTop <= 18;
}

function readingReadyAtEnd(): boolean {
  if (session.value?.kind === "text") return !loading.value && Boolean(textArea.value);
  const last = pageCount.value - 1;
  const image = flowElements.get(last)?.querySelector("img");
  return flowStates.value[last] === "loaded" && Boolean(image?.complete && image.naturalWidth > 0);
}

function checkAutoContinue(): void {
  const eligible = canAutoContinueReading({
    enabled: autoContinue.value, interacted: readingInteracted.value,
    ready: readingReadyAtEnd(), atEnd: atReadingEnd(), hasNext: Boolean(series.value.next), cancelled: autoCancelled.value,
  });
  if (!eligible || chapterChanging.value || document.visibilityState === "hidden") { cancelAutoContinue(); return; }
  if (Date.now() < suppressReadingScrollUntil) {
    cancelAutoContinue();
    if (!autoCheckTimer) {
      const id = session.value?.sessionId;
      autoCheckTimer = setTimeout(() => {
        autoCheckTimer = undefined;
        if (!disposed && session.value?.sessionId === id) checkAutoContinue();
      }, suppressReadingScrollUntil - Date.now() + 20);
    }
    return;
  }
  if (autoTimer) return;
  const id = session.value?.sessionId;
  autoCountdown.value = 3;
  autoTimer = setInterval(() => {
    if (session.value?.sessionId !== id || !atReadingEnd() || !readingReadyAtEnd() || !autoContinue.value || !series.value.next || autoCancelled.value || document.visibilityState === "hidden") { cancelAutoContinue(); return; }
    autoCountdown.value--;
    if (autoCountdown.value <= 0) { cancelAutoContinue(); void navigateUnit(series.value.next); }
  }, 1000);
}

function readingInput(): void { userReadingInputUntil = Date.now() + 1800; }

async function navigateUnit(item?: ViewerSeriesItem): Promise<void> {
  if (!item || chapterChanging.value) return;
  // Rebuild from current stores so a removed or reassigned output cannot be used.
  const latest = series.value.items.find((candidate) => candidate.collection === item.collection && candidate.id === item.id && candidate.path === item.path);
  if (!latest) { actionError.value = "此章节已不在当前作品的已完成下载中，请刷新下载记录。"; return; }
  chapterChanging.value = true; cancelAutoContinue(); savePosition();
  try { await router.push(latest.route); }
  catch (cause) { actionError.value = cause instanceof Error ? cause.message : String(cause); }
  finally { chapterChanging.value = false; }
}

function selectUnit(event: Event): void {
  const index = Number((event.target as HTMLSelectElement).value);
  if (Number.isSafeInteger(index)) void navigateUnit(series.value.items[index]);
}

function toggleAutoContinue(): void {
  autoContinue.value = !autoContinue.value;
  autoCancelled.value = false; cancelAutoContinue();
  try { localStorage.setItem("acgn-hub.viewer-auto-continue.v1", JSON.stringify(autoContinue.value)); } catch { /* No effect on reading. */ }
  if (autoContinue.value) checkAutoContinue();
}

function nextComicPage(): void {
  readingInteracted.value = true;
  if (page.value >= pageCount.value - 1 && (comicMode.value === "continuous" ? readingReadyAtEnd() : pageLoaded.value) && series.value.next) void navigateUnit(series.value.next);
  else changePage(page.value + 1);
}

function saveNovelPreferences(): void {
  try { localStorage.setItem("acgn-hub.novel-reader.v1", JSON.stringify({ fontSize: fontSize.value, lineHeight: lineHeight.value, paper: paper.value, width: readingWidth.value })); } catch { /* No effect on reading. */ }
}

function jumpNovelChapter(): void {
  const current = textArea.value;
  const heading = current?.querySelector<HTMLElement>(`[id="${novelChapter.value}"]`);
  if (!current || !heading) return;
  readingInteracted.value = true; cancelAutoContinue();
  current.scrollTop += heading.getBoundingClientRect().top - current.getBoundingClientRect().top - 25;
}

function updateNovelChapter(): void {
  const current = textArea.value;
  if (!current || !novel.value.chapters.length) return;
  const marker = current.getBoundingClientRect().top + 75;
  let selected = novel.value.chapters[0].id;
  for (const chapter of novel.value.chapters) {
    const heading = current.querySelector<HTMLElement>(`[id="${chapter.id}"]`);
    if (heading && heading.getBoundingClientRect().top <= marker) selected = chapter.id;
    else break;
  }
  novelChapter.value = selected;
}

function flowPageElement(index: number, element: unknown): void {
  const old = flowElements.get(index);
  if (old && old !== element) flowObserver?.unobserve(old);
  if (element instanceof HTMLElement) { flowElements.set(index, element); flowObserver?.observe(element); }
  else flowElements.delete(index);
}

function stopFlow(): void {
  flowObserver?.disconnect(); flowObserver = undefined;
  if (flowFrame) cancelAnimationFrame(flowFrame);
  flowFrame = 0;
  flowElements.clear();
}

function flowStyle(index: number): Record<string, string> {
  const size = flowSizes.value[index];
  return { aspectRatio: size ? `${size.width} / ${size.height}` : "2 / 3", maxWidth: `${size?.width ?? 960}px` };
}

function flowUrl(index: number): string {
  return session.value ? localViewerPageUrl(session.value.sessionId, index) : "";
}

function flowImageEvents(index: number): Record<string, (event: Event) => void> {
  const id = session.value?.sessionId ?? "";
  const attempt = flowAttempts.value[index] ?? 0;
  return {
    load: (event) => { void flowImageFinished(event, index, id, attempt, false); },
    error: (event) => { void flowImageFinished(event, index, id, attempt, true); },
  };
}

function updateFlowPosition(): void {
  if (disposed || comicMode.value !== "continuous" || session.value?.kind !== "comic" || !stage.value) return;
  const bounds = stage.value.getBoundingClientRect();
  const marker = bounds.top + Math.min(bounds.height * 0.3, 160);
  let closest = page.value;
  let distance = Infinity;
  for (const [index, element] of flowElements) {
    const box = element.getBoundingClientRect();
    const nextDistance = marker < box.top ? box.top - marker : marker > box.bottom ? marker - box.bottom : 0;
    if (nextDistance < distance) { closest = index; distance = nextDistance; }
  }
  flowCenter.value = closest;
  page.value = closest; requestedPage.value = closest + 1;
  const image = flowElements.get(closest)?.querySelector("img");
  if (image?.complete && image.naturalWidth > 0 && flowStates.value[closest] === "loaded") persistPosition(closest);
}

function flowScrolled(): void {
  if (flowFrame || comicMode.value !== "continuous") return;
  flowFrame = requestAnimationFrame(() => {
    flowFrame = 0; updateFlowPosition();
    // A real scroll during restoration suppression still counts as reading.
    // Suppression delays continuation, never discards the user's interaction.
    if (Date.now() < userReadingInputUntil) readingInteracted.value = true;
    checkAutoContinue();
  });
}

async function scrollFlowTo(index: number): Promise<void> {
  const id = session.value?.sessionId;
  const request = generation;
  flowCenter.value = index;
  await nextTick();
  if (disposed || request !== generation || id !== session.value?.sessionId || comicMode.value !== "continuous") return;
  const currentStage = stage.value;
  const element = flowElements.get(index);
  if (!currentStage || !element) return;
  currentStage.scrollTop += element.getBoundingClientRect().top - currentStage.getBoundingClientRect().top - 10;
  updateFlowPosition();
  checkAutoContinue();
}

async function startFlow(index = page.value): Promise<void> {
  const id = session.value?.sessionId;
  const request = generation;
  stopFlow();
  await nextTick();
  if (disposed || request !== generation || id !== session.value?.sessionId || comicMode.value !== "continuous" || session.value?.kind !== "comic" || !stage.value) return;
  // Vue refs may not fire again when switching observers without remounting.
  stage.value.querySelectorAll<HTMLElement>("[data-page-index]").forEach((element) => flowElements.set(Number(element.dataset.pageIndex), element));
  if (typeof IntersectionObserver !== "undefined") {
    flowObserver = new IntersectionObserver(() => { flowScrolled(); }, { root: stage.value, rootMargin: "100% 0px", threshold: [0, 0.01, 0.5, 1] });
    for (const element of flowElements.values()) flowObserver.observe(element);
  }
  await scrollFlowTo(index);
}

async function flowImageFinished(event: Event, index: number, id: string, attempt: number, failed: boolean): Promise<void> {
  const image = event.currentTarget as HTMLImageElement;
  if (disposed || session.value?.sessionId !== id || image.dataset.viewerSession !== id
    || (flowAttempts.value[index] ?? 0) !== attempt || comicMode.value !== "continuous" || !flowWindow.value.has(index)) return;
  const anchor = flowElements.get(page.value);
  const before = anchor?.getBoundingClientRect().top;
  flowStates.value[index] = failed ? "error" : "loaded";
  if (!failed && image.naturalWidth > 0 && image.naturalHeight > 0) flowSizes.value[index] = { width: image.naturalWidth, height: image.naturalHeight };
  await nextTick();
  if (session.value?.sessionId !== id) return;
  if (before !== undefined && anchor && stage.value) stage.value.scrollTop += anchor.getBoundingClientRect().top - before;
  updateFlowPosition();
}

function retryFlowPage(index: number): void {
  flowStates.value[index] = "loading";
  flowAttempts.value[index] = (flowAttempts.value[index] ?? 0) + 1;
}

async function changeComicMode(mode: "continuous" | "single"): Promise<void> {
  if (comicMode.value === mode) return;
  const current = page.value;
  savePosition(); clearPrefetch(); stopFlow();
  comicMode.value = mode; pageLoaded.value = false; pageError.value = false; pageAttempt.value++;
  try { localStorage.setItem("acgn-hub.viewer-comic-mode.v1", mode); } catch { /* Viewing remains available when preferences cannot be saved. */ }
  if (mode === "continuous") await startFlow(current);
  else { await nextTick(); if (stage.value) stage.value.scrollTop = 0; }
}

function persistPosition(value: number): void {
  if (!progressKey) return;
  try { if (!writeLocalViewerProgress(localStorage, progressKey, value)) storageWarning.value = true; }
  catch { storageWarning.value = true; }
}

function savePosition(): void {
  if (session.value?.kind === "comic") {
    if (comicMode.value === "continuous") updateFlowPosition();
    else if (pageLoaded.value) persistPosition(page.value);
  }
  else if (session.value?.kind === "video") {
    const current = video.value;
    if (current && current.dataset.viewerSession === session.value.sessionId && current.readyState >= 1 && Number.isFinite(current.currentTime)) persistPosition(current.currentTime);
  } else if (session.value?.kind === "text" && textArea.value) {
    const current = textArea.value;
    if (current.dataset.viewerSession !== session.value.sessionId) return;
    const maximum = current.scrollHeight - current.clientHeight;
    persistPosition(maximum > 0 ? Math.min(1, Math.max(0, current.scrollTop / maximum)) : 0);
  }
}

function resetStage(): void {
  cancelAutoContinue();
  if (autoCheckTimer) clearTimeout(autoCheckTimer);
  autoCheckTimer = undefined;
  if (textSaveTimer) { clearTimeout(textSaveTimer); textSaveTimer = undefined; }
  clearPrefetch();
  stopFlow();
  const currentVideo = video.value;
  if (currentVideo) { currentVideo.pause(); currentVideo.removeAttribute("src"); currentVideo.load(); }
}

function releaseSession(): void {
  const current = session.value;
  session.value = undefined;
  progressKey = "";
  if (current) void closeLocalViewer(current.sessionId).catch(() => undefined);
}

async function loadViewer(): Promise<void> {
  const request = ++generation;
  savePosition(); resetStage(); releaseSession();
  loading.value = true; error.value = ""; actionError.value = ""; target.value = undefined;
  videoError.value = ""; pageError.value = false; pageLoaded.value = false; pageAttempt.value = 0;
  flowStates.value = {}; flowSizes.value = {}; flowAttempts.value = {};
  readingInteracted.value = false; autoCancelled.value = false; suppressReadingScrollUntil = Date.now() + 1000; userReadingInputUntil = 0;
  rememberedPosition = undefined; lastVideoSave = 0;
  try {
    localStore.initialize();
    if (route.params.collection === "engine") await downloadStore.initialize();
    if (disposed || request !== generation) return;
    const selected = resolveTarget();
    target.value = selected;
    const opened = await prepareLocalViewer(selected);
    if (disposed || request !== generation) { await closeLocalViewer(opened.sessionId).catch(() => undefined); return; }
    // Ownership can change while native preparation is running.
    let latest: LocalViewerTarget;
    try { latest = resolveTarget(); }
    catch (cause) { await closeLocalViewer(opened.sessionId).catch(() => undefined); throw cause; }
    if (latest.path !== selected.path || latest.allowedRoot !== selected.allowedRoot) {
      await closeLocalViewer(opened.sessionId).catch(() => undefined);
      throw new Error("成品位置已更新，请重新打开当前下载记录。");
    }
    progressKey = localViewerProgressKey(selected.path, opened);
    try { rememberedPosition = readLocalViewerProgress(localStorage, progressKey); } catch { rememberedPosition = undefined; }
    page.value = clampComicPage(rememberedPosition ?? 0, opened.pageCount ?? 1);
    requestedPage.value = page.value + 1;
    session.value = opened;
    if (opened.kind === "comic" && comicMode.value === "continuous") {
      loading.value = false;
      flowCenter.value = page.value;
      await startFlow(page.value);
    }
    if (opened.kind === "text") {
      loading.value = false;
      await nextTick();
      if (request === generation && textArea.value) {
        const current = textArea.value;
        current.scrollTop = Math.min(1, Math.max(0, rememberedPosition ?? 0)) * Math.max(0, current.scrollHeight - current.clientHeight);
        novelChapter.value = novel.value.chapters[0]?.id ?? "";
        updateNovelChapter();
      }
    }
  } catch (cause) {
    if (request === generation && !disposed) error.value = cause instanceof Error ? cause.message : String(cause);
  } finally { if (request === generation && !disposed) loading.value = false; }
}

function changePage(value: number): void {
  const next = clampComicPage(value, pageCount.value);
  if (!session.value) return;
  readingInteracted.value = true; cancelAutoContinue();
  if (comicMode.value === "continuous") {
    page.value = next; requestedPage.value = next + 1;
    void scrollFlowTo(next); return;
  }
  if (next === page.value) return;
  clearPrefetch();
  page.value = next; requestedPage.value = next + 1;
  pageError.value = false; pageLoaded.value = false; pageAttempt.value = 0;
  if (stage.value) { stage.value.scrollTop = 0; stage.value.scrollLeft = 0; }
}

function jumpPage(): void {
  if (!Number.isFinite(requestedPage.value)) { requestedPage.value = page.value + 1; return; }
  changePage(requestedPage.value - 1);
  requestedPage.value = page.value + 1;
}

function retryPage(): void { pageError.value = false; pageLoaded.value = false; pageAttempt.value++; }

function handleKey(event: KeyboardEvent): void {
  const element = event.target instanceof Element ? event.target : undefined;
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
    || element?.closest("input,textarea,select,button,a,[contenteditable='true'],video") || session.value?.kind !== "comic") return;
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  if (event.key === "ArrowLeft") changePage(page.value - 1);
  else if (event.key === "ArrowRight") nextComicPage();
  else if (event.key === "Home") changePage(0);
  else changePage(pageCount.value - 1);
}

function videoMetadata(event: Event): void {
  const current = event.currentTarget as HTMLVideoElement;
  if (current !== video.value || session.value?.kind !== "video" || current.dataset.viewerSession !== session.value.sessionId) return;
  videoError.value = "";
  const position = clampVideoPosition(rememberedPosition, current.duration);
  if (position !== undefined) { try { current.currentTime = position; } catch { /* Unseekable containers may reject seeking. */ } }
  rememberedPosition = undefined;
}

function videoFailed(event: Event): void {
  if (event.currentTarget !== video.value || session.value?.kind !== "video" || video.value?.dataset.viewerSession !== session.value.sessionId) return;
  videoError.value = "当前系统的内置视频组件无法读取或解码此文件。HEVC、部分 MKV 或内嵌字幕的兼容性取决于系统；可以使用系统播放器打开。";
}

function videoEnded(event: Event): void {
  savePosition();
  if (event.currentTarget === video.value && video.value?.dataset.viewerSession === session.value?.sessionId && autoContinue.value) void navigateUnit(series.value.next);
}

function videoProgress(event: Event): void {
  if (event.currentTarget !== video.value || video.value?.dataset.viewerSession !== session.value?.sessionId) return;
  if (Date.now() - lastVideoSave < 3000) return;
  lastVideoSave = Date.now(); savePosition();
}

function textScrolled(event: Event): void {
  if (event.currentTarget !== textArea.value || textArea.value?.dataset.viewerSession !== session.value?.sessionId) return;
  if (textSaveTimer) clearTimeout(textSaveTimer);
  if (Date.now() < userReadingInputUntil) readingInteracted.value = true;
  textSaveTimer = setTimeout(() => { textSaveTimer = undefined; savePosition(); updateNovelChapter(); checkAutoContinue(); }, 300);
}

async function openSystem(): Promise<void> {
  if (openingSystem.value) return;
  openingSystem.value = true; actionError.value = "";
  try { await openLocalViewerWithSystem(resolveTarget()); }
  catch (cause) { actionError.value = cause instanceof Error ? cause.message : String(cause); }
  finally { openingSystem.value = false; }
}

async function toggleFullScreen(): Promise<void> {
  actionError.value = "";
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (surface.value) { await surface.value.requestFullscreen(); stage.value?.focus({ preventScroll: true }); }
    if (comicMode.value === "continuous") await scrollFlowTo(page.value);
  } catch { actionError.value = "当前窗口无法进入全屏，可以尝试最大化窗口。"; }
}

function fullscreenChanged(): void { fullScreen.value = document.fullscreenElement === surface.value; if (comicMode.value === "continuous") void scrollFlowTo(page.value); }
function settingsChanged(): void { settingsRevision.value++; }
function visibilityChanged(): void { if (document.visibilityState === "hidden") { savePosition(); cancelAutoContinue(); } }
function pageLeaving(): void { stopViewer(); }
function pageReturned(event: PageTransitionEvent): void {
  if (event.persisted && viewerReady.value && !disposed) void loadViewer();
}

function stopViewer(): void {
  generation++; savePosition(); resetStage(); releaseSession();
  if (surface.value && document.fullscreenElement === surface.value) void document.exitFullscreen().catch(() => undefined);
}

watch([() => route.fullPath, taskFingerprint, settingsRevision, viewerReady], () => {
  if (viewerReady.value && !disposed) void loadViewer();
}, { flush: "post" });
watch(fontSize, saveNovelPreferences);

onMounted(async () => {
  window.addEventListener("keydown", handleKey);
  window.addEventListener(SETTINGS_CHANGED_EVENT, settingsChanged);
  window.addEventListener("pagehide", pageLeaving);
  window.addEventListener("pageshow", pageReturned);
  document.addEventListener("visibilitychange", visibilityChanged);
  document.addEventListener("fullscreenchange", fullscreenChanged);
  // Hydrate the task list before enabling its watcher, so a direct viewer URL
  // does not open two native sessions when [] becomes the saved task list.
  loading.value = true;
  try { comicMode.value = localStorage.getItem("acgn-hub.viewer-comic-mode.v1") === "single" ? "single" : "continuous"; } catch { comicMode.value = "continuous"; }
  try {
    autoContinue.value = localStorage.getItem("acgn-hub.viewer-auto-continue.v1") !== "false";
    const preferences = JSON.parse(localStorage.getItem("acgn-hub.novel-reader.v1") ?? "{}");
    if (typeof preferences.fontSize === "number" && Number.isFinite(preferences.fontSize)) fontSize.value = Math.min(30, Math.max(14, preferences.fontSize));
    if (typeof preferences.lineHeight === "number" && Number.isFinite(preferences.lineHeight)) lineHeight.value = Math.min(2.6, Math.max(1.5, preferences.lineHeight));
    if (["cream", "night", "sage"].includes(preferences.paper)) paper.value = preferences.paper;
    if (preferences.width === "wide") readingWidth.value = "wide";
  } catch { /* Default reading preferences remain usable. */ }
  localStore.initialize();
  if (route.params.collection === "engine") {
    try { await downloadStore.initialize(); } catch { /* loadViewer reports the store failure. */ }
  }
  await nextTick();
  if (disposed) return;
  viewerReady.value = true;
});
onBeforeRouteLeave(() => { stopViewer(); });
onBeforeUnmount(() => {
  disposed = true; stopViewer();
  window.removeEventListener("keydown", handleKey);
  window.removeEventListener(SETTINGS_CHANGED_EVENT, settingsChanged);
  window.removeEventListener("pagehide", pageLeaving);
  window.removeEventListener("pageshow", pageReturned);
  document.removeEventListener("visibilitychange", visibilityChanged);
  document.removeEventListener("fullscreenchange", fullscreenChanged);
});
</script>

<template>
  <section class="local-viewer">
    <header class="viewer-heading">
      <div><p>YOUR LOCAL STORIES</p><h1>{{ session?.title || target?.title || '打开本地作品' }}</h1><span>{{ session ? kindLabel : '从已完成的下载，继续故事' }}</span></div>
      <div class="viewer-heading-actions"><RouterLink to="/downloads">← 返回下载</RouterLink><button type="button" :disabled="!target || openingSystem || loading" @click="openSystem">{{ openingSystem ? '正在打开…' : '系统程序打开 ↗' }}</button></div>
    </header>
    <p v-if="actionError" class="viewer-notice error" role="alert">{{ actionError }}</p>
    <p v-if="storageWarning" class="viewer-notice">阅读位置暂时无法保存，当前观看不受影响。</p>
    <div v-if="loading" class="viewer-loading" role="status"><span></span><p>正在打开你的本地文件…</p></div>
    <div v-else-if="error" class="viewer-failure" role="alert"><span>◇</span><h2>暂时无法打开</h2><p>{{ error }}</p><div><button type="button" @click="loadViewer">重新尝试</button><RouterLink to="/downloads">回到下载中心</RouterLink></div></div>
    <div v-else-if="session" ref="surface" class="viewer-surface" aria-label="本地阅读器" :class="[theme, 'surface-' + session.kind, 'paper-' + paper]" @wheel.passive="readingInput" @touchmove.passive="readingInput" @pointerdown="readingInput" @keydown="readingInput">
      <div class="viewer-toolbar" aria-label="观看设置">
        <div class="viewer-toolbar-group"><span>{{ kindLabel }}</span><template v-if="session.kind === 'comic'"><button type="button" :class="{ active: comicMode === 'continuous' }" :aria-pressed="comicMode === 'continuous'" @click="changeComicMode('continuous')">连续滚动</button><button type="button" :class="{ active: comicMode === 'single' }" :aria-pressed="comicMode === 'single'" @click="changeComicMode('single')">单页翻页</button><template v-if="comicMode === 'single'"><button type="button" :class="{ active: fit === 'width' }" :aria-pressed="fit === 'width'" @click="fit = 'width'">适合宽度</button><button type="button" :class="{ active: fit === 'height' }" :aria-pressed="fit === 'height'" @click="fit = 'height'">适合高度</button></template></template><template v-else-if="session.kind === 'text'"><button type="button" :disabled="fontSize <= 14" aria-label="缩小字号" @click="fontSize = Math.max(14, fontSize - 1)">A−</button><span class="viewer-font-size">{{ fontSize }}</span><button type="button" :disabled="fontSize >= 30" aria-label="放大字号" @click="fontSize = Math.min(30, fontSize + 1)">A＋</button></template></div>
        <div class="viewer-toolbar-group"><button v-if="session.kind !== 'text'" type="button" :aria-pressed="theme === 'light'" @click="theme = theme === 'dark' ? 'light' : 'dark'">{{ theme === 'dark' ? '浅色舞台' : '深色舞台' }}</button><details v-else class="novel-settings"><summary>阅读设置</summary><div><label>行距<select v-model.number="lineHeight" aria-label="小说行距" @change="saveNovelPreferences"><option :value="1.6">紧凑</option><option :value="2">舒适</option><option :value="2.4">宽松</option></select></label><label>纸色<select v-model="paper" aria-label="小说纸色" @change="saveNovelPreferences"><option value="cream">米白</option><option value="sage">护眼</option><option value="night">夜间</option></select></label><label>阅读宽度<select v-model="readingWidth" aria-label="小说阅读宽度" @change="saveNovelPreferences"><option value="comfortable">舒适</option><option value="wide">宽幅</option></select></label></div></details><button type="button" @click="toggleFullScreen">{{ fullScreen ? '退出全屏' : '全屏观看' }}</button></div>
      </div>
      <nav class="viewer-series-toolbar" aria-label="作品阅读顺序">
        <strong :title="series.title">{{ series.title }}</strong><select :value="series.currentIndex" aria-label="作品章节目录" :disabled="series.items.length < 2 || chapterChanging" @change="selectUnit"><option v-for="(item, index) in series.items" :key="item.collection + ':' + item.id + ':' + item.path" :value="index">{{ item.unitTitle || item.title }}</option></select>
        <button type="button" :disabled="!series.previous || chapterChanging" @click="navigateUnit(series.previous)">上一话 / 卷</button><button type="button" :disabled="!series.next || chapterChanging" @click="navigateUnit(series.next)">下一话 / 卷</button><button type="button" :aria-pressed="autoContinue" @click="toggleAutoContinue">自动接续{{ autoContinue ? '已开启' : '已关闭' }}</button>
      </nav>
      <div v-if="session.kind === 'text'" class="novel-contents"><label for="novel-contents">本卷目录</label><select id="novel-contents" v-model="novelChapter" aria-label="小说章节目录" :disabled="!novel.chapters.length" @change="jumpNovelChapter"><option v-if="!novel.chapters.length" value="">正文（未识别到章节标题）</option><option v-for="chapter in novel.chapters" :key="chapter.id" :value="chapter.id">{{ chapter.title }}</option></select><span>{{ novel.chapters.length ? novel.chapters.length + ' 个章节' : '全文阅读' }}</span></div>
      <div ref="stage" class="viewer-stage" :class="[theme, 'kind-' + session.kind, 'fit-' + fit, 'paper-' + paper, { 'comic-continuous': session.kind === 'comic' && comicMode === 'continuous' }]" :aria-label="kindLabel + '区域'" tabindex="0" @scroll.passive="flowScrolled">
        <template v-if="session.kind === 'comic' && comicMode === 'single'">
          <div v-if="!pageLoaded && !pageError" class="viewer-page-status" role="status">正在读取第 {{ page + 1 }} 页…</div>
          <div v-if="pageError" class="viewer-page-status" role="alert"><p>第 {{ page + 1 }} 页读取失败。文件可能已移动或改变。</p><button type="button" @click="retryPage">重试这一页</button><button type="button" @click="loadViewer">重新打开文件</button></div>
          <img v-show="!pageError" :key="imageKey" class="viewer-comic-page" :class="{ pending: !pageLoaded }" :src="pageSource" :alt="session.title + '，第 ' + (page + 1) + ' 页'" decoding="async" draggable="false" v-on="pageEvents" />
          <button v-if="fullScreen" class="viewer-float-page previous" type="button" aria-label="全屏上一页" :disabled="page <= 0" @click="changePage(page - 1)">‹</button><button v-if="fullScreen" class="viewer-float-page next" type="button" aria-label="全屏下一页" :disabled="page >= pageCount - 1 && !series.next" @click="nextComicPage">›</button>
        </template>
        <div v-else-if="session.kind === 'comic'" class="viewer-page-flow" aria-label="连续漫画页">
          <section v-for="index in flowPages" :key="session.sessionId + ':' + index" :ref="(element) => flowPageElement(index, element)" class="viewer-flow-page" :data-page-index="index" :style="flowStyle(index)" :aria-label="'第 ' + (index + 1) + ' 页'">
            <template v-if="flowWindow.has(index)">
              <img v-if="flowStates[index] !== 'error'" :key="session.sessionId + ':' + index + ':' + (flowAttempts[index] ?? 0)" :data-viewer-session="session.sessionId" :src="flowUrl(index)" :alt="session.title + '，第 ' + (index + 1) + ' 页'" decoding="async" draggable="false" v-on="flowImageEvents(index)" />
              <div v-if="flowStates[index] === 'error'" class="viewer-flow-message" role="alert"><p>第 {{ index + 1 }} 页读取失败</p><button type="button" @click="retryFlowPage(index)">重试这一页</button></div>
              <span v-else-if="flowStates[index] !== 'loaded'" class="viewer-flow-message" role="status">正在读取第 {{ index + 1 }} 页…</span>
            </template>
            <span v-else class="viewer-flow-message">第 {{ index + 1 }} 页</span>
          </section>
        </div>
        <template v-else-if="session.kind === 'video'">
          <video :key="session.sessionId" ref="video" :data-viewer-session="session.sessionId" :src="videoSource" controls preload="metadata" playsinline @loadedmetadata="videoMetadata" @error="videoFailed" @timeupdate="videoProgress" @pause="savePosition" @ended="videoEnded">当前环境不支持内置视频播放。</video>
          <div v-if="videoError" class="viewer-video-error" role="alert"><p>{{ videoError }}</p><button type="button" :disabled="openingSystem" @click="openSystem">使用系统播放器</button><button type="button" @click="loadViewer">重新读取</button></div>
        </template>
        <article v-else :key="session.sessionId" ref="textArea" :data-viewer-session="session.sessionId" class="viewer-text-scroll" :class="['novel-width-' + readingWidth]" :style="{ fontSize: fontSize + 'px', lineHeight }" tabindex="0" aria-label="小说正文" @scroll.passive="textScrolled"><div class="novel-body"><template v-for="block in novel.blocks" :key="block.id"><h2 v-if="block.heading" :id="block.id">{{ block.text }}</h2><p v-else :id="block.id">{{ block.text }}</p></template></div></article>
      </div>
      <footer v-if="session.kind === 'comic'" class="viewer-pagination">
        <button type="button" :disabled="page <= 0" @click="changePage(page - 1)">← 上一页</button>
        <form @submit.prevent="jumpPage"><label for="viewer-page">页码</label><input id="viewer-page" v-model.number="requestedPage" type="number" min="1" :max="pageCount" inputmode="numeric" aria-label="跳转页码" /><span>/ {{ pageCount }}</span><button type="submit">跳转</button></form>
        <button type="button" :disabled="page >= pageCount - 1 && !series.next" @click="nextComicPage">{{ page >= pageCount - 1 && series.next ? '下一话 →' : '下一页 →' }}</button>
      </footer>
      <div v-if="autoCountdown" class="viewer-auto-next" role="status"><span>{{ autoCountdown }} 秒后继续：{{ series.next?.unitTitle || series.next?.title }}</span><button type="button" @click="cancelAutoContinue(true)">取消本次接续</button><button type="button" @click="navigateUnit(series.next)">立即继续</button></div>
      <p v-else-if="!series.next" class="viewer-series-end">已到最后一话 / 卷已下载内容</p>
      <p class="viewer-footnote">{{ session.kind === 'comic' ? comicMode === 'continuous' ? '向下滚动连续阅读 · 页码可直接跳转 · 自动记住已读位置' : '← → 翻页 · Home / End 首尾页 · 自动记住已读页码' : session.kind === 'video' ? '使用视频控件播放、调节音量或全屏 · 自动记住播放位置' : '滚动阅读 · 自动记住阅读位置' }}</p>
    </div>
  </section>
</template>

<style scoped>
.local-viewer{max-width:1250px;margin:0 auto}.viewer-heading{display:flex;align-items:center;justify-content:space-between;gap:25px;margin:0 0 24px}.viewer-heading p{font-size:10px;letter-spacing:1.8px;color:#a28bb4;margin:0 0 10px}.viewer-heading h1{font-size:23px;color:#51405f;line-height:1.5;margin:0 0 8px;overflow-wrap:anywhere;max-width:760px}.viewer-heading>div>span{font-size:12px;color:#a18bad}.viewer-heading-actions{display:flex;gap:12px;align-items:center;flex-wrap:wrap;justify-content:flex-end;flex-shrink:0}.viewer-heading-actions a{font-size:12px;color:#9272a5;text-decoration:none;white-space:nowrap}.local-viewer button{font:inherit;font-size:12px;cursor:pointer;border:1px solid #e3d8ec;background:#fff;color:#8b6e9f;padding:9px 12px;border-radius:7px;white-space:nowrap}.local-viewer button:hover:not(:disabled){border-color:#bba4cf;background:#f8f2fc}.local-viewer button:disabled{opacity:.4;cursor:default}.local-viewer button:focus-visible,.local-viewer a:focus-visible,.viewer-stage:focus-visible{outline:2px solid #a88cc6;outline-offset:3px}.viewer-notice{color:#a08364;font-size:12px;line-height:1.8;padding:11px 14px;border:1px solid #ecddc8;border-radius:8px;background:#fffaef}.viewer-notice.error{color:#af6a83;border-color:#ecd9e2;background:#fff5f8}.viewer-loading,.viewer-failure{min-height:400px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;color:#a087b1;gap:15px;font-size:13px}.viewer-loading>span{width:27px;height:27px;border:2px solid #e6dcf0;border-top-color:#a78ac3;border-radius:50%;animation:viewer-spin 1s linear infinite}.viewer-failure>span{font-size:35px;color:#bda5d0}.viewer-failure h2{font-size:19px;margin:0;color:#806192}.viewer-failure p{max-width:600px;line-height:1.8;margin:0}.viewer-failure>div{display:flex;gap:20px;align-items:center;margin-top:10px}.viewer-failure a{font-size:12px;text-decoration:none;color:#a185b0}.viewer-toolbar{display:flex;justify-content:space-between;gap:16px;padding:12px 15px;background:#fff;border:1px solid #e9e0ef;border-bottom:0;border-radius:12px 12px 0 0}.viewer-toolbar-group{display:flex;align-items:center;gap:8px}.viewer-toolbar-group>span{font-size:11px;color:#ab96b7;margin-right:9px;white-space:nowrap}.viewer-toolbar-group>.viewer-font-size{margin:0;font-variant-numeric:tabular-nums}.viewer-toolbar button{padding:7px 10px;font-size:11px;border-color:transparent;background:#faf7fc}.viewer-toolbar button.active{color:#7c5997;border-color:#d9c7e8;background:#f1e9f8}.viewer-stage{position:relative;min-height:430px;height:calc(100vh - 340px);max-height:1100px;overflow:auto;border:1px solid #e5dbed;border-radius:0 0 12px 12px;outline:0;background:#24202b;color:#d5c9df;overscroll-behavior:contain;scrollbar-color:#63556f #24202b}.viewer-stage.light{background:#e9e4ed;color:#6c5b78;scrollbar-color:#baafc2 #e9e4ed}.viewer-stage.kind-comic{display:flex;align-items:flex-start;justify-content:center;isolation:isolate}.viewer-comic-page{display:block;flex-shrink:0;object-fit:contain;margin:0 auto}.viewer-comic-page.pending{opacity:0}.fit-height .viewer-comic-page{height:100%;width:auto;max-width:100%;object-fit:contain}.fit-width .viewer-comic-page{width:100%;height:auto}.viewer-page-status{position:absolute;inset:0;display:flex;gap:13px;align-items:center;justify-content:center;flex-wrap:wrap;align-content:center;font-size:13px;padding:25px;text-align:center;z-index:1}.viewer-page-status p{width:100%;line-height:1.8;margin:0 0 5px}.viewer-page-status button,.viewer-video-error button{background:#39303f;color:#e0cfe9;border-color:#675270}.viewer-stage.light .viewer-page-status button{background:#fff;color:#8b6e9f;border-color:#d5c2e1}.viewer-stage.kind-video{display:flex;flex-direction:column;align-items:center;justify-content:center;background:#151218;min-height:400px}.viewer-stage video{display:block;width:100%;height:100%;max-height:100%;min-height:0;background:#000;object-fit:contain;flex:1}.viewer-video-error{padding:20px 30px;text-align:center;font-size:12px;line-height:1.8;color:#e0cfe9;max-width:760px}.viewer-video-error p{margin:0 0 13px}.viewer-video-error button+button{margin-left:10px}.viewer-stage.kind-text{overflow:hidden}.viewer-text-scroll{height:100%;overflow:auto;box-sizing:border-box;overscroll-behavior:contain;outline:0;padding:32px clamp(22px,6vw,90px);line-height:2;font-family:"Microsoft YaHei","Noto Sans SC",sans-serif;scrollbar-color:inherit}.viewer-text-scroll pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;margin:0 auto;max-width:880px}.viewer-pagination{display:flex;align-items:center;justify-content:center;gap:25px;margin-top:19px}.viewer-pagination form{display:flex;align-items:center;gap:9px;font-size:12px;color:#9b86aa}.viewer-pagination label{font-size:11px}.viewer-pagination input{width:65px;box-sizing:border-box;padding:8px 4px;text-align:center;border:1px solid #e2d6eb;border-radius:7px;color:#806094;font:inherit;background:#fff}.viewer-pagination button{font-size:11px}.viewer-footnote{font-size:10px;line-height:1.8;text-align:center;color:#b4a2c1;margin:15px 0 0}.viewer-stage:fullscreen{height:100vh;min-height:100vh;max-height:100vh;width:100vw;border:0;border-radius:0}.viewer-stage:fullscreen.fit-height .viewer-comic-page{height:100vh}.viewer-stage:fullscreen .viewer-text-scroll{padding-top:40px;padding-bottom:50px}@keyframes viewer-spin{to{transform:rotate(360deg)}}@media(max-width:1000px){.viewer-heading{align-items:flex-start;flex-direction:column;gap:17px}.viewer-heading-actions{justify-content:flex-start}.viewer-stage{height:calc(100vh - 375px);min-height:380px}.viewer-toolbar-group>span:first-child{display:none}.viewer-heading h1{font-size:21px}}@media(max-width:700px){.viewer-heading h1{font-size:19px}.viewer-toolbar{flex-wrap:wrap;padding:10px;gap:8px}.viewer-toolbar-group{gap:4px}.viewer-toolbar button{font-size:10px;padding:7px 8px}.viewer-pagination{gap:9px;justify-content:space-between;flex-wrap:wrap}.viewer-pagination button{padding:8px;font-size:10px}.viewer-pagination form{gap:5px}.viewer-pagination label{display:none}.viewer-pagination input{width:45px}.viewer-stage{min-height:360px;height:calc(100vh - 390px)}.viewer-text-scroll{padding:23px 19px}.viewer-heading-actions button,.viewer-heading-actions a{font-size:11px}.viewer-footnote{font-size:9px}}
.viewer-surface{border-radius:12px;background:#fff;overflow:hidden}.viewer-surface .viewer-toolbar{flex-shrink:0}.viewer-toolbar-group{flex-wrap:wrap}.viewer-surface .viewer-pagination{flex-shrink:0;margin:0;padding:14px;background:#fff;border:1px solid #e9e0ef;border-top:0}.viewer-surface .viewer-footnote{margin:0;padding:10px;background:#fff}.viewer-surface:fullscreen{width:100vw;height:100vh;display:flex;flex-direction:column;border-radius:0;background:#24202b}.viewer-surface:fullscreen .viewer-toolbar{border-radius:0}.viewer-surface:fullscreen .viewer-stage{flex:1;height:auto;min-height:0;max-height:none;width:auto;border:0;border-radius:0}.viewer-surface:fullscreen .viewer-footnote{display:none}.viewer-surface:fullscreen .viewer-pagination{padding:12px 24px}.viewer-stage.comic-continuous{display:block;padding:12px 18px;box-sizing:border-box;overflow-anchor:none}.viewer-page-flow{width:100%;display:flex;flex-direction:column;gap:14px;align-items:center}.viewer-flow-page{position:relative;width:100%;flex-shrink:0;background:#1b1720;overflow:hidden;box-shadow:0 3px 12px #0002}.light .viewer-flow-page{background:#dcd5e2}.viewer-flow-page img{display:block;width:100%;height:100%;object-fit:contain}.viewer-flow-message{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;color:#b5a1c2;font-size:12px;padding:18px;text-align:center;pointer-events:none}.viewer-flow-message button{pointer-events:auto}.viewer-flow-message p{margin:0}.viewer-float-page{position:fixed;top:50%;transform:translateY(-50%);z-index:3!important;border-color:#ffffff35!important;background:#493853b8!important;color:#fff!important;width:48px;height:70px;padding:0!important;font-size:40px!important;border-radius:12px!important;box-shadow:0 2px 12px #0003}.viewer-float-page.previous{left:15px}.viewer-float-page.next{right:15px}.viewer-float-page:hover:not(:disabled){background:#74558be0!important}.viewer-surface:fullscreen .viewer-text-scroll{padding-top:35px;padding-bottom:40px}@media(max-width:700px){.viewer-surface .viewer-pagination{padding:10px 8px}.viewer-stage.comic-continuous{padding:8px}.viewer-page-flow{gap:9px}.viewer-float-page{width:37px;height:58px}.viewer-float-page.previous{left:7px}.viewer-float-page.next{right:7px}.viewer-toolbar-group{gap:4px}}
.viewer-series-toolbar{display:flex;align-items:center;gap:8px;padding:10px 14px;border:1px solid #e9e0ef;border-top:0;background:#fcf9fe;flex-wrap:wrap}.viewer-series-toolbar strong{font-size:11px;color:#806590;max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-right:auto}.viewer-series-toolbar select,.novel-contents select,.novel-settings select{border:1px solid #e1d5ea;border-radius:6px;background:#fff;color:#806590;font:inherit;font-size:11px;padding:7px 9px;max-width:280px}.viewer-series-toolbar button{font-size:10px;padding:7px 9px}.novel-contents{display:flex;align-items:center;gap:10px;padding:9px 14px;background:#fffdf8;border:1px solid #eee4da;border-top:0;color:#9a866f;font-size:11px}.novel-contents select{max-width:430px;flex:1}.novel-contents span{white-space:nowrap;color:#b19d88}.novel-settings{position:relative;font-size:11px;color:#8b6e9f}.novel-settings summary{cursor:pointer;list-style:none;border:1px solid #e3d8ec;background:#faf7fc;padding:7px 10px;border-radius:7px}.novel-settings summary::-webkit-details-marker{display:none}.novel-settings>div{position:absolute;right:0;top:calc(100% + 6px);z-index:5;background:#fff;border:1px solid #e3d8ec;border-radius:8px;padding:10px;box-shadow:0 8px 20px #37214a20;display:grid;gap:7px;min-width:230px}.novel-settings label{display:flex;align-items:center;justify-content:space-between;gap:10px}.viewer-stage.kind-text.paper-cream{background:#fbf5e9;color:#5f5147}.viewer-stage.kind-text.paper-sage{background:#edf3e8;color:#506252}.viewer-stage.kind-text.paper-night{background:#24202b;color:#d5c9df}.novel-body{max-width:720px;margin:0 auto}.novel-width-wide .novel-body{max-width:980px}.novel-body p{white-space:pre-wrap;overflow-wrap:anywhere;margin:0 0 1.1em}.novel-body h2{font-size:1.18em;line-height:1.6;color:inherit;margin:1.6em 0 .85em;font-weight:650}.viewer-auto-next{display:flex;align-items:center;justify-content:center;gap:9px;flex-wrap:wrap;padding:9px 14px;background:#f8f0fc;border:1px solid #e8d9ef;color:#86649b;font-size:11px}.viewer-auto-next button{font-size:10px;padding:6px 9px}.viewer-series-end{margin:0;padding:8px;text-align:center;font-size:10px;color:#b09eaa;background:#fcf9fd}.viewer-surface:fullscreen .viewer-series-toolbar,.viewer-surface:fullscreen .novel-contents{flex-shrink:0}.viewer-surface:fullscreen .viewer-series-end{display:none}
</style>
