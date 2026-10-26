# Crash-to-guard log

Every incident or revert leaves a guard behind: a check, test, lint rule or gate that would have caught it. Log it here
in the same PR that adds the guard. `test/guards.test.mjs` (run by `npm test`) fails when an entry has no `- Guard:`
line or its link points at a file that does not exist.

Copy the template below into `## Entries`, newest first. Quote anyone's words verbatim and label everything else as
interpretation.

```markdown
### YYYY-MM-DD: <one-line summary>
- Kind: incident | revert | rollback
- Ref: <PR, revert PR, commit or Core note id>
- What broke: <the observable failure>
- Why it got through: <the missing check>
- Guard: [<check or test name>](<repo-relative path to the check, test or rule>)
```

## Entries
