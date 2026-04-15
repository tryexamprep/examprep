-- Harden trial expiry enforcement.
--
-- Before this migration, the trial→free downgrade only ran inside
-- getUserProfile() in api/crud.mjs, which is invoked only on /api/me,
-- /api/courses (create), and admin-switch-plan. Endpoints that skipped
-- getUserProfile (e.g. /api/questions/enhance-solution) could still see
-- a stale plan='trial' value for a user whose plan_expires_at had passed.
--
-- After this migration, the downgrade happens inside the RPC that is
-- already called before every paid operation (upload, generate-solution,
-- generate-solutions, enhance-solution, study/generate). This makes
-- enforcement automatic and unbypassable — no per-endpoint code change
-- needed.

CREATE OR REPLACE FUNCTION reset_user_quotas_if_needed(p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  -- (1) Expire trial → free when plan_expires_at has passed.
  UPDATE profiles
  SET plan = 'free',
      trial_used = true,
      plan_expires_at = NULL
  WHERE id = p_user_id
    AND plan = 'trial'
    AND plan_expires_at IS NOT NULL
    AND plan_expires_at < NOW();

  -- (2) Reset daily counters if rolled over.
  UPDATE profiles
  SET pdfs_uploaded_today = 0,
      ai_questions_used_today = 0,
      daily_reset_at = NOW()
  WHERE id = p_user_id
    AND daily_reset_at < (NOW() - INTERVAL '24 hours');

  -- (3) Reset monthly counters if rolled over.
  UPDATE profiles
  SET pdfs_uploaded_this_month = 0,
      ai_questions_used_this_month = 0,
      study_packs_used_this_month = 0,
      monthly_reset_at = NOW()
  WHERE id = p_user_id
    AND monthly_reset_at < (NOW() - INTERVAL '30 days');
END;
$$;

-- Re-grant execute since CREATE OR REPLACE preserves grants but being explicit
-- is safer across Postgres versions.
REVOKE ALL ON FUNCTION reset_user_quotas_if_needed(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reset_user_quotas_if_needed(UUID) TO service_role;
