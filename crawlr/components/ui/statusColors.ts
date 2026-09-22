import type { QueueStatus } from "@/lib/types";

export const QUEUE_STATUS_COLOR: Record<QueueStatus, string> = {
  pending: "#4b5f57",
  fetching: "#5cff9d",
  done: "#22e8ff",
  skipped: "#ffb020",
  error: "#ff3b5c",
};

export const QUEUE_STATUS_LABEL: Record<QueueStatus, string> = {
  pending: "queued",
  fetching: "fetching",
  done: "done",
  skipped: "skipped",
  error: "blocked",
};
