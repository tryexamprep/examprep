# ExamPrep - SaaS לתרגול שאלות אמריקאיות

פלטפורמה ישראלית בעברית להעלאת קבצי PDF של מבחנים, עיבוד אוטומטי של שאלות אמריקאיות, ויצירת אפליקציית תרגול מקצועית עם מעקב התקדמות, ניתוח דפוסי מרצה, ויצירת שאלות AI דומות.

## פיצ'רים עיקריים

### חינמי לכל משתמש
- ✅ העלאה של עד 5 קבצי PDF
- ✅ קורס אחד פעיל
- ✅ עיבוד אוטומטי של PDF (חיתוך שאלות + זיהוי תשובות מסימוני צהוב)
- ✅ תרגול מלא עם טיימר ומעקב התקדמות
- ✅ ממשק מודרני, רספונסיבי, RTL עברי

### מנויים בתשלום
- 💎 **Basic** (₪19.90/חודש): 30 PDFs, 5 קורסים, 100 שאלות AI
- 💎 **Pro** (₪49.90/חודש): 150 PDFs, ∞ קורסים, 500 שאלות AI
- 💎 **Education** (₪199/חודש): למורים - דשבורד תלמידים, 2000 שאלות AI

### פיצ'רי AI מתקדמים
- 🧠 **ניתוח דפוסי מרצה** - AI מזהה אילו נושאים המרצה אוהב לשאול ומציע על מה להתמקד
- ✨ **שאלות AI דומות** - יוצר שאלות חדשות באותו סגנון לתרגול בלתי מוגבל
- 💡 **פידבק חכם** - אחרי כל מקבץ AI אומר על מה לחזור ומציע שאלות ממוקדות

## ארכיטקטורה

```
examprep/
├── server.mjs              # Express server (לשימוש מקומי / API)
├── scripts/
│   ├── process-pdf.mjs     # Pipeline עיבוד PDFs (חיתוך + זיהוי תשובות)
│   └── build-prod.mjs      # מייצר config.js מ-env vars
├── public/
│   ├── index.html          # SPA עם templates לכל דף
│   ├── styles.css          # עיצוב בסגנון gotest.co.il
│   ├── app.js              # router + Supabase client
│   ├── config.js.template  # template - לעולם לא שמור עם sectrets
│   └── config.js           # נוצר אוטומטית מ-.env (gitignored)
├── legal/
│   ├── privacy.html        # מדיניות פרטיות (חוק הגנת הפרטיות)
│   ├── terms.html          # תנאי שימוש
│   ├── accessibility.html  # הצהרת נגישות (תקנה 35)
│   └── cookies.html        # מדיניות עוגיות
├── supabase/
│   └── schema.sql          # סכמת DB עם RLS
├── BUSINESS_PLAN.md        # תוכנית עסקית מלאה עם חישובי טוקנים
├── .env.example            # template ל-environment variables
├── .gitignore              # מסתיר .env, config.js, node_modules
└── vercel.json             # הגדרות פריסה + security headers
```

## אבטחה

הפלטפורמה תוכננה לפי best practices לאבטחה:

1. **כל הסודות ב-.env** - לעולם לא בקוד, לעולם לא ב-git
2. **Row Level Security** ב-Supabase - כל משתמש רואה רק את הנתונים שלו
3. **Service-role key** רק בשרת - לעולם לא נשלח ללקוח
4. **Rate limiting** על כל endpoint
5. **קווטות דו-שכבתיות** - יומיות + חודשיות
6. **SHA-256 deduplication** - מונע העלאה כפולה של אותו קובץ
7. **Email verification** - מונע ספאם
8. **Security headers** ב-vercel.json: HSTS, X-Frame-Options, CSP, etc.
9. **HTTPS only** ב-production
10. **תאימות GDPR** ו-**חוק הגנת הפרטיות הישראלי**

## תאימות חוקית בישראל

- ✅ **חוק הגנת הפרטיות, תשמ"א-1981**
- ✅ **תקנות הגנת הפרטיות (אבטחת מידע), תשע"ז-2017**
- ✅ **תקנה 35 לתקנות שוויון זכויות לאנשים עם מוגבלות** (נגישות אתרים)
- ✅ **תקן ת"י 5568** ו-**WCAG 2.1 ברמה AA**
- ✅ **GDPR** של האיחוד האירופי
- ✅ **חוק חוזה מרחק** - אפשרות ביטול מנוי
- ✅ **חוק הגנת הצרכן** - תיאור מוצר ברור

## הוראות התקנה ופיתוח

### 1. Clone והתקנה
```bash
git clone https://github.com/omerkonkol/examprep.git
cd examprep
npm install
```

### 2. הגדרת Supabase
1. צור פרויקט חדש ב-https://supabase.com (חינמי)
2. ב-SQL Editor, הרץ את `supabase/schema.sql`
3. ב-Authentication > Providers > Email, **כבה** את "Confirm email" (לטסטים)
4. ב-Project Settings > API, העתק:
   - Project URL
   - anon public key
   - service_role secret (שמור בסוד!)

### 3. צור .env מקומי
```bash
cp .env.example .env
# ערוך את .env והכנס את ה-keys שלך
```

### 4. הרץ את השרת המקומי
```bash
npm start
# פתח http://localhost:3000
```

### 5. פריסה ל-Vercel
```bash
vercel link
vercel env add SUPABASE_URL production
vercel env add SUPABASE_ANON_KEY production
vercel env add SUPABASE_SERVICE_ROLE_KEY production
vercel --prod
```

## הוראות שימוש למשתמש קצה

ראה את ה-[BUSINESS_PLAN.md](BUSINESS_PLAN.md) לתוכנית העסקית המלאה עם:
- ניתוח עלויות טוקנים מדויק
- אסטרטגיית תמחור
- מנגנוני הגנה מנגד ניצול לרעה
- רוד-מאפ פיתוח
- חישובי רווח/הפסד

## רישיון

© 2026 ExamPrep. כל הזכויות שמורות.
