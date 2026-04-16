# ExamPrep — AI-Powered Exam Practice SaaS

A full-stack SaaS platform that lets students upload past exam PDFs, automatically extracts multiple-choice questions, and generates an interactive practice environment with AI-powered analysis and question generation.

## Features

### Free tier (all users)
- Upload up to 5 PDFs per course
- 1 active course
- Automatic PDF processing — question extraction + answer detection from yellow highlights
- Full practice mode with timer and progress tracking
- Modern responsive Hebrew/RTL interface

### Paid subscriptions
| Plan | Price | PDFs | Courses | AI Questions |
|------|-------|------|---------|-------------|
| Basic | ₪19.90/mo | 30 | 5 | 100 |
| Pro | ₪49.90/mo | 150 | ∞ | 500 |
| Education | ₪199/mo | Unlimited | ∞ | 2,000 |

### AI features
- **Lecturer pattern analysis** — identifies which topics and question styles appear most frequently
- **Similar question generation** — creates new questions in the same style for unlimited practice
- **Smart feedback** — after each session, highlights weak areas and suggests targeted follow-up questions

## Architecture

```
examprep/
├── server.mjs              # Express server (local dev / API)
├── scripts/
│   ├── process-pdf.mjs     # PDF pipeline: question extraction + answer detection
│   └── build-prod.mjs      # Builds config.js from env vars
├── public/
│   ├── index.html          # Single-page app with route templates
│   ├── styles.css          # UI styling
│   ├── app.js              # Router + Supabase client
│   └── config.js.template  # Template — never committed with secrets
├── legal/
│   ├── privacy.html        # Privacy policy (Israeli Privacy Protection Law)
│   ├── terms.html          # Terms of service
│   ├── accessibility.html  # Accessibility statement (Regulation 35)
│   └── cookies.html        # Cookie policy
├── supabase/
│   └── schema.sql          # Database schema with Row Level Security
└── vercel.json             # Deployment config + security headers
```

## Security

- All secrets stored in `.env` — never committed to git
- **Row Level Security** (Supabase) — users can only access their own data
- `service_role` key used server-side only, never sent to the client
- Rate limiting on all endpoints
- Two-layer quotas — daily + monthly
- **SHA-256 deduplication** — prevents duplicate PDF uploads
- Email verification to prevent spam
- Security headers (HSTS, X-Frame-Options, CSP) via `vercel.json`
- HTTPS-only in production
- **GDPR** and Israeli Privacy Protection Law compliant

## Tech Stack

- **Node.js + Express** — backend API
- **Supabase (PostgreSQL)** — database with RLS
- **AI API** — question generation and analysis
- **Vercel** — deployment and hosting
- **Vanilla JS SPA** — frontend (no framework)

## Setup

```bash
git clone https://github.com/tryexamprep/examprep.git
cd examprep
npm install

# Configure environment
cp .env.example .env
# Add your Supabase URL, anon key, and service_role key to .env

npm start
# Open http://localhost:3000
```

## Deploy to Vercel

```bash
vercel link
vercel env add SUPABASE_URL production
vercel env add SUPABASE_ANON_KEY production
vercel env add SUPABASE_SERVICE_ROLE_KEY production
vercel --prod
```

---

*Full-stack SaaS — Node.js · Supabase · AI · Vercel*
