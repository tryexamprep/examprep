-- Free-tier AI explanation daily quota columns on profiles.
-- ai_explain_count_today: resets to 0 each new day (checked + reset in code).
-- ai_explain_date: the date of the last increment (ISO 'YYYY-MM-DD').

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS ai_explain_count_today INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ai_explain_date DATE;
