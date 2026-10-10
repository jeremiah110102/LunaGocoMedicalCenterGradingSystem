# Grading Tools (Tracker, Curriculum, Transcript, Duplicates) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a grade submission tracker with reminders, a curriculum that creates a section's classes in one click, a printable transcript per student, and a duplicate-student check with merge.

**Architecture:** Static ES-module pages over the pluggable data layer (`js/firebase-config.js` → Firestore, Google Sheets `Database.gs`, or Supabase `schema.sql`). Pure logic goes in small new modules (testable in Node); pages wire it into the UI. Only Curriculum adds a new collection, so it is the only task that touches the rules on all three databases.

**Tech Stack:** Vanilla JS modules, Bootstrap 5, Firebase Auth; Firestore rules, Google Apps Script, Postgres plpgsql.

**Spec:** Design agreed in chat on 2026-10-08 (no separate spec file): items 1, 2, 4, 8 of the suggestion list. Parts 3 (Paste grades) and 6 (Combined class) are already built in commit `9ba27c2`. Remind is available to admin **and** registrar (option A).

## Global Constraints

- Never push to GitHub; commit locally only and deliver a zip (`git archive` → scratchpad `LunaGocoMedicalCenterGradingSystem-v23.zip`).
- Every rule change goes to all three backends: `firestore.rules`, `google-apps-script/Database.gs` (`canRead`/`canWrite`), `supabase/schema.sql` (`grading.can_read`/`grading.can_write`).
- User-facing text: plain English, sentence case, no jargon (match existing pages).
- Escape every value put in HTML with `escapeHtml` from `js/app.js`.
- Teachers never see the tracker, curriculum, transcript or merge (pages/buttons are admin + registrar).
- Saved grades are never deleted by these features, except the duplicate-merge case defined in Task 5.

## Test Harness (already in this environment)

- `QA=/tmp/claude-0/-home-user-LunaGocoMedicalCenterGradingSystem/381ada5d-8092-5672-b538-062460d3e620/scratchpad/qa` — Playwright page tests against the mock backend (`$QA/lib.js`, `$QA/mock.js`; `L.open(page, { uid, role, patch, options })`). Serve the repo with `python3 -m http.server 8767` (background). Run: `cd $QA && NODE_PATH=$(npm root -g) node <file>.js`.
- Pure-module tests: `node --input-type=module` scripts in `$QA`, importing the module via `data:` URL (see `$QA/names.mjs`).
- Rules: Firebase `/var/tmp/fbtest` (`npx firebase emulators:exec --only firestore --project demo-x "node <file>.mjs"`), Sheets `/var/tmp/gstest` (`node <file>.js`), Supabase `/var/tmp/gspg` (start: `su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /var/tmp/gspg/data -o '-p 5499 -k /var/tmp/gspg' -l /var/tmp/gspg/log start"`, load: `psql -h /var/tmp/gspg -p 5499 -U postgres -f supabase/schema.sql`).

## Review Focus

- A teacher with **no linked login account** pressed in Remind → button disabled with "No account linked" (Task 1 test `remind-unlinked`).
- A section name **without a year number** ("Rizal") or a program with **no curriculum saved** for that level/term → clear message, nothing created (Task 2 test `curriculum-missing`).
- A subject in the curriculum **already assigned** to the section in that term, or a student who already takes it → skipped and listed, never duplicated (Task 2 test `curriculum-skip-existing`).
- Transcript of a student with **INC/DRP only** in a term, or **no grades at all** → GWA "—", no division by zero (Task 3 test `transcript-marks`).
- Merging two records where **both have a grade in the same class** → the kept record's grade stays, the other is reported and removed, nothing silently lost (Task 4 test `merge-conflict`).

---

### Task 1: Grade submission tracker + Remind (Dashboard)

**Files:**
- Create: `js/tracker.js`
- Modify: `js/dashboard.js` (staff view), `pages/dashboard.html` (new panel), `js/users.js` (save link on teacher), `js/teachers.js` (save link when creating an account)
- Test: `$QA/tracker-unit.mjs`, `$QA/tracker-ui.js`

**Interfaces:**
- Produces: `summarizeSubmissions(assignments, grades) -> Array<{ asg, total, entered, missing, inc, drp }>` sorted by `missing` desc, then `asg.teacherName`, then `asg.subjectCode`. `total` = `asg.studentIds.length`; `entered` counts grades of that assignment whose student is still in `studentIds` (numbers, INC and DRP all count as entered); `inc`/`drp` count `remarks === "Incomplete"/"Dropped"` with `finalGrade == null`.
- Produces: `reminderText(asg, missing, deadlineMs|null) -> string` = `"GE 1 · BSC 1A: 4 grades missing, deadline Oct 30, 2026"` (no deadline part when `null`; "1 grade missing" singular).
- Produces: teacher record field `teachers/{id}.userUid` (string, the linked account uid; removed/null when unlinked).
- Consumes: `termOf`, `termDeadline`, `deadlineText` from `js/terms.js`; `getOptions` from `js/app.js`.

- [ ] **Step 1: Write failing unit test** `$QA/tracker-unit.mjs`: 2 assignments (a: 3 students, 1 numeric grade + 1 INC; b: 2 students, 0 grades) → `[{asg:b, missing:2, entered:0}, {asg:a, missing:1, entered:2, inc:1}]`; a grade for a student no longer in `studentIds` is not counted; `reminderText(a,1,null) === "GE 1 · BSC 1A: 1 grade missing"`.
- [ ] **Step 2: Run it** — expect FAIL (module missing).
- [ ] **Step 3: Implement `js/tracker.js`** with the two functions above.
- [ ] **Step 4: Run unit test** — expect all PASS.
- [ ] **Step 5: Save the link on the teacher.** In `js/users.js` save: when role is teacher, also `update teachers/{teacherDocId} { userUid: uid }`, and clear `userUid` on the previously linked teacher if it changed. In `js/teachers.js` account creation, add `{ type: "update", ref: teachers/{t.id}, data: { userUid: uid } }` to the same commit. On the Users page load (admin), back-fill: for each teacher account whose teacher record lacks the matching `userUid`, write it (one batch, only when something differs).
- [ ] **Step 6: Dashboard panel (staff only).** In `pages/dashboard.html` add a full-width panel "Grade submission" with selects `#trackYear`, `#trackTerm` ("All terms" + terms present) and a table `#trackBody` (Teacher, Class, Entered "38 of 42", Missing, INC, action). Load `gradingAssignments` and `grades` where `schoolYear == year`; read `teachers` for `userUid`. Rows with `missing === 0` show "Complete". Remind button: `data-remind="<assignmentId>"`; disabled with title "No account linked" when the teacher has no `userUid`.
- [ ] **Step 7: Remind** writes `notifications` `{ toUid: teacher.userUid, fromUid: me.uid, fromName, type: "grade_reminder", title: "Grades still missing", message: reminderText(...), read: false, createdAt: serverTimestamp() }`; toast "Reminder sent to <teacher>."; button shows "Sent" for the rest of the visit.
- [ ] **Step 8: UI test** `$QA/tracker-ui.js`: registrar sees rows sorted by missing; term filter narrows rows; Remind writes the notification with the exact message; `remind-unlinked`: teacher without `userUid` → button disabled; teacher role sees no panel.
- [ ] **Step 9: Run UI test** — expect PASS; then commit `git commit -m "Add a grade submission tracker with reminders on the Dashboard"`.

### Task 2: Curriculum, then classes in one click

**Files:**
- Create: `js/curriculum.js` (page), `js/curriculum-core.js` (pure), `pages/curriculum.html`
- Modify: `firestore.rules`, `google-apps-script/Database.gs`, `supabase/schema.sql`, `js/app.js` (`PAGE_ROLES.curriculum = ["admin","registrar"]`), the sidebar of all 14 pages (link after Subjects: `curriculum.html`, icon `bi-list-check`, roles `admin registrar`), `vercel.json` (add `curriculum` to the 3 page lists), `js/backup.js` (`DATA_COLLECTIONS` after subjects: `{ name: "curriculum", label: "Curriculum" }`), `js/audit.js` (`AUDIT_LISTS.curriculum = "Curriculum"`, label `program · yearLevel · term`), `js/assignments.js` + `pages/assignments.html` (button "Add from curriculum")
- Test: `$QA/curriculum-unit.mjs`, `$QA/curriculum-ui.js`, rule tests in the three harnesses

**Interfaces:**
- Produces: collection `curriculum/{id}` = `{ program, yearLevel, term, subjectIds: string[], updatedAt }`; one doc per program+yearLevel+term (id = `${program}|${yearLevel}|${term}` slugged: lowercase, non-alphanumerics → `-`).
- Produces: `programOf(sectionName) -> string` = text before the first digit, trimmed of spaces/dashes, uppercased ("BSC 1A" → "BSC", "BSN-1B" → "BSN", "Rizal" → "").
- Produces: `planFromCurriculum({ curriculum, section, term, assignments, sectionStudents }) -> { create: [{ subjectId }], skipped: [{ subjectId, reason }] }` — skip when the section already has that subject in that school year + term (`reason: "already assigned"`); students = attending (`isAttending`) section students minus those who already take the subject that year+term (`subjectTakers(..., term)`).
- Rules (all 3): read when active; write when staff.

- [ ] **Step 1: Unit test** `$QA/curriculum-unit.mjs`: `programOf` cases above; `planFromCurriculum` with one subject already assigned → it lands in `skipped` with "already assigned"; dropped student excluded from `create`'s students.
- [ ] **Step 2: Run** — expect FAIL. **Step 3:** implement `js/curriculum-core.js`. **Step 4:** run — PASS.
- [ ] **Step 5: Rules.** Firestore `match /curriculum/{id} { allow read: if active(); allow write: if isStaff(); }`; Database.gs add `"curriculum"` to the `subjects…gradingAssignments` cases in `canRead`/`canWrite`; schema.sql add `when 'curriculum' then r.active` / `'curriculum'` to the staff-write list. Rule tests: teacher reads (allow), teacher writes (deny), registrar writes (allow) on each backend — run all three, expect PASS, plus the existing suites still PASS.
- [ ] **Step 6: Curriculum page.** Program (free text with datalist from `programOf` of existing sections), Year level, Term selects; subject checklist with search (all `subjects`); Save writes the doc; list of saved curricula (program, level, term, subject count, Edit/Delete).
- [ ] **Step 7: "Add from curriculum" in Grading assignments** (enabled once year, level, section are chosen): modal shows term select, program (prefilled `programOf(section)`, editable), the plan's rows with a teacher search picker each, and the skipped list with reasons. "Create N classes" adds one `gradingAssignments` doc per row that has a teacher (same fields as the normal save, including `term`), then reloads.
- [ ] **Step 8: UI test** `$QA/curriculum-ui.js`: save a curriculum (BSC, 1st Year, 1st Semester: GE 1, GE 2, GE 3); in Grading assignments for BSC 1A pick it → GE 1 shown as skipped "already assigned", GE 2/GE 3 created with the chosen teachers and the section's attending students; `curriculum-missing`: section "Rizal" or no saved curriculum → message "No curriculum saved for … — add it on the Curriculum page", Create disabled.
- [ ] **Step 9: Run** — PASS; commit `git commit -m "Add a curriculum and create a section's classes from it in one click"`.

### Task 3: Transcript / permanent record

**Files:**
- Create: `js/transcript.js`
- Modify: `js/students.js` (row action "Record"), `pages/students.html` (modal `#recordModal`)
- Test: `$QA/transcript-unit.mjs`, `$QA/transcript-ui.js`

**Interfaces:**
- Produces: `buildTranscript(grades) -> { periods: [{ schoolYear, term, subjects: [{ subjectCode, subjectName, units, finalGrade|null, mark: ""|"INC"|"DRP", remarks }], units, gwa|null }], units, gwa|null }` — periods ordered by schoolYear asc then term order (`TERMS`, "" last); GWA = Σ(grade × units) ÷ Σ units over numeric grades only (INC/DRP excluded, as Final grades); cumulative over all periods.
- Produces: `transcriptHtml(student, transcript, school) -> string` printable HTML (letterhead via `letterheadHtml(school)`, signature via `signatureHtml(school)`); final grade column shown when `finalDiffers()` using `toFinal`.
- Consumes: `markCode`, `remarksFor`, `toFinal`, `finalDiffers` from `js/grading-scale.js`; `TERMS`, `termOf` from `js/terms.js`.

- [ ] **Step 1: Unit test:** 2 years × 2 terms of grades → period GWAs and cumulative match hand values (e.g. 1.75×3 + 1.25×3 → 1.50); `transcript-marks`: a term with only INC/DRP → `gwa === null`, cumulative ignores it; no grades → `{ periods: [], gwa: null }`.
- [ ] **Step 2: Run** — FAIL. **Step 3:** implement. **Step 4:** run — PASS.
- [ ] **Step 5: UI.** Students row button "Record" → loads `grades where studentId == id` → modal with `transcriptHtml`; "Print" opens a new window with that HTML and calls `print()`.
- [ ] **Step 6: UI test:** record shows each year/term heading, subjects, term GWA, cumulative GWA; a promoted student shows both school years.
- [ ] **Step 7: Run** — PASS; commit `git commit -m "Add a printable transcript for each student"`.

### Task 4: Duplicate student check + merge

**Files:**
- Create: `js/duplicates.js`
- Modify: `js/students.js` (warn on add, "Find duplicates" + merge modal), `pages/students.html`, `js/students-import.js` (warning badge)
- Test: `$QA/dup-unit.mjs`, `$QA/dup-ui.js`

**Interfaces:**
- Produces: `nameKey(name) -> string` = folded surname + first given name (uses `fold` from `js/name-list.js`): "Dela Peña, Cloui Miles" and "DELA PENA, Cloui M." → same key.
- Produces: `similarStudents(name, students, exceptId) -> student[]` (same `nameKey`).
- Produces: `duplicateGroups(students) -> student[][]` (groups of 2+ by `nameKey`).
- Produces: `planMerge(keep, drop, assignments, grades) -> { ops, moved, conflicts: [{ subjectCode, keptGrade, droppedGrade }] }` — assignments: replace `drop.id` with `keep.id` in `studentIds` (deduplicated); grades of `drop`: if `keep` has a grade in the same assignment → conflict, delete drop's grade; else create `grades/${assignmentId}_${keep.id}` with the same data and `studentId/studentNumber/studentName` of `keep`, delete the old doc; finally delete `students/${drop.id}`.

- [ ] **Step 1: Unit test:** `nameKey` equality above; different first names ≠; `planMerge` moves a grade, replaces ids in assignments, and `merge-conflict` (both graded in a1) → keep's grade stays, one conflict reported, drop's grade deleted.
- [ ] **Step 2: Run** — FAIL. **Step 3:** implement. **Step 4:** run — PASS.
- [ ] **Step 5: Warn on add/edit:** before saving a new student (or a renamed one), if `similarStudents` finds someone → confirm "Possible duplicate: <ID – name (section)>. Save anyway?". Import preview: rows whose name matches an existing student with a different ID get a yellow "Possible duplicate of <ID>" note (not an error; import still allowed).
- [ ] **Step 6: Find duplicates + Merge:** button on Students opens a modal listing `duplicateGroups`; each pair has "Keep this one" radios and "Merge"; confirm dialog lists moved grades and conflicts, then `commitOperations(plan.ops)`; toast summary.
- [ ] **Step 7: UI test:** adding "Bautista, ANA" when "Bautista, Ana" exists → warning dialog; Find duplicates shows the pair; merge moves the dropped record's assignment membership and grade to the kept one and deletes the dropped student.
- [ ] **Step 8: Run** — PASS; commit `git commit -m "Warn about duplicate students and merge duplicates"`.

### Task 5: Docs, regression and delivery

**Files:** Modify `README.md` (sections for each feature).

- [ ] **Step 1:** Add README sections: Grade submission tracker, Curriculum, Transcript, Duplicate students, Combined classes, Paste grades.
- [ ] **Step 2:** Re-run all earlier page tests in `$QA` and the scratchpad root (`dropflow term irreg promote oldyear paste-move xss teacher combo marks termlock approve promote-ui edit-all fg-test final-test opt-test dt-test`) — expect no `PAGE ERROR`; rule suites on all three backends — expect 0 FAIL.
- [ ] **Step 3:** Commit `git commit -m "Document the new tools"`; build `LunaGocoMedicalCenterGradingSystem-v23.zip` with `git archive`; send it with SendUserFile. Do not push.
