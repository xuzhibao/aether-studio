import type { TaskSnapshot } from "../../shared/desktop";

/**
 * A terminal snapshot delivered by tasks:changed may arrive before the tasks:start reply.
 * The reply only describes the just-spawned process, so it must never regress a finished task.
 */
export function mergeTaskSnapshot(existing: TaskSnapshot | undefined, incoming: TaskSnapshot): TaskSnapshot {
  return existing && existing.status !== "running" ? existing : incoming;
}

export function mergeTaskList(tasks: TaskSnapshot[], incoming: TaskSnapshot): TaskSnapshot[] {
  const existing = tasks.find((task) => task.id === incoming.id);
  return [...tasks.filter((task) => task.id !== incoming.id), mergeTaskSnapshot(existing, incoming)];
}
