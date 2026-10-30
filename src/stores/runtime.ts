import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { initializeSettings, loadSettings, type AppSettings } from "@/shared/settings";
import { isTauriRuntime } from "@/shared/runtime";
import { probeDownloadEngine } from "@/infrastructure/download/create-download-engine";
import { useDownloadStore } from "./download";
import { errorMessage } from "@/application/download-manager";

export const useRuntimeStore = defineStore("runtime", () => {
  const phase = ref<"starting" | "ready" | "failed">("starting");
  const startupError = ref("");
  const engineState = ref<"idle" | "checking" | "ready" | "failed">("idle");
  const engineMessage = ref("");
  const settings = ref<AppSettings>();
  let initializing: Promise<void> | undefined;
  let checking: Promise<void> | undefined;
  const desktop = isTauriRuntime();

  async function initialize(): Promise<void> {
    if (initializing) return initializing;
    phase.value = "starting";
    startupError.value = "";
    initializing = (async () => {
      try {
        settings.value = await initializeSettings();
        phase.value = "ready";
        try { await useDownloadStore().initialize(); }
        catch (cause) { startupError.value = errorMessage(cause); }
        // Each download backend is started only when it is actually requested.
        // Browsing covers, reading a chapter or managing the library does not
        // need an aria2 subprocess. Settings still offers an explicit probe.
      } catch (cause) { startupError.value = errorMessage(cause); phase.value = "failed"; }
    })().finally(() => { initializing = undefined; });
    return initializing;
  }
  async function checkEngine(): Promise<void> {
    if (checking) return checking;
    checking = (async () => {
      engineState.value = "checking";
      engineMessage.value = "正在连接下载引擎";
      try {
        const version = await probeDownloadEngine(loadSettings(), "aria2");
        engineState.value = "ready";
        engineMessage.value = "aria2 " + version;
      } catch (cause) { engineState.value = "failed"; engineMessage.value = errorMessage(cause); }
    })().finally(() => { checking = undefined; });
    return checking;
  }
  function reloadSettings(): void {
    try { settings.value = loadSettings(); }
    catch (cause) { startupError.value = errorMessage(cause); }
  }
  return { phase, startupError, engineState, engineMessage, settings, desktop, initialize, checkEngine, reloadSettings, configured: computed(() => Boolean(settings.value?.incomingDirectory && settings.value?.libraryDirectory)) };
});
