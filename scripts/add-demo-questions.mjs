// =============================================================
// add-demo-questions.mjs
// Adds ALL remaining exams+questions from static JSON to the
// demo user's "תוכנה 1" sub-course (skips exams already there).
// Also fixes ביולוגיה and משפטים degree-card images.
//
// Run:
//   node --env-file=.env.local scripts/add-demo-questions.mjs
// =============================================================

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const metadata   = JSON.parse(readFileSync(join(__dir, '../public/data/metadata.json'),  'utf8'));
const answersRaw = JSON.parse(readFileSync(join(__dir, '../public/data/answers.json'),   'utf8'));
const answers    = answersRaw.answers;

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const DEMO_EMAIL    = 'demo@examprep.co';
const BASE_IMG_URL  = 'https://tohna1-quiz.vercel.app/images/';

// Encode only non-ASCII characters (e.g. Hebrew letters in filenames)
function buildImageUrl(imagePath) {
  return BASE_IMG_URL + imagePath.replace(/[^\x00-\x7F]/g, c => encodeURIComponent(c));
}

// ── Find demo user ────────────────────────────────────────────
const { data: { users } } = await sb.auth.admin.listUsers();
const demo = users?.find(u => u.email === DEMO_EMAIL);
if (!demo) { console.error('Demo user not found.'); process.exit(1); }
const uid = demo.id;
console.log(`Demo user: ${uid}`);

// ── Load all courses for the demo user ────────────────────────
const { data: courses, error: cErr } = await sb
  .from('ep_courses')
  .select('id,name,parent_id,is_degree')
  .eq('user_id', uid);
if (cErr) { console.error('Could not fetch courses:', cErr.message); process.exit(1); }

// ── Find מדעי המחשב degree ────────────────────────────────────
const csDegree = courses.find(c => c.name === 'מדעי המחשב' && !c.parent_id);
if (!csDegree) { console.error('"מדעי המחשב" degree not found'); process.exit(1); }
console.log(`מדעי המחשב ID: ${csDegree.id}`);

// ── Find תוכנה 1 sub-course ────────────────────────────────────
const tohua1 = courses.find(c => c.name === 'תוכנה 1' && c.parent_id === csDegree.id);
if (!tohua1) { console.error('"תוכנה 1" sub-course not found under מדעי המחשב'); process.exit(1); }
const subId = tohua1.id;
console.log(`תוכנה 1 sub-course ID: ${subId}`);

// ── Get existing exam names in that sub-course ─────────────────
const { data: existingExams } = await sb
  .from('ep_exams')
  .select('id,name')
  .eq('course_id', subId)
  .is('deleted_at', null);
const existingNames = new Set((existingExams || []).map(e => e.name));
console.log(`\nExisting exams (${existingNames.size}): ${[...existingNames].join(', ')}`);

// ── Insert each missing exam ────────────────────────────────────
let addedExams = 0;
let addedQuestions = 0;

console.log('\n── Adding missing exams ──');
for (const exam of metadata.exams) {
  if (existingNames.has(exam.label)) {
    console.log(`  skip: "${exam.label}"`);
    continue;
  }

  const qCount = exam.questions.length;

  // Insert exam row
  const { data: newExam, error: examErr } = await sb
    .from('ep_exams')
    .insert({
      course_id:      subId,
      user_id:        uid,
      name:           exam.label,
      status:         'ready',
      question_count: qCount,
      processed_at:   new Date().toISOString(),
    })
    .select('id')
    .single();

  if (examErr) {
    console.error(`  ERROR creating exam "${exam.label}": ${examErr.message}`);
    continue;
  }

  console.log(`  + "${exam.label}" (id=${newExam.id}, ${qCount}q)`);
  addedExams++;

  // Build question rows
  const rows = exam.questions.map(q => {
    const ans = answers[q.id] || {};
    return {
      exam_id:        newExam.id,
      course_id:      subId,
      user_id:        uid,
      question_number: q.orderIdx,
      section_label:  q.section,
      image_path:     buildImageUrl(q.image),
      num_options:    ans.numOptions  ?? 4,
      option_labels:  ans.optionLabels ?? null,
      correct_idx:    ans.correctIdx  ?? 1,
      topic:          ans.topic       ?? null,
    };
  });

  const { error: qErr } = await sb.from('ep_questions').insert(rows);
  if (qErr) {
    console.error(`  ERROR inserting questions for "${exam.label}": ${qErr.message}`);
    continue;
  }
  addedQuestions += rows.length;
}

console.log(`\n✓ Added ${addedExams} exams, ${addedQuestions} questions to "תוכנה 1"`);

// ── Fix degree images for ביולוגיה and משפטים ─────────────────
const _UNS = id => `https://images.unsplash.com/photo-${id}?w=88&h=88&fit=crop&auto=format`;

const imageFixes = [
  // DNA/cell microscopy — clearly biological
  { name: 'ביולוגיה', imageUrl: _UNS('1559757148-5c350d0d3c56') },
  // Open law book / gavel — clearly legal
  { name: 'משפטים',  imageUrl: _UNS('1589994965851-a8f479c573a9') },
];

console.log('\n── Fixing degree images ──');
for (const fix of imageFixes) {
  const course = courses.find(c => c.name === fix.name && !c.parent_id);
  if (!course) { console.log(`  "${fix.name}" not found — skipping`); continue; }
  const { error } = await sb
    .from('ep_courses')
    .update({ image_url: fix.imageUrl })
    .eq('id', course.id);
  if (error) console.error(`  ERROR updating "${fix.name}": ${error.message}`);
  else       console.log(`  ✓ "${fix.name}" image updated (id=${course.id})`);
}

console.log('\n✅  add-demo-questions complete!');
console.log(`   Total in "תוכנה 1": ${existingNames.size + addedExams} exams`);
