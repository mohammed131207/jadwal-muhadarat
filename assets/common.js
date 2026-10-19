/* إعدادات المستودع — لوحة الإدارة تنشر الجدول على هذا الملف */
const CONFIG = {
  owner: 'mohammed131207',
  repo: 'jadwal-muhadarat',
  branch: 'main',
  dataPath: 'data/schedule.json',
  // توكن GitHub مشفّر بكلمة سر اللوحة، حتى ينشر أي مشرف بكلمة السر فقط
  accessPath: 'data/access.json',
};

const DEFAULT_TITLE = 'جدول المحاضرات';

/* الأسبوع الدراسي يبدأ من السبت. js = رقم اليوم في Date.getDay() */
const DAYS = [
  { key: 'sat', name: 'السبت', short: 'سبت', js: 6 },
  { key: 'sun', name: 'الأحد', short: 'أحد', js: 0 },
  { key: 'mon', name: 'الاثنين', short: 'اثنين', js: 1 },
  { key: 'tue', name: 'الثلاثاء', short: 'ثلاثاء', js: 2 },
  { key: 'wed', name: 'الأربعاء', short: 'أربعاء', js: 3 },
  { key: 'thu', name: 'الخميس', short: 'خميس', js: 4 },
  { key: 'fri', name: 'الجمعة', short: 'جمعة', js: 5 },
];
const DAY_ORDER = Object.fromEntries(DAYS.map((d, i) => [d.key, i]));
const DRAFT_KEY = 'jadwal.draft.v2';

/* ألوان المواد: كل مادة تاخد لون ثابت حسب ترتيبها الأبجدي */
const SUBJECT_COLORS = ['#3B6FF0', '#8B5CF6', '#E5487F', '#F0802B', '#12A08A', '#3E9F4F', '#D99A06', '#1A9BC7', '#C2410C', '#6366F1'];

function subjectColors(lectures) {
  const names = [...new Set(lectures.map((l) => l.subject))].sort((a, b) => a.localeCompare(b, 'ar'));
  return Object.fromEntries(names.map((n, i) => [n, SUBJECT_COLORS[i % SUBJECT_COLORS.length]]));
}

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

function timeText(t) {
  const total = typeof t === 'number' ? t : toMinutes(t);
  const h24 = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${h24 % 12 || 12}:${String(m).padStart(2, '0')} ${h24 < 12 ? 'ص' : 'م'}`;
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
  if (m === 30 && h > 0) return `${h === 1 ? 'ساعة' : h === 2 ? 'ساعتين' : `${h} ساعات`} ونص`;
  const hs = h ? countWord(h, 'ساعة', 'ساعتين', 'ساعات', 'ساعة') : '';
  const ms = m ? countWord(m, 'دقيقة', 'دقيقتين', 'دقائق', 'دقيقة') : '';
  if (hs && ms) return `${hs} و${ms}`;
  return hs || ms || 'أقل من دقيقة';
}

function sortLectures(a, b) {
  return DAY_ORDER[a.day] - DAY_ORDER[b.day] || toMinutes(a.from) - toMinutes(b.from);
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

const TIME_RE = /^\d{2}:\d{2}$/;

/* يرجّع نسخة نظيفة من البيانات. بيقبل كمان الشكل القديم اللي كان فيه دفعات */
function normalizeData(raw) {
  const out = { updatedAt: null, title: DEFAULT_TITLE, subtitle: '', lectures: [] };
  if (!raw || typeof raw !== 'object') return out;
  out.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : null;

  let source = raw.lectures;
  if (!Array.isArray(source) && Array.isArray(raw.batches)) {
    const batches = raw.batches.filter((b) => b && Array.isArray(b.lectures));
    const batch = batches.find((b) => String(b.name) === '2025')
      || batches.find((b) => b.lectures.length)
      || batches[0];
    source = batch ? batch.lectures : [];
    if (batch && raw.subtitle === undefined) out.subtitle = `دفعة ${batch.name}`;
  }

  if (typeof raw.title === 'string' && raw.title.trim()) out.title = raw.title.trim();
  if (typeof raw.subtitle === 'string') out.subtitle = raw.subtitle.trim();

  out.lectures = (Array.isArray(source) ? source : [])
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
