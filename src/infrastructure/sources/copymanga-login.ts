import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "@/shared/runtime";

interface CopyMangaLoginResponse {
  token: string;
}

export async function loginCopyManga(username: string, password: string): Promise<string> {
  if (!isTauriRuntime()) {
    throw new Error("拷贝漫画账号登录只在桌面版可用");
  }
  const result = await invoke<CopyMangaLoginResponse>("copymanga_login", { username, password });
  if (!result.token?.trim()) throw new Error("拷贝漫画登录没有返回有效 Token");
  return result.token.trim();
}
