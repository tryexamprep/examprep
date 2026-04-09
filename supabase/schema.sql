-- =====================================================
-- ExamPrep - Supabase Schema
-- =====================================================
-- Run this in your Supabase SQL Editor

-- ====== USER PROFILES ======
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT,
  email TEXT,
  -- Subscription
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'basic', 'pro', 'education')),
  plan_expires_at TIMESTAMPTZ,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  -- Usage counters (current month, reset on plan_expires_at)
  pdfs_uploaded_this_month INTEGER NOT NULL DEFAULT 0,
  ai_questions_used_this_month INTEGER NOT NULL DEFAULT 0,
  storage_bytes_used BIGINT NOT NULL DEFAULT 0,
  -- Daily counters (reset every day)
  pdfs_uploaded_today INTEGER NOT NULL DEFAULT 0,
  ai_questions_used_today INTEGER NOT NULL DEFAULT 0,
  daily_reset_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  monthly_reset_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles_select_own" ON profiles;
CREATE POLICY "profiles_select_own" ON profiles FOR SELECT USING (auth.uid() = id);

DROP POLICY IF EXISTS "profiles_insert_own" ON profiles;
CREATE POLICY "profiles_insert_own" ON profiles FOR INSERT WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "profiles_update_own" ON profiles;
CREATE POLICY "profiles_update_own" ON profiles FOR UPDATE USING (auth.uid() = id);

-- ====== COURSES ======
-- Each user can have multiple courses (e.g., "Software 1", "Calculus", "Statistics")
CREATE TABLE IF NOT EXISTS courses (
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

CREATE INDEX IF NOT EXISTS courses_user_idx ON courses(user_id);

ALTER TABLE courses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "courses_select_own" ON courses;
CREATE POLICY "courses_select_own" ON courses FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "courses_insert_own" ON courses;
CREATE POLICY "courses_insert_own" ON courses FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "courses_update_own" ON courses;
CREATE POLICY "courses_update_own" ON courses FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "courses_delete_own" ON courses;
CREATE POLICY "courses_delete_own" ON courses FOR DELETE USING (auth.uid() = user_id);

-- ====== EXAMS (uploaded PDFs) ======
CREATE TABLE IF NOT EXISTS exams (
  id BIGSERIAL PRIMARY KEY,
  course_id BIGINT REFERENCES courses(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  exam_pdf_path TEXT,
  solution_pdf_path TEXT,
  exam_pdf_hash TEXT,         -- SHA-256 to prevent duplicate uploads
  total_pages INTEGER,
  question_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS exams_course_idx ON exams(course_id);
CREATE INDEX IF NOT EXISTS exams_user_idx ON exams(user_id);
CREATE INDEX IF NOT EXISTS exams_hash_idx ON exams(user_id, exam_pdf_hash);

ALTER TABLE exams ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "exams_select_own" ON exams;
CREATE POLICY "exams_select_own" ON exams FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "exams_insert_own" ON exams;
CREATE POLICY "exams_insert_own" ON exams FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "exams_update_own" ON exams;
CREATE POLICY "exams_update_own" ON exams FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "exams_delete_own" ON exams;
CREATE POLICY "exams_delete_own" ON exams FOR DELETE USING (auth.uid() = user_id);

-- ====== QUESTIONS ======
CREATE TABLE IF NOT EXISTS questions (
  id BIGSERIAL PRIMARY KEY,
  exam_id BIGINT REFERENCES exams(id) ON DELETE CASCADE NOT NULL,
  course_id BIGINT REFERENCES courses(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  question_number INTEGER NOT NULL,
  section_label TEXT,           -- e.g., "א" or "1"
  image_path TEXT NOT NULL,     -- path in storage
  num_options INTEGER NOT NULL DEFAULT 4,
  option_labels JSONB,          -- e.g., ["מתקמפל", "לא מתקמפל"] or null for numbered
  correct_idx INTEGER NOT NULL, -- 1-based
  topic TEXT,
  is_ai_generated BOOLEAN NOT NULL DEFAULT FALSE,
  source_question_id BIGINT REFERENCES questions(id) ON DELETE SET NULL,
  general_explanation TEXT,
  option_explanations JSONB,    -- array of {idx, isCorrect, explanation}
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS questions_exam_idx ON questions(exam_id);
CREATE INDEX IF NOT EXISTS questions_course_idx ON questions(course_id);
CREATE INDEX IF NOT EXISTS questions_user_idx ON questions(user_id);

ALTER TABLE questions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "questions_select_own" ON questions;
CREATE POLICY "questions_select_own" ON questions FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "questions_insert_own" ON questions;
CREATE POLICY "questions_insert_own" ON questions FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "questions_update_own" ON questions;
CREATE POLICY "questions_update_own" ON questions FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "questions_delete_own" ON questions;
CREATE POLICY "questions_delete_own" ON questions FOR DELETE USING (auth.uid() = user_id);

-- ====== ATTEMPTS ======
CREATE TABLE IF NOT EXISTS attempts (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  question_id BIGINT REFERENCES questions(id) ON DELETE CASCADE NOT NULL,
  course_id BIGINT REFERENCES courses(id) ON DELETE CASCADE NOT NULL,
  selected_idx INTEGER,
  is_correct BOOLEAN NOT NULL DEFAULT FALSE,
  revealed BOOLEAN NOT NULL DEFAULT FALSE,
  time_seconds INTEGER,
  batch_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS attempts_user_idx ON attempts(user_id);
CREATE INDEX IF NOT EXISTS attempts_question_idx ON attempts(question_id);
CREATE INDEX IF NOT EXISTS attempts_course_idx ON attempts(course_id);

ALTER TABLE attempts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "attempts_select_own" ON attempts;
CREATE POLICY "attempts_select_own" ON attempts FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "attempts_insert_own" ON attempts;
CREATE POLICY "attempts_insert_own" ON attempts FOR INSERT WITH CHECK (auth.uid() = user_id);

-- ====== REVIEW QUEUE ======
CREATE TABLE IF NOT EXISTS review_queue (
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  question_id BIGINT REFERENCES questions(id) ON DELETE CASCADE NOT NULL,
  course_id BIGINT REFERENCES courses(id) ON DELETE CASCADE NOT NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, question_id)
);

ALTER TABLE review_queue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "review_queue_select_own" ON review_queue;
CREATE POLICY "review_queue_select_own" ON review_queue FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "review_queue_insert_own" ON review_queue;
CREATE POLICY "review_queue_insert_own" ON review_queue FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "review_queue_delete_own" ON review_queue;
CREATE POLICY "review_queue_delete_own" ON review_queue FOR DELETE USING (auth.uid() = user_id);

-- ====== USAGE LOG (for abuse tracking + debugging) ======
CREATE TABLE IF NOT EXISTS usage_log (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  action TEXT NOT NULL, -- 'pdf_upload' | 'ai_generate' | 'rate_limit_hit' | 'quota_exceeded'
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS usage_log_user_idx ON usage_log(user_id, created_at DESC);

-- Admin only - users cannot read usage_log
ALTER TABLE usage_log ENABLE ROW LEVEL SECURITY;

-- ====== HELPER: Reset daily counters ======
-- This function should be called by a cron job (or before each upload)
CREATE OR REPLACE FUNCTION reset_user_quotas_if_needed(p_user_id UUID)
RETURNS VOID AS $$
DECLARE
  prof RECORD;
BEGIN
  SELECT * INTO prof FROM profiles WHERE id = p_user_id;
  IF prof IS NULL THEN RETURN; END IF;

  -- Daily reset
  IF prof.daily_reset_at < NOW() - INTERVAL '1 day' THEN
    UPDATE profiles SET
      pdfs_uploaded_today = 0,
      ai_questions_used_today = 0,
      daily_reset_at = NOW()
    WHERE id = p_user_id;
  END IF;

  -- Monthly reset
  IF prof.monthly_reset_at < NOW() - INTERVAL '30 days' THEN
    UPDATE profiles SET
      pdfs_uploaded_this_month = 0,
      ai_questions_used_this_month = 0,
      monthly_reset_at = NOW()
    WHERE id = p_user_id;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
