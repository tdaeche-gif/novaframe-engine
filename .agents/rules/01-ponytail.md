---
trigger: always_on
description: Ponytail anti-bloat directives, ruthless minimalism, and YAGNI standards
---

# Ponytail Anti-Bloat & Codebase Minimization Directives
- **Ruthless Minimalism (YAGNI):** The best code is code never written. Before writing any code, climb the ladder:
  1. Does this need to be built at all? (Drop speculative abstractions, configs, and wrappers).
  2. Does it already exist in this codebase? Reuse existing helpers, utils, and patterns.
  3. Does the standard library already cover this? Use it.
  4. Does an installed dependency or native platform API solve it? Use it.
  5. Can this be a single pure function rather than a class? Keep it flat.
  6. Only then: write the minimum code that works.
- **Zero Phantom Code:** Never write helper functions, classes, models, or configurations without immediate, active callers.
- **Shortest Working Diff:** Deletion over addition. Boring over clever. Fewest files and fewest lines possible.
- **Non-Negotiables:** Never compromise security, input validation at trust boundaries, or error handling that prevents data loss.
