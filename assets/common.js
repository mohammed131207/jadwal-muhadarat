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

/* المحاضرات المتداخلة بنفس اليوم: id ← المحاضرات اللي متعارضة معها */
function findConflicts(lectures) {
  const out = {};
  lectures.forEach((a, i) => {
    lectures.slice(i + 1).forEach((b) => {
      if (a.day !== b.day) return;
      if (toMinutes(a.from) < toMinutes(b.to) && toMinutes(b.from) < toMinutes(a.to)) {
        (out[a.id] = out[a.id] || []).push(b);
        (out[b.id] = out[b.id] || []).push(a);
      }
    });
  });
  return out;
}

function conflictHtml(others) {
  const list = others.map((o) => `«${escapeHtml(o.subject)}» (${timeText(o.from)} – ${timeText(o.to)})`).join(' و');
  return `في تعارض: متداخلة مع ${list}`;
}

function sortQuizzes(a, b) {
  return a.date.localeCompare(b.date) || toMinutes(a.from) - toMinutes(b.from);
}

/* ---------- تواريخ الكويزات ---------- */
const pad2 = (n) => String(n).padStart(2, '0');

function dateKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDays(d, n) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + n);
  return x;
}

/* أول يوم بالأسبوع الحالي (السبت) */
function weekStart(now = new Date()) {
  return addDays(now, -((now.getDay() + 1) % 7));
}

function dayKeyOf(dateStr) {
  return todayKey(parseDate(dateStr));
}

function shortDate(dateStr) {
  const d = parseDate(dateStr);
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

function longDate(dateStr) {
  return parseDate(dateStr).toLocaleDateString('ar-u-nu-latn', { weekday: 'long', day: 'numeric', month: 'long' });
}

function daysUntil(dateStr, now = new Date()) {
  return Math.round((parseDate(dateStr) - addDays(now, 0)) / 86400000);
}

function daysUntilText(dateStr, now = new Date()) {
  const n = daysUntil(dateStr, now);
  if (n < 0) return 'خلص';
  if (n === 0) return 'اليوم';
  if (n === 1) return 'بكرة';
  return `بعد ${countWord(n, 'يوم', 'يومين', 'أيام', 'يوم')}`;
}

function quizEnded(q, now = new Date()) {
  const today = dateKey(now);
  return q.date < today || (q.date === today && now.getHours() * 60 + now.getMinutes() >= toMinutes(q.to));
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

const TIME_RE = /^\d{2}:\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ATTENDANCE = { required: 'إجباري', optional: 'مش إجباري' };

/* يرجّع نسخة نظيفة من البيانات. بيقبل كمان الشكل القديم اللي كان فيه دفعات */
function normalizeData(raw) {
  const out = { updatedAt: null, title: DEFAULT_TITLE, subtitle: '', lectures: [], quizzes: [], zoom: {} };
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
      attendance: ATTENDANCE[l.attendance] ? l.attendance : '',
      note: String(l.note || '').trim(),
    }))
    .sort(sortLectures);

  // الكويزات بتاريخ محدد، مش أسبوعية
  out.quizzes = (Array.isArray(raw.quizzes) ? raw.quizzes : [])
    .filter((q) => q && DATE_RE.test(q.date) && TIME_RE.test(q.from) && TIME_RE.test(q.to) && String(q.subject || '').trim())
    .map((q) => ({
      id: String(q.id || makeId()),
      date: q.date,
      from: q.from,
      to: q.to,
      subject: String(q.subject).trim(),
      note: String(q.note || '').trim(),
    }))
    .sort(sortQuizzes);

  // روابط الزوم لكل مادة: { اسم المادة: { url, updatedAt } }
  if (raw.zoom && typeof raw.zoom === 'object') {
    Object.entries(raw.zoom).forEach(([subject, z]) => {
      if (z && isWebUrl(z.url)) out.zoom[subject] = { url: z.url.trim(), updatedAt: typeof z.updatedAt === 'string' ? z.updatedAt : null };
    });
  }
  return out;
}

function isWebUrl(u) {
  return typeof u === 'string' && /^https?:\/\/\S+$/i.test(u.trim());
}

/* "قبل ساعتين" وما شابه، لآخر تحديث رابط الزوم */
function timeAgo(iso) {
  const t = new Date(iso).getTime();
  if (!iso || Number.isNaN(t)) return '';
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 1) return 'هلأ';
  if (mins < 60) return `قبل ${countWord(mins, 'دقيقة', 'دقيقتين', 'دقائق', 'دقيقة')}`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `قبل ${countWord(hours, 'ساعة', 'ساعتين', 'ساعات', 'ساعة')}`;
  const days = Math.round(hours / 24);
  if (days < 30) return `قبل ${countWord(days, 'يوم', 'يومين', 'أيام', 'يوم')}`;
  return new Date(t).toLocaleDateString('ar-u-nu-latn', { dateStyle: 'medium' });
}

function exactTime(iso) {
  return new Date(iso).toLocaleString('ar-u-nu-latn', { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' });
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
