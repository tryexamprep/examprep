// =====================================================
// Apply a single migration file to the ExamPrep Supabase project.
// Usage: SBP_TOKEN=sbp_xxx node scripts/apply-migration.mjs <migration-file>
// Example: SBP_TOKEN=sbp_xxx node scripts/apply-migration.mjs supabase/migrations/fix_ai_cost_log_rls.sql
//
// SECURITY: SBP_TOKEN is read from env only. Never written to disk.
// =====================================================

import * as fs from 'node:fs';
import * as path from 'node:path';

const TOKEN = process.env.SBP_TOKEN;
const PROJECT_REF = 'lbkwykuzcffphvabmzex';

if (!TOKEN) {
  console.error('Missing SBP_TOKEN env var.');
  process.exit(1);
}

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/apply-migration.mjs <migration-file>');
  process.exit(1);
}

const abs = path.resolve(process.cwd(), file);
if (!fs.existsSync(abs)) {
  console.error(`File not found: ${abs}`);
  process.exit(1);
}

const sql = fs.readFileSync(abs, 'utf8');
console.log(`▸ Applying ${file} (${sql.length} chars)`);

const r = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
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
  console.error(`❌ HTTP ${r.status}:`);
  console.error(JSON.stringify(json, null, 2).slice(0, 2000));
  process.exit(2);
}

console.log('✓ migration applied');
if (Array.isArray(json) && json.length > 0) {
  console.log('result:', JSON.stringify(json, null, 2).slice(0, 500));
}
