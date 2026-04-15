-- ====== AI Cost Log ======
-- Tracks every Gemini API call with token counts and cost.
-- Used for budget monitoring and per-user cost analysis.
CREATE TABLE IF NOT EXISTS ep_ai_cost_log (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,              -- 'upload' | 'generate-solution' | 'ai-similar' etc
  exam_id BIGINT,                       -- optional FK (no constraint, soft reference)
  question_id BIGINT,                   -- optional FK (no constraint, soft reference)
  model TEXT,                           -- 'gemini-2.5-flash' etc
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd NUMERIC(10, 6) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ep_ai_cost_log_user_idx ON ep_ai_cost_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ep_ai_cost_log_created_idx ON ep_ai_cost_log(created_at DESC);

ALTER TABLE ep_ai_cost_log ENABLE ROW LEVEL SECURITY;

-- Users can see their own cost logs (read-only)
DROP POLICY IF EXISTS "ep_ai_cost_log_select_own" ON ep_ai_cost_log;
CREATE POLICY "ep_ai_cost_log_select_own" ON ep_ai_cost_log FOR SELECT USING (auth.uid() = user_id);

-- Only server (service_role) can insert
DROP POLICY IF EXISTS "ep_ai_cost_log_insert_service" ON ep_ai_cost_log;
CREATE POLICY "ep_ai_cost_log_insert_service" ON ep_ai_cost_log FOR INSERT WITH CHECK (true);

-- Helper function: current month's total cost across all users (for admin budget monitoring)
CREATE OR REPLACE FUNCTION ep_ai_cost_this_month()
RETURNS NUMERIC
LANGUAGE sql SECURITY DEFINER
AS $$
  SELECT COALESCE(SUM(cost_usd), 0)::numeric
  FROM ep_ai_cost_log
  WHERE created_at >= date_trunc('month', NOW());
$$;

GRANT EXECUTE ON FUNCTION ep_ai_cost_this_month() TO authenticated, service_role;

COMMENT ON TABLE ep_ai_cost_log IS 'AI/Gemini API call log for cost tracking and budget alerts';
