-- =====================================================
-- ExamPrep - Supabase Schema (with ep_ prefix to coexist with other apps)
-- =====================================================
-- Run this in your Supabase SQL Editor

-- ====== EXTEND PROFILES (or create if doesn't exist) ======
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username TEXT UNIQUE,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add ExamPrep-specific columns (safe to run multiple times)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS plan_expires_at TIMESTAMPTZ;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS pdfs_uploaded_this_month INTEGER NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS ai_questions_used_this_month INTEGER NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS storage_bytes_used BIGINT NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS pdfs_uploaded_today INTEGER NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS ai_questions_used_today INTEGER NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS daily_reset_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS monthly_reset_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Make sure RLS is on
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles_select_own" ON profiles;
CREATE POLICY "profiles_select_own" ON profiles FOR SELECT USING (auth.uid() = id);

DROP POLICY IF EXISTS "profiles_insert_own" ON profiles;
CREATE POLICY "profiles_insert_own" ON profiles FOR INSERT WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "profiles_update_own" ON profiles;
CREATE POLICY "profiles_update_own" ON profiles FOR UPDATE USING (auth.uid() = id);

-- ====== EP_COURSES ======
CREATE TABLE IF NOT EXISTS ep_courses (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  color TEXT DEFAULT '#3b82f6',
  total_questions INTEGER NOT NULL DEFAULT 0,
  total_pdfs INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ep_courses_user_idx ON ep_courses(user_id);

ALTER TABLE ep_courses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ep_courses_select_own" ON ep_courses;
CREATE POLICY "ep_courses_select_own" ON ep_courses FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "ep_courses_insert_own" ON ep_courses;
CREATE POLICY "ep_courses_insert_own" ON ep_courses FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "ep_courses_update_own" ON ep_courses;
CREATE POLICY "ep_courses_update_own" ON ep_courses FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "ep_courses_delete_own" ON ep_courses;
CREATE POLICY "ep_courses_delete_own" ON ep_courses FOR DELETE USING (auth.uid() = user_id);

-- ====== EP_EXAMS ======
CREATE TABLE IF NOT EXISTS ep_exams (
  id BIGSERIAL PRIMARY KEY,
  course_id BIGINT REFERENCES ep_courses(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  exam_pdf_path TEXT,
  solution_pdf_path TEXT,
  exam_pdf_hash TEXT,
  total_pages INTEGER,
  question_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ep_exams_course_idx ON ep_exams(course_id);
CREATE INDEX IF NOT EXISTS ep_exams_user_idx ON ep_exams(user_id);
CREATE INDEX IF NOT EXISTS ep_exams_hash_idx ON ep_exams(user_id, exam_pdf_hash);

ALTER TABLE ep_exams ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ep_exams_select_own" ON ep_exams;
CREATE POLICY "ep_exams_select_own" ON ep_exams FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "ep_exams_insert_own" ON ep_exams;
CREATE POLICY "ep_exams_insert_own" ON ep_exams FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "ep_exams_update_own" ON ep_exams;
CREATE POLICY "ep_exams_update_own" ON ep_exams FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "ep_exams_delete_own" ON ep_exams;
CREATE POLICY "ep_exams_delete_own" ON ep_exams FOR DELETE USING (auth.uid() = user_id);

-- ====== EP_QUESTIONS ======
CREATE TABLE IF NOT EXISTS ep_questions (
  id BIGSERIAL PRIMARY KEY,
  exam_id BIGINT REFERENCES ep_exams(id) ON DELETE CASCADE NOT NULL,
  course_id BIGINT REFERENCES ep_courses(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  question_number INTEGER NOT NULL,
  section_label TEXT,
  image_path TEXT NOT NULL,
  num_options INTEGER NOT NULL DEFAULT 4,
  option_labels JSONB,
  correct_idx INTEGER NOT NULL,
  topic TEXT,
  is_ai_generated BOOLEAN NOT NULL DEFAULT FALSE,
  source_question_id BIGINT REFERENCES ep_questions(id) ON DELETE SET NULL,
  general_explanation TEXT,
  option_explanations JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ep_questions_exam_idx ON ep_questions(exam_id);
CREATE INDEX IF NOT EXISTS ep_questions_course_idx ON ep_questions(course_id);

ALTER TABLE ep_questions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ep_questions_select_own" ON ep_questions;
CREATE POLICY "ep_questions_select_own" ON ep_questions FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "ep_questions_insert_own" ON ep_questions;
CREATE POLICY "ep_questions_insert_own" ON ep_questions FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "ep_questions_update_own" ON ep_questions;
CREATE POLICY "ep_questions_update_own" ON ep_questions FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "ep_questions_delete_own" ON ep_questions;
CREATE POLICY "ep_questions_delete_own" ON ep_questions FOR DELETE USING (auth.uid() = user_id);

-- ====== EP_ATTEMPTS ======
CREATE TABLE IF NOT EXISTS ep_attempts (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  question_id BIGINT REFERENCES ep_questions(id) ON DELETE CASCADE NOT NULL,
  course_id BIGINT REFERENCES ep_courses(id) ON DELETE CASCADE NOT NULL,
  selected_idx INTEGER,
  is_correct BOOLEAN NOT NULL DEFAULT FALSE,
  revealed BOOLEAN NOT NULL DEFAULT FALSE,
  time_seconds INTEGER,
  batch_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ep_attempts_user_idx ON ep_attempts(user_id);
CREATE INDEX IF NOT EXISTS ep_attempts_question_idx ON ep_attempts(question_id);

ALTER TABLE ep_attempts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ep_attempts_select_own" ON ep_attempts;
CREATE POLICY "ep_attempts_select_own" ON ep_attempts FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "ep_attempts_insert_own" ON ep_attempts;
CREATE POLICY "ep_attempts_insert_own" ON ep_attempts FOR INSERT WITH CHECK (auth.uid() = user_id);

-- ====== EP_REVIEW_QUEUE ======
CREATE TABLE IF NOT EXISTS ep_review_queue (
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  question_id BIGINT REFERENCES ep_questions(id) ON DELETE CASCADE NOT NULL,
  course_id BIGINT REFERENCES ep_courses(id) ON DELETE CASCADE NOT NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, question_id)
);

ALTER TABLE ep_review_queue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ep_review_queue_select_own" ON ep_review_queue;
CREATE POLICY "ep_review_queue_select_own" ON ep_review_queue FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "ep_review_queue_insert_own" ON ep_review_queue;
CREATE POLICY "ep_review_queue_insert_own" ON ep_review_queue FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "ep_review_queue_delete_own" ON ep_review_queue;
CREATE POLICY "ep_review_queue_delete_own" ON ep_review_queue FOR DELETE USING (auth.uid() = user_id);
