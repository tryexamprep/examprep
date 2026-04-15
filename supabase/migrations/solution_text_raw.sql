-- Text-first solution pipeline: add raw solution text column
-- Stores the text extracted from the user's solution PDF for each question.
-- Used by the enhance-solution endpoint to ground AI explanations in the
-- user's actual solution key rather than asking AI to guess.

ALTER TABLE ep_questions ADD COLUMN IF NOT EXISTS solution_text_raw TEXT;

-- Note: question_text and options_text columns already exist in schema.sql
-- (see ep_questions table definition, lines 155-156) and were previously unused.
-- This migration completes the set.
