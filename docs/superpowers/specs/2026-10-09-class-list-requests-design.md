# Class List Requests: Design

Date: 2026-10-09. Approved in chat on 2026-10-09.

## Goal

A teacher can ask for changes to the student list of one of their classes:

- **add** a student,
- **remove** a student,
- **move** a student to the same subject's class in another section.

The changes are collected in a **draft** the teacher can check and edit. The teacher then
**submits** it. A **registrar or admin** approves or declines each change. An approved change is
made at once. Nothing in the class changes before that.

## Decisions taken with the user

| Question | Answer |
|---|---|
| Who approves? | Registrar or admin only. Teachers with "can approve" don't see these requests. |
| What does "change section" do? | It moves the student only in this subject: they leave this class and join the same subject's class (same school year and term) in the other section. Their own section and other subjects stay. |
| How is the draft grouped? | One draft list per class. The registrar decides each line, or uses Approve all. |

## Data: `rosterRequests/{autoId}`

```
{
  assignmentId, teacherDocId, teacherName,
  subjectId, subjectCode, sectionId, sectionName, schoolYear, term,
  requestedBy (uid), requestedByName,
  status: "draft" | "submitted" | "done" | "withdrawn",
  reviewStarted: false,          // set by the registrar on the first decision
  items: [{
    id,                          // short random id, unique in the request
    type: "add" | "remove" | "move",
    studentId, studentName, studentNumber,
    toAssignmentId, toSectionName,   // move only
    reason,                      // at least 10 characters
    decision: "pending" | "approved" | "declined" | "skipped",
    note, decidedBy, decidedByName, decidedAt
  }],
  createdAt, submittedAt, updatedAt, doneAt
}
```

- There is one open request (`draft` or `submitted`) per class. The page enforces this: it loads
  the open request before creating one. The rules don't, because they can't query. A second open
  request would only mean more lines for the registrar, never a change without approval.
- At most 50 items per request (checked in the rules).
- `skipped` means it was approved but could not be made, because the class changed meanwhile
  (see Approving). The note says why.
- The status becomes `done` when every item is decided.

## Pure logic: `js/roster-requests.js` (no database access)

- `checkItem(item, ctx)` returns `""` when the line is allowed, else a plain-English reason. `ctx`
  is `{ assignment, assignments, grades }`, where `grades` are the class's grades for the student.
  - **add:**
    - The student is not in the class.
    - The student is not in another class of the same subject, school year and term.
  - **remove / move:**
    - The student is in the class.
    - The student has no **submitted** grade in it. Otherwise the reason says to use DRP instead.
  - **move:**
    - The target is another class of the same subject, school year and term, in another section.
    - The student is not in the target already.
  - **all:** the reason has at least 10 characters, and the same student is not in two lines.
- `planApprove(item, now)` returns `{ ops, result: "apply" | "skip", note }`, where `now` is the
  re-read `{ assignment, target, grades, assignments }`. It runs `checkItem` again on the fresh
  data. When that fails, it returns `skip` with the reason. Otherwise:
  - **add:** update the class's `studentIds` (append).
  - **remove:** update `studentIds` (without the student), and delete the student's **draft**
    grade in the class, if there is one.
  - **move:** like remove, plus append the student to the target's `studentIds`.

## Teacher: Enter grades (`js/grading.js`, `pages/grading.html`)

- Inside an open class, a **Request class list change** button opens a panel. The panel shows
  the open request, if there is one.
- **Add student:** search the students of the class's school year. Students who are already in
  the class or already take the subject that term are disabled, with the reason.
- **Remove** and **Move to another section** are in a menu on each student row. Move lists only
  the classes of the same subject, school year and term in other sections.
- Each action asks for a reason and adds a line to the draft. Lines can be edited or deleted
  while the request is a draft. The draft is saved to the database (`status: "draft"`), so it
  survives a reload.
- **Submit request** sets `status: "submitted"`. **Withdraw** sets `status: "withdrawn"`, and is
  allowed while it's a draft, or after submission until the registrar decides the first line.
- A row with a submitted grade has no Remove or Move. Its tooltip says "Grade submitted: use DRP
  instead".
- A draft grade on a removed or moved student is shown in the line ("draft grade 2.50 will be
  deleted when approved").
- Students added or removed by a pending line are marked in the class list ("Add requested",
  "Removal requested").
- During downtime the panel is read only, as Enter grades already is.

## Registrar or admin: Notifications page (`js/notifications.js`, `pages/notifications.html`)

- A new **Class list requests** section, shown only to staff. It lists the submitted requests,
  oldest first.
- Each request shows the class, the teacher, and each line with its type, student, target
  section, reason and any draft grade.
- **Approve** and **Decline** on each line, with an optional note. Declining asks for a note.
  **Approve all** approves every pending line.
- Approving re-reads the class, the move target, and the student's grades in those classes. It
  then commits through `commitOperations` (audited), in one batch:
  - the class changes, from `planApprove`;
  - the request update: the item's decision, `reviewStarted: true`, and `status: "done"` when
    no line is pending.
- A `skip` writes only the request update, with the note.
- When the request becomes `done`, the teacher gets a notification: "Your class list request
  for GE 1, BSC 1A: 2 approved, 1 declined". It uses the existing `notifications` collection.

## Database rules (all three backends)

The rules are in `firestore.rules`, `google-apps-script/Database.gs` and `supabase/schema.sql`.

- **Read:**
  - staff;
  - a teacher, when `teacherDocId` is their own.
- **Create:** a teacher, not during downtime, when all of these hold:
  - `teacherDocId` is their own;
  - the class's `teacherDocId` is their own;
  - `requestedBy` is their uid;
  - `status` is `draft` or `submitted`;
  - `reviewStarted` is false;
  - `items` is a list of at most 50.

  An admin may also create one, for restore from backup.
- **Update by the teacher** (own request, not during downtime):
  - from `draft`, to `draft`, `submitted` or `withdrawn`; or
  - from `submitted` to `withdrawn`, while `reviewStarted` is false.

  `assignmentId`, `teacherDocId`, `requestedBy` and `reviewStarted` can't change. `items` stays a
  list of at most 50.
- **Update by staff:** any update.
- **Delete:**
  - staff;
  - the teacher, for their own `draft`.
- Class and grade writes stay as they are: only staff change `gradingAssignments`. Teachers
  never change a class through this feature.

## Also updated

- `js/audit.js`, `google-apps-script/Database.gs` and `supabase/schema.sql`: an audit label for
  `rosterRequests` (class, subject, status).
- `js/backup.js`: include `rosterRequests`.
- `js/sheets-sync.js`: a "Class list requests" tab.
- `README.md`: one paragraph.

## Not included

- Moving the student's own section. That stays on Students → Change section.
- Requests by approvers who are not staff.
- Combined classes are handled as their separate parts. A move picks one class.

## Testing

- **Unit test** (`qa/roster-unit.mjs`): `checkItem` and `planApprove` for each type, including:
  - a submitted grade blocks;
  - a draft grade is deleted;
  - add when the student is already taking the subject;
  - move to the same section or another subject is refused;
  - an approval after the class changed returns `skip`.
- **Page test** (`qa/roster-ui.js`, mock):
  - The teacher adds three lines, reloads (the draft is kept), and submits.
  - The registrar approves two lines, which writes the class changes and the draft-grade delete,
    and declines one, which asks for a note.
  - The teacher gets the notification.
  - An approver who isn't staff doesn't see the section.
  - A withdraw after the first decision is refused.
- **Rules tests** on the Firestore emulator, the Sheets harness and Postgres:
  - a teacher can't read or write another teacher's request;
  - a teacher can't create a request for a class that isn't theirs;
  - a teacher can't edit a submitted request, or withdraw it after `reviewStarted`;
  - a teacher can't change `gradingAssignments`;
  - staff can decide.
