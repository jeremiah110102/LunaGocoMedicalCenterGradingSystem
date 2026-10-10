# Remove Duplicate Class Enrollments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the registrar remove a student's duplicate grading assignments (same subject, school year and term) from the existing warning on the Grading assignments page, in one click, without ever losing a grade by surprise.

**Architecture:** A new pure module `js/dup-classes.js` decides, per duplicated student, which classes may be kept and which writes that needs (remove the student from the other classes; delete a grade only in the both-graded case, after confirmation). `js/assignments.js` loads the grades of the involved classes, renders the choices inside the existing `#dupWarning` box, confirms, and commits through `commitOperations` (the audited write path). No database rule changes.

**Tech Stack:** Static site, ES modules, Bootstrap 5; Firestore / Google Sheets / Supabase through `js/firebase-config.js`.

**Spec:** the design agreed in chat on 2026-10-09 (bounded change, no separate spec file):
- per duplicated student, list the classes (teacher, section, saved grade or "no grade") with **Keep here** on each allowed class;
- no grade anywhere → any class may be kept; one class graded → only that class may be kept; several graded → **decision A (default, change to B before Task 2 if the user picks B):** any graded class may be kept, the other grades are deleted after a confirmation that names them;
- **Remove all safe duplicates** fixes every student whose fix deletes no grade, in one save;
- every write goes through the audit trail; registrar and admin only.

## Global Constraints

- Never delete a grade except in the both-graded case, and only after a confirmation that names the student, subject, class and the grade being deleted.
- "Same class group" = same `subjectId`, `schoolYear` and `termOf(a)` (as `duplicateEnrollments` in `js/app.js`).
- Writes only through `commitOperations` (chunked, audited); no direct `setDoc`/`updateDoc` calls.
- Copy: plain English, no jargon; the button text is exactly `Keep here` and `Remove all safe duplicates`.
- Don't push; commit locally only.

## Review Focus

1. A student in **three** classes of the same subject: Keep removes them from both others, one write each.
2. A **combined class** (two parts of the same subject in two sections, same teacher): its parts are separate assignments; keeping one part must remove only the duplicated student, not the whole combined class.
3. A **draft** grade (`draft: true`) counts as a saved grade (it must never be deleted silently).
4. Someone edits the class while the warning is open: re-read the involved assignments before committing; if the student is no longer duplicated, show "Already fixed" and write nothing.
5. INC / DRP grades (`finalGrade: null`) count as saved grades.

---

### Task 1: Pure decision module

**Files:**
- Create: `js/dup-classes.js`
- Test: `qa/dup-classes-unit.mjs` (scratchpad QA folder, like `dup-unit.mjs`)

**Interfaces:**
- Consumes: `duplicateEnrollments(assignments)` output from `js/app.js` (`[{ subjectCode, subjectName, schoolYear, term, studentIds, assignments }]`).
- Produces:
  - `studentFixes(dups, grades) → Fix[]` where `Fix = { key: string /* "<subjectId>|<schoolYear>|<term>|<studentId>" */, studentId, subjectCode, schoolYear, term, places: [{ assignment, grade /* grade doc or null */ }], keepable: string[] /* assignment ids */, safe: boolean /* true when keeping any keepable class deletes no grade */ }`
  - `planKeep(fix, keepId) → { ops: [{ type: "update", path: "gradingAssignments/<id>", data: { studentIds } } | { type: "delete", path: "grades/<gradeId>" }], deletedGrades: grade[] }`; throws `Error("not keepable")` when `keepId` isn't in `fix.keepable`.

- [ ] **Step 1: Write the failing tests** (`dup-classes-unit.mjs`, same `eq()` style as `dup-unit.mjs`):
  - no grades, 2 classes → `keepable` = both ids, `safe === true`; `planKeep(fix, "a1")` → one update on `gradingAssignments/a2` whose `studentIds` no longer contains the student, no deletes.
  - grade only in `a2` → `keepable` = `["a2"]`, `safe === true`; `planKeep(fix, "a1")` throws `not keepable`.
  - grades in both (one is `draft: true`, one INC) → `keepable` = both, `safe === false`; `planKeep(fix, "a1")` → update on `a2` + delete `grades/<a2 grade id>`, `deletedGrades.length === 1`.
  - student in three classes, no grades → `planKeep(fix, "a2")` → two updates (a1, a3), nothing else.
  - two duplicated students in the same pair of classes → two `Fix` objects; `planKeep` for one leaves the other student's id in `studentIds`.
- [ ] **Step 2: Run** `node dup-classes-unit.mjs` → FAIL (module not found).
- [ ] **Step 3: Implement** `studentFixes` and `planKeep` in `js/dup-classes.js` (no imports from `firebase-config.js`; grades matched by `assignmentId` + `studentId`).
- [ ] **Step 4: Run** `node dup-classes-unit.mjs` → all PASS.
- [ ] **Step 5: Commit** `js/dup-classes.js` — "Duplicate classes: decide what Keep here removes".

### Task 2: Keep here in the duplicates warning

**Files:**
- Modify: `js/assignments.js` (`renderDuplicates`, the `#dupWarning` click handler, a new `loadDupGrades()` and `keepClass(fixKey, keepId)`), `README.md` (Rules built in → duplicates line)
- Test: `qa/dup-fix-ui.js` (Playwright + mock, like `dup-ui.js`; mock patch with `mock-dup` style data)

**Interfaces:**
- Consumes: `studentFixes`, `planKeep` (Task 1); `commitOperations(ops)` expects `{ type, ref, data? }` → map each `path` to `doc(db, col, id)`.
- Produces: buttons `[data-keep="<assignmentId>"][data-fix="<fix.key>"]` and `#btnFixSafeDups`.

- [ ] **Step 1: Write the failing page test** (registrar `R`):
  - `s1` in `a1` and `x9` (same subject/year/term), no grades → each student line shows two `Keep here` buttons; click Keep on `a1` → confirm dialog names the student and `x9`'s teacher/section → confirm → `__writes` has one update of `gradingAssignments/x9` without `s1`; warning disappears.
  - grade only in `x9` → only one `Keep here` (on `x9`).
  - grades in both → both buttons; confirm text contains the grade that will be deleted (e.g. `2.50`); after confirm `__writes` has the update **and** `grades/<id>` delete.
  - **Remove all safe duplicates** with one safe and one both-graded student → only the safe one is written; the both-graded one is still listed.
  - Review Focus 4: change `x9.studentIds` in `window.__store` before clicking Keep → toast "Already fixed", no writes.
  - teacher account: page not reachable (existing `PAGE_ROLES`), so no extra test.
- [ ] **Step 2: Run** `GS_CSS=1 node dup-fix-ui.js` → FAIL (no Keep buttons).
- [ ] **Step 3: Implement** in `js/assignments.js`: load the involved classes' grades once when the warning opens (`getDocs(query(collection(db,"grades"), where("assignmentId","==",id)))` per involved assignment), render each place as `Teacher, Section — 1.75 / INC / no grade` with `Keep here` where allowed, a one-line note "Both classes have a grade: Keep here deletes the other grade" when `safe` is false; on click re-read the involved assignments with `getDoc`, rebuild the fix, `confirmDialog` (variant `warning`, danger wording when grades are deleted), `commitOperations`, then reload the assignments list.
- [ ] **Step 4: Run** `GS_CSS=1 node dup-fix-ui.js` → ALL PASSED; also `node dup-ui.js` (existing warning test) and `node edit-all.js` unchanged against the pre-change output.
- [ ] **Step 5: Commit** `js/assignments.js`, `README.md` — "Grading assignments: Keep here removes duplicate class enrollments".
