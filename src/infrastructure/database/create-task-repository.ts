import type { TaskRepository } from "@/application/ports";
import { createRepository } from "./repository-runtime";
import { SqliteTaskRepository } from "./sqlite-task-repository";
import { LocalStorageTaskRepository } from "./local-storage-task-repository";

export function createTaskRepository(): Promise<TaskRepository> {
  return createRepository<TaskRepository>("tasks", () => new SqliteTaskRepository(), () => new LocalStorageTaskRepository());
}
