---
name: eng-stack
description: "Check STACK.md before adding a language, framework, package manager or major dependency. Use whenever you would add one."
---

# eng-stack
1. Read `STACK.md`. If what you need is listed, use it.
2. If not, prefer a listed choice. The stack is the suggested set, not a gate: eng does not block other choices. If you still need one, propose a `stack.exceptions` entry in eng.config.yml: `{kind, name, reason}` where reason matches STACK.md "When another language is justified" with a measured fact. {{Approves}} approves.
3. Version floors for the fleet live in eng-standard `standard/modern-stack.yml`. They are advice; the repo's own review checks them.
