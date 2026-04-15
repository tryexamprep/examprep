-- Add course_id and materials JSONB to ep_study_packs
ALTER TABLE ep_study_packs
  ADD COLUMN IF NOT EXISTS course_id BIGINT REFERENCES ep_courses(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS materials JSONB;

CREATE INDEX IF NOT EXISTS idx_ep_study_packs_course_id ON ep_study_packs(course_id);
