/* إعدادات المستودع — لوحة الإدارة تنشر الجدول على هذا الملف */
const CONFIG = {
  owner: 'mohammed131207',
  repo: 'jadwal-muhadarat',
  branch: 'main',
  dataPath: 'data/schedule.json',
  // توكن GitHub مشفّر بكلمة سر اللوحة، حتى ينشر أي مشرف بكلمة السر فقط
  accessPath: 'data/access.json',
};

/* الأسبوع الدراسي يبدأ من السبت. js = رقم اليوم في Date.getDay() */
const DAYS = [
  { key: 'sat', name: 'السبت', js: 6 },
  { key: 'sun', name: 'الأحد', js: 0 },
  { key: 'mon', name: 'الاثنين', js: 1 },
  { key: 'tue', name: 'الثلاثاء', js: 2 },
  { key: 'wed', name: 'الأربعاء', js: 3 },
  { key: 'thu', name: 'الخميس', js: 4 },
  { key: 'fri', name: 'الجمعة', js: 5 },
];
const DAY_ORDER = Object.fromEntries(DAYS.map((d, i) => [d.key, i]));
const DRAFT_KEY = 'jadwal.draft';

function dayName(key) {
  const d = DAYS.find((x) => x.key === key);
  return d ? d.name : key;
}

function todayKey(date = new Date()) {
  return DAYS.find((d) => d.js === date.getDay()).key;
}

function toMinutes(t) {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + (m || 0);
}

function fromMinutes(total) {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function timeParts(t) {
  const total = toMinutes(t);
  const h24 = Math.floor(total / 60);
  const m = total % 60;
  return {
    num: `${h24 % 12 || 12}:${String(m).padStart(2, '0')}`,
    ap: h24 < 12 ? 'ص' : 'م',
  };
}

function timeHtml(t) {
  const p = timeParts(t);
  return `<span class="t-num">${p.num}</span> <span class="t-ap">${p.ap}</span>`;
}

function timeText(t) {
  const p = timeParts(t);
  return `${p.num} ${p.ap}`;
}

function countWord(n, one, two, few, many) {
  if (n === 1) return one;
  if (n === 2) return two;
  if (n >= 3 && n <= 10) return `${n} ${few}`;
  return `${n} ${many}`;
}

function durationText(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const hs = h ? countWord(h, 'ساعة', 'ساعتين', 'ساعات', 'ساعة') : '';
  const ms = m ? countWord(m, 'دقيقة', 'دقيقتين', 'دقائق', 'دقيقة') : '';
  if (hs && ms) return `${hs} و${ms}`;
  return hs || ms || 'أقل من دقيقة';
}

function lectureCountText(n) {
  if (n === 0) return 'لا محاضرات بعد';
  return countWord(n, 'محاضرة واحدة', 'محاضرتان', 'محاضرات', 'محاضرة');
}

function sortLectures(a, b) {
  return DAY_ORDER[a.day] - DAY_ORDER[b.day] || toMinutes(a.from) - toMinutes(b.from);
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

const TIME_RE = /^\d{2}:\d{2}$/;

/* يرجّع نسخة نظيفة من البيانات مهما كان شكل الملف */
function normalizeData(raw) {
  const out = { updatedAt: null, batches: [] };
  if (!raw || typeof raw !== 'object') return out;
  out.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : null;
  for (const b of Array.isArray(raw.batches) ? raw.batches : []) {
    const name = String((b && b.name) || '').trim();
    if (!name || out.batches.some((x) => x.name === name)) continue;
    const lectures = (Array.isArray(b.lectures) ? b.lectures : [])
      .filter((l) => l && DAY_ORDER[l.day] !== undefined && TIME_RE.test(l.from) && TIME_RE.test(l.to) && String(l.subject || '').trim())
      .map((l) => ({
        id: String(l.id || makeId()),
        day: l.day,
        from: l.from,
        to: l.to,
        subject: String(l.subject).trim(),
        room: String(l.room || '').trim(),
        doctor: String(l.doctor || '').trim(),
      }))
      .sort(sortLectures);
    out.batches.push({ name, lectures });
  }
  return out;
}

async function fetchPublished() {
  const res = await fetch(`${CONFIG.dataPath}?v=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return normalizeData(await res.json());
}

function readDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeDraft(draft) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

function clearDraft() {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {}
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function formatUpdated(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return 'آخر تحديث: ' + d.toLocaleString('ar-u-nu-latn', { dateStyle: 'medium', timeStyle: 'short' });
}
