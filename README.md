# College Grading System

HTML + CSS + Vanilla JS + Bootstrap 5 + Tailwind (CDN) + Firebase Firestore. No backend.
The records can also be kept in a Google Sheet or in **Supabase** (School settings → School database).

## Setup

> **No keys in the code.** The first time the site opens, a **Connect to Firebase** screen asks for
> your Firebase config (paste the snippet from Firebase Console). It's tested and saved on that
> device. Other devices connect with a link from **School settings → Firebase connection**.

1. Create a project at https://console.firebase.google.com and add a **Web app**.
2. Create a **Firestore Database**, then paste `firestore.rules` into its **Rules** tab and click **Publish**.
3. In **Authentication > Sign-in method**, enable **Email/Password**.
4. Keep the web config snippet handy (Firebase Console → Project settings → Your apps → Config).
5. Serve the folder over HTTP (ES modules don't load from `file://`):
   - VS Code: right-click `index.html` → **Open with Live Server**, or
   - `python -m http.server 8000` then open http://localhost:8000
6. Open the site: paste the config on the **Connect to Firebase** screen, then **create the administrator account**.
7. Follow the order: Subjects → Teachers → Sections → Students → Grading Assignments → Enter Grades.

## Collections

| Collection | Key fields |
|---|---|
| subjects | subjectCode, subjectName, units |
| teachers | teacherId, teacherName |
| sections | schoolYear, yearLevel, sectionName |
| students | studentId, studentName, schoolYear, yearLevel, sectionId, sectionName |
| gradingAssignments | teacherDocId, teacherId, teacherName, subjectId, subjectCode, subjectName, units, schoolYear, yearLevel, sectionId, sectionName, studentIds[] |
| grades | assignmentId, studentId (student doc id), studentNumber, studentName, teacher/subject/section copies, finalGrade, remarks |

## Rules built in

- Units must be a number greater than 0 (decimals like 1.5 allowed).
- Subject codes, teacher IDs and student IDs are unique; a section name is unique per school year.
- Duplicate grading assignments (same teacher + subject + school year + section) are rejected with
  "This grading assignment already exists."
- **A student takes a subject only once per school year.** A student can't be in two grading
  assignments for the same subject in the same school year (e.g. the same subject with another
  teacher or in another section): on Grading assignments they're greyed out ("Already takes GE 1
  with …"), saving checks again, the Excel import leaves them out, and moving a student to another
  section doesn't add a subject they still take. Duplicates saved before this check are listed in a
  warning on the Grading assignments page, with each class's saved grade: **Keep here** keeps the
  student in that class and takes them out of the others (only a class with a grade can be kept
  when one has a grade; when several have grades, it asks first, naming each grade it deletes),
  and **Remove all safe duplicates** fixes every student whose grades all have the same value (no
  grade value is lost). **Check for duplicate grades** reads every saved grade and also lists a
  student with two grade records for one subject, school year and term: two records in one class,
  a grade left behind in a class the student was taken out of, or a grade of a deleted grading
  assignment. Keep here then keeps one record (the submitted one, else the newest). Before saving,
  it reads the student's grades again; if a grade was saved meanwhile, nothing is written.
- Final grade: 0–100, up to 2 decimals. Remarks are automatic: 75 and above = Passed, below 75 = Failed.
- One grade per student per assignment. Grade documents use the id `{assignmentId}_{studentDocId}`,
  and existing grades are updated instead of duplicated. The database rules (all three databases)
  only accept a teacher's grade under that id and with its class's subject, units, school year, term
  and section, so a grade can't count twice or with other units in the GWA.
- Renaming a subject, teacher, section or student updates the copies stored in assignments and grades.
- Records in use can't be deleted (e.g. a subject used by an assignment). Deleting an assignment also deletes its grades.

## Importing subjects from Excel

On the Subjects page, click **Import from Excel** and choose a file.

**Simple class list (recommended).** Click *Download the template* in the dialog. It looks like this:

| | | | | | | |
|---|---|---|---|---|---|---|
| **Proctor** | *proctor's name* | | | | | |
| **section** | **year** | **student no** | **student name** | **subject code** | **subject** | **unit** |
| BSC 1A | 1 | 20260001 | Abordo, Christian S. | GE 1 | Understanding the Self | 3 |
| | | | | GE 2 | Reading In Philippine History | 3 |
| | | | | NSTP 1 | National Service Training Program 1 | IRREG |

- One row per subject; add as many subject rows per student as needed. Blank section, year,
  student no or name = same as the row above.
- **year** is the year level (1, 1st, 1st Year, First Year…). The school year is typed in the dialog.
- **student no**: typed in → used as the Student ID. Left blank → the next number after the
  **last student no in the system** (e.g. last is 20250150 → 20250151, 20250152…; same format and
  leading zeros). If a typed number already belongs to another student, or the same number is typed
  for several students, the first keeps it and the others get the next numbers (shown in the preview).
  With no students in the system yet, numbering starts from the school year (20260001).
- The **Proctor** becomes the teacher for the subjects on that sheet.
- **Irregular:** a blank subject or unit, or **IRREG / Irreg / IRREGULAR / Iregular** (any case),
  means the student does not take that subject.
  The import window shows a short guide with an example of tagging an irregular student.

The import creates the subjects, the proctor as a teacher, the section, the students and the grading
assignments, exactly as for grade sheets below.

Other layouts also work:

- **Class grade sheet** (like *BSC 3A*): subjects across the top written as `CODE - Subject name`
  with a UNIT column beside each; the instructor row above is shown for reference.
  `CLJ 2 - Human Rights Education` becomes code **CLJ 2**, name **Human Rights Education**.
- **Simple list:** columns *Subject Code*, *Subject Name*, *Units* (template available in the dialog).

Every sheet is read; a subject repeated across sheets is imported once. Review the preview
(New / Update / Already saved / Error), choose whether existing codes are skipped or updated, then import.

**Sections and teachers are added too.** From a class grade sheet, the import also creates:

- the **section** named in "INSTRUCTOR - BSC 3A" (or the sheet name). You only enter the
  **School Year** and **Year Level** (pre-selected from the name: BSC **3**A → 3rd Year; with several
  sheets each section can have its own year level). Sections already saved for that school year are reused.
- a **teacher** for each instructor, with the next free Teacher ID (T011, T012…). Instructors are
  matched by name without ranks or credentials, so "F02 HANNAH CHELSEA PADUA, Rcrim" and an existing
  "Hannah Chelsea Padua" are the same person, and someone teaching two subjects is added once.

- every **student** listed under NAME, placed in that section with the same school year and year
  level. If the file has no Student ID column, IDs are created from the school year
  (2026-2027 → 20260001, 20260002…, continuing after the highest existing one). Students already
  saved for that school year are matched by name and not added again. The preview shows the
  subjects each student has in the file (e.g. a student taking only FORENSIC 3).

- the **grading assignments**: each subject with its instructor, the section, and only the students
  who have that subject in the file (e.g. GE 2 with just the two students listed for it). If the
  assignment already exists, missing students are added to it.

**Which students take a subject:** a student takes a subject when its block on their row has the
subject or units filled in. They do **not** take it when the subject and unit cells are both blank,
or when the block is tagged **IRREG** (also *Irreg.*, *IRREGULAR*, any letter case) in the subject,
unit, final grade or remarks cell. The preview lists IRREG subjects per student
(e.g. "8 subjects · IRREG: LEA 4"), and those students are left out of that subject's assignment.

Importing the same file again adds nothing new. Untick *Teachers*, *Sections*, *Students* or
*Grading assignments* in the dialog to leave them out.

## Grading assignments (quick entry)

Pick **School year → Year level → Section**, then add the section's subjects one after another:
choose the **Subject** and **Teacher**, check the students (the whole section is ticked to start;
**Find a student** narrows a long list) and **Save**. The section stays selected for the next subject.
Under the section you see what it **already has** (click one to edit it), and the subject list marks
subjects already assigned to it (✓ assigned · teacher). The list of existing assignments can be
filtered by school year, section and teacher.

Long lists (teacher, subject, section, and the teacher linked to a user account) open a **search
pop-up**: type part of a name, code or ID and click it (or press Enter for the first match).
When **editing** a grading assignment, the school year, section, subject and teacher can all change;
saved grades follow (the system asks first, and a new teacher takes over those grades).

## Student status, irregular students and terms

**Status** (Students → Edit, or select students → **Set status**): Regular, Irregular, Dropped,
Transferred out or Graduated, with an optional note ("Dropped on Oct 5"). Students in a grading
assignment can't be deleted, so use the status for a student who leaves; every saved grade is kept.

- **Dropped / Transferred out**: no new grades (Enter grades locks their row; saved grades stay).
  In Final grades their ungraded subjects show "Dropped" (or "Transferred out") instead of
  "Not graded", and the remark is Dropped instead of Incomplete. New grading assignments don't tick them.
- **Graduated**: kept for the record; new grading assignments don't tick them.
- **Irregular**: a label for students who take subjects with other sections.

**Irregular students:** in Grading assignments, under the student list, click
**+ Add a student from another section (irregular)** and search for the student (same school year).
A student who already takes that subject (in the same term) can't be added twice.

**Terms (semesters):** each grading assignment can have a term: 1st Semester, 2nd Semester or
Summer (or none = the whole school year; older assignments have none). Grades keep a copy of it.
A student takes a subject once per term, so a failed subject can be retaken in another term.
Final grades has a **Term** filter: the GWA, report cards, emails and Excel files for one term or
the whole school year. The Excel subject import has a term choice for the assignments it creates.

**INC and DRP (remarks instead of a grade):** in Enter grades, type **INC** (incomplete) or **DRP**
(dropped) in the grade box, or pick it from the small **…** menu beside it (phones show a number
keypad). It's saved as a remark with no number: it isn't counted in the units or the GWA. In Final
grades an INC subject makes the student Incomplete; DRP subjects are left out (a student who dropped
every subject is Dropped). Like any saved grade, a teacher changes an INC later (for example to 2.00)
with **Request change**; the database rules on Firebase, Google Sheets and Supabase accept only
INC/DRP with no number, or a grade on the school's scale.

**Term deadlines** (Setup and options → Term deadlines): set the last day teachers can add grades
for each term (1st Semester, 2nd Semester, Summer). After it, teachers' Enter grades is read-only for
that term's classes; other terms stay open. The registrar and administrators can still enter grades,
and teachers can still send a change request. The database rules check it too.

**Promote to next school year** (Sections → **Promote to next school year**): choose the school
year to promote from; each section's students move to the next year level's section of the next
school year (BSC 1A 2026-2027 → BSC 2A 2027-2028). Missing sections are created; you can pick another
section, "Don't move them", or **Mark as Graduated** (the default for the top 4th/5th Year). Dropped,
transferred out and graduated students stay. Last year's grading assignments and grades are kept.

**End of a semester:** saved grades are already locked for teachers (changes need approval); use
Teacher downtime to stop new entries if needed. Print or email the term's reports from Final grades
(Term: 1st Semester), then create the 2nd Semester grading assignments for the same sections.

**End of the school year:** use **Promote to next school year** on the Sections page (or create
next year's sections and move students with Students → select → Change section). Last year's assignments and grades stay untouched and Final grades still
shows that year in full. Set graduating students to **Graduated** instead of moving them.

## Paste a list of students (masterlist)

Copy the names from the teacher's masterlist (Excel, Word or a message), one student per line, and
click **Paste list**. Capitals, accents (ñ = n), extra spaces, row numbers and a shortened middle
name ("Fonte, Daniella Grace M." = "Fonte, Daniella Grace Mendoza") don't matter; Student IDs work
too. Names that match two students let you choose; names not found are listed in red.

- **Grading assignments → Paste list**: ticks those students for the chosen subject (and, by
  default, unticks students who aren't on the list). For students on the list who are in another
  section, choose: **Change their section** to this one (the masterlist is right; they also move in
  grading assignments, as on the Students page) or **add them to this class only** (irregular).
- **Students → Paste list**: finds those students and, by default, opens **Change section** for
  all of them at once (e.g. paste the BSC 1A masterlist and choose BSC 1A). Choose "Only select
  them" to use **Set status** or another action instead.

## Grade submission tracker (Dashboard)

Administrators and registrars see, for every class of the chosen school year and term, how many
grades are entered ("38 of 42"), how many are missing and how many are INC, most missing first.
**Remind** sends the teacher a notification such as "GE 1 · BSC 1A: 4 grades missing, deadline
Oct 30, 2026" (the deadline comes from Setup and options → Term deadlines). Reminders need the
teacher to have a linked account (Users and roles); the link is kept on the teacher record.

## Curriculum (classes in one click)

On the **Curriculum** page, save each program's subjects once per year level and term (for example
BSC · 1st Year · 1st Semester: GE 1, GE 2, NSTP 1). The program is the part of the section name
before the year (BSC for "BSC 1A"). In **Grading assignments**, choose the school year, level and
section, then **Add from curriculum**: pick the term and a teacher for each subject and click
**Create**. Subjects the section already has that term are skipped; each class gets the section's
attending students (not dropped, transferred out or graduated), minus anyone already taking that
subject that term. With **Promote to next school year**, a new school year is set up in minutes.

## Entering grades (teachers)

- **Your classes** are cards: subject, section, school year and term, "12 of 40 graded" with a
  progress bar, the term deadline ("Due in 2 days", "Closed Oct 1") and Not started / In progress /
  Ready to submit / Complete. The class you opened last opens again; the cursor starts in the first
  empty grade. (Administrators and registrars pick from the class list, as before.)
- **Keys**: Enter or ↓ next student, Shift+Enter or ↑ previous, **Ctrl+S** (⌘S on a Mac) saves.
  Locked rows are skipped; no key changes a grade.
- **Find students**: search by name or student ID, show only No grade yet / Unsaved changes /
  Saved, not submitted / Submitted / Needs fixing, and sort by name, ID, grade or no grade first.
  Grades typed in rows that are hidden or moved stay, and are saved too.
- Each student's **Status** says No grade, Unsaved, Check grade, Saved or Submitted. A wrong grade
  shows what's wrong under its box ("Grade must be between 0 and 100."). The **Save** bar stays at
  the bottom of the screen and says how many changes are unsaved.
- **Draft, then Submit**: **Save grades** keeps the grades as a draft the teacher can still change
  or clear. **Submit grades** makes them final (it asks first, and says who has no grade yet);
  after that a change needs an approved request. Drafts also lock at the term deadline, during
  teacher downtime, and for good when their school year is over (from Aug 1 of the year it ends:
  "2026-2027" → Aug 1, 2027), even if the same term's deadline is set again for a later year.
  Registrars and administrators can correct a draft (their correction is final) or submit a
  class's drafts with **Submit grades**. Grades saved before this version count as submitted.
- **Safe saving**: if a grade was saved from another tab or device, or the registrar changed the
  class (units, students) while you were typing, the others are saved and the page lists what
  wasn't and why. Without internet, or if the database refuses, nothing is lost: the grades stay on
  the page. The browser asks before a refresh or closing the tab loses unsaved grades.

## Paste grades (Enter grades)

Copy two columns from the teacher's Excel class record (name, then final grade) and click **Paste
grades**. Each line is matched to a student of the class (capitals, accents and a shortened middle
name don't matter; INC and DRP work), with a preview of what will be filled, what isn't valid and
which names weren't found. Nothing is saved until **Save grades**; submitted (locked) grades aren't
changed.

## Combined classes

See Setup and options → **Combined classes**. When one teacher has the same subject for two or more
sections in the same school year and term (for example GE 1 for BSPT 1 and BSPH 1), keep one grading
assignment per section; Enter grades then also offers **"(combined)"**: one list with a Section
column. Each grade is saved to the student's own section's class, so records, report cards and Excel
sheets stay per section. Grading assignments shows "Combined with …". Switch it off there if you
don't want it.

## Permanent record (transcript)

Students → **Record**: every school year and term the student has grades in, the term GWA and a
cumulative GWA (INC and DRP listed but not counted), with the school letterhead and the registrar's
signature line. **Print** prints it.

## Duplicate students

Adding a student (or renaming one) whose surname and first name match an existing student asks
first ("Dela Peña, Cloui M." and "DELA PENA, Cloui" are treated as the same name). The Excel import
preview marks possible duplicates. Students → **Find duplicates** lists them; choose the record to
keep and **Merge**: the other record's classes and grades move to it (when both have a grade in the
same class, the kept record's grade stays and the other is removed), then the other record is
deleted. The audit trail records every change.

## Teacher accounts

**Teacher ID:** when adding a teacher, leave Teacher ID blank and the system gives the next number
after the last one in the system (T001, T002, …; the form shows "Next: T003"). If the school uses
another numbered style (for example FAC-0012), it continues that. The Excel subject import numbers
new teachers the same way.

On the Teachers page, each teacher has a **⋯** menu with *Edit*, *Create account* and *Delete*
(the *Account* column shows who already has one). **Create account** (administrators) suggests a
username from the name ("F03 RIO G. ALVEYRA, RCrim" → `ralveyra`), generates a password, creates a
**Teacher** account and links it to that teacher, so they see only their own classes after signing in.
Use **Copy details** to send the username, password and sign-in link to the teacher. A simple list can also carry
optional *Instructor* and *Section* columns.

## Student numbers

The same rule is used everywhere students are added (class list import, grade sheet import,
Students → Import from Excel, and Add student): a typed Student ID is used as is; a blank one gets
the next number after the last student no in the system.

## Importing students from Excel

On the Students page, click **Import from Excel**:

1. Download the template (it also lists your existing sections on a second sheet).
2. Choose a .xlsx, .xls or .csv file. Headers like "ID No.", "Full Name", "SY" and "Yr Level" are recognised.
3. Optionally pick one section to put everyone in (then only Student ID and Student Name are needed),
   and choose whether existing Student IDs are skipped or updated.
4. Check the preview. Rows with errors (missing fields, unknown section, wrong year level,
   duplicate IDs in the file) are listed with the reason and left out. Click **Import**.

Excel files are read in the browser with SheetJS; nothing is uploaded except the student records saved to Firestore.

## Final grades (GWA)

**Grading > Final grades** (Administrator and Registrar) computes each student's
General Weighted Average for a school year from the saved grades:

    GWA = Σ (Final Grade × Units) ÷ Σ Units

Example: IT101 (3 units) = 85, MATH101 (5 units) = 90 → (255 + 450) ÷ 8 = 88.13 → Passed.

- 75.00 and above = Passed; below = Failed (GWA rounded to 2 decimals).
- A student assigned to a subject with no saved grade yet is **Incomplete**; the GWA shown is partial (marked *).
- Filter by year level and section, sort by name, section or highest GWA.
- **View** opens a per-student report (subjects, units, final grades, remarks and the GWA / final grade); **Print report** prints it on **half of an A4 sheet, landscape** (A5 landscape, 210 × 148 mm), one student per sheet.
- **Export to Excel** is a menu:
  - **Grade sheets by year level** (1st Year, 2nd Year…): one file per year level, e.g.
    `Final-Grades-2026-2027-1st-Year.xlsx`, formatted like the school's BSC sheets (BSC 1A/3A):
    Calibri, bold wrapped headers, thin borders, red **SAMPLE** row, same row heights and column
    widths, instructors merged above each subject, subjects in the same order as the imported sheet.
    It has a **Summary** sheet (every student's GWA) and **one sheet per section**: NO., NAME, each
    subject block with UNIT, FINAL GRADE, grade × unit and REMARKS, then Total Grades, Total Units,
    GWA and STATUS (Complete/Incomplete). Blocks are blank for subjects a student doesn't take.
    The cells are live Excel formulas, as in the school's file: grade × unit per subject,
    Total Grades = sum of those, Total Units = sum of the units, GWA = Total Grades ÷ Total Units.
    (A subject without a grade yet counts its units with 0 grade points, as in the school's sheet,
    and the status shows *Incomplete*.) Built with ExcelJS, loaded only when exporting.
  - **All year levels**: one file for each (allow multiple downloads if the browser asks).
  - **Current list only**: the filtered summary plus a per-subject details sheet.
  The exported section sheets can be read back by *Subjects → Import from Excel*.
- **Print report** (one student) or **Print all** (every listed student, one report per page).
- **Email report** / **Email all**: see below.
- Nothing extra is stored: results are computed live, so they always match the latest grades.

## Emailing reports

Students have an optional **Email** field (Students page and the Excel import's Email column).

There are two ways to send, chosen automatically:

1. **Without setup:** **Email report** opens your email app (Gmail, Outlook…) with the
   report written into the message. Review it and click Send there. One student at a time.
2. **With EmailJS (free, no server of your own):** reports are sent directly from the system
   as a formatted email, and **Email all** sends each listed student their own report.

EmailJS setup (about 10 minutes):

1. Create an account at https://www.emailjs.com (free tier: 200 emails/month).
2. **Email Services → Add New Service**, connect your school Gmail or Outlook. Copy the **Service ID**.
3. **Email Templates → Create New Template**:
   - To Email: `{{to_email}}`
   - CC (in the template's settings): `{{cc_email}}`
   - From Name: `{{from_name}}`
   - Subject: `{{subject}}`
   - Content: open the **Code** editor and enter only `{{{message_html}}}` (three braces, so the HTML renders).
   Save and copy the **Template ID**.
4. **Account → General**: copy the **Public Key**.
5. In the system: **School settings → Email sending**, unlock with your password and paste the three values.

Bulk sending waits about a second between emails to respect EmailJS limits, and lists any that failed.

## Class list requests (add, remove or move a student)

A teacher can ask the registrar to change the student list of one of their classes. In Enter
grades, open the class and click **Class list change**:

- Choose what needs to change: **Add a student** (students of the class's school year; one who
  already takes the subject that term is greyed out with the reason), **Remove a student**, or
  **Move to another class** for a student who belongs to another section or teacher (only this
  subject moves). For a move, search the class the student belongs to by section or teacher
  ("2B", "Joseph"); if it isn't listed, choose **Not in the list?**, pick the section and type the
  teacher's name. Tap a ready-made reason or write one; a one-line preview shows exactly what the
  registrar will read before **Add to draft**.
- Each change needs a reason (at least 10 characters) and goes into a **draft** the teacher can
  check and edit (it is saved, so it survives a reload). **Submit request** sends it; **Withdraw**
  is possible until the registrar decides the first line.
- A student with a **submitted** grade can't be removed or moved (record DRP instead). A **draft**
  grade is shown in the line and deleted when the change is approved.
- Students in a pending removal or move are marked in the class list.

The registrar or an admin decides on **Notifications → Class list requests** (teachers with "Can
approve grade changes" don't see these): **Approve** or **Decline** each line (declining needs a
note), or **Approve all**. Approving reads the class again and makes the change at once, through
the audit trail; if the class changed meanwhile (for example the grade was submitted), the line
is marked "could not be made" with the reason and nothing changes. A move to a section that has no
class of the subject yet waits (Approve is off, with a link to Grading assignments) until the
registrar creates that class. When every line is decided,
the teacher gets a notification. The database rules on Firebase, Google Sheets and Supabase let a
teacher write only their own class's request (draft, submit, withdraw) and never the class itself.

## Grade change approval & notifications

Teachers can change their saved grades until they click **Submit grades** (see Entering grades).
After a grade is submitted it's **locked** for them; to change it they click **Request change** on
the Enter grades page, enter the new grade and a **reason** (required).

1. Every user tagged **Can approve grade changes** (Users and roles page) gets a notification.
   The bell in the sidebar shows a live unread count.
2. On **Notifications → Approvals**, an approver reviews the old → new grade and the reason,
   then **Accept change** (optional note) or **Decline** (note required).
3. On accept, the grade is updated automatically and the remarks recalculated.
4. The teacher gets a notification with the decision and note, and can follow every request
   under **Notifications → My requests** (and cancel one that's still pending).

Rules enforced by `firestore.rules`:
- Teachers can't overwrite or delete a submitted grade (only their own drafts, while grade entry is
  open), and a submitted grade can't become a draft again.
- An approver's grade update is only accepted together with the matching approved request.
- Nobody can approve their own request.
- Administrators and registrars can still correct grades directly on the Enter grades page.

The first administrator is an approver by default. New collections:
`gradeChangeRequests` and `notifications`.

## School settings

**Administration → School settings** (Administrator): school name, short name, address, phone,
email, website, registrar's name and title, and logo (resized automatically).

They appear in the sidebar, on the sign-in page, as a letterhead on printed final grade reports
(with a registrar signature line), and in emailed reports. Stored in `settings/school`.

## Backup and restore (Excel)

**Administration → Backup and restore** (Administrator):

- **Download full backup:** one .xlsx with an *About* sheet and one sheet per collection
  (settings, subjects, teachers, sections, students, gradingAssignments, grades,
  gradeChangeRequests, and optionally users and usernames). Passwords are never included.
- **Import all:** choose a backup file, review rows per sheet, then:
  - **Merge** adds records and updates those with the same ID; nothing is deleted. Safe to repeat.
  - **Replace** deletes the current records in those sheets first, then restores the file exactly
    (type RESTORE to confirm; there's a "Back up current data first" button).
- The `_id` column keeps each record's ID, so links between students, sections, assignments
  and grades survive. Dates are stored as ISO text, lists as JSON text.
- Grade rows with an invalid grade or mismatched remarks are skipped and listed.
- Restoring user accounts only works in the same Firebase project (sign-in logins aren't in the
  file). Your own account is never deleted or overwritten during a restore.
- Notifications aren't backed up.

## Users and roles

| Role | Can do |
|---|---|
| Administrator | Everything, plus add/edit/disable/delete users and reset their passwords |
| Registrar | Subjects, teachers, sections, students, grading assignments, and all grades |
| Teacher | Dashboard, Notifications and Enter grades, only for their linked teacher record's assignments. Saved grades stay editable until submitted; submitted grades change only through an approved request |

- People sign in with a **username and password**. Behind the scenes each username maps to an internal
  Firebase Auth address (`username@gradingsystem.local`); no real email is needed.
- Roles are enforced by `firestore.rules`, not just by hiding menu items. A teacher can't read or change
  another teacher's grades even with browser tools.
- Everyone can change their own password from the sidebar (**Password**).
- **Reset password** (admin): a client-only app can't change another user's Firebase password, so the
  system creates a fresh sign-in for that username with the new password and moves the profile to it.
  The old sign-in is left without a profile and can't access anything.
- **Delete user** removes the profile and username, so the person can no longer sign in. The leftover
  Firebase Auth entry can be removed in Firebase Console > Authentication if you want a tidy list.
- The system always keeps at least one active administrator, and you can't disable or delete yourself.

New collections: `users/{uid}` (username, displayName, role, teacherDocId, active),
`usernames/{username}` (sign-in lookup), `meta/setup` (marks first-run setup as done).

## Audit trail

**Administration → Audit trail** (administrators) lists who **added, edited or deleted** what and when:
students, teachers, subjects, sections, grading assignments, grades, change requests, user accounts
and settings. **View** shows every field with its **old value → new value**. Filter by record type,
action, person, dates or text; **Load older** goes further back.

- Recorded with the change itself (all or nothing). On **Google Sheets** and **Supabase** the database
  writes the entries (`Database.gs`, `schema.sql`), so they can't be skipped. On **Firebase** the website
  writes them; `firestore.rules` only lets people add entries in their own name, with the server's time.
- Nobody can edit an entry; only administrators can read or delete them. Not recorded: notifications,
  "last active" and sign-in device updates. Images are stored as "[image]", long text is shortened.
- **Keeping entries** (Setup and options → Audit trail): until you delete them, or delete automatically
  after 30 days … 2 years or a custom number of days (checked when an administrator opens the system,
  at most twice a day). The Audit trail page can also delete entries older than a chosen age, or all.
  A note of every delete is kept.
- On Firebase each save reads the records first (to know the old values): about one extra read per
  changed record.

## Setup and options

**Administration → Setup and options** (administrators).

### Grading scale

| Scale | Grades | Remarks |
|---|---|---|
| **Percentage** (default) | 0 to 100 | 75 and above Passed, below 75 Failed |
| **1.00 to 5.00, 1.00 is the highest** | 1.00 excellent · 1.25–2.75 very good to fair · 3.00 lowest passing · 4.00 conditional / incomplete · 5.00 failing | Passed / Conditional / Failed |
| **5.00 to 1.00, 5.00 is the highest** (the reverse) | 5.00 excellent · 4.75–3.25 · 3.00 lowest passing · 2.00 conditional / incomplete · 1.00 failing | Passed / Conditional / Failed |

- On the point scales only those values can be entered (steps of 0.25). The conditional grade can be
  switched off.
- Enter grades, change requests, Final grades (GWA), the Excel grade sheets (remarks formulas),
  printed / emailed reports and backups all follow the chosen scale. On the 1.00 scale a GWA of 3.00
  or lower passes; on the 5.00 scale, 3.00 or higher.
- The database enforces it too (`firestore.rules`, `Database.gs`, `schema.sql`).
- **The scale can only change while no grades are saved**, because grades entered on one scale would
  be wrong on another. Download a full backup first if you need to start over.

### Final grade (GWA)

The scale the **final grade** is shown on (Final grades, student reports, emails, Excel grade sheets):
**Same as the grading scale**, **Percentage 0 to 100**, **1.00 to 5.00 (1.00 highest)** or **5.00 to 1.00
(5.00 highest)**. The GWA is always computed from the subjects' grades and then converted, so this can
change at any time without touching saved grades.

- From 0–100 to 1.00–5.00 the GWA is converted with an **editable conversion table** (the lowest GWA
  for each grade). Standard table: 97+ = 1.00, 94+ = 1.25, 91+ = 1.50, 88+ = 1.75, 85+ = 2.00,
  82+ = 2.25, 79+ = 2.50, 76+ = 2.75, 75+ = 3.00, below = 5.00; a 4.00 (conditional) row can be turned on.
  The 5.00-highest scale uses the same table reversed.
- Between 1.00-highest and 5.00-highest the final grade is 6 − GWA. A 1.00–5.00 grade can't be shown as
  a percentage.
- Final grades shows the final grade with the GWA beside it, e.g. **1.50 (91.50)**; the Excel sheets get
  a FINAL GRADE column (a live formula on the section sheets).

### When a student changes section

When a student's section changes (Students → Edit, or Move to section), the system can also move them
in grading assignments: it adds them to the new section's grading assignments (same school year) and
removes them from the old section's ones **where no grade is saved yet**; saved grades are never
deleted (those assignments are listed). Choose **Ask each time** (default: "Also move them in grading
assignments?"), **Always** or **Never**. Moving a student to **another school year** (promotion)
never touches last school year's grading assignments: they stay as that year's record, and Final grades
of the old year still lists the student with their old section.

### Teacher downtime

**School settings → Teacher downtime** (administrators) closes grade entry for **teacher accounts
only**, for example while the registrar reviews or finalizes grades:

- Teachers can still sign in and view their classes and grades, but every grade (drafts too) is
  read-only, **Save grades**, **Submit grades** and **Request change** are turned off, and a notice explains why (with your
  optional message and reopening time).
- Administrators and registrars keep full access and can enter or change any grade.
- **Reopen automatically on** (optional): grade entry opens again by itself at that time.
  Leave it empty to keep it closed until you turn the switch off.
- It's enforced by the database, not just the screen: `firestore.rules`, `Database.gs` and
  `schema.sql` refuse teachers' new grades and change requests during downtime. Publish the
  latest rules (and, with Google Sheets or Supabase, the latest `Database.gs` / `schema.sql`).

### Who is online

**Users and roles** shows an **Online now** list (name, role, the page they're on and their device)
and a **Last active** column for every account ("Online", "5 min ago", "Signed out"). It updates by
itself. While the system is open on screen, each account records its last activity about every
5 minutes (one small save, no spinner); someone active in the last 7 minutes counts as online.
Signing out shows the account offline right away. Needs the latest `firestore.rules` published
(and, with Google Sheets or Supabase, the latest `Database.gs` / `schema.sql`).

## Works on any device

- **Phones:** every table turns into easy-to-read cards with labels; dialogs open full screen;
  buttons are large enough to tap; the grade pad shows a "Next" key; iPhone doesn't zoom into fields.
- **Tablets:** cards two per row in portrait; full tables in landscape.
- **Laptops and large monitors:** full tables, content centered on very wide screens.
- **Notched phones** (iPhone, many Android): content stays clear of the notch and home bar.
- **Add to Home Screen:** on a phone, open the site and choose *Add to Home Screen*
  (Safari: Share button; Chrome/Samsung Internet: menu). It opens like an app with its own icon.
- **Supported browsers:** current Chrome, Edge, Firefox, Safari (iOS/iPadOS 14+, macOS) and
  Samsung Internet. Very old browsers see a "Please update your browser" message instead of a blank page.
- Printing works from phones and computers.

## Firebase connection (no keys in the code)

- **First device:** the site opens a **Connect to Firebase** screen. Paste the config snippet from
  Firebase Console → Project settings → Your apps → Config. **Test connection** checks the API key,
  that Authentication is enabled, and that the database answers, then **Save and continue**.
- **Other devices:** an administrator opens **School settings → Firebase connection**, enters their
  password, and clicks **Copy link for another device**. Opening that link connects the device.
  People still sign in with their own username and password. The config travels in the link's
  `#` part, which browsers never send to any server.
- **Changing it:** School settings → Firebase connection → **Change connection** (after your
  password), or **Connection settings** on the sign-in page, which asks for an administrator's
  username and password. If the saved connection doesn't work at all, it can be replaced without
  a password (there's nothing to protect).
- **Email sending:** EmailJS keys are entered in School settings → Email sending (password
  required) and stored in `settings/email`, readable only by administrators and registrars.

## One address for everything

The address bar always shows just the main address (e.g. `https://lunagococolleges.vercel.app/`).
`index.html` opens the system inside a full-screen frame, so moving between pages doesn't change
the address. Refreshing keeps the current page, and Back works as usual. If someone opens a page
address directly (like `/subjects` or `/pages/subjects.html`), it jumps to the main address and
shows that page there. Works the same on Vercel and GitHub Pages.

## Hosting on Vercel (clean addresses)

`vercel.json` makes pages open at clean addresses: `/subjects` instead of `/pages/subjects.html`,
`/final-grades`, `/login`, `/setup`, and so on. Old addresses with `/pages/` or `.html` jump to the
clean ones automatically, so bookmarks keep working. (GitHub Pages ignores this file.)

When you move to a new address, also add it in:
- Firebase Console → Authentication → Settings → **Authorized domains** (e.g. `lunagococolleges.vercel.app`)
- Google Cloud → Credentials → your API key → **Website restrictions**, if you use them
  (e.g. `https://lunagococolleges.vercel.app/*`)

## Publishing on GitHub

There are no keys in the code, so you can push the whole folder. `.gitignore` keeps Excel/CSV
backups (student data) out of the repository.

1. **Turn on Pages:** Settings → Pages → Source: **GitHub Actions**. Every push to `main` runs
   `.github/workflows/deploy.yml` and publishes to `https://USERNAME.github.io/REPOSITORY/`.
2. **Allow your site to sign in:** Firebase Console → Authentication → Settings → Authorized domains
   → add `USERNAME.github.io`.
3. **Restrict the API key** (recommended): Google Cloud Console → your project → APIs & Services →
   Credentials → *Browser key (auto created by Firebase)*:
   - Application restrictions → **Websites**: `https://USERNAME.github.io/*`, plus
     `http://localhost/*` and `http://127.0.0.1/*` for testing.
   - API restrictions → **Restrict key**: Identity Toolkit API, Token Service API,
     Cloud Firestore API, Firebase Installations API.
4. **Optional, skip the setup screen on every device:** add repository Secrets
   (Settings → Secrets and variables → Actions): `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`,
   `FIREBASE_PROJECT_ID`, `FIREBASE_APP_ID` (and optionally `FIREBASE_STORAGE_BUCKET`,
   `FIREBASE_MESSAGING_SENDER_ID`). The workflow builds them into the published site.
   A connection saved on a device still takes priority.

Note: a Firebase web API key always reaches the browser, so it can't be made truly secret on a
live site. That's by design. Your data is protected by `firestore.rules` and the key restrictions.

## Tailwind CSS

Tailwind utilities (`tw-` prefix) are **pre-built** into `css/tailwind.css`; no CDN is used.
After adding new `tw-` classes, rebuild it once: `npm install` then `npm run build:css`
(settings in `tailwind.config.js`; source `css/tailwind.input.css`). Bootstrap does most of the styling.

## Sign-in security

**School settings → Sign-in security** (administrators):

- **One device at a time:** when someone signs in while their account is open on another device,
  the sign-in page shows where (e.g. *Chrome on Windows, 5 minutes ago*) and asks whether to sign
  out the other device and continue. If yes, the other device is signed out automatically with the
  message *"You were signed out because your account was opened on another device."*
- **Sign out automatically after no activity:** Off, 1 minute, 5 minutes, 10 minutes, 30 minutes,
  1 hour, 5 hours or 24 hours. Counts time without clicks, typing, scrolling or touches (in any tab
  of the system). A *Stay signed in* warning appears shortly before. A device left closed longer
  than the limit is signed out when it's opened again.

Stored in `settings/security`. Publish the updated `firestore.rules` (users may now record their
own active device). With the Google Sheets database, update `Database.gs` and deploy a New version.

## The school's connection (one setup for every device)

**One time:** the school's Firebase connection is written into the website, in
`js/firebase-config.js` (`BUILT_IN_CONFIG`). Every account and device then uses it automatically:
no setup screen, no links, nothing saved per device.

Easiest way: open the website → the setup screen asks for your Firebase config (Firebase Console →
Project settings → Your apps → Config) → **Test connection** → **Download firebase-config.js** → put
the file into the `js` folder (replace the old one) → `git add js/firebase-config.js`,
`git commit -m "School connection"`, `git push`.

The Firebase web config is meant to be public (every Firebase website sends it to the browser).
Data is protected by sign-in and the security rules. Never put service-account / private keys in it.

**Choosing the database (administrators, inside the system):** School settings → **School database**:
- **Use Google Sheet…** → paste the `Database.gs` Web app URL → Test → Switch. **Switch back to
  Firebase** returns to Firestore. Changing Google Sheet A → B works the same way.
- **Use Supabase…** → paste the Supabase Project URL and publishable key → Test → Switch
  (see *Supabase as the database* below).
- Saved for the whole school in Firebase (`settings/connection`), with a **change history**
  (`connectionHistory`). Every account and device follows within about a minute.
- Shows a **status** (Connected / Disconnected / Configuration error) and **Test connection**.
- Only administrators can change it (`firestore.rules`). When the records are in a Google Sheet,
  the administrator accounts allowed to change it are listed with the choice (updated on each change).
- Needs a Firestore database to exist in the Firebase project (Firestore Database → Create
  database), even when the records are in a Google Sheet, and the latest `firestore.rules` published.

**Changing the Firebase project itself** (Firebase A → B): write the new config into
`js/firebase-config.js` the same way and push. Sign-in accounts belong to a Firebase project; copy
them with `firebase auth:export` / `auth:import`, or restore a backup and reset passwords.

## Google Sheets as the database (option)

Instead of Firestore, the records can live in a **Google Sheet** you own. Firebase is then used
**only for sign-in** (no daily read/write quota for data). Every request goes through
`google-apps-script/Database.gs`, which checks the signed-in user and applies the same role rules
as `firestore.rules` (teachers see only their classes, saved grades need approval, and so on).
Writes in one action are all-or-nothing.

**Trade-offs:** each action takes about 1 to 3 seconds; notifications and the bell refresh every
30 seconds instead of instantly; Apps Script handles a limited number of requests at once (fine for
a school office, not for hundreds of people at the same minute). Firestore stays the default.

**Setup (about 5 minutes):**
1. Create a Google Sheet (sheets.new), e.g. "Grading System database".
2. **Extensions → Apps Script**: delete the sample code and paste `google-apps-script/Database.gs`.
3. Set `FIREBASE_API_KEY` at the top to the **apiKey** from your Firebase config. Save.
   *Optional default administrator:* choose the function **createDefaultAdmin** in the toolbar and
   click **Run** (after *authorize* below). It creates username **admin** with password **admin123**
   (change `DEFAULT_ADMIN_USERNAME` / `DEFAULT_ADMIN_PASSWORD` at the top first if you like; Firebase
   needs at least 6 characters, so "123" isn't possible). The first sign-in asks for a new password.
   Running it again does nothing once an administrator exists.
   Then choose the function **authorize** in the toolbar and click **Run** → Review permissions →
   your account → (Advanced → Go to … →) **Allow**. This grants "Connect to an external service",
   which the database uses to check sign-ins. Without it you'll see *"You do not have permission to
   call UrlFetchApp.fetch"* (Filipino: *"Wala kang pahintulot na tumawag kay UrlFetchApp.fetch"*).
4. **Deploy → New deployment → Web app**: *Execute as:* Me, *Who has access:* Anyone. Copy the URL.
5. In the system: **School settings → Firebase connection** → unlock with your password →
   **Use Google Sheet…** → paste the Web app URL → **Test** → **Switch to Google Sheet**.
   (Or on the sign-in page: *Connection settings* → Database: Google Sheets.)
   To go back, use **Switch back to Firebase** in the same place.
6. Share the connection link (School settings → Firebase connection) so other devices switch too.

**If you restricted your Firebase API key to your website** (Google Cloud → Credentials), the
Sheet's script can't check sign-ins with it, and creating the administrator is refused. Either set
the *Browser key*'s **Application restrictions to None** (keep its API restrictions), or create a
**second API key** restricted to the *Identity Toolkit API* only and put that one in
`FIREBASE_API_KEY`. **Test** on the connection screen detects this.

**One choice for the whole school.** The database (Firebase or Google Sheets) is chosen by an
administrator in School settings → Firebase connection, and saved in Firestore (`settings/connection`).
Every device follows it automatically the next time a page opens; the Connection setup screen shows it
read-only. Publish the latest `firestore.rules` so every device can read it.

**Moving existing data from Firestore to Google Sheets:**
1. While still on Firestore: Backup and restore → **Download full backup** (with user accounts).
2. Switch the database to Google Sheets (steps above). The sign-in page then shows
   *Create the administrator* because the Sheet is empty: enter **your existing administrator
   username and password**; it signs in to your existing account.
3. Backup and restore → **Import all** → choose the backup → **Merge**, tick
   *Also restore user accounts* → Import. Everyone signs in as before.
(The same steps in reverse move data back to Firestore.)

In the Sheet, each list is a tab. Column A is the record id, column B (hidden) holds the full
record, and the following columns are readable copies for viewing and filtering. Make changes
through the grading system: edits to the readable columns are not read back.

## Supabase as the database (option)

The records can also live in a **Supabase** project (Postgres). Firebase is still used **for
sign-in only**: Supabase checks each Firebase sign-in itself (*Third-party Auth*), and
`supabase/schema.sql` applies the same role rules as `firestore.rules` (teachers see only their
classes, saved grades need approval, and so on). Writes in one action are all-or-nothing.
Faster than Google Sheets (well under a second per action) and no daily Firestore quota for data;
notifications and the bell refresh every 30 seconds instead of instantly.

**Setup (about 5 minutes):**
1. Create a project at https://supabase.com (the free plan is fine).
2. **SQL Editor → New query** → paste the whole file `supabase/schema.sql` → **Run**.
   (Running it again later is safe: it keeps the records and updates the rules.)
3. **Authentication → Sign In / Providers → Third-party Auth → Add provider → Firebase** → enter
   your Firebase **Project ID** (the `projectId` in `js/firebase-config.js`) → Create.
4. **Project Settings → API Keys**: copy the **Project URL** (`https://….supabase.co`) and the
   **publishable key** (`sb_publishable_…`, or the legacy *anon public* key).
   **Never use the secret / service_role key**: it bypasses every rule. The system refuses it.
5. In the system: **School settings → School database → Use Supabase…** → paste the URL and key
   → **Test** (it also checks that Supabase accepts your Firebase sign-in) → **Switch to Supabase**.
   Every account and device follows automatically; you're signed out.
   To go back, use **Switch back to Firebase** in the same place.

Moving existing data works exactly as for Google Sheets: **Download full backup** first, switch,
create the administrator with your **existing username and password** when the sign-in page asks
(Supabase starts empty), then **Import all** → **Merge** with *Also restore user accounts*.

The choice can also be written into the website (Connection setup screen → Database: Supabase →
Download firebase-config.js), as the default before any administrator has chosen.

**How it's stored:** one table, `grading.docs` (`col` = list such as `students`, `id`, `data` as
JSON), visible in Supabase's Table Editor under the `grading` schema. The website can't reach the
table directly; every request goes through one function, `public.gs_request`, which checks who is
signed in first. Make changes through the grading system. The publishable key is meant to be
public (like the Firebase web config); the rules in `schema.sql` are what protect the data.

## Google Sheets copy

Keep a copy of every record in a Google Sheet you own (one tab per list: Subjects, Teachers,
Sections, Students, Grading assignments, Grades, Grade change requests, Users, School, plus an
*About* tab with the last sync time). It's a **one-way copy**: Firebase stays the real database,
and edits made in the sheet are replaced by the next sync. Passwords, sign-in details, email keys
and the sync key are never copied.

**Setup (about 5 minutes):**
1. Create a Google Sheet (sheets.new). Open **Extensions → Apps Script**, delete the sample code,
   and paste the whole file `google-apps-script/SheetsCopy.gs`.
2. Change `SYNC_KEY` at the top to your own long secret (20+ letters and numbers). Save.
3. **Deploy → New deployment →** gear icon **→ Web app**: *Execute as:* Me, *Who has access:* Anyone.
   Deploy, allow the permissions, and copy the **Web app URL** (ends with `/exec`).
   ("Anyone" only lets the system reach the script; nothing is written without your sync key,
   and the sheet stays private unless you share it.)
4. In the system: **School settings → Google Sheets copy** → unlock with your password → paste the
   URL and the same sync key → **Test** → **Save**. Optionally turn on the daily automatic copy.
5. **Backup and restore → Copy to Google Sheets → Sync now** for the first copy.

The daily automatic copy runs when an administrator opens the Dashboard and the last copy is more
than a day old. If you edit `SheetsCopy.gs` later, use Deploy → Manage deployments → Edit → New version.

## Keeping Firebase reads low

The free Firebase plan allows 50,000 reads, 20,000 writes and 20,000 deletes per day
(reset at midnight Pacific Time, 3 PM / 4 PM Philippine time). To stay well under it:

- **Device cache:** each browser keeps a copy of the data (IndexedDB). When a page loads a list
  again, Firebase sends only the records that changed, and only those are charged. Pages still
  confirm with the server, so data is always current. Revisits within about 30 minutes are the
  cheapest; after a longer break the first load reads the full list again.
- **School settings** are re-read at most every 5 minutes (immediately after you save them), so a changed school name or logo reaches every device quickly.
- **Signing out erases the device copy**, so the next person on a shared computer can't see it.
- Check usage in Firebase Console → Firestore Database → **Usage**. If you still hit the limit in
  busy weeks, the Blaze plan keeps the same free allowance and only charges beyond it (set a
  budget alert).

## Security note

Publish `firestore.rules`; without it, Firestore's default or test-mode rules apply and roles are only
cosmetic. Your Firebase web config is public by design; the rules are what protect the data.
