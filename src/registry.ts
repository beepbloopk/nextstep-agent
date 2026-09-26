// Every tool the model can call is classified here. The agent loop asks this registry, not the
// model, how much confirmation an action needs.
//
//   read_only    : no side effects                      -> run, no confirmation
//   reversible   : changes our own state, can be undone -> run, then tell the user (notify)
//   irreversible : leaves the system, cannot be undone  -> never run from the loop; propose,
//                  show the exact text, wait for an explicit confirm outside the model's reach
//
// Fail-safe default: a tool name that is not in this table is treated as irreversible.

export type Reversibility = "read_only" | "reversible" | "irreversible";
export type ConfirmationMode = "none" | "notify" | "exact_preview";

export interface ToolClass {
  name: string;
  reversibility: Reversibility;
  confirmation: ConfirmationMode;
  known: boolean;
  undo?: string;
}

const TABLE: Record<string, Omit<ToolClass, "name" | "known">> = {
  recordAssessment: { reversibility: "read_only", confirmation: "none" },
  askUser: { reversibility: "read_only", confirmation: "none" },
  calculateTime: { reversibility: "read_only", confirmation: "none" },
  searchInformation: { reversibility: "read_only", confirmation: "none" },
  createTask: { reversibility: "reversible", confirmation: "notify", undo: "cancelTask(taskId) appends a task_cancelled entry" },
  retryFailedTasks: { reversibility: "reversible", confirmation: "notify", undo: "cancelTask(taskId)" },
  updateSituation: { reversibility: "reversible", confirmation: "notify", undo: "versions are append-only; the previous version is still there" },
  draftMessage: { reversibility: "reversible", confirmation: "notify", undo: "a draft never leaves NextStep; just discard it" },
  sendMessage: { reversibility: "irreversible", confirmation: "exact_preview" },
};

export function classify(name: string): ToolClass {
  const row = TABLE[name];
  if (row) return { name, known: true, ...row };
  return { name, known: false, reversibility: "irreversible", confirmation: "exact_preview" };
}

export function registryTable(): ToolClass[] {
  return Object.keys(TABLE).map(classify);
}
