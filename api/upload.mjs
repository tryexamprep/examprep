// =====================================================
// Vercel Serverless Function — POST /api/upload
// =====================================================
// Pipeline:
//  1. Upload exam PDF to Cloudinary (as PDF; we use pg_ / c_crop to serve pages)
//  2. Extract text-layer positions via unpdf (pdf.js) — locate "שאלה N" headings
//  3. Filter to MCQs (regions with א./ב./ג./ד. or 1./2./3./4. options)
//  4. Compute exact Cloudinary crop pixels from the REAL page dimensions
//     (fixes the old hardcoded RENDER_H=2070 that broke A4 PDFs)
//  5. In parallel, send solution PDF to Gemini to extract {question → answer}
//  6. Fallback: if text layer found no MCQs (image-only / scanned PDF) — use
//     Gemini Vision on the exam PDF
// =====================================================

import { createClient } from '@supabase/supabase-js';

export const config = { api: { bodyParser: false }, maxDuration: 120 };

const MAX_PDF_BYTES = 15 * 1024 * 1024;

// Cloudinary renders the PDF at this width. Height is computed per-page
// from the actual page dimensions, so A4 vs Letter no longer matters.
const CLOUDINARY_RENDER_W = 1600;
// PDF-coordinate margins around each question so the crop isn't flush to text.
const CROP_MARGIN_TOP_PT = 12;
const CROP_MARGIN_BOTTOM_PT = 18;

// ===== Supabase =====
let _admin = null;
function getAdmin() {
  if (!_admin && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    _admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  }
  return _admin;
}
function userClient(jwt) {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ===== Auth =====
async function authenticate(req) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.substring(7);
  const client = getAdmin() || createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data?.user) return null;
  return { userId: data.user.id, db: userClient(token) };
}

// ===== Multipart parsing =====
function rawBody(req, limit = MAX_PDF_BYTES + 512 * 1024) {
  return new Promise((resolve, reject) => {
    if (req.body && Buffer.isBuffer(req.body)) return resolve(req.body);
    if (req.body && typeof req.body === 'string') return resolve(Buffer.from(req.body));
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { req.destroy(); reject(new Error('Body too large')); } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipart(buf, contentType) {
  const bm = contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/i);
  if (!bm) throw new Error('No multipart boundary');
  const boundary = bm[1] || bm[2];
  const sep = Buffer.from('--' + boundary);
  const parts = [];
  let start = buf.indexOf(sep);
  while (start !== -1) {
    start += sep.length;
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break;
    const next = buf.indexOf(sep, start);
    if (next === -1) break;
    const part = buf.slice(start, next - 2);
    const hEnd = part.indexOf('\r\n\r\n');
    if (hEnd === -1) { start = next; continue; }
    const hdr = part.slice(0, hEnd).toString('utf8');
    parts.push({
      name: hdr.match(/name="([^"]+)"/)?.[1] || '',
      filename: hdr.match(/filename="([^"]+)"/)?.[1] || null,
      data: part.slice(hEnd + 4),
    });
    start = next;
  }
  return parts;
}

function isPdf(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 5 &&
    buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46;
}

// ===== Filename similarity matching =====
function normalizeFilename(filename) {
  if (!filename) return '';
  return filename
    .toLowerCase()
    .replace(/\.[^/.]+$/, '') // remove extension
    .replace(/\b(exam|test|solution|answers|answer key|מבחן|בחינה|פתרון|תשובות|מפתח)\b/gi, '')
    .replace(/[^\w\u0590-\u05FF]/g, ' ') // keep Hebrew/English alphanumerics, replace special chars with space
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
    .trim();
}

function filenamesSimilar(name1, name2, threshold = 0.55) {
  const norm1 = normalizeFilename(name1);
  const norm2 = normalizeFilename(name2);

  // If both normalize to empty, consider them unrelated
  if (!norm1 || !norm2) return false;

  // Extract tokens
  const tokens1 = new Set(norm1.split(/\s+/).filter(Boolean));
  const tokens2 = new Set(norm2.split(/\s+/).filter(Boolean));

  // Jaccard similarity: intersection / union
  const intersection = [...tokens1].filter(t => tokens2.has(t)).length;
  const union = new Set([...tokens1, ...tokens2]).size;

  return union === 0 ? false : (intersection / union) >= threshold;
}

// =====================================================
// PDF text-layer analysis (pdf.js via unpdf)
// =====================================================

// Extract per-item text positions for every page.
// Each item carries x, y in PDF native coords, and yFromTop (flipped so 0
// is at the top of the page, matching how we'll crop the rendered image).
async function extractPositions(pdfBytes) {
  const { getDocumentProxy } = await import('unpdf');
  const doc = await getDocumentProxy(new Uint8Array(pdfBytes));
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 1.0 });
    const tc = await page.getTextContent();
    const items = tc.items
      .filter(it => it && it.str !== undefined)
      .map(it => ({
        str: it.str,
        x: it.transform[4],
        y: it.transform[5],
        yFromTop: viewport.height - it.transform[5],
        width: it.width,
        height: it.height,
      }));
    pages.push({ page: i, width: viewport.width, height: viewport.height, items });
  }
  return pages;
}

// Group items into visual lines (items whose yFromTop is within yTol of each
// other). Returns each line with its concatenated text + left/right X extents.
function buildLines(page, yTol = 3) {
  const items = page.items.filter(it => it.str && it.str.trim() !== '');
  if (!items.length) return [];
  const sorted = [...items].sort((a, b) => a.yFromTop - b.yFromTop);
  const lines = [];
  for (const it of sorted) {
    const line = lines.find(l => Math.abs(l.yFromTop - it.yFromTop) < yTol);
    if (line) {
      line.items.push(it);
      line.yFromTop = (line.yFromTop * (line.items.length - 1) + it.yFromTop) / line.items.length;
    } else {
      lines.push({ yFromTop: it.yFromTop, items: [it] });
    }
  }
  for (const line of lines) {
    // RTL: rightmost item first when building visual text.
    line.items.sort((a, b) => b.x - a.x);
    const parts = [];
    let lastX = null;
    for (const it of line.items) {
      if (lastX !== null && lastX - (it.x + (it.width || 0)) > 2) parts.push(' ');
      parts.push(it.str);
      lastX = it.x;
    }
    line.text = parts.join('').replace(/\s+/g, ' ').trim();
    line.leftX = Math.min(...line.items.map(it => it.x));
    line.rightX = Math.max(...line.items.map(it => it.x + (it.width || 0)));
  }
  return lines;
}

// Find the page range for a parent question (used by sections mode).
function findQuestionRange(pages, parentQ) {
  let startPage = null, startY = null, endPage = null, endY = null;
  for (const page of pages) {
    const lines = buildLines(page);
    for (const line of lines) {
      const m = line.text.match(/שאלה\s*(\d+)|(\d+)\s*שאלה/);
      if (m) {
        const num = parseInt((m[1] || m[2]), 10);
        if (num === parentQ && startPage === null) {
          startPage = page.page; startY = line.yFromTop;
        } else if (num === parentQ + 1 && startPage !== null && endPage === null) {
          endPage = page.page; endY = line.yFromTop;
        }
      }
    }
  }
  return { startPage, startY, endPage, endY };
}

const ALL_LETTERS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט', 'י'];

// Find sub-section headings (סעיף א/ב/ג...) within a parent question.
function findSectionHeadings(pages, parentQ) {
  const range = findQuestionRange(pages, parentQ);
  const results = [];
  if (range.startPage === null) return { headings: results, range };
  const seen = new Set();
  for (const page of pages) {
    if (page.page < range.startPage) continue;
    if (range.endPage !== null && page.page > range.endPage) break;
    const lines = buildLines(page);
    for (const line of lines) {
      if (range.endPage === page.page && line.yFromTop >= range.endY) continue;
      for (const letter of ALL_LETTERS) {
        if (seen.has(letter)) continue;
        const re1 = new RegExp(`(^|\\s)סעיף\\s*${letter}['\u2019\u05F3\`]?(\\s|$|\\()`);
        const re2 = new RegExp(`(^|\\s)${letter}['\u2019\u05F3\`]\\s*\\(\\s*\\d+\\s*נק`);
        if (re1.test(line.text) || re2.test(line.text)) {
          if (line.rightX > page.width - 110) {
            seen.add(letter);
            results.push({ section: letter, page: page.page, yFromTop: line.yFromTop });
            break;
          }
        }
      }
    }
  }
  results.sort((a, b) => a.page - b.page || a.yFromTop - b.yFromTop);
  return { headings: results, range };
}

// Find standalone numbered question headings ("שאלה 1", "שאלה 2", ...).
// Requires that the line STARTS with "שאלה" (not embedded in a paragraph)
// and sits near the right edge of the page (RTL heading position).
//
// Page 1 is scanned unless it's clearly an instructions page (has the word
// "הוראות" / "כללי" near the top and no "שאלה N" headings). We decide that
// per-PDF by actually looking at what page 1 contains.
function findStandaloneQuestions(pages) {
  const results = [];
  const seen = new Set();
  // Decide whether to skip page 1: only if it looks like an instructions page
  // AND has no שאלה-N heading on it. Otherwise include it.
  let skipPage1 = false;
  if (pages.length > 1) {
    const p1 = pages.find(p => p.page === 1);
    if (p1) {
      const lines = buildLines(p1);
      const hasQHeading = lines.some(l => /^\s*שאלה\s*\d/.test(l.text));
      const looksLikeInstructions = lines.slice(0, 15).some(l =>
        /(הוראות\s+כלליות|משך\s+הבחינה|חומר\s+עזר|מהלך\s+הבחינה)/.test(l.text));
      skipPage1 = !hasQHeading && looksLikeInstructions;
    }
  }
  for (const page of pages) {
    if (page.page === 1 && skipPage1) continue;
    const lines = buildLines(page);
    for (const line of lines) {
      // Skip only the absolute outliers — real headings can include the full
      // question stem on the same visual line ("שאלה 2 נאמר ששפה L מסכימה...").
      if (line.text.length > 300) continue;
      // Match "שאלה N" at line start. Don't use \b — Hebrew + digit boundary is
      // tricky; use an explicit "not a digit" lookahead instead.
      const m = line.text.match(/^\s*שאלה\s*(\d{1,3})(?!\d)/);
      if (!m) continue;
      const num = parseInt(m[1], 10);
      if (num < 1 || num > 100 || seen.has(num)) continue;
      if (line.rightX <= page.width * 0.35) continue;
      seen.add(num);
      results.push({ section: String(num), page: page.page, yFromTop: line.yFromTop });
    }
  }
  results.sort((a, b) => a.page - b.page || a.yFromTop - b.yFromTop);
  return results;
}

// Given a heading and the following heading, find where the current question
// actually ends.
//
// The returned `yFromTop` is the PRE-MARGIN bottom — buildCropUrl will still
// add CROP_MARGIN_BOTTOM_PT on top. So we cap at (hardUpper - safety) where
// safety ≥ CROP_MARGIN_BOTTOM_PT to guarantee the crop never spills into the
// next heading after the aesthetic margin is added.
//
// Priority order:
//  A. A "נימוק" line (justification box) on the starting page — tohna1 sections
//     mode puts this after each MCQ.
//  B. The LAST option line (1./2./3./4. or א./ב./ג./ד.) on the starting page,
//     within the region before the next heading. This is the most reliable
//     signal for MCQs — stops us cropping into the next question when there's
//     no explicit structural marker.
//  C. The next heading on the same page (minus a safety margin).
//  D. The page bottom.
function findBottomBoundary(pages, fromHeading, nextHeading) {
  const startPage = fromHeading.page;
  const startY = fromHeading.yFromTop;
  const page = pages.find(p => p.page === startPage);
  if (!page) return null;

  // Upper Y bound — never scan past the next heading (if it's on the same page).
  const hardUpper = (nextHeading && nextHeading.page === startPage)
    ? nextHeading.yFromTop
    : page.height;

  // Safety margin between our returned bottom and the next heading. We need
  // at least CROP_MARGIN_BOTTOM_PT + a few points to absorb the crop padding.
  const SAFETY = CROP_MARGIN_BOTTOM_PT + 6;
  const safeCap = hardUpper - SAFETY;

  const lines = buildLines(page);

  // A. "נימוק" line
  for (const line of lines) {
    if (line.yFromTop <= startY || line.yFromTop >= hardUpper) continue;
    if (/^נימוק\s*[:.]?\s*$/.test(line.text)) {
      return { page: startPage, yFromTop: Math.min(safeCap, line.yFromTop - 10) };
    }
  }

  // B. Last sequential option line in the region
  let lastOptionY = null;
  let numSeen = 0, hebSeen = 0;
  for (const line of lines) {
    if (line.yFromTop <= startY || line.yFromTop >= hardUpper) continue;
    const t = line.text.replace(/^[\s•·]+/, '');
    const mNum = t.match(/^\.?\s*([1-9])\s*[.)]/);
    if (mNum) {
      const n = parseInt(mNum[1], 10);
      if (n === numSeen + 1 && n <= 6) {
        numSeen = n;
        lastOptionY = line.yFromTop;
        continue;
      }
    }
    const mHeb = t.match(/^\.?\s*([א-ט])\s*[.)]/);
    if (mHeb) {
      const idx = 'אבגדהוזח'.indexOf(mHeb[1]);
      if (idx === hebSeen && hebSeen < 6) {
        hebSeen = idx + 1;
        lastOptionY = line.yFromTop;
        continue;
      }
    }
  }
  if (lastOptionY !== null && Math.max(numSeen, hebSeen) >= 2) {
    // Extend past the last option marker to capture any wrapped continuation
    // lines — stop at the next structural element (new heading, new option,
    // נימוק) or a big vertical gap.
    let includeY = lastOptionY;
    const tail = lines
      .filter(l => l.yFromTop > lastOptionY && l.yFromTop < hardUpper)
      .sort((a, b) => a.yFromTop - b.yFromTop);
    for (const line of tail) {
      if (/^נימוק\s*[:.]?\s*$/.test(line.text)) break;
      if (/^\s*שאלה\s*\d/.test(line.text)) break;
      const t = line.text.replace(/^[\s•·]+/, '');
      if (/^\.?\s*[1-9]\s*[.)]/.test(t)) break;
      if (/^\.?\s*[א-ט]\s*[.)]/.test(t)) break;
      if (line.yFromTop - includeY > 25) break;
      includeY = line.yFromTop;
    }
    // +6pt accounts for the baseline → descender of the last included line;
    // CROP_MARGIN_BOTTOM_PT below adds the rest of the line height.
    return { page: startPage, yFromTop: Math.min(safeCap, includeY + 6) };
  }

  // C. Next heading on the same page
  if (nextHeading && nextHeading.page === startPage) {
    return { page: startPage, yFromTop: safeCap };
  }

  // D. Page bottom
  return { page: startPage, yFromTop: page.height - 30 };
}

// Does the region between heading and bottom look like an MCQ?
// Signals:
//   + "הקיפו" / "בחרו" / "איזו מהטענות" → explicit circle-one-answer = MCQ
//   + ≥3 sequential numbered (1.2.3.4) or lettered (א.ב.ג.ד.) option lines
//   - explicit open-question commands at sentence start (הוכיחו / השלימו / ...)
//
// `strict=true` (standalone mode) requires a concrete positive signal.
// `strict=false` (sections mode) defaults to MCQ — the parent question is
// typically dedicated to MCQs, so unclear cases are kept rather than dropped.
function classifyRegion(pages, heading, bottom, strict = false) {
  const page = pages.find(p => p.page === heading.page);
  if (!page) return { isMCQ: false, numOptions: 0 };
  const lines = buildLines(page);
  const regionBottom = bottom ? bottom.yFromTop : page.height;
  let regionLines = lines.filter(l =>
    l.yFromTop > heading.yFromTop && l.yFromTop < regionBottom);

  // Cross-page scan: if the region extends to/near the end of the page,
  // also check the top portion of the next page for option markers.
  // This catches questions whose heading is near the bottom of a page
  // and whose options start on the following page.
  if (regionBottom >= page.height - 60) {
    const nextPage = pages.find(p => p.page === heading.page + 1);
    if (nextPage) {
      const nextLines = buildLines(nextPage).filter(l => l.yFromTop < 380);
      regionLines = [...regionLines, ...nextLines];
    }
  }

  if (regionLines.length === 0) return { isMCQ: false, numOptions: 0 };

  const regionText = regionLines.map(l => l.text).join(' ');

  // Count sequential option markers (".1", "1.", ".א", "א." at line start).
  let num = 0, heb = 0;
  for (const l of regionLines) {
    const t = l.text.replace(/^[\s•·]+/, '');
    const mNum = t.match(/^\.?\s*([1-9])\s*[.)]?/);
    if (mNum) {
      const n = parseInt(mNum[1], 10);
      if (n === num + 1 && n <= 6) num = n;
    }
    const mHeb = t.match(/^\.?\s*([א-ט])\s*[.)]?/);
    if (mHeb) {
      const letterIdx = 'אבגדהוזח'.indexOf(mHeb[1]);
      if (letterIdx === heb && heb < 6) heb = letterIdx + 1;
    }
  }
  const numOptions = Math.max(num, heb);
  const hasCirclePhrase = /(הקיפו|איזו\s+מהטענות|איזה\s+מהבא|בחרו\s+את|סמנו\s+את)/.test(regionText);

  // Strong positive: explicit "circle" instruction — always an MCQ, even for
  // 2-option true/false variants like "הקיפו: מתקמפל / לא מתקמפל".
  if (hasCirclePhrase) {
    return { isMCQ: true, numOptions: Math.max(numOptions, 2) };
  }

  // Strong negative: the stem opens with a clear write-an-answer command.
  const openMarkers = /(הוכיחו|הפריכו|השלימו\s+את|כתבו\s+את|מימשו\s+את|ממשו\s+את|חשבו\s+את|תכננו\s+את|סרטטו|ציירו|תארו\s+את|הסבירו|פתרו\s+את|נמקו\s+את)/;
  if (openMarkers.test(regionText) && numOptions < 3) {
    return { isMCQ: false, numOptions: 0 };
  }

  // ≥3 numbered options is a reliable positive.
  if (numOptions >= 3) return { isMCQ: true, numOptions };

  // Standalone mode: require a concrete positive signal above. Unclear = reject.
  if (strict) return { isMCQ: false, numOptions };

  // Sections mode: default to MCQ (permissive — parent Q is typically MCQ-only).
  return { isMCQ: true, numOptions: numOptions || 4 };
}

// Extract the question stem + 4 option texts from an MCQ region using the
// already-parsed line data. This enables text-first solution generation:
// instead of sending the PDF to Gemini as an image, we feed Gemini the real
// question text from the user's PDF.
//
// Returns { questionStemText, optionTexts: {1..N: text} }. Falls back gracefully
// to empty strings when the layout is unusual.
function extractRegionText(pages, page, yTop, yBottom) {
  const pageData = pages.find(p => p.page === page);
  if (!pageData) return { questionStemText: '', optionTexts: {} };

  let lines = buildLines(pageData).filter(l => l.yFromTop > yTop && l.yFromTop < yBottom);
  // Cross-page scan for questions near page bottom (same logic as classifyRegion)
  if (yBottom >= pageData.height - 60) {
    const nextPage = pages.find(p => p.page === page + 1);
    if (nextPage) {
      const nextLines = buildLines(nextPage).filter(l => l.yFromTop < 380);
      lines = [...lines, ...nextLines];
    }
  }
  // Skip the header line "שאלה N" itself
  lines = lines.filter(l => !/^\s*שאלה\s*\d{1,3}/.test(l.text));
  if (lines.length === 0) return { questionStemText: '', optionTexts: {} };

  // Walk through lines and split into stem vs options
  const stemLines = [];
  const options = {}; // { 1: [...lines], 2: [...], ... }
  let currentOpt = 0;

  for (const l of lines) {
    const t = l.text.replace(/^[\s•·]+/, '').trim();
    if (!t) continue;
    // Match option markers: "1.", "2)", ".1", "א.", "ב)", etc.
    const mNum = t.match(/^\.?\s*([1-6])\s*[.)]\s*(.*)$/);
    const mHeb = t.match(/^\.?\s*([א-ט])\s*[.)]\s*(.*)$/);
    if (mNum) {
      const n = parseInt(mNum[1], 10);
      if (n === currentOpt + 1) {
        currentOpt = n;
        options[n] = [mNum[2].trim()].filter(Boolean);
        continue;
      }
    }
    if (mHeb) {
      const idx = 'אבגדהוזח'.indexOf(mHeb[1]) + 1;
      if (idx === currentOpt + 1) {
        currentOpt = idx;
        options[idx] = [mHeb[2].trim()].filter(Boolean);
        continue;
      }
    }
    // Continuation line for current option, or stem line if no option yet
    if (currentOpt > 0) {
      options[currentOpt].push(t);
    } else {
      stemLines.push(t);
    }
  }

  const optionTexts = {};
  for (const [k, v] of Object.entries(options)) {
    optionTexts[k] = v.join(' ').replace(/\s+/g, ' ').trim();
  }

  return {
    questionStemText: stemLines.join(' ').replace(/\s+/g, ' ').trim(),
    optionTexts,
  };
}

// Top-level MCQ detection: auto-picks between sections mode (a single parent
// question with sub-sections) and standalone mode (each שאלה N is its own MCQ).
function detectMCQsFromPositions(pages) {
  // Sections mode: try parent questions 1..6 and keep the one with the most
  // sub-sections that actually look like MCQs.
  let best = { mode: 'none', mcqs: [] };
  for (let pq = 1; pq <= 6; pq++) {
    const { headings } = findSectionHeadings(pages, pq);
    if (headings.length < 3) continue;
    const mcqs = [];
    for (let i = 0; i < headings.length; i++) {
      const h = headings[i];
      const next = headings[i + 1];
      const bottom = findBottomBoundary(pages, h, next);
      if (!bottom) continue;
      const cls = classifyRegion(pages, h, bottom);
      if (!cls.isMCQ) continue;
      const pageMeta = pages.find(p => p.page === h.page);
      const regionText = extractRegionText(pages, h.page, h.yFromTop, bottom.yFromTop);
      mcqs.push({
        section: h.section,
        number: i + 1,
        page: h.page,
        yTop: h.yFromTop,
        yBottom: bottom.yFromTop,
        pageWidth: pageMeta.width,
        pageHeight: pageMeta.height,
        numOptions: cls.numOptions,
        questionStemText: regionText.questionStemText,
        optionTexts: regionText.optionTexts,
      });
    }
    if (mcqs.length > best.mcqs.length) {
      best = { mode: `sections(parent=${pq})`, mcqs };
    }
  }

  // Standalone mode: "שאלה N" at the right edge of the page.
  // Strict classifier — standalone "שאלה N" could easily be an open question
  // (proofs, design, programming), so we require concrete MCQ evidence.
  const standalone = findStandaloneQuestions(pages);
  if (standalone.length >= 3) {
    const mcqs = [];
    for (let i = 0; i < standalone.length; i++) {
      const h = standalone[i];
      const next = standalone[i + 1];
      const bottom = findBottomBoundary(pages, h, next);
      if (!bottom) continue;
      const cls = classifyRegion(pages, h, bottom, /* strict */ true);
      if (!cls.isMCQ) continue;
      const pageMeta = pages.find(p => p.page === h.page);
      const regionText = extractRegionText(pages, h.page, h.yFromTop, bottom.yFromTop);
      mcqs.push({
        section: h.section,
        number: parseInt(h.section, 10),
        page: h.page,
        yTop: h.yFromTop,
        yBottom: bottom.yFromTop,
        pageWidth: pageMeta.width,
        pageHeight: pageMeta.height,
        numOptions: cls.numOptions,
        questionStemText: regionText.questionStemText,
        optionTexts: regionText.optionTexts,
      });
    }

    // Second pass: for any headings that failed strict classification,
    // re-run non-strictly if we already confirmed most are MCQs.
    // This recovers questions skipped due to cross-page layouts or
    // unusual option formatting, while still rejecting clear open questions.
    if (mcqs.length >= 2 && mcqs.length < standalone.length) {
      const confirmedNums = new Set(mcqs.map(m => m.number));
      for (let i = 0; i < standalone.length; i++) {
        const h = standalone[i];
        const num = parseInt(h.section, 10);
        if (confirmedNums.has(num)) continue;
        const next = standalone[i + 1];
        const bottom = findBottomBoundary(pages, h, next);
        if (!bottom) continue;
        const cls2 = classifyRegion(pages, h, bottom, /* strict */ false);
        if (!cls2.isMCQ) continue;
        const pageMeta = pages.find(p => p.page === h.page);
        const regionText = extractRegionText(pages, h.page, h.yFromTop, bottom.yFromTop);
        console.log(`[standalone-gap-fill] adding Q${num} via non-strict pass`);
        mcqs.push({
          section: h.section,
          number: num,
          page: h.page,
          yTop: h.yFromTop,
          yBottom: bottom.yFromTop,
          pageWidth: pageMeta.width,
          pageHeight: pageMeta.height,
          numOptions: cls2.numOptions || 4,
          questionStemText: regionText.questionStemText,
          optionTexts: regionText.optionTexts,
        });
      }
    }

    if (mcqs.length > best.mcqs.length) {
      best = { mode: 'standalone', mcqs };
    }
  }

  return best;
}

// Build a Cloudinary URL that crops page `page` of `publicId` to exactly the
// rectangle containing this MCQ. `pageWidth` / `pageHeight` must be the real
// PDF page dimensions (in points) — we derive the rendered height from them
// instead of assuming a hardcoded 2070.
function buildCropUrl(cloudName, publicId, mcq) {
  const scale = CLOUDINARY_RENDER_W / mcq.pageWidth;
  const renderH = Math.round(CLOUDINARY_RENDER_W * (mcq.pageHeight / mcq.pageWidth));
  const yPx = Math.max(0, Math.round((mcq.yTop - CROP_MARGIN_TOP_PT) * scale));
  const rawH = Math.round((mcq.yBottom - mcq.yTop + CROP_MARGIN_TOP_PT + CROP_MARGIN_BOTTOM_PT) * scale);
  const hPx = Math.max(150, Math.min(renderH - yPx, rawH));
  return `https://res.cloudinary.com/${cloudName}/image/upload/pg_${mcq.page},w_${CLOUDINARY_RENDER_W}/c_crop,w_${CLOUDINARY_RENDER_W},h_${hPx},y_${yPx},g_north/q_auto/${publicId}.png`;
}

// =====================================================
// Cloudinary upload
// =====================================================
async function uploadPdfToCloudinary({ cloudName, apiKey, apiSecret, pdfBase64, publicId }) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const { createHash } = await import('node:crypto');
  const signature = createHash('sha1')
    .update(`public_id=${publicId}&timestamp=${timestamp}${apiSecret}`)
    .digest('hex');
  const r = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      file: `data:application/pdf;base64,${pdfBase64}`,
      public_id: publicId,
      api_key: apiKey,
      timestamp,
      signature,
    }),
  });
  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    console.error(`[cloudinary] ${r.status}:`, errText.slice(0, 200));
    return null;
  }
  const d = await r.json();
  return d.public_id;
}

// =====================================================
// Local solution-PDF parser (FREE, no Gemini!)
// =====================================================
// Extracts text from the solution PDF using unpdf, then walks through lines
// to find question headers and their associated solution text + answer key.
//
// Returns: { [qNumber]: { answer: 1-4|null, rawText: string } } or null if
// the PDF has no text layer (scanned).
async function parseSolutionPdf(solPdfBytes) {
  const pages = await extractPositions(solPdfBytes).catch(() => null);
  if (!pages || pages.length === 0) return null;

  // Flatten all pages into a single ordered stream of lines (across pages).
  const allLines = [];
  for (const page of pages) {
    const lines = buildLines(page);
    for (const l of lines) {
      allLines.push({ ...l, page: page.page });
    }
  }
  if (allLines.length === 0) return null;

  // Walk the lines looking for question headers. Recognize:
  //   "שאלה 1", "שאלה 2:", "שאלה 3 -", "פתרון לשאלה 4", "פתרון שאלה 5"
  //   "תשובה 1", "סעיף א"
  // NOTE: previously had `altHeaderRe` that matched "\\d+[.):]\\s" but that
  // caused false positives on exam-instruction lines like "3. חומר עזר מותר",
  // which polluted solution_text_raw with garbage. Removed.
  const headerRe = /(?:שאלה|פתרון(?:\s+ל?שאלה)?|סעיף|תשובה(?:\s+לשאלה)?)\s*(\d{1,3})\b/;

  const sections = []; // [{number, startIdx}]
  for (let i = 0; i < allLines.length; i++) {
    const text = allLines[i].text;
    if (text.length > 300) continue;
    const m = text.match(headerRe);
    if (!m) continue;
    const num = parseInt(m[1], 10);
    if (!num || num < 1 || num > 100) continue;
    if (sections.find(s => s.number === num)) continue;
    sections.push({ number: num, startIdx: i });
  }

  if (sections.length === 0) return null;
  sections.sort((a, b) => a.startIdx - b.startIdx);

  // For each section, the raw text is everything from startIdx up to (but not
  // including) the next section's startIdx.
  const out = {};
  const answerMarkers = [
    /(?:תשובה(?:\s+נכונה)?|התשובה\s+(?:ה)?נכונה|תשובה\s+סופית|Answer)\s*[:=\-–]?\s*([א-ד1-4])/,
    /^\s*([א-ד1-4])\s*[.)]?\s*(?:זוהי|היא|-)\s+(?:התשובה|נכונה)/,
    /(?:הקיפו|סימון)\s+([א-ד1-4])/,
  ];
  const letterMap = { 'א': 1, 'ב': 2, 'ג': 3, 'ד': 4 };

  for (let s = 0; s < sections.length; s++) {
    const start = sections[s].startIdx;
    const end = s + 1 < sections.length ? sections[s + 1].startIdx : allLines.length;
    const sectionLines = allLines.slice(start, end);
    const rawText = sectionLines.map(l => l.text).join('\n').trim();

    // Find the answer marker in the first few lines (most likely location).
    let answer = null;
    for (let i = 0; i < Math.min(sectionLines.length, 12); i++) {
      const t = sectionLines[i].text;
      for (const re of answerMarkers) {
        const m = t.match(re);
        if (m) {
          const raw = m[1];
          if (/\d/.test(raw)) answer = parseInt(raw, 10);
          else answer = letterMap[raw] || null;
          if (answer >= 1 && answer <= 4) break;
          answer = null;
        }
      }
      if (answer) break;
    }

    // Fallback: look for a standalone אאבגד/1234 on its own line near the start.
    if (!answer) {
      for (let i = 0; i < Math.min(sectionLines.length, 8); i++) {
        const t = sectionLines[i].text.trim();
        const m = t.match(/^([א-ד])\s*[.)]?\s*$|^([1-4])\s*[.)]?\s*$/);
        if (m) {
          const raw = m[1] || m[2];
          if (/\d/.test(raw)) answer = parseInt(raw, 10);
          else answer = letterMap[raw] || null;
          if (answer >= 1 && answer <= 4) break;
          answer = null;
        }
      }
    }

    out[String(sections[s].number)] = { answer, rawText };
  }

  return out;
}

// =====================================================
// Pass 2 — Aggressive flat scan (FREE, no Gemini)
// =====================================================
// Extracts ALL text from solution PDF and scans for simple number→letter
// patterns like "1. ב", "1: ב", "1-ב" — catches answer tables that don't
// have section headers (which parseSolutionPdf requires).
async function flatScanAnswers(pdfBytes) {
  const pages = await extractPositions(pdfBytes).catch(() => null);
  if (!pages || pages.length === 0) return {};
  const allText = pages.flatMap(p => buildLines(p)).map(l => l.text).join('\n');
  console.log(`[flat-scan] text length: ${allText.length}, sample: ${allText.slice(0, 200)}`);
  const letterMap = { 'א': 1, 'ב': 2, 'ג': 3, 'ד': 4 };
  const answers = {};
  // Letter answers: "1. ב", "1: ב", "1-ב", "1 ב" — use matchAll to avoid undeclared `m` in strict mode
  for (const m of allText.matchAll(/\b(\d{1,2})\s*[.:\-–—]?\s*([א-ד])\b/g)) {
    const q = parseInt(m[1], 10); const ans = letterMap[m[2]];
    if (q >= 1 && q <= 60 && ans) answers[String(q)] = ans;
  }
  // Digit answers: "1. 2", "1: 3"
  for (const m of allText.matchAll(/\b(\d{1,2})\s*[.:\-–—]\s*([1-4])\b/g)) {
    const q = parseInt(m[1], 10); const ans = parseInt(m[2], 10);
    if (q >= 1 && q <= 60 && !answers[String(q)]) answers[String(q)] = ans;
  }
  const count = Object.keys(answers).length;
  console.log(`[flat-scan] found ${count} answers:`, JSON.stringify(answers));
  return count >= 2 ? answers : {};
}

// =====================================================
// Pass 3 — Gemini vision on SOLUTION PDF only (near-zero cost)
// =====================================================
// Sends ONLY the solution PDF (not the exam) — half the tokens, twice as
// fast, works for visual markings (yellow highlights, circles) and text.
// Uses gemini-2.0-flash for all tiers (~$0.0001/call).
// Retries with 2.5-flash only for pro/trial if flash returns nothing.
async function extractAnswersWithGemini(solutionPdfBase64, questionNumbers, plan = 'trial') {
  const freeKey = (process.env.GEMINI_API_KEY || '').replace(/\\n/g, '').trim();
  const paidKey = (process.env.GEMINI_API_KEY_PAID || '').replace(/\\n/g, '').trim();
  if (!freeKey && !paidKey) return null;

  const list = questionNumbers.join(', ');
  const prompt = `This is a Hebrew university exam solution PDF.
Find the correct MCQ answer for each of these question numbers: ${list}

The answer key may appear in ANY of these formats:
- Table: "שאלה | תשובה" with rows like "1 | ב"
- List: "1. ב", "1: ב", "1-ב", "(1) ב"
- Inline: "תשובה לשאלה 1: ב" or "שאלה 1 — ב"
- Visual: highlighted/circled option on the exam itself
- Numbers: "1. 2" where 1=א, 2=ב, 3=ג, 4=ד

Return a JSON array — ONLY the array, no text, no explanation:
[{"q":1,"ans":2},{"q":2,"ans":1},...]
"ans" values: 1=א, 2=ב, 3=ג, 4=ד
Skip questions you cannot find. Include any answer you can identify, even if not 100% certain.`;

  const parts = [
    { text: prompt },
    { inlineData: { mimeType: 'application/pdf', data: solutionPdfBase64 } },
  ];

  // Returns { answers, quota_exceeded } or null
  async function callModel(model, apiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          temperature: 0.0,
          maxOutputTokens: 1024,
          responseMimeType: 'application/json',
          // responseSchema removed — uppercase type names caused silent API failures
        },
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      console.warn(`[answer-extract] ${model} ${r.status}:`, errText.slice(0, 300));
      return r.status === 429 ? { quota_exceeded: true } : null;
    }
    const j = await r.json();
    const text = j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
    console.log(`[answer-extract] ${model} raw: ${text.slice(0, 300)}`);

    // Try direct parse first (responseMimeType: 'application/json' should give clean JSON)
    let parsed = null;
    try { parsed = JSON.parse(text.trim()); } catch {}
    // Fallback: extract first JSON array found anywhere in the response
    if (!parsed) {
      const jsonMatch = text.match(/(\[[\s\S]*?\])/);
      if (jsonMatch) { try { parsed = JSON.parse(jsonMatch[1]); } catch {} }
    }
    if (!parsed) {
      console.warn(`[answer-extract] ${model} could not parse JSON from response`);
      return null;
    }

    const normalized = {};
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        const q = parseInt(item?.q, 10);
        const ans = parseInt(item?.ans, 10);
        if (q > 0 && ans >= 1 && ans <= 4) normalized[String(q)] = ans;
      }
    } else if (parsed && typeof parsed === 'object') {
      for (const [k, v] of Object.entries(parsed)) {
        const ans = parseInt(v, 10);
        if (ans >= 1 && ans <= 4) normalized[String(parseInt(k, 10))] = ans;
      }
    }
    return { answers: normalized };
  }

  // Primary: free AI Studio key (250 RPD). Fallback: paid key ($300 credits) on 429.
  const models = ['gemini-2.5-flash', 'gemini-2.0-flash'];

  for (const model of models) {
    try {
      let res = freeKey ? await callModel(model, freeKey) : null;
      if (res?.quota_exceeded && paidKey) {
        console.warn(`[answer-extract] ${model} free quota exhausted — switching to paid key`);
        res = await callModel(model, paidKey);
      }
      const result = res?.answers;
      if (result && Object.keys(result).length > 0) {
        console.log(`[answer-extract] ${model} found ${Object.keys(result).length}/${questionNumbers.length} answers`);
        return { answers: result, model };
      }
      console.warn(`[answer-extract] ${model} returned empty`);
    } catch (e) {
      console.warn(`[answer-extract] ${model} exception:`, e.message);
    }
  }
  return null;
}

// =====================================================
// Gemini fallback — full exam extraction (scanned/image-only PDFs)
// =====================================================
async function analyzeExamWithGemini(examPdfBase64, solPdfBase64) {
  const freeKey = (process.env.GEMINI_API_KEY || '').replace(/\\n/g, '').trim();
  const paidKey = (process.env.GEMINI_API_KEY_PAID || '').replace(/\\n/g, '').trim();
  if (!freeKey && !paidKey) return null;

  const prompt = `Analyze this Hebrew university exam PDF. Find EVERY multiple-choice question (שאלות אמריקאיות / שאלות סגורות).

A multiple-choice question has ALL of:
1. A question number (e.g. "שאלה 1", "שאלה 2", or "סעיף א")
2. 3-5 answer options labeled either 1./2./3./4. OR א./ב./ג./ד.
3. The student picks ONE answer

BE EXHAUSTIVE. Return EVERY question that matches. This is CRITICAL:
- Do NOT skip a question because its stem contains words like הוכיחו, הראו, הפריכו, חשבו, השלימו, הסבירו — MCQs often use these words inside the stem or inside their answer options.
- Include questions even if you are only ~80% sure they are MCQs.
- Scan ALL pages, including page 1.
- If questions are numbered 1..N, you should generally return N objects.

ONLY skip a question if:
- It has NO answer options at all (just a blank writing space)
- It sits under an explicit "שאלות פתוחות" section header
- It is pure instructions / cover page with no question stem

For EACH MCQ return:
{
  "n": question number (integer as printed),
  "page": PDF page number (1-based integer),
  "y_top": percentage from top where the "שאלה N" LABEL LINE starts — must be AT or ABOVE the top edge of the "שאלה X" text itself, not below it. If unsure, subtract ~2% from your estimate to ensure the label is included. (0-100),
  "y_bottom": percentage from top where the LAST option ends (0-100),
  "correct": correct answer index (1-4) if known, else null,
  "page_w": page width in points (usually 595),
  "page_h": page height in points (usually 842)
}

Return ONLY a JSON array. Be complete — if the exam has 10 questions, return 10 objects.`;

  const parts = [
    { text: prompt },
    { inlineData: { mimeType: 'application/pdf', data: examPdfBase64 } },
  ];
  if (solPdfBase64) {
    parts.push({ text: '\n\nSolution PDF (use for correct answers):' });
    parts.push({ inlineData: { mimeType: 'application/pdf', data: solPdfBase64 } });
  }

  async function tryWithKey(apiKey) {
    for (const model of ['gemini-2.5-flash', 'gemini-2.0-flash']) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      try {
        console.log(`[gemini-fallback] trying ${model}...`);
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: 16384,
              responseMimeType: 'application/json',
              // responseSchema omitted — uppercase types cause silent failures in some API versions
            },
          }),
          signal: AbortSignal.timeout(40000),
        });
        if (!r.ok) {
          console.warn(`[gemini-fallback] ${model} ${r.status}`);
          if (r.status === 429) return { quota_exceeded: true };
          continue;
        }
        const j = await r.json();
        const text = j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
        const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
        let parsed = null;
        try { parsed = JSON.parse(cleaned); } catch { continue; }
        if (Array.isArray(parsed) && parsed.length > 0) {
          console.log(`[gemini-fallback] ${model} found ${parsed.length} MCQs`);
          return { result: parsed };
        }
      } catch (e) {
        console.warn(`[gemini-fallback] ${model} failed:`, e.message);
      }
    }
    return null;
  }

  if (freeKey) {
    const res = await tryWithKey(freeKey);
    if (res?.result) return res.result;
    if (res?.quota_exceeded && paidKey) {
      console.warn('[gemini-fallback] free key quota exceeded — switching to paid key');
      const paidRes = await tryWithKey(paidKey);
      if (paidRes?.result) return paidRes.result;
    }
  } else if (paidKey) {
    const res = await tryWithKey(paidKey);
    if (res?.result) return res.result;
  }
  return null;
}

// =====================================================
// Gemini — batched solution generation (OPTIMIZED)
// =====================================================
// ONE Gemini call per exam (not per question). Sends exam PDF + solution PDF
// once, returns solutions for ALL questions in a single JSON array.
// Previous approach was 40+ calls per 10-question exam → this is 1 call.
// Cost reduction: ~6x (from ~$0.028/exam to ~$0.005/exam).

async function callGeminiJsonWithUsage(prompt, pdfParts, { temperature = 0.2, maxOutputTokens = 16384, timeoutMs = 60000 } = {}) {
  const apiKey = (process.env.GEMINI_API_KEY || '').replace(/\\n/g, '').trim();
  if (!apiKey) return { data: null, usage: null, error: 'no-api-key' };
  const parts = [{ text: prompt }, ...pdfParts];
  const models = ['gemini-2.5-flash', 'gemini-2.0-flash'];
  let lastError = null;
  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { temperature, maxOutputTokens, responseMimeType: 'application/json' },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) {
        lastError = `${model}:${r.status}`;
        const errBody = await r.text().catch(() => '');
        console.warn(`[gemini-batch] ${model} ${r.status}:`, errBody.slice(0, 200));
        continue;
      }
      const j = await r.json();
      const text = j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
      const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      try {
        const data = JSON.parse(cleaned);
        const usage = j.usageMetadata || null;
        return { data, usage, model, error: null };
      } catch (e) {
        lastError = `${model}:parse`;
        continue;
      }
    } catch (e) {
      lastError = `${model}:${e.message}`;
    }
  }
  return { data: null, usage: null, error: lastError };
}

// Main batched generator — ONE call for the whole exam.
// Returns: { solutions: {[qNumber]: {correct, general_explanation, option_explanations}}, usage: {input_tokens, output_tokens, cost_usd}, error }
async function generateAllSolutions(mcqs, examBase64, solBase64, answers) {
  const apiKey = (process.env.GEMINI_API_KEY || '').replace(/\\n/g, '').trim();
  if (!apiKey) {
    console.warn('[solutions] no GEMINI_API_KEY, skipping');
    return { solutions: {}, usage: null, error: 'no-api-key' };
  }

  const tStart = Date.now();
  const questionNumbers = mcqs.map(q => q.number).filter(Boolean);
  const answerHints = Object.entries(answers || {}).filter(([, v]) => v).map(([k, v]) => `Q${k}=${v}`).join(', ');

  const hasSolution = !!solBase64;
  const prompt = `You are reviewing a Hebrew university multiple-choice exam${hasSolution ? ' WITH its official solution key PDF' : ''}.

Your task: For EACH of the following questions in the exam PDF, produce a detailed Hebrew explanation.
Questions to solve: ${questionNumbers.join(', ')}
${answerHints ? `\nKnown correct answers from answer key extraction: ${answerHints}` : ''}
${hasSolution ? '\nUse the solution PDF as GROUND TRUTH for correct answers and reasoning. The solution PDF contains the official answers.' : '\nNo solution PDF provided — solve from first principles using the exam PDF.'}

Return a JSON array with EXACTLY one object per question, in this shape:
[
  {
    "n": <question number (integer)>,
    "correct": <1-4, the correct option index>,
    "general_explanation": "<2-4 sentence Hebrew paragraph explaining the core concept and why the correct answer is correct>",
    "option_explanations": [
      {"idx": 1, "isCorrect": <bool>, "explanation": "<2+ Hebrew sentences: WHY this option is right/wrong, citing the concept/formula/definition>"},
      {"idx": 2, "isCorrect": <bool>, "explanation": "..."},
      {"idx": 3, "isCorrect": <bool>, "explanation": "..."},
      {"idx": 4, "isCorrect": <bool>, "explanation": "..."}
    ]
  }
]

STRICT RULES:
- Return ONE entry per question in the questions-to-solve list. Do NOT skip any.
- Exactly ONE option per question must have isCorrect: true.
- Each option_explanation must be at least 2 full Hebrew sentences explaining the WHY.
- Write in clean academic Hebrew. Do not copy verbatim from the solution PDF — synthesize.
- Output ONLY the JSON array. No markdown fences, no commentary.`;

  const examPart = { inlineData: { mimeType: 'application/pdf', data: examBase64 } };
  const parts = [examPart];
  if (solBase64) {
    parts.push({ text: '\n\n--- SOLUTION KEY PDF (use as ground truth) ---' });
    parts.push({ inlineData: { mimeType: 'application/pdf', data: solBase64 } });
  }

  const result = await callGeminiJsonWithUsage(prompt, parts, {
    temperature: 0.1,
    maxOutputTokens: 16384,
    timeoutMs: 90000,
  });

  if (!result.data || !Array.isArray(result.data)) {
    console.error(`[solutions] batched call failed: ${result.error || 'invalid response shape'}`);
    return { solutions: {}, usage: result.usage, error: result.error || 'invalid-shape' };
  }

  // Normalize the response into a {qNumber: solution} map
  const out = {};
  for (const entry of result.data) {
    const n = parseInt(entry?.n, 10);
    if (!n || isNaN(n)) continue;
    const correct = Math.max(1, Math.min(4, parseInt(entry.correct, 10) || 1));
    const rawOpts = Array.isArray(entry.option_explanations) ? entry.option_explanations : [];
    const normalizedOpts = [1, 2, 3, 4].map(i => {
      const found = rawOpts.find(o => parseInt(o?.idx, 10) === i);
      return {
        idx: i,
        isCorrect: i === correct,
        explanation: (found?.explanation || '').toString().trim(),
      };
    });
    out[String(n)] = {
      correct,
      general_explanation: (entry.general_explanation || '').toString().trim(),
      option_explanations: normalizedOpts,
    };
  }

  // Cost calculation (Gemini 2.5 Flash pricing: $0.075/1M input, $0.30/1M output)
  const inputTokens = result.usage?.promptTokenCount || 0;
  const outputTokens = result.usage?.candidatesTokenCount || 0;
  const costUsd = (inputTokens * 0.075 + outputTokens * 0.30) / 1_000_000;

  console.log(
    `[solutions] batched: ${Object.keys(out).length}/${mcqs.length} questions in ${Date.now() - tStart}ms ` +
    `(model=${result.model}, in=${inputTokens}t, out=${outputTokens}t, ~$${costUsd.toFixed(5)})`
  );

  return {
    solutions: out,
    usage: { inputTokens, outputTokens, costUsd, model: result.model },
    error: null,
  };
}

// Quick document-type classifier — called only when 0 MCQs detected.
// Returns { type: 'exam'|'solution'|'notes'|'blank'|'other', reason: string } or null.
async function classifyPdfWithGemini(pdfBase64) {
  const apiKey = (process.env.GEMINI_API_KEY || '').replace(/\\n/g, '').trim();
  if (!apiKey) return null;
  const prompt = `Look at this PDF and classify it. Reply with ONLY a JSON object (no markdown):
{ "type": "exam" | "solution" | "notes" | "blank" | "other", "reason": "one short sentence in Hebrew" }
exam = university exam with questions students must answer
solution = answer key / פתרון / answers to an exam
notes = lecture slides, notes, textbook pages
blank = empty or unreadable
other = anything else`;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: 'application/pdf', data: pdfBase64 } }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 256, responseMimeType: 'application/json' },
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const text = j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    return JSON.parse(cleaned);
  } catch { return null; }
}

// Verify that a solution PDF actually corresponds to the given exam.
// Returns 'match' | 'mismatch' | 'unknown' (unknown means Gemini was unavailable or unsure).
// =====================================================
// Unified solution-PDF analyzer: verifies the solution matches the exam AND
// extracts all answers in ONE Gemini call.
//
// This replaces the old split approach (separate `verifySolutionMatchesExam`
// + `extractAnswersWithGemini`) for these reasons:
//   1. One round-trip → ~2x faster, half the cost.
//   2. Gemini sees both PDFs simultaneously and can reason about them together.
//   3. Prompt is explicit about colored highlighter marks (ANY color), circled
//      options, handwritten checkmarks, summary tables, inline "answer: X"
//      patterns — every format the user described.
//
// Returns: { match: 'match' | 'mismatch' | 'unknown', confidence: 0-1,
//            answers: {qNumber: answerIdx}, model }
// =====================================================
async function analyzeSolutionPdf(examBase64, solutionBase64, questionNumbers) {
  const freeKey = (process.env.GEMINI_API_KEY || '').replace(/\\n/g, '').trim();
  const paidKey = (process.env.GEMINI_API_KEY_PAID || '').replace(/\\n/g, '').trim();
  if (!freeKey && !paidKey) return { match: 'unknown', confidence: 0, answers: {}, model: null };

  const nums = questionNumbers.slice(0, 60).join(', ');
  const prompt = `You are analyzing two Hebrew academic PDFs that a student just uploaded:
1. An EXAM PDF containing multiple-choice questions numbered approximately: ${nums}
2. A SOLUTION PDF that the student claims contains the answer key for that exam.

Your job has TWO parts, in one response:

PART A — VERIFICATION (strict):
Determine if the SOLUTION PDF is genuinely the answer key for THIS exam.
- Check that question numbers in the solution PDF overlap with the exam's numbers.
- Check that the topic/subject and terminology match between the two PDFs.
- Check that the number of questions is compatible.
- If the solution PDF looks like lecture notes, a different exam, a syllabus, a study guide, or unrelated content → that's a MISMATCH.
- Only answer "match: true" when you are confident the two documents are paired. When in doubt, say unsure.

PART B — ANSWER EXTRACTION (STRICT):
For every exam question number you can find in the solution PDF, report the correct answer.
You are ONLY extracting answers that are EXPLICITLY STATED in the solution PDF. You are NOT solving the questions yourself. You are NOT inferring the answer from context. You are NOT guessing.

⚠️ CRITICAL WARNING — DO NOT BE FOOLED BY EXPLANATION TEXT:
Solution PDFs often contain detailed explanations that DISCUSS WRONG OPTIONS in order to explain why they are incorrect. For example: "ג שגויה כיוון ש...", "אפשרות ג אינה נכונה כי...", "ג אינה המחלקה הקטנה ביותר כי...". These sentences MENTION the letter of a wrong option — they are NOT the answer. If you pick up "ג" from such an explanation sentence, you will give the WRONG answer. Read the CONCLUSION of the solution, not the discussion.

Only count a letter as the answer if it appears in one of these EXPLICIT final-answer formats:
  1. PRIORITY: A SUMMARY TABLE on the last pages — e.g. a table with columns "שאלה | תשובה" listing each question with its answer letter. This is the most reliable source.
  2. A DEDICATED ANSWER KEY section or ordered list: "1. ב", "1) א", "תשובה 1: ב", "ת. 1: ג".
  3. A CONCLUSION SENTENCE at the very end of the solution for a question: "לכן התשובה היא ב", "התשובה הנכונה היא א", "הקיפו את אפשרות ב", "הפתרון: א". The sentence must DECLARE the answer, not discuss why another option is wrong.
  4. A HIGHLIGHTED or CIRCLED option — a colored highlight over one option letter, a hand-drawn circle, checkmark (✓), or arrow (→) pointing at one specific option. The correct option is the one that is marked/circled/highlighted, NOT the ones that are crossed out.
  5. A LETTER or DIGIT written in the margin next to the question number.
Map answers to indices: 1=א, 2=ב, 3=ג, 4=ד. Accept both Hebrew letters and digits in the source.

CRITICAL INSTRUCTION — OMIT RATHER THAN GUESS:
If you are NOT 100% sure of the answer for a specific question — if the solution PDF does not clearly state it with one of the 5 formats above, if you found the letter only in the middle of an explanation paragraph (not a conclusion), or if there is any ambiguity whatsoever — you MUST OMIT that question from the "answers" array entirely. Return nothing rather than a guess. Returning nothing is always correct; returning a wrong answer is always wrong.

Do NOT solve questions. Do NOT infer. Do NOT pick up letters from explanation paragraphs. Only report what is EXPLICITLY declared as the final answer.

Return ONLY this JSON object (no markdown, no extra text):
{
  "match": true | false | null,
  "confidence": <float 0.0-1.0 indicating how confident you are in the match verdict>,
  "reasoning": "<one short Hebrew sentence explaining the match verdict>",
  "answers": [
    {"q": <exam question number>, "ans": <1|2|3|4>, "method": "<one of: table, list, conclusion, highlight, handwritten, margin>", "confidence": <0.0-1.0>, "source_quote": "<the exact text snippet or visual description from the solution PDF declaring this as the answer, max 100 chars>"}
  ]
}

Rules:
- Skip any question where you cannot find the answer in one of the 5 explicit formats. Never guess.
- "confidence" < 0.85 → omit the answer entirely.
- "source_quote" is REQUIRED — quote the exact final-answer text (e.g. "התשובה: א" or "שאלה 2: ב") or describe the visual mark (e.g. "option א circled in red"). If your source_quote is a sentence from the middle of an explanation paragraph — OMIT the answer instead.
- If the solution PDF clearly does not match the exam, still return "answers": [] and set "match": false.
- Be exhaustive: scan every page. The answer key is often on the last page of the solution PDF.`;

  async function callModel(model, apiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [
          { text: prompt },
          { text: '\n\n--- EXAM PDF ---' },
          { inlineData: { mimeType: 'application/pdf', data: examBase64 } },
          { text: '\n\n--- SOLUTION PDF ---' },
          { inlineData: { mimeType: 'application/pdf', data: solutionBase64 } },
        ] }],
        generationConfig: { temperature: 0, maxOutputTokens: 4096, responseMimeType: 'application/json' },
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      console.warn(`[solution-analyze] ${model} ${r.status}:`, errText.slice(0, 300));
      return r.status === 429 ? { quota_exceeded: true } : null;
    }
    const j = await r.json();
    const text = j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
    try {
      const parsed = JSON.parse(text.trim());
      return { parsed, model };
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) { try { return { parsed: JSON.parse(m[0]), model }; } catch {} }
      return null;
    }
  }

  const models = ['gemini-2.5-flash', 'gemini-2.0-flash'];
  for (const model of models) {
    try {
      let res = freeKey ? await callModel(model, freeKey) : null;
      if (res?.quota_exceeded && paidKey) {
        console.warn(`[solution-analyze] ${model} free quota exhausted — switching to paid key`);
        res = await callModel(model, paidKey);
      }
      if (!res?.parsed) continue;

      const p = res.parsed;
      let matchVerdict = 'unknown';
      if (p.match === true) matchVerdict = 'match';
      else if (p.match === false) matchVerdict = 'mismatch';
      const confidence = typeof p.confidence === 'number' ? Math.max(0, Math.min(1, p.confidence)) : 0;

      const answers = {};
      if (Array.isArray(p.answers)) {
        for (const item of p.answers) {
          const q = parseInt(item?.q, 10);
          const ans = parseInt(item?.ans, 10);
          const conf = typeof item?.confidence === 'number' ? item.confidence : 1;
          const hasQuote = typeof item?.source_quote === 'string' && item.source_quote.trim().length > 0;
          // Require source_quote — if Gemini can't point to explicit text in the
          // solution PDF, it was inferring, and we don't accept inferences.
          if (!hasQuote) continue;
          // Reject answers where the source_quote is from an explanation of a
          // WRONG option (e.g. "ג שגויה כי..." or "אינה נכונה").
          // These sentences MENTION the letter of the wrong answer, not the correct one.
          const quote = (item.source_quote || '').toLowerCase();
          const negationWords = ['שגוי', 'שגויה', 'שגוים', 'שגויות', 'אינה', 'אינו', 'אין', 'לא נכון', 'לא מתאי', 'incorrect', 'wrong', 'not correct', 'אינם', 'אינן'];
          const appearsNegated = negationWords.some(w => quote.includes(w));
          if (appearsNegated) {
            console.warn(`[solution-analyze] Q${q}: REJECTED — source_quote looks like wrong-option explanation: "${(item.source_quote || '').slice(0, 120)}"`);
            continue;
          }
          if (q > 0 && ans >= 1 && ans <= 4 && conf >= 0.85) {
            answers[String(q)] = ans;
          }
        }
      }

      console.log(`[solution-analyze] ${model}: match=${matchVerdict} conf=${confidence.toFixed(2)} answers=${Object.keys(answers).length}/${questionNumbers.length} reasoning="${(p.reasoning || '').slice(0, 100)}"`);
      // Log each extracted answer with its source_quote so misreads can be diagnosed
      const rawItems = [];
      if (Array.isArray(p.answers) && p.answers.length > 0) {
        for (const item of p.answers) {
          const accepted = answers[String(parseInt(item?.q, 10))] !== undefined;
          const entry = { q: item?.q, ans: item?.ans, conf: item?.confidence, method: item?.method, accepted, quote: (item?.source_quote || '').slice(0, 120) };
          rawItems.push(entry);
          console.log(`[solution-analyze]   Q${item?.q}: ans=${item?.ans} conf=${item?.confidence?.toFixed?.(2) ?? item?.confidence} method=${item?.method} accepted=${accepted} quote="${entry.quote}"`);
        }
      }
      return { match: matchVerdict, confidence, answers, rawItems, model: res.model, reasoning: p.reasoning || null };
    } catch (e) {
      console.warn(`[solution-analyze] ${model} exception:`, e?.message || e);
    }
  }
  return { match: 'unknown', confidence: 0, answers: {}, model: null };
}

// =====================================================
// Cross-verify extracted answers with Groq (independent second opinion)
//
// For each answer that Gemini extracted from the solution PDF, ask Groq to
// solve the question independently (question text + options only, no solution
// PDF context). If Groq's answer matches Gemini's → 'agree'. If Groq picks a
// different option → 'disagree' (the UI will demote to 'uncertain'). If the
// question has no text (scanned PDF) or Groq fails → 'skip' (fall back to
// trusting Gemini alone).
//
// This catches the class of bugs where Gemini misread a colored-highlight or
// a table row and confidently committed the wrong option. Groq is free and
// fast (~2s per question in parallel), so the added cost is ~zero.
// =====================================================
async function crossVerifyAnswersWithGroq(mcqs, answers) {
  const apiKey = (process.env.GROQ_API_KEY || '').trim();
  if (!apiKey || Object.keys(answers).length === 0) return {};

  const results = {};

  // Process questions in parallel, with graceful per-question error handling
  const tasks = Object.entries(answers).map(async ([qNumStr, geminiAns]) => {
    try {
      const qNum = parseInt(qNumStr, 10);
      const mcq = mcqs.find(m => m.number === qNum);
      if (!mcq) { results[qNumStr] = 'skip'; return; }

      const stemText = String(mcq.questionStemText || '').trim();
      const opts = mcq.optionTexts || {};
      const optsArr = [1, 2, 3, 4].map(i => String(opts[i] || opts[String(i)] || '').trim());
      const nonEmptyOpts = optsArr.filter(o => o.length > 0);

      // Can't cross-verify without enough text to work with
      if (stemText.length < 10 || nonEmptyOpts.length < 2) {
        results[qNumStr] = 'skip';
        return;
      }

      const optionsList = optsArr.map((o, i) => `${i + 1}. ${o || '(ריק)'}`).join('\n');
      const prompt = `להלן שאלה אמריקאית מבחינה אקדמית בעברית. פתור אותה באופן עצמאי וחזיר את האפשרות הנכונה.

שאלה: ${stemText}

האפשרויות:
${optionsList}

נתח את השאלה בקפידה, שקול כל אפשרות, וקבע מהי האפשרות הנכונה. החזר JSON בלבד:
{
  "correct": <1|2|3|4>,
  "confidence": <0.0-1.0>,
  "reasoning": "<שתי משפטים קצרים>"
}

אם אינך בטוח בתשובה — החזר "confidence": 0.0 ו-"correct": null. עדיף לא לענות מאשר לטעות.`;

      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: 'אתה פרופסור מומחה שפותר שאלות אמריקאיות באקדמיה. אתה מדויק ולא מנחש.' },
            { role: 'user', content: prompt },
          ],
          temperature: 0.1,
          max_tokens: 512,
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(20000),
      });

      if (!r.ok) { results[qNumStr] = 'skip'; return; }
      const j = await r.json();
      const text = j.choices?.[0]?.message?.content || '';
      let parsed;
      try { parsed = JSON.parse(text); } catch { results[qNumStr] = 'skip'; return; }

      const groqAns = parseInt(parsed?.correct, 10);
      const groqConf = typeof parsed?.confidence === 'number' ? parsed.confidence : 0;

      // If Groq isn't confident either, we can't use it as a veto — skip
      if (!(groqAns >= 1 && groqAns <= 4) || groqConf < 0.6) {
        results[qNumStr] = 'skip';
        return;
      }

      results[qNumStr] = (groqAns === geminiAns) ? 'agree' : 'disagree';
      if (results[qNumStr] === 'disagree') {
        console.warn(`[cross-verify] Q${qNum}: Gemini=${geminiAns}, Groq=${groqAns} → uncertain (Groq reasoning: ${(parsed?.reasoning || '').slice(0, 120)})`);
      }
    } catch (e) {
      results[qNumStr] = 'skip';
    }
  });

  await Promise.all(tasks);
  const agreeCount = Object.values(results).filter(v => v === 'agree').length;
  const disagreeCount = Object.values(results).filter(v => v === 'disagree').length;
  const skipCount = Object.values(results).filter(v => v === 'skip').length;
  console.log(`[cross-verify] ${agreeCount} agree / ${disagreeCount} disagree / ${skipCount} skip`);
  return results;
}

// Legacy wrapper kept only for the handler's existing call-sites (if any remain).
// Will be removed in a follow-up cleanup once the handler fully uses analyzeSolutionPdf.
async function verifySolutionMatchesExam(examBase64, solutionBase64, questionNumbers) {
  const r = await analyzeSolutionPdf(examBase64, solutionBase64, questionNumbers);
  return r.match;
}

// Normalize a raw Gemini MCQ array into the same shape used by the text-layer
// detector, so the two result sets can be merged cleanly.
function normalizeGeminiMcqs(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    // Accept both number (7) and string ("7") — Gemini sometimes returns strings.
    .filter(q => q && (typeof q.n === 'number' || typeof q.n === 'string') && String(q.n).trim() !== '' && !isNaN(parseInt(q.n, 10)))
    .map(q => ({
      section: String(q.n),
      number: typeof q.n === 'number' ? q.n : parseInt(q.n, 10),
      page: q.page || 2,
      yTop: Math.max(0, ((q.y_top ?? 0) / 100) * (q.page_h || 842) - 25),
      yBottom: ((q.y_bottom ?? Math.min((q.y_top ?? 0) + 25, 100)) / 100) * (q.page_h || 842),
      pageWidth: q.page_w || 595,
      pageHeight: q.page_h || 842,
      numOptions: 4,
      _geminiCorrect: q.correct ?? null,
      _fromGemini: true,
    }));
}

// =====================================================
// Handler
// =====================================================
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await authenticate(req);
  if (!auth) return res.status(401).json({ error: 'Missing or invalid authorization' });

  let examId = null;

  try {
    const buf = await rawBody(req);
    const ct = req.headers['content-type'] || '';
    if (!ct.includes('multipart')) return res.status(400).json({ error: 'Expected multipart/form-data' });
    const parts = parseMultipart(buf, ct);

    const getField = (name) => parts.find(p => p.name === name && !p.filename)?.data?.toString('utf8');
    const getFile = (name) => parts.find(p => p.name === name && p.filename);

    const courseId = getField('courseId');
    const name = getField('name');
    const examFile = getFile('examPdf');
    const solFile = getFile('solutionPdf');

    // Capture filenames for similarity matching
    const examFilename = examFile?.filename || '';
    const solFilename = solFile?.filename || '';

    if (!courseId) return res.status(400).json({ error: 'חסר courseId' });
    const courseIdInt = parseInt(courseId, 10) || courseId;
    if (!name || name.length < 2 || name.length > 200) return res.status(400).json({ error: 'שם מבחן לא תקין' });
    if (!examFile) return res.status(400).json({ error: 'חסר קובץ PDF של המבחן' });
    if (!isPdf(examFile.data)) return res.status(400).json({ error: 'קובץ הבחינה אינו PDF תקני' });
    if (examFile.data.length > MAX_PDF_BYTES) return res.status(413).json({ error: 'הקובץ גדול מדי' });
    if (solFile && !isPdf(solFile.data)) return res.status(400).json({ error: 'קובץ הפתרון אינו PDF תקני' });

    // Verify course ownership (explicit check + RLS belt-and-suspenders)
    const { data: course } = await auth.db.from('ep_courses')
      .select('id, user_id').eq('id', courseIdInt).maybeSingle();
    if (!course || course.user_id !== auth.userId) {
      return res.status(403).json({ error: 'אין גישה לקורס' });
    }

    // ===== Per-user upload quota enforcement =====
    // Uses atomic RPC ep_reserve_pdf_slot (defined in supabase/schema.sql). Plan
    // quotas are mirrored from api/crud.mjs QUOTAS table to keep them in sync.
    const PLAN_QUOTAS = {
      trial:     { per_day: 10, per_month: 100, storage_mb:   500 },
      free:      { per_day:  0, per_month:   0, storage_mb:    50 },
      basic:     { per_day: 10, per_month:  30, storage_mb:  1024 },
      pro:       { per_day: 30, per_month: 150, storage_mb:  5120 },
      education: { per_day: 50, per_month: 500, storage_mb: 20480 },
    };
    let userPlan = 'trial'; // default — overwritten below; used for model tiering
    try {
      const admin = getAdmin();
      if (admin) {
        // Reset daily/monthly counters AND expire trial if past due.
        // This RPC was extended in migrations/harden_trial_expiry.sql to
        // flip plan 'trial' → 'free' when plan_expires_at < now.
        await admin.rpc('reset_user_quotas_if_needed', { p_user_id: auth.userId }).catch(() => {});
        // Fetch profile AFTER the RPC so we see the fresh (possibly
        // downgraded) plan value.
        const { data: profile } = await admin.from('profiles')
          .select('plan, is_admin, trial_used').eq('id', auth.userId).maybeSingle();
        const isAdmin = profile?.is_admin === true;
        if (!isAdmin) {
          const plan = profile?.plan || 'free';
          userPlan = plan;
          const q = PLAN_QUOTAS[plan] || PLAN_QUOTAS.free;
          if (q.per_day === 0 && q.per_month === 0) {
            return res.status(402).json({
              error: 'התוכנית שלך לא כוללת העלאת בחינות',
              guidance: 'שדרג לתוכנית Trial או Basic כדי להעלות בחינות.',
              trial_expired: profile?.trial_used === true && plan === 'free',
            });
          }
          const { data: granted } = await admin.rpc('ep_reserve_pdf_slot', {
            p_user_id: auth.userId,
            p_max_today: q.per_day,
            p_max_month: q.per_month,
            p_max_total: -1, // no lifetime cap for non-free plans
            p_max_storage_bytes: q.storage_mb * 1024 * 1024,
          });
          if (granted === false) {
            return res.status(429).json({
              error: 'הגעת למגבלת ההעלאות',
              guidance: `התוכנית "${plan}" מאפשרת ${q.per_day} בחינות ליום ו-${q.per_month} לחודש. נסה שוב מחר או שדרג תוכנית.`
            });
          }
        }
      }
    } catch (e) {
      console.warn('[upload] quota check failed (allowing upload):', e?.message || e);
    }

    // Duplicate name check (active exams)
    const { count: dupCount } = await auth.db.from('ep_exams')
      .select('id', { count: 'exact', head: true })
      .eq('course_id', courseIdInt).eq('name', name).is('deleted_at', null);
    if (dupCount > 0) return res.status(409).json({ error: `מבחן בשם "${name}" כבר קיים בקורס זה`, guidance: 'שנה את שם המבחן או מחק את המבחן הקיים מניהול הקבצים.' });

    // Trash duplicate check — if same name exists in recycle bin, purge it automatically before re-uploading
    let trashWarning = null;
    try {
      const { data: trashedDup } = await auth.db.from('ep_exams')
        .select('id').eq('course_id', courseIdInt).eq('name', name)
        .not('deleted_at', 'is', null).maybeSingle();
      if (trashedDup) {
        // Hard-delete the trashed exam and its questions to avoid duplicates
        await auth.db.from('ep_questions').delete().eq('exam_id', trashedDup.id).eq('course_id', courseIdInt);
        await auth.db.from('ep_exams').delete().eq('id', trashedDup.id).eq('course_id', courseIdInt);
        trashWarning = `מבחן קודם בשם "${name}" נמצא בסל המחזור ונמחק אוטומטית לפני ההעלאה החדשה.`;
        console.log(`[upload] purged trashed duplicate exam for "${name}"`);
      }
    } catch (e) {
      console.warn('[upload] trash-dup check failed:', e.message);
    }

    // Create exam record
    const { data: exam, error: examErr } = await auth.db.from('ep_exams')
      .insert({ course_id: courseIdInt, user_id: auth.userId, name, status: 'processing' })
      .select().single();
    if (examErr) {
      console.error('[upload] insert exam:', examErr.message);
      return res.status(500).json({ error: 'שגיאה ביצירת רשומת מבחן' });
    }
    examId = exam.id;

    // Prep Cloudinary creds
    const cleanEnv = s => (s || '').replace(/\\n/g, '').replace(/\s+/g, '').trim();
    const cloudName = cleanEnv(process.env.CLOUDINARY_CLOUD_NAME);
    const cloudKey = cleanEnv(process.env.CLOUDINARY_API_KEY);
    const cloudSecret = cleanEnv(process.env.CLOUDINARY_API_SECRET);
    const hasCloudinary = !!(cloudName && cloudKey && cloudSecret);
    const examBase64 = Buffer.from(examFile.data).toString('base64');
    const solBase64 = solFile ? Buffer.from(solFile.data).toString('base64') : null;

    // ===== Run in parallel: Cloudinary upload + text-layer analysis + Gemini verify =====
    const cloudinaryPromise = hasCloudinary
      ? uploadPdfToCloudinary({
          cloudName, apiKey: cloudKey, apiSecret: cloudSecret,
          pdfBase64: examBase64,
          publicId: `examprep/${auth.userId}/${exam.id}/exam`,
        }).catch(e => { console.error('[upload] cloudinary error:', e.message); return null; })
      : Promise.resolve(null);

    const positionsPromise = extractPositions(examFile.data)
      .catch(e => { console.error('[upload] positions error:', e.message); return null; });

    // Always run Gemini in parallel so it can fill any gaps the text-layer misses.
    // Send solution PDF so Gemini can set _geminiCorrect on each MCQ (primary answer source).
    const geminiVerifyPromise = analyzeExamWithGemini(examBase64, solBase64)
      .catch(e => { console.warn('[upload] gemini-verify failed:', e.message); return null; });

    // Start Pass 1 & 2 in parallel with Gemini — they only need solFile.data which is
    // already in memory, so they finish in ~2s while Gemini runs (free timing).
    const pass1Promise = solFile
      ? parseSolutionPdf(solFile.data).catch(e => { console.warn('[upload] pass1 parallel error:', e.message); return null; })
      : Promise.resolve(null);
    const pass2Promise = solFile
      ? flatScanAnswers(solFile.data).catch(e => { console.warn('[upload] pass2 parallel error:', e.message); return {}; })
      : Promise.resolve({});

    const [cloudinaryId, positions, geminiVerifyRaw, pass1Result, pass2Result] = await Promise.all([
      cloudinaryPromise, positionsPromise, geminiVerifyPromise, pass1Promise, pass2Promise,
    ]);

    // ===== Detect MCQs: text-layer + Gemini verify/fill =====
    let mcqs = [];
    let mode = 'text-layer';
    let usedGeminiFallback = false;

    // Text-layer detection (free, accurate crop coords).
    let textLayerMcqs = [];
    let textLayerMode = 'none';
    if (positions && positions.length) {
      const detected = detectMCQsFromPositions(positions);
      textLayerMcqs = detected.mcqs;
      textLayerMode = detected.mode;
      console.log(`[upload] text-layer detected ${textLayerMcqs.length} MCQs via ${textLayerMode}`);
    }

    // Normalize Gemini results (ran in parallel above).
    console.log(`[upload] gemini-verify raw n-values: ${JSON.stringify((geminiVerifyRaw || []).map(q => q?.n))}`);
    const geminiMcqs = normalizeGeminiMcqs(geminiVerifyRaw);
    console.log(`[upload] gemini-verify found ${geminiMcqs.length} MCQs`);

    // Merge: text-layer is authoritative for coordinates; Gemini fills gaps + answers.
    if (textLayerMcqs.length > 0) {
      const geminiByNumber = new Map(geminiMcqs.map(q => [q.number, q]));
      const textNums = new Set(textLayerMcqs.map(q => q.number));
      const geminiFill = geminiMcqs.filter(q => !textNums.has(q.number));
      // Copy _geminiCorrect from Gemini onto text-layer MCQs — critical for answer extraction.
      // Without this, Gemini's answer data is discarded when text-layer finds all questions.
      const enrichedTextLayer = textLayerMcqs.map(q => {
        const gq = geminiByNumber.get(q.number);
        return (gq?._geminiCorrect != null) ? { ...q, _geminiCorrect: gq._geminiCorrect } : q;
      });
      mcqs = [...enrichedTextLayer, ...geminiFill];
      mode = geminiFill.length > 0
        ? `text-layer:${textLayerMode}+gemini-fill(${geminiFill.length})`
        : `text-layer:${textLayerMode}`;
      const gcCount = enrichedTextLayer.filter(q => q._geminiCorrect != null).length;
      console.log(`[upload] merged: ${textLayerMcqs.length} text-layer + ${geminiFill.length} gemini-fill, gemini-correct: ${gcCount}`);
    } else if (geminiMcqs.length > 0) {
      // Scanned/image-only PDF — pure Gemini fallback.
      mcqs = geminiMcqs;
      mode = 'gemini-fallback';
      usedGeminiFallback = true;
      console.log(`[upload] pure gemini-fallback: ${mcqs.length} MCQs`);
    }

    // Dedup by number and sort
    const seen = new Set();
    mcqs = mcqs.filter(q => { const k = q.number; if (seen.has(k)) return false; seen.add(k); return true; });
    mcqs.sort((a, b) => (a.number || 0) - (b.number || 0));
    console.log(`[upload] ${mcqs.length} unique MCQs after dedup`);

    // Hard stop: 0 MCQs detected — classify and give a specific error
    if (mcqs.length === 0) {
      const cls = await classifyPdfWithGemini(examBase64).catch(() => null);
      // Clean up the placeholder exam record
      await auth.db.from('ep_exams').delete().eq('id', exam.id);
      examId = null;
      const hint = cls?.type === 'solution'
        ? 'נראה שהעלית קובץ פתרון. השתמש בו בשדה "קובץ פתרון" ולא כקובץ הבחינה.'
        : cls?.type === 'notes'
        ? 'נראה שהעלית חומר לימוד ולא בחינה. העלה קובץ שמכיל שאלות רב-ברירה.'
        : 'הקובץ לא מכיל שאלות אמריקאיות שניתן לזהות. ודא שיש שאלות עם אפשרויות 1/2/3/4 או א/ב/ג/ד.';
      return res.status(422).json({ error: 'לא זוהו שאלות אמריקאיות בקובץ', guidance: hint });
    }

    // ===== Unified solution analysis: match verification + answer extraction =====
    // One Gemini call does both jobs. Strict rejection if the AI says "not a match",
    // silent accept if the AI says "match" with confidence >= 0.7.
    let answers = {};
    let answerCrossVerify = {}; // { qNumStr: 'agree' | 'disagree' | 'skip' } — set by Groq pass
    let answerExtractDebug = { tried: false, ok: false, matched: 0, model: null };
    let matchVerdict = null;     // 'match' | 'mismatch' | 'unknown'
    let matchConfidence = 0;

    if (mcqs.length > 0 && solBase64) {
      const nums = mcqs.map(q => q.number).filter(Boolean);
      // Keep pass1/pass2 text-extract results as a free starting point (they already ran).
      if (pass1Result) {
        for (const [k, v] of Object.entries(pass1Result))
          if (v.answer >= 1 && v.answer <= 4) answers[k] = v.answer;
      }
      if (pass2Result && Object.keys(pass2Result).length > 0) {
        for (const [k, v] of Object.entries(pass2Result))
          if (!answers[k]) answers[k] = v;
      }

      // Always run the unified Gemini analyzer: it verifies match AND extracts
      // answers that text-only passes can miss (highlighted, handwritten, colored marks).
      answerExtractDebug.tried = true;
      try {
        const analysis = await analyzeSolutionPdf(examBase64, solBase64, nums);
        matchVerdict = analysis.match;
        matchConfidence = analysis.confidence;
        answerExtractDebug.model = analysis.model;
        answerExtractDebug.rawItems = analysis.rawItems || [];
        // Merge AI-extracted answers with text-based ones; AI wins on conflict
        // because it can see visual highlights that text parsing misses.
        if (analysis.answers && Object.keys(analysis.answers).length > 0) {
          for (const [k, v] of Object.entries(analysis.answers)) {
            answers[k] = v;
          }
          answerExtractDebug.ok = true;
        }
        console.log(`[upload] unified analysis: match=${matchVerdict} conf=${matchConfidence.toFixed(2)} answers=${Object.keys(answers).length}/${nums.length}`);
      } catch (e) {
        console.warn('[upload] analyzeSolutionPdf exception:', e?.message || e);
      }
      answerExtractDebug.matched = Object.keys(answers).length;

      // Cross-verify extracted answers with Groq — catches cases where Gemini
      // confidently misread the solution PDF. Runs in parallel, free, ~2s total.
      try {
        answerCrossVerify = await crossVerifyAnswersWithGroq(mcqs, answers);
      } catch (e) {
        console.warn('[upload] cross-verify failed:', e?.message || e);
      }

      // STRICT rejection rules — the user's explicit requirement:
      //   "תדע לזהות תמיד על ידי שימוש בAI שהקבצים בוודאות מתאימים אחרת בכלל לא לבצע"
      //
      // 1. AI says "mismatch"           → hard reject, delete exam, 422
      // 2. AI says "unknown"/"match" with confidence < 0.5 AND no answers extracted → reject
      // 3. AI says "match" with confidence >= 0.5 OR answers were found → proceed silently
      const answered = mcqs.filter(q => answers[String(q.number)]).length;
      const stronglyMatched = matchVerdict === 'match' && matchConfidence >= 0.5;
      const hasGoodAnswers = answered >= Math.max(2, Math.ceil(nums.length * 0.3));

      if (matchVerdict === 'mismatch') {
        await auth.db.from('ep_exams').delete().eq('id', exam.id);
        examId = null;
        return res.status(422).json({
          error: 'קובץ הפתרון אינו מתאים לבחינה',
          guidance: 'ה-AI זיהה שהפתרון שהועלה אינו שייך לבחינה זו. ודא שהעלית את קובץ הפתרון הנכון, או הסר אותו ונסה שוב ללא פתרון.',
        });
      }
      if (!stronglyMatched && !hasGoodAnswers) {
        await auth.db.from('ep_exams').delete().eq('id', exam.id);
        examId = null;
        return res.status(422).json({
          error: 'לא ניתן לאמת שהפתרון שייך לבחינה',
          guidance: 'ה-AI לא הצליח לאמת בוודאות שקובץ הפתרון מתאים לבחינה ולא חילץ מספיק תשובות. ודא שהעלית את קובץ הפתרון הנכון, או נסה להעלות רק את קובץ הבחינה.',
        });
      }
      console.log(`[upload] solution accepted: match=${matchVerdict} conf=${matchConfidence.toFixed(2)} answered=${answered}/${nums.length}`);
    }

    // ===== NO upload-time Gemini solution generation =====
    // The tier-2 pipeline generates structured explanations lazily at
    // display-time (when user first opens a question). This makes uploads
    // FREE and ~6x faster, and free-tier-resilient.
    const solutions = {}; // always empty — filled lazily

    // ===== Build DB rows =====
    if (mcqs.length > 0) {
      const qRecords = mcqs.map((q, i) => {
        let imagePath = 'text-only';
        if (cloudinaryId) {
          imagePath = buildCropUrl(cloudName, cloudinaryId, q);
        }
        // ONLY accept answers that came from the solution PDF via analyzeSolutionPdf.
        // `_geminiCorrect` (which had Gemini "solve" the question from the exam alone)
        // is deliberately ignored — it produced confidently-wrong answers on hard
        // theoretical questions. No solution PDF → correct_idx=unknown → user sets it.
        const answerFromSolution = answers[String(q.number)] ?? null;
        const crossVerified = answerCrossVerify?.[String(q.number)]; // set by Groq pass
        const hasAnswer = answerFromSolution !== null && answerFromSolution >= 1 && answerFromSolution <= 4;
        // Two confidence levels:
        //   'confirmed' — Gemini extracted an answer from the solution PDF
        //   'unknown'   — no answer extracted at all (UI shows "set manually" prompt)
        // Groq cross-verify is intentionally NOT used to downgrade confidence.
        // Gemini reads explicit visual marks (highlights, handwriting, circles) directly
        // from the solution PDF — it is more reliable than Groq solving theoretically.
        let confidence = 'unknown';
        if (hasAnswer) {
          confidence = 'confirmed';
        }
        return {
          exam_id: exam.id,
          course_id: courseIdInt,
          user_id: auth.userId,
          question_number: q.number || (i + 1),
          section_label: q.section || null,
          image_path: imagePath,
          num_options: q.numOptions || 4,
          correct_idx: hasAnswer ? answerFromSolution : 1, // 1 is a placeholder; UI shows warning via answer_confidence
          answer_confidence: confidence,
          option_labels: null,
          is_ai_generated: usedGeminiFallback,
          // Question text extracted by detectMCQsFromPositions (free, used by premium AI button)
          question_text: q.questionStemText || null,
          options_text: (q.optionTexts && Object.keys(q.optionTexts).length > 0) ? q.optionTexts : null,
          // solution_text_raw stays null — parseSolutionPdf side-task was removed (too unreliable)
          general_explanation: null,
          option_explanations: null,
        };
      });

      console.log(`[upload] inserting ${qRecords.length} questions (mode=${mode})`);
      const { error: qErr } = await auth.db.from('ep_questions').insert(qRecords);
      if (qErr) {
        console.error('[upload] batch insert failed:', qErr.message);
        let ok = 0;
        for (const r of qRecords) { if (!(await auth.db.from('ep_questions').insert(r)).error) ok++; }
        console.log(`[upload] individual: ${ok}/${qRecords.length}`);
      }
    }

    // Update exam status — always 'ready' after processing (even with 0 questions).
    // If detection looks incomplete, persist a one-line debug summary so we can
    // diagnose post-hoc without relying on Vercel log surfacing.
    const suspicious = mcqs.length < 3 ||
      (geminiMcqs.length > 0 && mcqs.length < geminiMcqs.length);
    const debugLine = `tl=${textLayerMcqs.length}[${textLayerMcqs.map(q => q.number).join(',')}] ` +
                      `gem=${geminiMcqs.length}[${geminiMcqs.map(q => q.number).join(',')}] ` +
                      `mode=${mode}`;
    await auth.db.from('ep_exams').update({
      status: 'ready',
      question_count: mcqs.length,
      total_pages: positions?.length || null,
      processed_at: new Date().toISOString(),
      ...(suspicious && { error_message: debugLine }),
    }).eq('id', exam.id);

    // Update course counters — MUST filter soft-deleted rows so counts don't
    // drift when the user deletes and re-uploads an exam (the old rows keep
    // `deleted_at` set but still live in the table).
    const [{ count: qCount }, { count: pdfCount }] = await Promise.all([
      auth.db.from('ep_questions').select('id', { count: 'exact', head: true }).eq('course_id', courseIdInt).is('deleted_at', null),
      auth.db.from('ep_exams').select('id', { count: 'exact', head: true }).eq('course_id', courseIdInt).is('deleted_at', null),
    ]);
    await auth.db.from('ep_courses').update({ total_questions: qCount, total_pdfs: pdfCount }).eq('id', courseIdInt);

    // Build warnings (per user rule: when files match, stay silent).
    // Only surface partial-extraction warnings when significantly incomplete.
    const warnings = [];
    if (mcqs.length === 0) {
      warnings.push('לא זוהו שאלות אמריקאיות בקובץ. ודא שהמבחן מכיל שאלות רב-ברירה בפורמט מוכר.');
    } else if (solBase64) {
      const answered = mcqs.filter(q => answers[String(q.number)]).length;
      if (answered > 0 && answered / mcqs.length < 0.5) {
        warnings.push(`זוהו תשובות רק ל-${answered} מתוך ${mcqs.length} שאלות.`);
      }
    }

    res.json({
      ok: true,
      exam_id: exam.id,
      question_count: mcqs.length,
      mode,
      _debug: {
        textLayerCount: textLayerMcqs.length,
        geminiCount: geminiMcqs.length,
        geminiNumbers: geminiMcqs.map(q => q.number),
        textLayerNumbers: textLayerMcqs.map(q => q.number),
        extractedAnswers: answerExtractDebug.rawItems || [],
        finalAnswers: answers,
      },
      ...(warnings.length && { warnings }),
      ...(trashWarning && { trashWarning }),
    });
  } catch (err) {
    console.error('[upload] fatal:', err?.message || err, err?.stack?.split('\n')[1] || '');
    try {
      if (auth?.db) {
        const q = auth.db.from('ep_exams').update({ status: 'failed' });
        if (examId) {
          await q.eq('id', examId);
        } else {
          await q.eq('user_id', auth.userId).eq('status', 'processing');
        }
      }
    } catch {}
    res.status(500).json({ error: 'שגיאה פנימית בהעלאה' });
  }
}
