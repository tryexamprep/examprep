-- Degree→Courses two-level hierarchy
-- Run manually in Supabase SQL editor (Dashboard → SQL Editor → New query)

ALTER TABLE ep_courses
  ADD COLUMN IF NOT EXISTS parent_id BIGINT REFERENCES ep_courses(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS is_degree BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_ep_courses_parent_id ON ep_courses(parent_id);
