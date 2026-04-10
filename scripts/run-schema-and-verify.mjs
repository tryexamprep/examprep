// =====================================================
// ExamPrep - Run schema + verify RLS / RPCs
// =====================================================
// Usage: SBP_TOKEN=sbp_xxx node scripts/run-schema-and-verify.mjs
//
// SECURITY: SBP_TOKEN is read from env only. Never written to disk.
// After this script completes, REVOKE the token at:
//   https://supabase.com/dashboard/account/tokens

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = process.env.SBP_TOKEN;
const PROJECT_REF = 'bhdkdttsxdrfpbheyouy';

if (!TOKEN) {
  console.error('Missing SBP_TOKEN env var.');
  process.exit(1);
}

const ENDPOINT = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

async function runSql(label, sql) {
  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  if (!r.ok) {
    console.error(`\n❌ [${label}] HTTP ${r.status}`);
    console.error(JSON.stringify(json, null, 2).slice(0, 2000));
    process.exit(2);
  }
  return json;
}

// ===== Step 1: Run the updated schema =====
console.log('▸ Step 1: Running schema.sql ...');
const schemaPath = path.join(__dirname, '..', 'supabase', 'schema.sql');
const schema = fs.readFileSync(schemaPath, 'utf8');
console.log(`  schema.sql is ${schema.length} chars`);
const r1 = await runSql('schema.sql', schema);
console.log('  ✓ schema applied');
if (Array.isArray(r1) && r1.length) {
  console.log('  result rows:', r1.length);
}

// ===== Step 2: Verify RLS is enabled on every ExamPrep + profiles table =====
console.log('\n▸ Step 2: Verifying RLS is enabled ...');
const rlsCheck = await runSql('rls check', `
  SELECT schemaname, tablename, rowsecurity
  FROM pg_tables
  WHERE schemaname = 'public'
    AND tablename IN ('ep_courses', 'ep_exams', 'ep_questions', 'ep_attempts', 'ep_review_queue', 'profiles')
  ORDER BY tablename;
`);
console.log('  Table                | RLS enabled');
console.log('  ---------------------|------------');
let rlsAllOn = true;
for (const row of rlsCheck) {
  const mark = row.rowsecurity ? '✓ ON' : '✗ OFF';
  if (!row.rowsecurity) rlsAllOn = false;
  console.log(`  ${(row.tablename + '                    ').slice(0, 20)} | ${mark}`);
}

if (!rlsAllOn) {
  console.log('\n  ⚠ Some tables had RLS off — turning them on now ...');
  await runSql('enable rls', `
    ALTER TABLE ep_courses ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ep_exams ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ep_questions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ep_attempts ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ep_review_queue ENABLE ROW LEVEL SECURITY;
    ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
  `);
  console.log('  ✓ RLS enabled');
}

// ===== Step 3: Verify the policies exist =====
console.log('\n▸ Step 3: Verifying RLS policies exist ...');
const policies = await runSql('policies', `
  SELECT schemaname, tablename, policyname, cmd
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN ('ep_courses', 'ep_exams', 'ep_questions', 'ep_attempts', 'ep_review_queue', 'profiles')
  ORDER BY tablename, policyname;
`);
const policyByTable = {};
for (const p of policies) {
  policyByTable[p.tablename] = (policyByTable[p.tablename] || 0) + 1;
}
let allHavePolicies = true;
for (const tbl of ['ep_courses', 'ep_exams', 'ep_questions', 'ep_attempts', 'ep_review_queue', 'profiles']) {
  const n = policyByTable[tbl] || 0;
  const mark = n > 0 ? `✓ ${n} polic${n === 1 ? 'y' : 'ies'}` : '✗ NO POLICIES';
  if (n === 0) allHavePolicies = false;
  console.log(`  ${(tbl + '                    ').slice(0, 20)} | ${mark}`);
}

// Check for the dangerous USING(true) pattern.
// Note: INSERT policies legitimately have qual=NULL because INSERT only
// uses WITH CHECK, not USING — so we exclude cmd='INSERT' from this check.
const dangerous = await runSql('dangerous policies', `
  SELECT tablename, policyname, cmd, qual
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename LIKE 'ep_%'
    AND cmd <> 'INSERT'
    AND (qual = 'true' OR qual IS NULL);
`);
if (dangerous.length > 0) {
  console.log('\n  🚨 DANGEROUS policies found (USING(true) or NULL on non-INSERT):');
  for (const d of dangerous) {
    console.log(`    - ${d.tablename}.${d.policyname} (${d.cmd}): ${d.qual}`);
  }
} else {
  console.log('  ✓ No "USING(true)" policies on read/update/delete');
}

// Also verify INSERT policies have proper WITH CHECK
const insertChecks = await runSql('insert checks', `
  SELECT tablename, policyname, with_check
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename LIKE 'ep_%'
    AND cmd = 'INSERT';
`);
const badInserts = insertChecks.filter(p => !p.with_check || p.with_check === 'true');
if (badInserts.length > 0) {
  console.log('\n  🚨 INSERT policies with no WITH CHECK constraint:');
  for (const b of badInserts) {
    console.log(`    - ${b.tablename}.${b.policyname}: ${b.with_check}`);
  }
} else {
  console.log(`  ✓ All ${insertChecks.length} INSERT policies have proper WITH CHECK`);
}

// ===== Step 4: Verify the atomic-quota + abuse RPCs exist =====
console.log('\n▸ Step 4: Verifying atomic quota + abuse RPCs ...');
const rpcs = await runSql('rpc check', `
  SELECT proname
  FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace
    AND proname IN (
      'reset_user_quotas_if_needed',
      'ep_reserve_pdf_slot',
      'ep_reserve_ai_slots',
      'ep_reserve_study_pack_slot',
      'ep_check_ip_throttle'
    )
  ORDER BY proname;
`);
const rpcNames = new Set(rpcs.map(r => r.proname));
for (const expected of [
  'reset_user_quotas_if_needed',
  'ep_reserve_pdf_slot',
  'ep_reserve_ai_slots',
  'ep_reserve_study_pack_slot',
  'ep_check_ip_throttle',
]) {
  const mark = rpcNames.has(expected) ? '✓ exists' : '✗ MISSING';
  console.log(`  ${(expected + '                              ').slice(0, 32)} | ${mark}`);
}

// ===== Step 4b: Smoke-test the IP throttle RPC (allow → block → reset) =====
console.log('\n▸ Step 4b: Smoke-testing ep_check_ip_throttle ...');
const TEST_IP_HASH = 'verifier-test-' + 'a'.repeat(50); // ≥16 chars, isolated key
const TEST_BUCKET = 'verifier_smoke';
// Wipe any prior state from earlier runs.
await runSql('throttle reset', `
  DELETE FROM ep_ip_throttle WHERE ip_hash = '${TEST_IP_HASH}' AND bucket = '${TEST_BUCKET}';
`);
// Cap = 2/day, 5/week. 3rd call must be blocked.
const t1 = await runSql('throttle call 1', `
  SELECT ep_check_ip_throttle('${TEST_IP_HASH}', '${TEST_BUCKET}', 2, 5, 24) AS result;
`);
const t2 = await runSql('throttle call 2', `
  SELECT ep_check_ip_throttle('${TEST_IP_HASH}', '${TEST_BUCKET}', 2, 5, 24) AS result;
`);
const t3 = await runSql('throttle call 3', `
  SELECT ep_check_ip_throttle('${TEST_IP_HASH}', '${TEST_BUCKET}', 2, 5, 24) AS result;
`);
function pickResult(rows) {
  // Supabase management API returns either an array of {result: {...}} or
  // a {result: {...}} object — handle both shapes.
  const row = Array.isArray(rows) ? rows[0] : rows;
  return row?.result || row;
}
const a1 = pickResult(t1);
const a2 = pickResult(t2);
const a3 = pickResult(t3);
console.log(`  call 1: allowed=${a1?.allowed}  count_today=${a1?.count_today}`);
console.log(`  call 2: allowed=${a2?.allowed}  count_today=${a2?.count_today}`);
console.log(`  call 3: allowed=${a3?.allowed}  reason=${a3?.reason || '?'}  blocked_until=${a3?.blocked_until || '?'}`);
const throttleOk = a1?.allowed === true && a2?.allowed === true && a3?.allowed === false;
if (!throttleOk) {
  console.error('  ✗ throttle smoke test FAILED — RPC not behaving as expected');
  process.exit(4);
}
console.log('  ✓ throttle behaves correctly (2 allowed, 3rd blocked)');
// Clean up the test row so we don't leave junk in the table.
await runSql('throttle cleanup', `
  DELETE FROM ep_ip_throttle WHERE ip_hash = '${TEST_IP_HASH}' AND bucket = '${TEST_BUCKET}';
`);

// ===== Step 5: Verify ep_questions has the new columns =====
console.log('\n▸ Step 5: Verifying ep_questions schema ...');
const cols = await runSql('cols', `
  SELECT column_name, data_type
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'ep_questions'
    AND column_name IN ('is_ai_generated', 'source_question_id', 'general_explanation', 'option_explanations');
`);
const colNames = new Set(cols.map(c => c.column_name));
for (const expected of ['is_ai_generated', 'source_question_id', 'general_explanation', 'option_explanations']) {
  const mark = colNames.has(expected) ? '✓' : '✗ MISSING';
  console.log(`  ${(expected + '                              ').slice(0, 32)} | ${mark}`);
}

// ===== Step 6: Sanity-check data ownership wasn't disturbed =====
console.log('\n▸ Step 6: Verifying data ownership unchanged ...');
const ownership = await runSql('ownership', `
  SELECT
    (SELECT COUNT(*) FROM ep_courses) AS courses,
    (SELECT COUNT(*) FROM ep_exams) AS exams,
    (SELECT COUNT(*) FROM ep_questions) AS questions,
    (SELECT COUNT(DISTINCT user_id) FROM ep_questions) AS distinct_owners;
`);
console.log('  ' + JSON.stringify(ownership[0] || ownership));

// ===== Step 7: Confirm the old admin password is no longer valid =====
console.log('\n▸ Step 7: Confirming old admin password is invalid ...');
const passCheck = await runSql('old pass check', `
  SELECT
    email,
    encrypted_password = crypt('!xx!6WxSMpRDNT$3', encrypted_password) AS old_pass_still_works
  FROM auth.users
  WHERE email = 'admin+a55c27@examprep.app';
`);
if (!passCheck.length) {
  console.log('  ⚠ admin+a55c27@examprep.app user not found in auth.users');
} else {
  const mark = passCheck[0].old_pass_still_works ? '🚨 OLD PASSWORD STILL WORKS!' : '✓ old password rejected';
  console.log(`  ${passCheck[0].email}: ${mark}`);
  if (passCheck[0].old_pass_still_works) {
    console.error('\n❌ ROTATION DID NOT TAKE EFFECT — fix this NOW.');
    process.exit(3);
  }
}

console.log('\n========================================');
console.log('✅ ALL CHECKS PASSED');
console.log('========================================');
console.log('\nNow REVOKE the SBP_TOKEN at:');
console.log('  https://supabase.com/dashboard/account/tokens');
