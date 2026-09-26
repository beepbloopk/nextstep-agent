import type { SituationStore } from "../store.ts";
import { currentVersion, type SituationVersion } from "../views.ts";

// updateSituation(): versioned, never overwrites. Each call appends version N+1 with what
// changed and why; every earlier version stays readable in the log. The staleness check for
// confirmed sends compares against these version numbers.

export function updateSituation(
  store: SituationStore,
  sid: string,
  input: { text: string; changes?: string[]; reason?: string; pasted?: string },
  source: SituationVersion["source"],
): { version: number; previousVersion: number; changes: string[] } {
  const previousVersion = currentVersion(store, sid);
  const version = previousVersion + 1;
  const changes = input.changes ?? [];
  store.append(sid, "situation_version", {
    meta: { version, source },
    data: { text: input.text, pasted: input.pasted, changes, reason: input.reason ?? "" },
  });
  return { version, previousVersion, changes };
}
