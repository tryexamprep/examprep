-- Add 'uncertain' as a valid answer_confidence value.
--
-- Context: the upload pipeline now cross-verifies extracted answers with
-- a second AI model (Groq) after Gemini pulls them from the solution PDF.
-- When the two models disagree, we store 'uncertain' instead of 'confirmed'
-- so the UI can surface a warning to the user.

ALTER TABLE ep_questions
  DROP CONSTRAINT IF EXISTS ep_questions_answer_confidence_check;

ALTER TABLE ep_questions
  ADD CONSTRAINT ep_questions_answer_confidence_check
  CHECK (answer_confidence IN ('confirmed', 'unknown', 'manual', 'uncertain'));
