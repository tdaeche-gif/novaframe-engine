# Novaframe Engine UI Layout Rules

- Header: Single row (`.panel-header`) for Logo + "Novaframe Engine" + Red X button.
- Active Theme & Labels: High-contrast white `#ffffff` (`font-size: 13px; font-weight: 600`).
- System Toggles: Grouped inside `.system-toggles-group` with 10px row gaps. No `<hr>` dividers between switches.
- Dividers: `.section-divider` (`margin: 12px 0; background: rgba(255, 255, 255, 0.08)`).

---

## Anti-Bloat & Ponytail Guidelines (Lazy Senior Dev Mode)
- **Ruthless Minimalism (YAGNI):** The best code is code never written. Before writing code, climb the Ponytail ladder:
  1. Does this need to be built at all? (Eliminate speculative abstractions, unused configs, dead wrappers).
  2. Does it already exist in this codebase? Reuse existing helpers, utils, and patterns.
  3. Does the standard library already cover this? Use it.
  4. Does an installed dependency or native platform API solve it? Use it.
  5. Can this be a single pure function rather than a class? Keep it flat.
  6. Only then: write the minimum code that works.
- **Zero Phantom Code:** Never write helper functions, classes, models, or configurations without immediate, active callers.
- **Shortest Working Diff:** Deletion over addition. Boring over clever. Fewest files and fewest lines possible while maintaining strict data integrity and error handling.
- **Non-Negotiables:** Never compromise security, input validation at trust boundaries, or error handling that prevents data loss.
