// =====================================================
// patch-demo-v2.mjs
// Converts the demo user's flat courses into a
// degree→courses two-level hierarchy and fixes images.
//
// Run (after applying supabase/migrations/degree_hierarchy.sql):
//   node --env-file=.env.local scripts/patch-demo-v2.mjs
// =====================================================

import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const DEMO_EMAIL = 'demo@examprep.co';
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
  console.log(`    + "${name}" (${qCount}q)`);
  return ex.id;
}

async function createSubCourse(degreeId, userId, name, description, color) {
  const { data, error } = await sb.from('ep_courses').insert({
    user_id: userId, name, description: description || null,
    color, parent_id: degreeId, is_degree: false,
  }).select('id').single();
  if (error) throw new Error(`sub-course "${name}": ${error.message}`);
  console.log(`  → sub-course "${name}" created (${data.id})`);
  return data.id;
}

async function moveExamsToSubCourse(fromCourseId, toSubCourseId) {
  const { error: ee } = await sb.from('ep_exams')
    .update({ course_id: toSubCourseId })
    .eq('course_id', fromCourseId);
  if (ee) throw new Error(`move exams: ${ee.message}`);
  const { error: qe } = await sb.from('ep_questions')
    .update({ course_id: toSubCourseId })
    .eq('course_id', fromCourseId);
  if (qe) throw new Error(`move questions: ${qe.message}`);
}

// ── main ──────────────────────────────────────────────
const { data: users } = await sb.auth.admin.listUsers();
const demo = users?.users?.find(u => u.email === DEMO_EMAIL);
if (!demo) { console.error('Demo user not found.'); process.exit(1); }
const uid = demo.id;
console.log(`Demo user: ${uid}`);

const { data: courses } = await sb.from('ep_courses').select('id,name,color,is_degree,parent_id').eq('user_id', uid);
const byName = Object.fromEntries(courses.filter(c => !c.parent_id).map(c => [c.name, c]));
console.log('Top-level courses:', Object.keys(byName));

// ── 1. מדעי המחשב ─────────────────────────────────────
console.log('\n── מדעי המחשב ──');
const csObj = byName['מדעי המחשב'];
if (!csObj) { console.error('"מדעי המחשב" course not found.'); process.exit(1); }
const csId = csObj.id;

// Set as degree
await sb.from('ep_courses').update({ is_degree: true, image_url: 'https://images.unsplash.com/photo-1461749280684-dccba630e2f6?w=88&h=88&fit=crop&auto=format' }).eq('id', csId);
console.log('  is_degree = true');

// Get all exams currently under מדעי המחשב
const { data: csExams } = await sb.from('ep_exams').select('id,name').eq('course_id', csId).is('deleted_at', null);
const csExamNames = csExams.map(e => e.name);
console.log('  existing exams:', csExamNames);

// Identify the 3 real exams (from create-demo-user.mjs)
const realExamLabels = ['מועד א, סמסטר א, 2024', 'מועד א, סמסטר א, 2025', 'מועד ב, סמסטר א, 2024'];
const fakeExamLabels = ['מודלים חישוביים', 'מבוא למדעי המחשב'];

// Get or create sub-course "תוכנה 1" and move real exams + questions there
const { data: existingSubs } = await sb.from('ep_courses').select('id,name').eq('parent_id', csId);
const existingSubNames = existingSubs.map(s => s.name);

if (!existingSubNames.includes('תוכנה 1')) {
  const tohua1Id = await createSubCourse(csId, uid, 'תוכנה 1', 'Java, Generics, Streams, OOP', '#2563eb');
  // Move the 3 real exam + their questions
  const realExams = csExams.filter(e => realExamLabels.includes(e.name));
  for (const exam of realExams) {
    await sb.from('ep_exams').update({ course_id: tohua1Id }).eq('id', exam.id);
    await sb.from('ep_questions').update({ course_id: tohua1Id }).eq('exam_id', exam.id);
    console.log(`    moved real exam "${exam.name}" → תוכנה 1`);
  }
} else {
  console.log('  תוכנה 1 already exists — skipping');
}

// Sub-course "מודלים חישוביים"
const modelsSub = existingSubNames.includes('מודלים חישוביים')
  ? existingSubs.find(s => s.name === 'מודלים חישוביים')
  : null;
if (!modelsSub) {
  const modelsId = await createSubCourse(csId, uid, 'מודלים חישוביים', 'אוטומטים, סבוכיות, חישוביות', '#7c3aed');
  const fakeModelsExam = csExams.find(e => e.name === 'מודלים חישוביים');
  if (fakeModelsExam) {
    await sb.from('ep_exams').update({ course_id: modelsId }).eq('id', fakeModelsExam.id);
    await sb.from('ep_questions').update({ course_id: modelsId }).eq('exam_id', fakeModelsExam.id);
    console.log('    moved fake "מודלים חישוביים" exam → sub-course');
  } else {
    await fakeExam(modelsId, uid, 'מועד א׳ 2024', 11);
    await fakeExam(modelsId, uid, 'מועד ב׳ 2024', 8);
  }
} else {
  console.log('  מודלים חישוביים already exists — skipping');
}

// Sub-course "מבוא למדעי המחשב"
const mavoSub = existingSubNames.includes('מבוא למדעי המחשב')
  ? existingSubs.find(s => s.name === 'מבוא למדעי המחשב')
  : null;
if (!mavoSub) {
  const mavoId = await createSubCourse(csId, uid, 'מבוא למדעי המחשב', 'Python, אלגוריתמים בסיסיים', '#0891b2');
  const fakeMavoExam = csExams.find(e => e.name === 'מבוא למדעי המחשב');
  if (fakeMavoExam) {
    await sb.from('ep_exams').update({ course_id: mavoId }).eq('id', fakeMavoExam.id);
    await sb.from('ep_questions').update({ course_id: mavoId }).eq('exam_id', fakeMavoExam.id);
    console.log('    moved fake "מבוא למדעי המחשב" exam → sub-course');
  } else {
    await fakeExam(mavoId, uid, 'מועד א׳ 2024', 9);
    await fakeExam(mavoId, uid, 'מועד ב׳ 2024', 7);
  }
} else {
  console.log('  מבוא למדעי המחשב already exists — skipping');
}

// ── 2. Non-CS courses → is_degree + sub-courses ────────
const nonCsConfig = [
  {
    name: 'ביולוגיה', color: '#16a34a',
    image: 'https://images.unsplash.com/photo-1530026186672-2cd00ffc50fe?w=88&h=88&fit=crop&auto=format',
    subs: [
      { name: 'גנטיקה ואבולוציה', desc: 'גנטיקה מולקולרית ואבולוציה', color: '#16a34a', examName: 'גנטיקה ואבולוציה', fallbackQ: 14 },
      { name: 'ביולוגיה תאית', desc: 'מבנה תא, תהליכים תאיים', color: '#059669', examName: 'ביולוגיה תאית', fallbackQ: 11 },
    ],
  },
  {
    name: 'כימיה', color: '#7c3aed',
    image: 'https://images.unsplash.com/photo-1532187863486-abf9dbad1b69?w=88&h=88&fit=crop&auto=format',
    subs: [
      { name: 'כימיה אורגנית', desc: 'פחמימנים, תגובות אורגניות', color: '#7c3aed', examName: 'כימיה אורגנית', fallbackQ: 13 },
      { name: 'תרמודינמיקה ואלקטרוכימיה', desc: 'אנרגיה, תגובות חשמליות', color: '#9333ea', examName: 'תרמודינמיקה', fallbackQ: 9 },
    ],
  },
  {
    name: 'משפטים', color: '#dc2626',
    image: null, // already has a working image from previous patch
    subs: [
      { name: 'דיני חוזים', desc: 'כריתת חוזה, תנאים, הפרה', color: '#dc2626', examName: 'דיני חוזים', fallbackQ: 16 },
      { name: 'דיני נזיקין', desc: 'אחריות, פיצויים, עוולות', color: '#ef4444', examName: 'דיני נזיקין', fallbackQ: 12 },
    ],
  },
  {
    name: 'פיזיקה', color: '#d97706',
    image: null, // already has a working image
    subs: [
      { name: 'מכניקה קלאסית', desc: 'קינמטיקה, דינמיקה, אנרגיה', color: '#d97706', examName: 'מכניקה קלאסית', fallbackQ: 13 },
      { name: 'חשמל ומגנטיות', desc: 'אלקטרוסטטיקה, מעגלים, מגנטיות', color: '#f59e0b', examName: 'חשמל ומגנטיות', fallbackQ: 10 },
    ],
  },
];

for (const cfg of nonCsConfig) {
  const courseObj = byName[cfg.name];
  if (!courseObj) { console.log(`\n"${cfg.name}" not found — skipping`); continue; }
  const cid = courseObj.id;
  console.log(`\n── ${cfg.name} ──`);

  const updateData = { is_degree: true };
  if (cfg.image) updateData.image_url = cfg.image;
  await sb.from('ep_courses').update(updateData).eq('id', cid);
  console.log('  is_degree = true' + (cfg.image ? ' + image updated' : ''));

  const { data: thisExams } = await sb.from('ep_exams').select('id,name').eq('course_id', cid).is('deleted_at', null);
  const { data: thisSubs } = await sb.from('ep_courses').select('id,name').eq('parent_id', cid);
  const existingThisSubNames = (thisSubs || []).map(s => s.name);

  for (const sub of cfg.subs) {
    if (existingThisSubNames.includes(sub.name)) {
      console.log(`  "${sub.name}" already exists — skipping`);
      continue;
    }
    const subId = await createSubCourse(cid, uid, sub.name, sub.desc, sub.color);
    // Try to move a matching exam, otherwise create fake ones
    const matchingExam = (thisExams || []).find(e => e.name === sub.examName || e.name.includes(sub.name.split(' ')[0]));
    if (matchingExam) {
      await sb.from('ep_exams').update({ course_id: subId }).eq('id', matchingExam.id);
      await sb.from('ep_questions').update({ course_id: subId }).eq('exam_id', matchingExam.id);
      console.log(`    moved existing exam "${matchingExam.name}" → ${sub.name}`);
    } else {
      await fakeExam(subId, uid, 'מועד א׳ 2024', sub.fallbackQ);
    }
  }
}

console.log('\n✅  patch-demo-v2 complete!');
console.log('   Login: demo@examprep.co / ExamPrep2025!');
console.log('   Dashboard will show 5 degree cards. Click each to see sub-courses.');
