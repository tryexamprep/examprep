// =====================================================
// Create a demo user for product walkthrough videos.
// Run: node --env-file=.env scripts/create-demo-user.mjs
//
// Idempotent — safe to run multiple times.
// =====================================================

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.');
  console.error('Run with: node --env-file=.env scripts/create-demo-user.mjs');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

// ───────────────────────────────────────────────────────────
// Demo user config
// ───────────────────────────────────────────────────────────
const DEMO_EMAIL    = 'demo@examprep.co';
const DEMO_PASSWORD = 'ExamPrep2025!';
const DISPLAY_NAME  = 'Free Trial';

// ───────────────────────────────────────────────────────────
// Courses (5 total — only CS has real questions)
// ───────────────────────────────────────────────────────────
const COURSES = [
  { name: 'תוכנה 1',   description: 'מדעי המחשב — Java, Generics, Streams, OOP',          color: '#2563eb', hasContent: true  },
  { name: 'ביולוגיה',   description: 'תאים, גנטיקה, פיזיולוגיה ואבולוציה',                color: '#16a34a', hasContent: false },
  { name: 'כימיה',      description: 'כימיה אורגנית, תרמודינמיקה ואלקטרוכימיה',            color: '#7c3aed', hasContent: false },
  { name: 'משפטים',     description: 'דיני חוזים, נזיקין ומשפט מנהלי',                    color: '#dc2626', hasContent: false },
  { name: 'פיזיקה',     description: 'מכניקה, אלקטרומגנטיות ומכניקת קוונטים',            color: '#d97706', hasContent: false },
];

// ───────────────────────────────────────────────────────────
// CS exam data — 3 exams, 23 questions total
// Images served from tohna1-quiz.vercel.app (no university branding)
// ───────────────────────────────────────────────────────────
function imgUrl(examId, n, section) {
  const nn = String(n).padStart(2, '0');
  return `https://tohna1-quiz.vercel.app/images/${examId}/q-${nn}_${encodeURIComponent(section)}.png`;
}

const CS_EXAMS = [
  {
    label: 'מועד א, סמסטר א, 2024',
    examId: 'moed_a_sem_a_2024',
    questions: [
      { n: 1, s: 'א', opts: 2, labels: ['מתקמפל', 'לא מתקמפל'], ans: 2, topic: 'Method Overloading + Generics'           },
      { n: 2, s: 'ב', opts: 2, labels: ['מתקמפל', 'לא מתקמפל'], ans: 2, topic: 'Method Overloading + Wildcards'          },
      { n: 3, s: 'ג', opts: 3, labels: null,                      ans: 2, topic: 'Inner Classes + Generics'               },
      { n: 4, s: 'ד', opts: 3, labels: null,                      ans: 2, topic: 'Wildcards (extends/super)'              },
      { n: 5, s: 'ה', opts: 3, labels: null,                      ans: 1, topic: 'Streams (peek/sorted/forEach)'         },
      { n: 6, s: 'ו', opts: 2, labels: ['מנשק פונקציונלי', 'אינו מנשק פונקציונלי'], ans: 2, topic: 'Functional Interfaces' },
      { n: 7, s: 'ז', opts: 4, labels: null,                      ans: 1, topic: 'Constructor + Method Overriding'       },
      { n: 8, s: 'ח', opts: 4, labels: null,                      ans: 2, topic: 'private vs public Method Resolution'   },
    ],
  },
  {
    label: 'מועד א, סמסטר א, 2025',
    examId: 'moed_a_sem_a_2025',
    questions: [
      { n: 1, s: 'א', opts: 4, labels: null, ans: 1, topic: 'Visibility (private vs public)'      },
      { n: 2, s: 'ב', opts: 3, labels: null, ans: 1, topic: 'Generics'                            },
      { n: 3, s: 'ג', opts: 3, labels: null, ans: 2, topic: 'Wildcards in Method Parameters'      },
      { n: 4, s: 'ד', opts: 3, labels: null, ans: 3, topic: 'Streams + Predicate'                 },
      { n: 5, s: 'ה', opts: 4, labels: null, ans: 2, topic: 'Exceptions'                          },
      { n: 6, s: 'ו', opts: 4, labels: null, ans: 4, topic: 'Constructors + null reference'       },
      { n: 7, s: 'ז', opts: 4, labels: null, ans: 3, topic: 'Method Overriding'                   },
    ],
  },
  {
    label: 'מועד ב, סמסטר א, 2024',
    examId: 'moed_b_sem_a_2024',
    questions: [
      { n: 1, s: 'א', opts: 4, labels: null,                      ans: 2, topic: 'Static + Instance Methods'             },
      { n: 2, s: 'ב', opts: 2, labels: ['מתקמפל', 'לא מתקמפל'], ans: 2, topic: 'Wildcards in Generics'                 },
      { n: 3, s: 'ג', opts: 4, labels: null,                      ans: 3, topic: 'Interfaces + multiple inheritance'     },
      { n: 4, s: 'ד', opts: 4, labels: null,                      ans: 1, topic: 'Streams (filter/map/peek)'             },
      { n: 5, s: 'ה', opts: 2, labels: ['מתקמפל', 'לא מתקמפל'], ans: 1, topic: 'Generics + List<Object>'               },
      { n: 6, s: 'ו', opts: 2, labels: ['מתקמפל', 'לא מתקמפל'], ans: 2, topic: 'Generics + List<String>'               },
      { n: 7, s: 'ז', opts: 4, labels: null,                      ans: 2, topic: 'Method Overriding (private)'          },
      { n: 8, s: 'ח', opts: 4, labels: null,                      ans: 1, topic: 'Method Overriding (private)'          },
    ],
  },
];

// ───────────────────────────────────────────────────────────
// Main
// ───────────────────────────────────────────────────────────
async function run() {
  // 1. Create user (or find existing)
  let userId;
  console.log(`Creating user ${DEMO_EMAIL}...`);
  const { data: created, error: createErr } = await sb.auth.admin.createUser({
    email: DEMO_EMAIL,
    password: DEMO_PASSWORD,
    email_confirm: true,
  });

  if (createErr) {
    if (createErr.message?.includes('already been registered') || createErr.code === 'email_exists') {
      console.log('  User already exists — looking up ID...');
      const { data: list } = await sb.auth.admin.listUsers();
      const existing = list?.users?.find(u => u.email === DEMO_EMAIL);
      if (!existing) { console.error('Cannot find existing user.'); process.exit(1); }
      userId = existing.id;
    } else {
      console.error('Failed to create user:', createErr.message);
      process.exit(1);
    }
  } else {
    userId = created.user.id;
    console.log(`  Created: ${userId}`);
  }

  // 2. Upgrade profile to pro with 2-year expiry
  console.log('Upgrading profile to pro...');
  const expiresAt = new Date(Date.now() + 2 * 365 * 24 * 60 * 60 * 1000).toISOString();
  const { error: profErr } = await sb
    .from('profiles')
    .update({ plan: 'pro', plan_expires_at: expiresAt, display_name: DISPLAY_NAME })
    .eq('id', userId);
  if (profErr) { console.error('Profile update failed:', profErr.message); process.exit(1); }
  console.log('  Done.');

  // 3. Create courses (skip if already present for this user)
  console.log('Creating courses...');
  const { data: existingCourses } = await sb.from('ep_courses').select('name').eq('user_id', userId);
  const existingNames = new Set((existingCourses || []).map(c => c.name));

  let csCourseId = null;

  for (const course of COURSES) {
    if (existingNames.has(course.name)) {
      console.log(`  "${course.name}" already exists — skipping.`);
      if (course.hasContent) {
        const { data: row } = await sb.from('ep_courses').select('id').eq('user_id', userId).eq('name', course.name).single();
        csCourseId = row?.id;
      }
      continue;
    }
    const totalQ = course.hasContent ? CS_EXAMS.reduce((sum, e) => sum + e.questions.length, 0) : 0;
    const totalP = course.hasContent ? CS_EXAMS.length : 0;
    const { data: row, error: cErr } = await sb
      .from('ep_courses')
      .insert({ user_id: userId, name: course.name, description: course.description, color: course.color, total_questions: totalQ, total_pdfs: totalP })
      .select('id')
      .single();
    if (cErr) { console.error(`  Failed to create "${course.name}":`, cErr.message); process.exit(1); }
    console.log(`  Created "${course.name}" (id ${row.id})`);
    if (course.hasContent) csCourseId = row.id;
  }

  if (!csCourseId) { console.error('CS course ID not found.'); process.exit(1); }

  // 4. Insert exams + questions for CS course (skip if exams already exist)
  console.log('Inserting CS exams and questions...');
  const { data: existingExams } = await sb.from('ep_exams').select('name').eq('course_id', csCourseId);
  const existingExamNames = new Set((existingExams || []).map(e => e.name));

  for (const exam of CS_EXAMS) {
    if (existingExamNames.has(exam.label)) {
      console.log(`  Exam "${exam.label}" already exists — skipping.`);
      continue;
    }

    const { data: examRow, error: eErr } = await sb
      .from('ep_exams')
      .insert({
        course_id: csCourseId,
        user_id: userId,
        name: exam.label,
        status: 'ready',
        question_count: exam.questions.length,
        processed_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (eErr) { console.error(`  Failed to create exam "${exam.label}":`, eErr.message); process.exit(1); }

    const examId = examRow.id;
    const qRows = exam.questions.map(q => ({
      exam_id: examId,
      course_id: csCourseId,
      user_id: userId,
      question_number: q.n,
      section_label: q.s,
      image_path: imgUrl(exam.examId, q.n, q.s),
      num_options: q.opts,
      option_labels: q.labels ?? null,
      correct_idx: q.ans,
      topic: q.topic,
    }));

    const { error: qErr } = await sb.from('ep_questions').insert(qRows);
    if (qErr) { console.error(`  Failed to insert questions for "${exam.label}":`, qErr.message); process.exit(1); }
    console.log(`  "${exam.label}" — ${exam.questions.length} questions inserted.`);
  }

  // ───────────────────────────────────────────────────────
  console.log('\n✅  Demo user ready!\n');
  console.log('  Email:    ', DEMO_EMAIL);
  console.log('  Password: ', DEMO_PASSWORD);
  console.log('  Plan:     ', 'pro (expires', expiresAt.slice(0, 10), ')');
  console.log('  URL:       https://try.examprep.com\n');
}

run().catch(err => { console.error(err); process.exit(1); });
