import { z } from "zod";

export type PluginConfigFieldType = "string" | "url" | "boolean" | "number";

export interface PluginConfigField {
  type: PluginConfigFieldType;
  required: boolean;
  description?: string;
}

export interface PluginManifest {
  apiVersion: 1;
  id: string;
  name: string;
  version: string;
  kind: "source";
  entry: string;
  permissions: {
    domains: string[];
  };
  config: Record<string, PluginConfigField>;
}

export interface PluginRecord {
  manifest: PluginManifest;
  enabled: boolean;
  lastHealth?: { ok: boolean; checkedAt: string; message?: string };
  updatedAt: string;
}

const configFieldSchema = z.object({
  type: z.enum(["string", "url", "boolean", "number"]),
  required: z.boolean().default(false),
  description: z.string().max(200).optional(),
}).strict();

const manifestSchema = z.object({
  apiVersion: z.literal(1),
  id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
  name: z.string().trim().min(1).max(80),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/),
  kind: z.literal("source"),
  entry: z.string().trim().min(1).max(260),
  permissions: z.object({ domains: z.array(z.string().trim().min(1).max(255)).min(1).max(32) }).strict(),
  config: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), configFieldSchema).default({}),
}).strict();

export function validatePluginManifest(input: unknown): PluginManifest {
  const result = manifestSchema.safeParse(input);
  if (!result.success) throw new Error(`插件 Manifest 无效：${result.error.issues[0]?.message ?? "结构错误"}`);
  if (result.data.entry.includes("..") || result.data.entry.includes("\\") || result.data.entry.startsWith("/")) {
    throw new Error("插件 entry 必须是无父目录片段的相对路径");
  }
  const domains = [...new Set(result.data.permissions.domains.map(normalizeDomainPattern))];
  if (domains.length !== result.data.permissions.domains.length || domains.some((domain) => !domain)) {
    throw new Error("插件域名权限包含重复或无效域名");
  }
  return { ...result.data, permissions: { domains } };
}

export function assertPluginUrlAllowed(manifest: PluginManifest, rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("插件请求地址无效");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
    throw new Error("插件只允许不带认证信息的 HTTP/HTTPS 请求");
  }
  const host = normalizeHostname(parsed.hostname);
  if (isPrivateHostname(host)) throw new Error("插件不能请求本机或私有网络");
  if (!manifest.permissions.domains.some((domain) => matchesDomain(host, domain))) {
    throw new Error(`插件未声明域名权限：${host}`);
  }
  return parsed;
}

export function validatePluginConfiguration(manifest: PluginManifest, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("插件配置必须是对象");
  const input = value as Record<string, unknown>;
  for (const [key, field] of Object.entries(manifest.config)) {
    const item = input[key];
    if (item === undefined || item === null || item === "") {
      if (field.required) throw new Error(`插件配置缺少：${key}`);
      continue;
    }
    if (field.type === "string" && typeof item !== "string") throw new Error(`插件配置 ${key} 必须是文本`);
    if (field.type === "url") {
      if (typeof item !== "string") throw new Error(`插件配置 ${key} 必须是 URL`);
      try { new URL(item); } catch { throw new Error(`插件配置 ${key} 不是有效 URL`); }
    }
    if (field.type === "boolean" && typeof item !== "boolean") throw new Error(`插件配置 ${key} 必须是布尔值`);
    if (field.type === "number" && (typeof item !== "number" || !Number.isFinite(item))) throw new Error(`插件配置 ${key} 必须是数字`);
  }
  return input;
}

function normalizeDomainPattern(value: string): string {
  const domain = value.trim().toLowerCase().replace(/^\*\./, "*.").replace(/\.$/, "");
  if (domain.startsWith("*.")) {
    const base = domain.slice(2);
    if (!isValidHostname(base) || isPrivateHostname(base)) throw new Error(`插件域名权限无效：${value}`);
    return `*.${base}`;
  }
  if (!isValidHostname(domain) || isPrivateHostname(domain)) throw new Error(`插件域名权限无效：${value}`);
  return domain;
}

function matchesDomain(host: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const base = pattern.slice(2);
    return host.endsWith(`.${base}`) || host === base;
  }
  return host === pattern;
}

function normalizeHostname(value: string): string {
  return value.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function isValidHostname(value: string): boolean {
  return value.length <= 253 && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(value);
}

function isPrivateHostname(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168);
}
