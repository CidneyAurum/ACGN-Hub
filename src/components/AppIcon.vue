<script setup lang="ts">
withDefaults(defineProps<{ name: string; size?: number }>(), { size: 20 });
const paths: Record<string, string> = {
  home: "M3 10.5 12 3l9 7.5V21h-6v-7H9v7H3z",
  search: "M21 21l-5-5M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15",
  library: "M4 3h4v18H4zM10 3h4v18h-4zM16 4l3-1 5 17-4 1z",
  feed: "M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16M4 19h.01",
  source: "M8 5H4v14h4M16 5h4v14h-4M9 16l6-8M9 8l6 8",
  download: "M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5",
  organizer: "M3 7h7l2-3h9v16H3zM8 13h8m-3-3 3 3-3 3",
  manga: "M3 4h7l2 2 2-2h7v16h-7l-2 1-2-1H3zM12 6v15M6 8h3m-3 4h3m6-4h3m-3 4h3",
  games: "M6 8h12l3 8-2 3-5-3h-4l-5 3-2-3zM6 11v5m-2-2h5m7-2h.01m2 3h.01",
  settings: "M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1zM15 12a3 3 0 1 0-6 0 3 3 0 0 0 6 0",
  arrow: "M5 12h14m-6-6 6 6-6 6",
  check: "m5 12 4 4L19 6",
  warning: "m12 3 10 18H2zM12 9v5m0 3h.01",
  folder: "M3 6h7l2 3h9v11H3z",
  refresh: "M20 7v5h-5M4 17v-5h5M5 8a8 8 0 0 1 13-4l2 3M4 17l2 3a8 8 0 0 0 13-4",
  plus: "M12 5v14M5 12h14",
};
</script>
<template><svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="paths[name] || paths.folder" /></svg></template>
