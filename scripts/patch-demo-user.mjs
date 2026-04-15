// =====================================================
// Patch demo user for video:
//  1. Rename course "תוכנה 1" → "מדעי המחשב"
//  2. Add fake exams "מודלים חישוביים" + "מבוא למדעי המחשב" inside it
//  3. Fill other 4 courses with fake exams + placeholder questions
// Run: node --env-file=.env.local scripts/patch-demo-user.mjs
// =====================================================

import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const DEMO_EMAIL = 'demo@examprep.co';
// Placeholder image — loads fine, looks neutral
const PLACEHOLDER = 'https://placehold.co/820x320/eef2ff/6366f1?text=Question';

// ── helpers ──────────────────────────────────────────
async function fakeExam(courseId, userId, name, qCount) {
  const { data: ex, error } = await sb.from('ep_exams').insert({
    course_id: courseId, user_id: userId,
    name, status: 'ready', question_count: qCount,
    processed_at: new Date().toISOString(),
  }).select('id').single();
  if (error) throw new Error(`exam "${name}": ${error.message}`);

  const sections = ['א','ב','ג','ד','ה','ו','ז','ח','ט','י','יא','יב','יג','יד','טו'];
  const rows = Array.from({ length: qCount }, (_, i) => ({
    exam_id: ex.id, course_id: courseId, user_id: userId,
    question_number: i + 1,
    section_label: sections[i % sections.length],
    image_path: PLACEHOLDER,
    num_options: 4,
    correct_idx: (i % 4) + 1,
    topic: null,
  }));
  const { error: qErr } = await sb.from('ep_questions').insert(rows);
  if (qErr) throw new Error(`questions for "${name}": ${qErr.message}`);
  console.log(`  + exam "${name}" (${qCount} שאלות)`);
}

// ── main ─────────────────────────────────────────────
const { data: users } = await sb.auth.admin.listUsers();
const demo = users?.users?.find(u => u.email === DEMO_EMAIL);
if (!demo) { console.error('Demo user not found.'); process.exit(1); }
const uid = demo.id;

const { data: courses } = await sb.from('ep_courses').select('id,name').eq('user_id', uid);
const byName = Object.fromEntries(courses.map(c => [c.name, c.id]));

// 1. Rename תוכנה 1 → מדעי המחשב
const csId = byName['תוכנה 1'];
if (csId) {
  await sb.from('ep_courses').update({ name: 'מדעי המחשב' }).eq('id', csId);
  console.log('Renamed "תוכנה 1" → "מדעי המחשב"');
} else {
  console.log('"תוכנה 1" already renamed or missing — skipping rename.');
}
const csCourseId = csId ?? byName['מדעי המחשב'];

// 2. Add fake exams inside מדעי המחשב (skip if already present)
console.log('\nAdding fake exams to מדעי המחשב...');
const { data: existingCsExams } = await sb.from('ep_exams').select('name').eq('course_id', csCourseId);
const existingCsNames = new Set(existingCsExams.map(e => e.name));

if (!existingCsNames.has('מודלים חישוביים'))   await fakeExam(csCourseId, uid, 'מודלים חישוביים',      11);
else console.log('  "מודלים חישוביים" already exists — skipping.');
if (!existingCsNames.has('מבוא למדעי המחשב')) await fakeExam(csCourseId, uid, 'מבוא למדעי המחשב',    9);
else console.log('  "מבוא למדעי המחשב" already exists — skipping.');

// 3. Fake questions for the 4 empty courses
const emptyFill = [
  { name: 'ביולוגיה', exams: [{ label: 'גנטיקה ואבולוציה',         q: 14 }, { label: 'ביולוגיה תאית', q: 11 }] },
  { name: 'כימיה',    exams: [{ label: 'כימיה אורגנית',            q: 13 }, { label: 'תרמודינמיקה',   q: 9  }] },
  { name: 'משפטים',   exams: [{ label: 'דיני חוזים',               q: 16 }, { label: 'דיני נזיקין',   q: 12 }] },
  { name: 'פיזיקה',   exams: [{ label: 'מכניקה קלאסית',            q: 13 }, { label: 'חשמל ומגנטיות', q: 10 }] },
];

for (const { name, exams } of emptyFill) {
  const cid = byName[name];
  if (!cid) { console.log(`\nCourse "${name}" not found — skipping.`); continue; }

  console.log(`\nFilling "${name}"...`);
  const { data: existingExams } = await sb.from('ep_exams').select('name').eq('course_id', cid);
  const existingNames = new Set(existingExams.map(e => e.name));

  for (const { label, q } of exams) {
    if (existingNames.has(label)) { console.log(`  "${label}" already exists — skipping.`); continue; }
    await fakeExam(cid, uid, label, q);
  }
}

console.log('\n✅  Patch complete!');
