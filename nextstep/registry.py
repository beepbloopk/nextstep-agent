"""Every tool is classified here. The agent asks this table, not the AI, how careful to be.

  read_only    : no side effects                       -> run, no confirmation
  reversible   : changes NextStep's own data, undoable -> run, then tell the user
  irreversible : leaves the system, cannot be undone   -> never run from the loop; propose,
                 show the exact text, wait for the user's yes (outside the AI's reach)

Fail-safe: a tool name that is not in the table is treated as irreversible.
"""
TABLE = {
    "recordAssessment": ("read_only", "none"),
    "askUser": ("read_only", "none"),
    "calculateTime": ("read_only", "none"),
    "searchInformation": ("read_only", "none"),
    "createTask": ("reversible", "notify"),
    "retryFailedTasks": ("reversible", "notify"),
    "updateSituation": ("reversible", "notify"),
    "draftMessage": ("reversible", "notify"),
    "sendMessage": ("irreversible", "exact_preview"),
}


def classify(name: str) -> dict:
    if name in TABLE:
        rev, conf = TABLE[name]
        return {"name": name, "known": True, "reversibility": rev, "confirmation": conf}
    return {"name": name, "known": False, "reversibility": "irreversible", "confirmation": "exact_preview"}
