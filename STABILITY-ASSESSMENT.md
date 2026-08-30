# CityU Course Visualizer - Stability Assessment

**Date**: 2026-08-30
**Auditor**: opencode automated audit

---

## Current State

Functional MVP. Full pipeline works: Banweb fetch (39 subjects) → 2-layer CI validation → GitHub Pages visualizer. Safe for limited use, has gaps for public-facing reliability.

### What Works Well

- 39-subject auto-discovery from Banweb (458 courses / 1372 sections)
- 2-layer CI validation (structural schema + differential comparison)
- `esc()` on all user-facing data fields in visualizer
- localStorage persistence with try/catch (quota, corruption, private browsing)
- Fetcher retry logic (3x with exponential backoff)
- Random delay 1.2-2s per request to avoid rate limiting
- Monthly cron + manual dispatch

---

## Issues

| # | Severity | Area | Finding | Impact |
|---|----------|------|---------|--------|
| 1 | HIGH | data-prep.mjs:169 | `mt.time.split()` crashes if `mt.time` is undefined | One missing time field kills entire monthly build |
| 2 | HIGH | index.html | No staleness indicator; `fetchedAt` exists but never displayed | Users see months-old data with no warning |
| 3 | HIGH | index.html | Full DOM destroy+rebuild on every keystroke/filter change | Jank on mobile/low-end devices |
| 4 | HIGH | index.html | Zero ARIA attributes; sections not keyboard-navigable | Unusable for screen reader users |
| 5 | MEDIUM | index.html:1289-1294 | `statsText` innerHTML from unsanitized localStorage | Stored XSS (requires local machine access) |
| 6 | MEDIUM | workflow | No failure notification if monthly cron fails | Silent data staleness |
| 7 | MEDIUM | index.html | No try/catch around `render()` or `initApp()` | Single bad data field crashes entire UI |
| 8 | MEDIUM | fetcher | No Incapsula/CAPTCHA detection | Silent 0-result if Banweb blocks |
| 9 | MEDIUM | index.html | Double scan of `active` array per day (width calc + render) | Redundant O(n) work |
| 10 | MEDIUM | index.html | `hasSearchMatch()` O(n) per keystroke | Two full scans per keystroke |
| 11 | MEDIUM | index.html | No skip navigation; no focus management on drawer open | Poor keyboard UX |
| 12 | MEDIUM | index.html | Single CSS breakpoint (1000px); no touch optimizations | Limited mobile experience |
| 13 | LOW | index.html:1258,1264-1265 | `data-crn`, `data-exclude-code` attributes not escaped | Mitigated by CRN 5-digit validation in data-prep |
| 14 | LOW | index.html:1637-1643 | `localStorage` restore has no type validation on `focusList`/`excluded` | Corrupted state possible |

---

## Effort Estimates

### Tier 1: Must-Fix (Public Safety) ~2-3 hours

1. **mt.time null check** (`data-prep.mjs:169`): Add `if (!mt.time) continue;` before `.split()`
2. **Staleness banner** (`index.html`): Display `DATA.meta.fetchedAt` in UI; warn if >30 days old
3. **Stats XSS fix** (`index.html:1289-1294`): Apply `esc()` to `focusStrs` and `excluded` values
4. **Render try/catch** (`index.html`): Wrap `render()` body in try/catch with fallback UI

### Tier 2: Should-Fix (Robustness) ~4-6 hours

5. **rAF batching**: Wrap `render()` in `requestAnimationFrame` to prevent jank
6. **Workflow failure notification**: Add IG DM step when cron fails (using existing `send-ig.mjs`)
7. **Fetcher CAPTCHA detection**: Check for Incapsula/challenge pages, abort with clear error
8. **Fetch output validation**: Add basic structural check before writing courses.json

### Tier 3: Nice-to-Have (Inclusivity) ~8-12 hours

9. **ARIA/keyboard nav**: Add `role="grid"`, `tabindex` on sections, `aria-live` for stats
10. **Virtualization**: Only render visible section divs (for 1372+ sections)
11. **Mobile touch**: Swipe handling, responsive font sizes
12. **Reduced-motion**: `@media (prefers-reduced-motion)` for CSS transitions

---

## Verdict

After **Tier 1** fixes (~3 hours), the tool is safe for public student use. Tier 2 makes it robust against operational failures. Tier 3 makes it inclusive.
