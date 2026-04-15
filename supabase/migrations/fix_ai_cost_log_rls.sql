-- ====== Tighten ep_ai_cost_log RLS ======
-- The original policy allowed INSERT WITH CHECK (true), meaning authenticated
-- users could forge cost rows attributed to any user_id. Server code is the
-- only legitimate writer; switch all cost-log inserts to the service-role
-- client and revoke INSERT from authenticated/anon roles.
--
-- service_role bypasses RLS entirely, so no INSERT policy is needed for it.

DROP POLICY IF EXISTS "ep_ai_cost_log_insert_service" ON ep_ai_cost_log;

REVOKE INSERT ON ep_ai_cost_log FROM authenticated, anon;
REVOKE UPDATE ON ep_ai_cost_log FROM authenticated, anon;
REVOKE DELETE ON ep_ai_cost_log FROM authenticated, anon;

-- SELECT policy from ai_cost_log.sql is preserved: users read their own rows.
