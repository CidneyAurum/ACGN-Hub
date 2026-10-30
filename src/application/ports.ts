import type {
  DownloadOptions,
  DownloadStatus,
  DownloadTarget,
  DownloadTask,
  DownloadEngineSettings,
} from "@/domain/download";

export interface TaskRepository {
  initialize(): Promise<void>;
  list(): Promise<DownloadTask[]>;
  insert(task: DownloadTask): Promise<void>;
  update(task: DownloadTask): Promise<void>;
  remove(id: string): Promise<void>;
  findById(id: string): Promise<DownloadTask | undefined>;
}

export interface DownloadEngine {
  readonly id: string;
  add(target: DownloadTarget, options: DownloadOptions): Promise<string>;
  pause(engineTaskId: string): Promise<void>;
  resume(engineTaskId: string): Promise<void>;
  cancel(engineTaskId: string): Promise<void>;
  status(engineTaskId: string, context?: Pick<DownloadTarget, "protocol">): Promise<DownloadStatus>;
  /** Optional so external engines and existing integrations retain their contract. */
  applySettings?(settings: DownloadEngineSettings, engineTaskIds: string[]): Promise<void>;
}
