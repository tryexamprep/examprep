-- Track whether each question's correct_idx was confidently extracted
-- by Gemini, manually set by the user, or unknown (extraction failed).
-- Used by the frontend to show a warning ⚠️ badge and a manual override
-- dropdown when the auto-extraction didn't find a confident answer.

ALTER TABLE ep_questions
  ADD COLUMN IF NOT EXISTS answer_confidence TEXT NOT NULL DEFAULT 'confirmed'
    CHECK (answer_confidence IN ('confirmed', 'unknown', 'manual'));

-- Backfill: existing questions were inserted before this column existed.
-- Mark them as 'confirmed' (the default) since we can't retroactively tell
-- which were extraction-failures. Users who re-upload will get accurate data.
