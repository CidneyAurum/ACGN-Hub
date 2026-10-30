<script setup lang="ts">
import { onMounted, ref, shallowRef } from "vue";
import { isTauriRuntime } from "@/shared/runtime";
import { detectLegacyStorageImport, previewLegacyStorageImport, importLegacyStorage, type LegacyImportPreview, type LegacyImportResult } from "@/infrastructure/database/legacy-storage-migration";

const visible = ref(false);
const busy = ref("");
const error = ref("");
const preview = shallowRef<LegacyImportPreview>();
const result = shallowRef<LegacyImportResult>();

onMounted(() => {
  if (!isTauriRuntime()) return;
  try { visible.value = detectLegacyStorageImport(); }
  catch { visible.value = true; error.value = "旧版本机记录暂时无法读取，请检查应用存储权限。"; }
});

async function inspect(): Promise<void> {
  busy.value = "preview";
  error.value = "";
  result.value = undefined;
  try { preview.value = await previewLegacyStorageImport(); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : "旧版记录预览失败，原始数据保持不变。"; }
  finally { busy.value = ""; }
}

async function importRecords(): Promise<void> {
  if (!preview.value || busy.value) return;
  busy.value = "import";
  error.value = "";
  try { result.value = await importLegacyStorage(preview.value); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : "导入未完成，本次更改已回滚；原始记录保持不变。"; }
  finally { busy.value = ""; }
}

function reloadRecords(): void { window.location.reload(); }
</script>

<template>
  <aside v-if="visible" class="legacy-import-notice" aria-label="旧版记录导入">
    <div class="legacy-import-heading"><div><h3>{{ result ? '旧版记录已检查' : '发现旧版记录' }}</h3><p>旧版本机存储中有收藏、来源或任务记录。可以先查看数量，再将缺少的记录导入当前资料库。</p></div><button class="ghost-button" :disabled="!!busy" type="button" @click="visible = false">{{ result ? '关闭' : '稍后处理' }}</button></div>
    <p v-if="!preview && !result" class="hint">预览不会改写记录；导入会跳过已有 ID / 链接冲突，并始终保留旧版原文。</p>
    <p v-if="error" class="error-message" role="alert">{{ error }}</p>
    <div v-if="preview || result" class="legacy-preview">
      <div class="legacy-table-wrap"><table><thead><tr><th>记录类型</th><th>有效</th><th>无效</th><th>冲突 / 已存在</th><th>{{ result ? '本次已导入' : '可导入' }}</th></tr></thead><tbody><tr v-for="category in (result ?? preview)!.categories.filter((item) => item.detected > 0)" :key="category.kind"><th>{{ category.label }}</th><td>{{ category.valid }}</td><td>{{ category.invalid }}</td><td>{{ category.conflicts }}</td><td>{{ result ? category.imported : category.importable }}</td></tr></tbody></table></div>
      <p v-if="(result ?? preview)!.pausedTasks" class="hint">{{ (result ?? preview)!.pausedTasks }} 项活动任务{{ result ? '已' : '将' }}暂停导入；确认目录和引擎后再手动继续，不会自动开始下载。</p>
      <template v-for="category in (result ?? preview)!.categories" :key="category.kind"><p v-for="(issue, index) in category.issues" :key="index" class="hint">{{ category.label }}：{{ issue }}</p></template>
      <p v-if="result" class="success-message" role="status">本次导入 {{ result.totalImported }} 条记录。已有资料未覆盖，旧版原文已保留。重新加载后可在对应页面查看。</p>
      <p v-else class="hint">所有新增记录会在一次事务中写入；发生错误时回滚本次写入。格式无效及冲突记录留在原位置。</p>
    </div>
    <div class="form-footer"><button v-if="!result" class="ghost-button" :disabled="!!busy" type="button" @click="inspect">{{ busy === 'preview' ? '正在预览…' : preview ? '重新预览' : '查看导入预览' }}</button><button v-if="preview && !result" class="primary-button" :disabled="!!busy || !preview.totalImportable" type="button" @click="importRecords">{{ busy === 'import' ? '正在安全导入…' : `确认导入 ${preview.totalImportable} 条` }}</button><button v-if="result" class="primary-button" type="button" @click="reloadRecords">重新加载记录</button></div>
  </aside>
</template>

<style scoped>
.legacy-import-notice { margin-bottom: 1.4rem; padding: 1.25rem; background: #f0f8fa; border: 1px solid #c9e1e6; border-radius: 14px; }
.legacy-import-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
.legacy-import-heading h3 { margin-bottom: 0.45rem; font-size: 1rem; color: #225366; }
.legacy-import-heading p { max-width: 760px; color: #607c8b; font-size: 0.82rem; line-height: 1.75; }
.legacy-table-wrap { margin: 1rem 0; overflow-x: auto; border: 1px solid #d6e4ea; border-radius: 9px; }
table { width: 100%; border-collapse: collapse; font-size: 0.78rem; background: #ffffffc9; }
th, td { padding: 0.65rem 0.8rem; text-align: left; white-space: nowrap; border-bottom: 1px solid #e5edf1; }
thead th { font-weight: 600; color: #617b8b; background: #f6fafb; }
tbody tr:last-child > * { border-bottom: 0; }
.legacy-preview > .success-message { margin-top: 0.9rem; line-height: 1.8; }
.form-footer { flex-wrap: wrap; margin-top: 1rem; }
@media (max-width: 650px) { .legacy-import-heading { flex-direction: column; } }
</style>
