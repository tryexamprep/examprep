// Build script - generates public/config.js from environment variables
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');

try {
  const dotenv = await import('dotenv');
  dotenv.config({ path: path.join(APP_ROOT, '.env') });
} catch {}

const templatePath = path.join(APP_ROOT, 'public', 'config.js.template');
const outPath = path.join(APP_ROOT, 'public', 'config.js');

if (!fs.existsSync(templatePath)) {
  console.error('Missing template:', templatePath);
  process.exit(1);
}

const url = (process.env.SUPABASE_URL || '').trim();
const key = (process.env.SUPABASE_ANON_KEY || '').trim();
if (!url || !key) {
  console.warn('⚠️  WARNING: SUPABASE_URL or SUPABASE_ANON_KEY env vars are missing');
  console.warn('   The site will load but auth/data features will not work.');
}

let content = fs.readFileSync(templatePath, 'utf8');
content = content
  .replaceAll('__SUPABASE_URL__', url)
  .replaceAll('__SUPABASE_ANON_KEY__', key)
  .replaceAll('__APP_TITLE__', (process.env.APP_TITLE || 'ExamPrep').trim())
  .replaceAll('__APP_URL__', (process.env.APP_URL || 'https://examprep.vercel.app').trim());

fs.writeFileSync(outPath, content);
console.log('✓ Generated public/config.js');
console.log('  Supabase URL:', url || '(not set)');
console.log('  Has anon key:', !!key);
