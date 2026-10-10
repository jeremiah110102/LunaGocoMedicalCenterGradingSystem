-- ==========================================================
-- College Grading System: SUPABASE DATABASE (server)
-- ==========================================================
-- Makes a Supabase (Postgres) project the system's database. Firebase is
-- still used for sign-in: Supabase checks each Firebase sign-in token
-- (Third-party Auth) and the functions below apply the same role rules as
-- firestore.rules and google-apps-script/Database.gs.
--
-- SETUP (about 5 minutes)
--  1. Create a project at https://supabase.com (any region; the free plan is fine).
--  2. SQL Editor → New query → paste this whole file → Run.
--  3. Authentication → Sign In / Providers → Third-party Auth → Add provider →
--     Firebase → enter your Firebase Project ID (e.g. lunagococolleges) → Create.
--  4. Project Settings → API Keys: copy the Project URL and the
--     publishable key (sb_publishable_…) or the legacy "anon public" key.
--     NEVER use the secret / service_role key on the website.
--  5. In the system: School settings → School database → Use Supabase… →
--     paste the URL and key → Test → Switch to Supabase.
--
-- Running this file again is safe: it keeps your records and updates the functions.
--
-- Storage: every record is one row of grading.docs (col = list name such as
-- "students", id = record id, data = the record as JSON). The table can't be
-- reached directly from the website; everything goes through public.gs_request,
-- which checks the signed-in user first.
-- ==========================================================

set client_min_messages = warning;
create schema if not exists grading;
revoke all on schema grading from public;

create table if not exists grading.docs (
  col        text        not null,
  id         text        not null,
  data       jsonb       not null,
  updated_at timestamptz not null default now(),
  primary key (col, id)
);
alter table grading.docs enable row level security; -- no policies: no direct access
create index if not exists docs_data_idx on grading.docs using gin (data jsonb_path_ops);
revoke all on grading.docs from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema grading from anon, authenticated';
    execute 'revoke all on grading.docs from anon, authenticated';
  end if;
end $$;

-- ---------------------------------------------------------- helpers
-- Who is signed in: the Firebase uid, only for tokens issued by Firebase
-- (Supabase has already checked the signature against your Firebase project).
create or replace function grading.uid() returns text
language sql stable as $$
  select case
    when c ->> 'iss' = 'https://securetoken.google.com/' || (c ->> 'aud')
     and coalesce(c ->> 'sub', '') <> ''
    then c ->> 'sub'
  end
  from (select nullif(current_setting('request.jwt.claims', true), '')::jsonb as c) x
$$;

create or replace function grading.fail(code text, message text) returns void
language plpgsql as $$
begin
  raise exception using message = message, hint = 'gs:' || code;
end $$;

-- What the signed-in person may do (same names as firestore.rules)
drop type if exists grading.ctx cascade;
create type grading.ctx as (
  uid         text,
  signed_in   boolean,
  active      boolean,
  is_admin    boolean,
  is_staff    boolean,
  is_teacher  boolean,
  is_approver boolean,
  my_teacher  jsonb
);

create or replace function grading.make_ctx(p_uid text) returns grading.ctx
language plpgsql stable as $$
declare
  me jsonb;
  r grading.ctx;
  act boolean;
begin
  if p_uid is not null then
    select data into me from grading.docs where col = 'users' and id = p_uid;
  end if;
  act := p_uid is not null and me is not null and me -> 'active' = 'true'::jsonb;
  r.uid := p_uid;
  r.signed_in := p_uid is not null;
  r.active := act;
  r.is_admin := act and me ->> 'role' = 'admin';
  r.is_staff := act and me ->> 'role' in ('admin', 'registrar');
  r.is_teacher := act and me ->> 'role' = 'teacher';
  r.is_approver := act and me -> 'canApprove' = 'true'::jsonb;
  r.my_teacher := me -> 'teacherDocId';
  return r;
end $$;

create or replace function grading.before(p_col text, p_id text) returns jsonb
language sql stable as $$
  select data from grading.docs where col = p_col and id = p_id
$$;

-- A record as it will be after the write being checked (after = planned changes)
create or replace function grading.after(after_map jsonb, p_col text, p_id text) returns jsonb
language sql stable as $$
  select case
    when after_map ? (p_col || '/' || p_id)
      then nullif(after_map -> (p_col || '/' || p_id), 'null'::jsonb)
    else grading.before(p_col, p_id)
  end
$$;

-- The school's grading scale (Setup and options → settings/options), as in firestore.rules:
--   percent 0–100 (75 passes) · point1 1.00 best…3.00 pass, 4.00 conditional, 5.00 fail
--   point5 the reverse: 5.00 best…3.00 pass, 2.00 conditional, 1.00 fail
create or replace function grading.scale() returns text
language sql stable as $$
  select case when o ->> 'gradingScale' in ('point1', 'point5') then o ->> 'gradingScale' else 'percent' end
  from (select coalesce(grading.before('settings', 'options'), '{}'::jsonb) as o) x
$$;

create or replace function grading.is_grade(n jsonb) returns boolean
language plpgsql stable as $$
declare
  v numeric;
  cond boolean := coalesce(grading.before('settings', 'options') -> 'allowConditional', 'true'::jsonb) <> 'false'::jsonb;
begin
  if n is null or jsonb_typeof(n) <> 'number' then return false; end if;
  v := (n #>> '{}')::numeric;
  case grading.scale()
    when 'point1' then return v in (1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 5) or (cond and v = 4);
    when 'point5' then return v in (5, 4.75, 4.5, 4.25, 4, 3.75, 3.5, 3.25, 3, 1) or (cond and v = 2);
    else return v between 0 and 100;
  end case;
end $$;

create or replace function grading.remarks_of(n jsonb) returns text
language sql stable as $$
  select case grading.scale()
    when 'point1' then case when v = 4 then 'Conditional' when v <= 3 then 'Passed' else 'Failed' end
    when 'point5' then case when v = 2 then 'Conditional' when v >= 3 then 'Passed' else 'Failed' end
    else case when v >= 75 then 'Passed' else 'Failed' end
  end
  from (select (n #>> '{}')::numeric as v) x
$$;

-- A remark instead of a number: INC (Incomplete) or DRP (Dropped); the grade is then null
create or replace function grading.is_mark(grade jsonb, remarks jsonb) returns boolean
language sql immutable as $$
  select (grade is null or jsonb_typeof(grade) = 'null') and coalesce(remarks #>> '{}', '') in ('Incomplete', 'Dropped')
$$;

-- A valid grade record: a grade on the school's scale with its remarks, or a remark (INC / DRP)
create or replace function grading.valid_grade(d jsonb) returns boolean
language sql stable as $$
  select d is not null and (grading.is_mark(d -> 'finalGrade', d -> 'remarks')
    or coalesce(grading.is_grade(d -> 'finalGrade') and d ->> 'remarks' = grading.remarks_of(d -> 'finalGrade'), false))
$$;

-- Term deadline (Setup and options → Term deadlines): after it, teachers can't add that term's grades
create or replace function grading.term_open(asg jsonb) returns boolean
language sql stable as $$
  select coalesce((
    select jsonb_typeof(dl -> '__ts') is distinct from 'string' or now() < (dl ->> '__ts')::timestamptz
    from (select grading.before('settings', 'options') -> 'termDeadlines' -> coalesce(asg ->> 'term', '') as dl) x
  ), true)
$$;

-- true when only the allowed keys differ between the two records
create or replace function grading.only_keys_changed(b jsonb, a jsonb, allowed text[]) returns boolean
language sql immutable as $$
  select coalesce(bool_and(b -> k is not distinct from a -> k or k = any (allowed)), true)
  from (select jsonb_object_keys(coalesce(b, '{}')) as k
        union select jsonb_object_keys(coalesce(a, '{}'))) keys
$$;

-- ---------------------------------------------------------- rules (same as firestore.rules)
-- Teacher downtime (School settings): teachers can't add grades or change requests
create or replace function grading.teachers_locked() returns boolean
language sql stable as $$
  select coalesce((
    select d -> 'teachersLocked' = 'true'::jsonb
       and (jsonb_typeof(d -> 'until' -> '__ts') is distinct from 'string'
            or now() < (d -> 'until' ->> '__ts')::timestamptz)
    from (select grading.before('settings', 'downtime') as d) x
  ), false)
$$;

-- A teacher's grade must belong to its class exactly: one record per student and class
-- (id = assignmentId_studentId), with the class's subject, units, school year, term and
-- section. Final grades / GWA use these copies, so they can't be made up.
create or replace function grading.matches_class(p_id text, a jsonb, asg jsonb) returns boolean
language sql immutable as $$
  select coalesce(asg is not null
    and coalesce(asg -> 'studentIds', '[]'::jsonb) @> jsonb_build_array(a -> 'studentId')
    and p_id = (a ->> 'assignmentId') || '_' || (a ->> 'studentId')
    and coalesce(a -> 'subjectId', 'null'::jsonb) = coalesce(asg -> 'subjectId', 'null'::jsonb)
    and coalesce(a -> 'units', 'null'::jsonb) = coalesce(asg -> 'units', 'null'::jsonb)
    and coalesce(a -> 'schoolYear', 'null'::jsonb) = coalesce(asg -> 'schoolYear', 'null'::jsonb)
    and coalesce(a ->> 'term', '') = coalesce(asg ->> 'term', '')
    and coalesce(a -> 'sectionId', 'null'::jsonb) = coalesce(asg -> 'sectionId', 'null'::jsonb)
    and (not a ? 'draft' or jsonb_typeof(a -> 'draft') = 'boolean'), false)
$$;

-- A draft belongs to its school year: from Aug 1 of the year it ends ("2026-2027" → Aug 1, 2027)
-- it is locked for good, even if the same term's deadline is set again for a later school year.
-- School years written another way aren't limited by this.
create or replace function grading.in_school_year(asg jsonb) returns boolean
language sql stable as $$
  select case when coalesce(asg ->> 'schoolYear', '') ~ '^[^-]*-[0-9]{4}$'
    then now() < make_timestamptz(split_part(asg ->> 'schoolYear', '-', 2)::int, 8, 1, 0, 0, 0, 'UTC')
    else true end
$$;

-- Draft, then Submit: a teacher may change or clear their own grade while it is a draft (saved,
-- not submitted yet), until the term deadline or downtime. Submitted grades, and grades saved
-- before drafts existed (no draft field), stay locked.
create or replace function grading.teacher_draft(r grading.ctx, b jsonb) returns boolean
language plpgsql stable as $$
declare
  asg jsonb;
begin
  if not coalesce(r.is_teacher and b -> 'draft' = 'true'::jsonb and b -> 'teacherDocId' = r.my_teacher, false)
     or grading.teachers_locked() then
    return false;
  end if;
  asg := grading.before('gradingAssignments', b ->> 'assignmentId');
  return coalesce(asg -> 'teacherDocId' = r.my_teacher and grading.term_open(asg) and grading.in_school_year(asg), false);
end;
$$;

create or replace function grading.can_read(r grading.ctx, p_col text, p_id text, d jsonb) returns boolean
language sql stable as $$
  select coalesce(case p_col
    when 'meta' then p_id = 'setup'
    when 'usernames' then true -- single look-ups only (listing is blocked in run_query)
    when 'users' then (r.signed_in and (r.uid = p_id or r.is_admin)) or (r.active and d -> 'canApprove' = 'true'::jsonb)
    when 'settings' then p_id = 'school' or (p_id in ('security', 'downtime', 'options') and r.signed_in) or (p_id = 'email' and r.is_staff) or r.is_admin
    when 'subjects' then r.active
    when 'teachers' then r.active
    when 'sections' then r.active
    when 'students' then r.active
    when 'gradingAssignments' then r.active
    when 'curriculum' then r.active
    when 'grades' then r.is_staff or (r.is_teacher and d -> 'teacherDocId' = r.my_teacher)
    when 'gradeChangeRequests' then r.is_staff or r.is_approver or (r.is_teacher and d -> 'teacherDocId' = r.my_teacher)
    when 'rosterRequests' then r.is_staff or (r.is_teacher and d -> 'teacherDocId' = r.my_teacher)
    when 'notifications' then r.signed_in and d ->> 'toUid' = r.uid
    else r.is_admin
  end, false)
$$;

create or replace function grading.can_write(
  r grading.ctx, op text, p_col text, p_id text, b jsonb, a jsonb, after_map jsonb
) returns boolean
language plpgsql stable as $$
declare
  first_setup boolean := grading.before('meta', 'setup') is null
                         and grading.after(after_map, 'meta', 'setup') is not null;
  valid boolean;
  asg jsonb;
  req jsonb;
  g jsonb;
  mark_ok boolean;
begin
  case p_col
    when 'meta' then
      if p_id <> 'setup' then return r.is_admin; end if;
      return op = 'create' and r.signed_in and a ->> 'adminUid' = r.uid;

    when 'usernames' then
      if op = 'create' then
        return r.is_admin or (r.signed_in and first_setup and a ->> 'uid' = r.uid);
      end if;
      return r.is_admin;

    when 'users' then
      if op = 'create' then
        return r.is_admin or (r.signed_in and r.uid = p_id and first_setup
          and a ->> 'role' = 'admin' and a -> 'active' = 'true'::jsonb);
      elsif op = 'update' then
        -- Everyone may record their own active device and "last active" time, and clear their own "must change password"
        -- mark (it may stay as it is, or be cleared, but never switched on)
        mark_ok := b -> 'mustChangePassword' is not distinct from a -> 'mustChangePassword'
                   or a -> 'mustChangePassword' = 'false'::jsonb;
        return r.is_admin or coalesce(r.signed_in and r.uid = p_id and mark_ok
          and grading.only_keys_changed(b, a, array['activeSession', 'mustChangePassword', 'updatedAt', 'lastSeen']), false);
      end if;
      return r.is_admin;

    when 'settings' then
      return r.is_admin;

    when 'subjects', 'teachers', 'sections', 'students', 'gradingAssignments', 'curriculum' then
      return r.is_staff;

    when 'grades' then
      valid := grading.valid_grade(a);
      if op = 'create' then
        if r.is_staff then return valid; end if;
        if not coalesce(r.is_teacher and a -> 'teacherDocId' = r.my_teacher, false) or grading.teachers_locked() then return false; end if;
        asg := grading.before('gradingAssignments', a ->> 'assignmentId');
        return coalesce(valid and asg -> 'teacherDocId' = r.my_teacher and grading.term_open(asg)
          and grading.matches_class(p_id, a, asg), false);
      elsif op = 'update' then
        if r.is_staff then return true; end if;
        -- A teacher changes their own draft; it stays the same student's grade in the same class
        if grading.teacher_draft(r, b) then
          asg := grading.before('gradingAssignments', a ->> 'assignmentId');
          return coalesce(valid and a -> 'teacherDocId' = r.my_teacher
            and a -> 'assignmentId' = b -> 'assignmentId' and a -> 'studentId' = b -> 'studentId'
            and grading.matches_class(p_id, a, asg), false);
        end if;
        -- An approver may change only the grade, its remarks and the change-request trail
        if not (r.is_approver and valid and a ? 'lastChangeRequestId'
          and grading.only_keys_changed(b, a, array['finalGrade', 'remarks', 'lastChangeRequestId', 'lastChangedByName', 'updatedAt']))
        then return false; end if;
        -- An approver's update must match a request approved in the same write
        req := grading.after(after_map, 'gradeChangeRequests', a ->> 'lastChangeRequestId');
        return coalesce(req ->> 'status' = 'approved' and req ->> 'gradeId' = p_id
          and coalesce(req -> 'newGrade', 'null'::jsonb) = coalesce(a -> 'finalGrade', 'null'::jsonb)
          and req -> 'newRemarks' is not distinct from a -> 'remarks' and req ->> 'decidedBy' = r.uid, false);
      end if;
      return r.is_staff or grading.teacher_draft(r, b); -- delete

    when 'gradeChangeRequests' then
      if op = 'create' then
        if r.is_admin then return true; end if; -- restore from backup
        g := grading.before('grades', a ->> 'gradeId');
        return coalesce(r.is_teacher and not grading.teachers_locked() and a -> 'teacherDocId' = r.my_teacher and g is not null
          and g -> 'teacherDocId' = r.my_teacher and a ->> 'requestedBy' = r.uid
          and a ->> 'status' = 'pending'
          and (grading.is_mark(a -> 'newGrade', a -> 'newRemarks')
               or coalesce(grading.is_grade(a -> 'newGrade') and a ->> 'newRemarks' = grading.remarks_of(a -> 'newGrade'), false))
          and jsonb_typeof(a -> 'reason') = 'string' and length(a ->> 'reason') >= 10, false);
      elsif op = 'update' then
        if r.is_admin then return true; end if;
        -- An approver decides a pending request (never their own)
        if coalesce(r.is_approver and b ->> 'status' = 'pending' and b ->> 'requestedBy' <> r.uid
          and a ->> 'status' in ('approved', 'declined') and a ->> 'decidedBy' = r.uid
          and grading.only_keys_changed(b, a, array['status', 'decidedBy', 'decidedByName', 'decidedAt', 'decisionNote']), false)
        then return true; end if;
        -- The requester withdraws a pending request
        return coalesce(r.active and b ->> 'requestedBy' = r.uid and b ->> 'status' = 'pending'
          and a ->> 'status' = 'cancelled'
          and grading.only_keys_changed(b, a, array['status', 'decidedAt']), false);
      end if;
      return r.is_staff;

    when 'rosterRequests' then
      -- Class list requests (as in firestore.rules): a teacher drafts and submits for their own
      -- class, and may withdraw until the registrar decides the first line; only staff decide.
      if r.is_staff then return true; end if;
      if not coalesce(r.is_teacher, false) or grading.teachers_locked() then return false; end if;
      if op = 'create' then
        asg := grading.before('gradingAssignments', a ->> 'assignmentId');
        return coalesce(jsonb_typeof(a -> 'items') = 'array' and jsonb_array_length(a -> 'items') <= 50
          and a -> 'teacherDocId' = r.my_teacher and asg is not null and asg -> 'teacherDocId' = r.my_teacher
          and a ->> 'requestedBy' = r.uid and a ->> 'status' in ('draft', 'submitted')
          and a -> 'reviewStarted' = 'false'::jsonb, false);
      end if;
      if not coalesce(b -> 'teacherDocId' = r.my_teacher and b ->> 'requestedBy' = r.uid, false) then return false; end if;
      if op = 'update' then
        return coalesce(jsonb_typeof(a -> 'items') = 'array' and jsonb_array_length(a -> 'items') <= 50
          and a -> 'assignmentId' is not distinct from b -> 'assignmentId'
          and a -> 'teacherDocId' is not distinct from b -> 'teacherDocId'
          and a -> 'requestedBy' is not distinct from b -> 'requestedBy'
          and a -> 'reviewStarted' is not distinct from b -> 'reviewStarted'
          and ((b ->> 'status' = 'draft' and a ->> 'status' in ('draft', 'submitted', 'withdrawn'))
            or (b ->> 'status' = 'submitted' and a ->> 'status' = 'withdrawn'
              and b -> 'reviewStarted' = 'false'::jsonb and a -> 'items' = b -> 'items')), false);
      end if;
      return coalesce(b ->> 'status' = 'draft', false); -- delete

    when 'auditLog' then
      -- Entries are written by grading.commit with each change; administrators may delete old ones
      return op = 'delete' and r.is_admin;

    when 'notifications' then
      if op = 'create' then
        return coalesce(r.active and a ->> 'fromUid' = r.uid and a -> 'read' = 'false'::jsonb, false);
      elsif op = 'update' then
        return coalesce(r.signed_in and b ->> 'toUid' = r.uid
          and grading.only_keys_changed(b, a, array['read', 'readAt']), false);
      end if;
      return coalesce(r.signed_in and b ->> 'toUid' = r.uid, false);

    else
      return r.is_admin;
  end case;
end $$;

-- ---------------------------------------------------------- queries
create or replace function grading.field(p_id text, d jsonb, f text) returns jsonb
language sql immutable as $$
  select case when f = '__name__' then to_jsonb(p_id) else d -> f end
$$;

-- Dates are stored as {"__ts": "2026-…Z"} and compared by their text
create or replace function grading.sort_key(v jsonb) returns jsonb
language sql immutable as $$
  select case when jsonb_typeof(v) = 'object' and jsonb_typeof(v -> '__ts') = 'string' then v -> '__ts' else v end
$$;

create or replace function grading.num_key(v jsonb) returns numeric
language sql immutable as $$
  select case when jsonb_typeof(grading.sort_key(v)) = 'number' then (grading.sort_key(v) #>> '{}')::numeric end
$$;

create or replace function grading.text_key(v jsonb) returns text
language sql immutable as $$
  select case when v is null or jsonb_typeof(v) = 'null' or jsonb_typeof(grading.sort_key(v)) = 'number' then null
              else grading.sort_key(v) #>> '{}' end
$$;

-- -1 / 0 / 1 like the Google Sheets database; missing values sort last
create or replace function grading.cmp(a jsonb, b jsonb) returns integer
language sql immutable as $$
  select case
    when grading.sort_key(a) = grading.sort_key(b) then 0
    when a is null or jsonb_typeof(a) = 'null' then 1
    when b is null or jsonb_typeof(b) = 'null' then -1
    when grading.num_key(a) is not null and grading.num_key(b) is not null
      then sign(grading.num_key(a) - grading.num_key(b))::integer
    when grading.sort_key(a) #>> '{}' < grading.sort_key(b) #>> '{}' then -1
    else 1
  end
$$;

create or replace function grading.matches(p_id text, d jsonb, w jsonb) returns boolean
language plpgsql immutable as $$
declare
  v jsonb := grading.field(p_id, d, w ->> 0);
  op text := w ->> 1;
  val jsonb := w -> 2;
begin
  case op
    when '==' then return v is not null and v = val;
    when '!=' then return v is not null and v <> val;
    when 'in' then return v is not null and exists (select 1 from jsonb_array_elements(coalesce(val, '[]')) x where x = v);
    when 'not-in' then return v is not null and not exists (select 1 from jsonb_array_elements(coalesce(val, '[]')) x where x = v);
    when 'array-contains' then return jsonb_typeof(v) = 'array' and v @> jsonb_build_array(val);
    when '<' then return v is not null and grading.cmp(v, val) < 0;
    when '<=' then return v is not null and grading.cmp(v, val) <= 0;
    when '>' then return v is not null and grading.cmp(v, val) > 0;
    when '>=' then return v is not null and grading.cmp(v, val) >= 0;
    else perform grading.fail('invalid-argument', 'Unsupported filter: ' || coalesce(op, '?'));
  end case;
  return false;
end $$;

create or replace function grading.matches_all(p_id text, d jsonb, wheres jsonb) returns boolean
language sql immutable as $$
  select coalesce(bool_and(grading.matches(p_id, d, w)), true)
  from jsonb_array_elements(coalesce(wheres, '[]')) w
$$;

-- The filter part of a query. Equality filters ("==", "array-contains", and "__name__ ==") are
-- also written as conditions the indexes can use (primary key, GIN on data), so a query reads only
-- the matching records instead of the whole collection; grading.matches_all still checks every
-- filter exactly. Uses $1 = collection, $2 = filters, $3 = ctx, $5 = equality object, $6 = id.
create or replace function grading.query_filter(wheres jsonb) returns text
language plpgsql immutable as $$
declare
  w jsonb;
  sql text := '';
  has_eq boolean := false;
begin
  if jsonb_typeof(wheres) is distinct from 'array' or jsonb_array_length(wheres) = 0 then
    return ' and grading.can_read($3, $1, d.id, d.data)';
  end if;
  for w in select * from jsonb_array_elements(wheres) loop
    if w ->> 0 = '__name__' and w ->> 1 = '==' and jsonb_typeof(w -> 2) = 'string' then
      sql := sql || ' and d.id = $6';
    elsif w ->> 0 <> '__name__' and w ->> 1 in ('==', 'array-contains') then
      has_eq := true;
    end if;
  end loop;
  if has_eq then sql := sql || ' and d.data @> $5'; end if;
  return sql || ' and grading.matches_all(d.id, d.data, $2) and grading.can_read($3, $1, d.id, d.data)';
end $$;

-- {"field": value, "list": [value]} for the "==" / "array-contains" filters (see query_filter)
create or replace function grading.query_eq(wheres jsonb) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_object_agg(w ->> 0, case when w ->> 1 = 'array-contains' then jsonb_build_array(w -> 2) else w -> 2 end), '{}')
  from jsonb_array_elements(case when jsonb_typeof(wheres) = 'array' then wheres else '[]' end) w
  where w ->> 0 <> '__name__' and w ->> 1 in ('==', 'array-contains')
$$;

-- The id asked for by a "__name__ ==" filter (or null)
create or replace function grading.query_id(wheres jsonb) returns text
language sql immutable as $$
  select (select w ->> 2 from jsonb_array_elements(case when jsonb_typeof(wheres) = 'array' then wheres else '[]' end) w
          where w ->> 0 = '__name__' and w ->> 1 = '==' and jsonb_typeof(w -> 2) = 'string' limit 1)
$$;

create or replace function grading.run_query(
  r grading.ctx, p_col text, wheres jsonb, orders jsonb, p_limit integer
) returns jsonb
language plpgsql stable as $$
declare
  sql text := 'select coalesce(jsonb_agg(jsonb_build_object(''id'', id, ''data'', data)), ''[]'') from ('
           || 'select d.id, d.data from grading.docs d where d.col = $1' || grading.query_filter(wheres);
  o jsonb;
  dir text;
  fx text;
  sorts text[] := '{}';
  result jsonb;
begin
  if p_col in ('usernames', 'settings', 'meta') and not r.is_admin then
    perform grading.fail('permission-denied', 'You can''t list ' || p_col || '.');
  end if;
  for o in select * from jsonb_array_elements(coalesce(orders, '[]')) loop
    dir := case when o ->> 1 = 'desc' then 'desc nulls first' else 'asc nulls last' end;
    -- Same order as grading.num_key / grading.text_key (numbers, then text and dates), written
    -- out so it is worked out once per record instead of through several function calls
    fx := case when o ->> 0 = '__name__' then 'to_jsonb(d.id)' else format('(d.data -> %L)', o ->> 0) end;
    sorts := sorts
      || format('(case when jsonb_typeof(%1$s) = ''number'' then (%1$s #>> ''{}'')::numeric end) %2$s', fx, dir)
      || format('(case when %1$s is null or jsonb_typeof(%1$s) in (''null'', ''number'') then null'
                || ' when jsonb_typeof(%1$s) = ''object'' and jsonb_typeof(%1$s -> ''__ts'') = ''string'' then %1$s ->> ''__ts'''
                || ' else %1$s #>> ''{}'' end) %2$s', fx, dir);
  end loop;
  if array_length(sorts, 1) > 0 then sql := sql || ' order by ' || array_to_string(sorts, ', '); end if;
  sql := sql || ' limit $4) q';
  execute sql into result using p_col, wheres, r, p_limit, grading.query_eq(wheres), grading.query_id(wheres);
  return result;
end $$;

-- How many records a query finds (without building the list)
create or replace function grading.run_count(r grading.ctx, p_col text, wheres jsonb) returns integer
language plpgsql stable as $$
declare
  result integer;
begin
  if p_col in ('usernames', 'settings', 'meta') and not r.is_admin then
    perform grading.fail('permission-denied', 'You can''t list ' || p_col || '.');
  end if;
  execute 'select count(*) from grading.docs d where d.col = $1' || grading.query_filter(wheres)
    into result using p_col, wheres, r, null::integer, grading.query_eq(wheres), grading.query_id(wheres);
  return result;
end $$;

-- ---------------------------------------------------------- writes (all-or-nothing)
create or replace function grading.resolve_server_times(v jsonb, now_iso text) returns jsonb
language plpgsql immutable as $$
begin
  if v is null then return null; end if;
  case jsonb_typeof(v)
    when 'array' then
      return coalesce((select jsonb_agg(grading.resolve_server_times(x, now_iso) order by n)
                       from jsonb_array_elements(v) with ordinality t(x, n)), '[]'::jsonb);
    when 'object' then
      if v -> '__serverTimestamp' = 'true'::jsonb then return jsonb_build_object('__ts', now_iso); end if;
      return coalesce((select jsonb_object_agg(k, grading.resolve_server_times(x, now_iso))
                       from jsonb_each(v) t(k, x)), '{}'::jsonb);
    else
      return v;
  end case;
end $$;

-- ---------------------------------------------------------- audit trail (same as js/audit.js)
-- A value made safe and small: no images, no huge text, dates as text
create or replace function grading.audit_value(v jsonb) returns jsonb
language plpgsql immutable as $$
begin
  if v is null then return 'null'::jsonb; end if;
  case jsonb_typeof(v)
    when 'string' then
      if left(v #>> '{}', 10) = 'data:image' then return to_jsonb('[image]'::text); end if;
      if length(v #>> '{}') > 300 then return to_jsonb(left(v #>> '{}', 300) || '…'); end if;
      return v;
    when 'array' then
      return coalesce((select jsonb_agg(grading.audit_value(x) order by n)
                       from jsonb_array_elements(v) with ordinality t(x, n) where n <= 100), '[]'::jsonb);
    when 'object' then
      if jsonb_typeof(v -> '__ts') = 'string' then return v -> '__ts'; end if;
      return coalesce((select jsonb_object_agg(k, grading.audit_value(x)) from jsonb_each(v) t(k, x)), '{}'::jsonb);
    else
      return v;
  end case;
end $$;

-- A short description of the record ("GE 1 · BSC 1A · Juan Cruz")
create or replace function grading.audit_label(p_col text, d jsonb, p_id text) returns text
language sql immutable as $$
  select case p_col
    when 'students' then concat_ws(' · ', nullif(d ->> 'studentName', ''), nullif(d ->> 'studentId', ''))
    when 'teachers' then concat_ws(' · ', nullif(d ->> 'teacherName', ''), nullif(d ->> 'teacherId', ''))
    when 'subjects' then concat_ws(' · ', nullif(d ->> 'subjectCode', ''), nullif(d ->> 'subjectName', ''))
    when 'sections' then concat_ws(' · ', nullif(d ->> 'sectionName', ''), nullif(d ->> 'yearLevel', ''), nullif(d ->> 'schoolYear', ''))
    when 'gradingAssignments' then concat_ws(' · ', nullif(d ->> 'subjectCode', ''), nullif(d ->> 'sectionName', ''), nullif(d ->> 'teacherName', ''), nullif(d ->> 'schoolYear', ''), nullif(d ->> 'term', ''))
    when 'curriculum' then concat_ws(' · ', nullif(d ->> 'program', ''), nullif(d ->> 'yearLevel', ''), nullif(d ->> 'term', ''))
    when 'grades' then concat_ws(' · ', nullif(d ->> 'studentName', ''), nullif(d ->> 'subjectCode', ''), nullif(d ->> 'sectionName', ''))
    when 'gradeChangeRequests' then concat_ws(' · ', nullif(d ->> 'studentName', ''), nullif(d ->> 'subjectCode', ''), nullif(d ->> 'status', ''))
    when 'rosterRequests' then concat_ws(' · ', nullif(d ->> 'subjectCode', ''), nullif(d ->> 'sectionName', ''), nullif(d ->> 'status', ''))
    when 'users' then concat_ws(' · ', nullif(d ->> 'displayName', ''), nullif(d ->> 'username', ''), nullif(d ->> 'role', ''))
    when 'settings' then coalesce(jsonb_build_object('school', 'School details', 'security', 'Sign-in security', 'email', 'Email sending',
      'downtime', 'Teacher downtime', 'options', 'Setup and options', 'sheets', 'Google Sheets copy') ->> p_id, p_id)
    else coalesce(p_id, '')
  end
$$;

-- Audit entries for the planned writes of one commit (who added / edited / deleted what)
create or replace function grading.write_audit(r grading.ctx, planned jsonb, now_iso text) returns void
language plpgsql as $$
declare
  me jsonb := coalesce(grading.before('users', r.uid), '{}'::jsonb);
  who jsonb;
  p jsonb;
  b jsonb;
  a jsonb;
  act text;
  keys text[];
  audit_deletes integer := 0;
begin
  who := jsonb_build_object('at', jsonb_build_object('__ts', now_iso), 'byUid', coalesce(r.uid, ''),
    'byName', coalesce(nullif(me ->> 'displayName', ''), me ->> 'username', ''), 'byRole', coalesce(me ->> 'role', ''));
  for p in select * from jsonb_array_elements(planned) loop
    b := nullif(p -> 'before', 'null'::jsonb);
    a := nullif(p -> 'after', 'null'::jsonb);
    if p ->> 'col' = 'auditLog' then
      if p ->> 'type' = 'delete' and b is not null then audit_deletes := audit_deletes + 1; end if;
      continue;
    end if;
    if p ->> 'col' = 'notifications' then continue; end if;
    if p ->> 'type' = 'delete' and b is null then continue; end if;
    act := case when p ->> 'type' = 'delete' then 'delete' when b is null then 'create' else 'update' end;
    select coalesce(array_agg(k order by k), '{}') into keys
    from (select jsonb_object_keys(coalesce(b, '{}'::jsonb)) as k union select jsonb_object_keys(coalesce(a, '{}'::jsonb))) s
    where k not in ('activeSession', 'lastSeen', 'updatedAt', 'createdAt')
      and (act <> 'update' or b -> k is distinct from a -> k);
    if act = 'update' and cardinality(keys) = 0 then continue; end if; -- only background noise changed
    insert into grading.docs (col, id, data) values ('auditLog', replace(gen_random_uuid()::text, '-', ''), who || jsonb_build_object(
      'action', act, 'col', p ->> 'col', 'docId', p ->> 'id',
      'label', grading.audit_label(p ->> 'col', coalesce(a, b), p ->> 'id'),
      'before', case when act = 'create' then '{}'::jsonb else
        (select coalesce(jsonb_object_agg(k, grading.audit_value(b -> k)), '{}'::jsonb) from unnest(keys) k where b ? k) end,
      'after', case when act = 'delete' then '{}'::jsonb else
        (select coalesce(jsonb_object_agg(k, grading.audit_value(a -> k)), '{}'::jsonb) from unnest(keys) k where a ? k) end));
  end loop;
  if audit_deletes > 0 then
    insert into grading.docs (col, id, data) values ('auditLog', replace(gen_random_uuid()::text, '-', ''), who || jsonb_build_object(
      'action', 'delete', 'col', 'auditLog', 'docId', '', 'before', '{}'::jsonb, 'after', '{}'::jsonb,
      'label', audit_deletes || ' audit trail entr' || case when audit_deletes = 1 then 'y' else 'ies' end));
  end if;
end $$;

create or replace function grading.commit(r grading.ctx, ops jsonb) returns void
language plpgsql as $$
declare
  now_iso text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  after_map jsonb := '{}';
  planned jsonb := '[]';
  op jsonb;
  p jsonb;
  parts text[];
  k text;
  cur jsonb;
  dat jsonb;
  nxt jsonb;
  kind text;
begin
  if jsonb_typeof(ops) <> 'array' or jsonb_array_length(ops) = 0 then return; end if;
  -- One write at a time, like the Google Sheets database (a school office's load)
  perform pg_advisory_xact_lock(hashtext('grading.commit'));

  for op in select * from jsonb_array_elements(ops) loop
    parts := string_to_array(coalesce(op ->> 'path', ''), '/');
    if array_length(parts, 1) is distinct from 2 or parts[1] = '' or parts[2] = '' then
      perform grading.fail('invalid-argument', 'Bad record path: ' || coalesce(op ->> 'path', ''));
    end if;
    k := parts[1] || '/' || parts[2];
    cur := grading.after(after_map, parts[1], parts[2]);
    dat := grading.resolve_server_times(op -> 'data', now_iso);
    case op ->> 'type'
      when 'delete' then nxt := null;
      when 'update' then
        if cur is null then perform grading.fail('not-found', 'No record to update: ' || k); end if;
        nxt := cur || coalesce(dat, '{}');
      when 'set' then
        nxt := case when op -> 'merge' = 'true'::jsonb and cur is not null
                    then cur || coalesce(dat, '{}') else coalesce(dat, '{}') end;
      else
        perform grading.fail('invalid-argument', 'Unknown write: ' || coalesce(op ->> 'type', '?'));
    end case;
    after_map := after_map || jsonb_build_object(k, coalesce(nxt, 'null'::jsonb));
    planned := planned || jsonb_build_array(jsonb_build_object(
      'type', op ->> 'type', 'col', parts[1], 'id', parts[2],
      'before', coalesce(cur, 'null'::jsonb), 'after', coalesce(nxt, 'null'::jsonb)));
  end loop;

  for p in select * from jsonb_array_elements(planned) loop
    cur := nullif(p -> 'before', 'null'::jsonb);
    nxt := nullif(p -> 'after', 'null'::jsonb);
    if p ->> 'type' = 'delete' and cur is null then continue; end if; -- deleting something missing is fine
    kind := case when p ->> 'type' = 'delete' then 'delete' when cur is not null then 'update' else 'create' end;
    if not coalesce(grading.can_write(r, kind, p ->> 'col', p ->> 'id', cur, nxt, after_map), false) then
      perform grading.fail('permission-denied', 'Not allowed: ' || kind || ' in ' || (p ->> 'col') || '.');
    end if;
  end loop;

  for k, nxt in select * from jsonb_each(after_map) loop
    parts := string_to_array(k, '/');
    if jsonb_typeof(nxt) = 'null' then
      delete from grading.docs where col = parts[1] and id = parts[2];
    else
      insert into grading.docs as t (col, id, data, updated_at) values (parts[1], parts[2], nxt, now())
      on conflict (col, id) do update set data = excluded.data, updated_at = now();
    end if;
  end loop;

  -- Audit trail: who added / edited / deleted what, with the old and new values
  perform grading.write_audit(r, planned, now_iso);
end $$;

-- ---------------------------------------------------------- the website's only entry point
-- body: { action: "ping" | "get" | "query" | "count" | "adminUids" | "commit", … }
-- (the same requests the Google Sheets database answers)
create or replace function public.gs_request(body jsonb) returns jsonb
language plpgsql
security definer
set search_path = grading, pg_temp
as $$
declare
  v_uid text := grading.uid();
  r grading.ctx;
  parts text[];
  d jsonb;
  hint text;
  msg text;
begin
  if body ->> 'action' = 'ping' then
    return jsonb_build_object('ok', true, 'version', 1, 'signedIn', v_uid is not null, 'uid', v_uid,
      'hasToken', nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'iss' is not null);
  end if;

  r := grading.make_ctx(v_uid);
  case body ->> 'action'
    when 'get' then
      parts := string_to_array(coalesce(body ->> 'path', ''), '/');
      if array_length(parts, 1) is distinct from 2 or parts[1] = '' or parts[2] = '' then
        perform grading.fail('invalid-argument', 'Bad record path: ' || coalesce(body ->> 'path', ''));
      end if;
      d := grading.before(parts[1], parts[2]);
      if d is null then return jsonb_build_object('ok', true, 'doc', null); end if;
      if not grading.can_read(r, parts[1], parts[2], d) then
        perform grading.fail('permission-denied', 'You don''t have access to this record.');
      end if;
      return jsonb_build_object('ok', true, 'doc', jsonb_build_object('id', parts[2], 'data', d));

    when 'query' then
      return jsonb_build_object('ok', true, 'docs', grading.run_query(
        r, body ->> 'collection', body -> 'where', body -> 'orderBy', (body ->> 'limit')::integer));

    when 'count' then
      return jsonb_build_object('ok', true, 'count', grading.run_count(r, body ->> 'collection', body -> 'where'));

    -- IDs of the active administrators (no names or other details), so the website can
    -- let them change the school's database even though Firebase can't read this database
    when 'adminUids' then
      return jsonb_build_object('ok', true, 'uids', coalesce((
        select jsonb_agg(id) from grading.docs
        where col = 'users' and data ->> 'role' = 'admin' and data -> 'active' = 'true'::jsonb), '[]'));

    when 'commit' then
      perform grading.commit(r, coalesce(body -> 'ops', '[]'));
      return jsonb_build_object('ok', true);

    else
      return jsonb_build_object('ok', false, 'code', 'invalid-argument', 'message', 'Unknown action.');
  end case;
exception when others then
  -- Everything this request changed is undone
  get stacked diagnostics hint = pg_exception_hint, msg = message_text;
  if hint like 'gs:%' then
    return jsonb_build_object('ok', false, 'code', substr(hint, 4), 'message', msg);
  end if;
  return jsonb_build_object('ok', false, 'code', 'internal', 'message', msg);
end $$;

-- Only gs_request can be called from the website; the helpers and the table can't
revoke all on all functions in schema grading from public;
revoke all on function public.gs_request(jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all functions in schema grading from anon, authenticated';
    -- anon too: Firebase tokens without a "role" claim arrive as anon; grading.uid() still checks them
    execute 'grant execute on function public.gs_request(jsonb) to anon, authenticated';
  end if;
end $$;
