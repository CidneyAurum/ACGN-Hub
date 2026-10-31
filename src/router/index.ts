import { createRouter, createWebHashHistory } from "vue-router";
import HomePage from "@/pages/HomePage.vue";

export default createRouter({
  history: createWebHashHistory(),
  scrollBehavior: (_to, _from, savedPosition) => savedPosition ?? { top: 0 },
  routes: [
    { path: "/", component: HomePage },
    { path: "/search", component: () => import("@/pages/SearchPage.vue") },
    { path: "/resources", component: () => import("@/pages/ResourceSearchPage.vue") },
    { path: "/media/:id", component: () => import("@/pages/MediaPage.vue") },
    { path: "/library", component: () => import("@/pages/LibraryPage.vue") },
    { path: "/sources", component: () => import("@/pages/SourcesPage.vue") },
    { path: "/manga", component: () => import("@/pages/MangaPage.vue") },
    { path: "/games", component: () => import("@/pages/GamesPage.vue") },
    { path: "/feeds", component: () => import("@/pages/FeedsPage.vue") },
    { path: "/downloads", component: () => import("@/pages/DownloadsPage.vue") },
    { path: "/viewer/:collection(local|engine)/:id", component: () => import("@/pages/LocalViewerPage.vue") },
    { path: "/organizer", component: () => import("@/pages/OrganizerPage.vue") },
    { path: "/settings", component: () => import("@/pages/SettingsPage.vue") },
    { path: "/:pathMatch(.*)*", component: () => import("@/pages/NotFoundPage.vue") },
  ],
});
