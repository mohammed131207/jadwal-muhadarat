/* بصمة PBKDF2 لكلمة سر لوحة الإدارة (كلمة السر نفسها مش مكتوبة بالكود) */
const PASS_VERIFIER = '42acc915ab285f99acb3eda643ad37d342d734c890ba303f5c42d397d039c9b5';
const PASS_SALT = 'jadwal-muhadarat:login';
const PBKDF2_ITERATIONS = 600000;
const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new?' + new URLSearchParams({
  name: CONFIG.repo,
  description: 'نشر جدول المحاضرات من لوحة الإدارة',
  target_name: CONFIG.owner,
  expires_in: 'none',
  contents: 'write',
});

const $ = (id) => document.getElementById(id);

let data = null;
let dirty = false;
let editingId = null;
let busy = false;
let draftWarned = false;
/* كلمة السر والتوكن بالذاكرة فقط طول ما الصفحة مفتوحة؛ تحديث الصفحة يطلب الدخول من جديد */
let loginPassword = null;
let token = null;
let linked = false;

/* ---------- تشفير ---------- */
const bytesToB64 = (bytes) => btoa(String.fromCharCode(...bytes));
const b64ToBytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function pbkdf2(password, salt, iterations, usage) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [usage === 'bits' ? 'deriveBits' : 'deriveKey']);
  const params = { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' };
  if (usage === 'bits') return new Uint8Array(await crypto.subtle.deriveBits(params, base, 256));
  return crypto.subtle.deriveKey(params, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function checkPassword(password) {
  const bits = await pbkdf2(password, new TextEncoder().encode(PASS_SALT), PBKDF2_ITERATIONS, 'bits');
  return [...bits].map((b) => b.toString(16).padStart(2, '0')).join('') === PASS_VERIFIER;
}

async function encryptToken(value, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await pbkdf2(password, salt, PBKDF2_ITERATIONS, 'key');
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(value));
  return {
    v: 1,
    kdf: 'PBKDF2-SHA256',
    iterations: PBKDF2_ITERATIONS,
    salt: bytesToB64(salt),
    iv: bytesToB64(iv),
    data: bytesToB64(new Uint8Array(cipher)),
  };
}

async function decryptToken(blob, password) {
  const key = await pbkdf2(password, b64ToBytes(blob.salt), blob.iterations, 'key');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(blob.iv) }, key, b64ToBytes(blob.data));
  return new TextDecoder().decode(plain);
}

/* يرجّع ملف التوكن المشفّر من الموقع، أو null إذا لسا ما انربط */
async function fetchAccess() {
  const res = await fetch(`${CONFIG.accessPath}?v=${Date.now()}`, { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/* يفك التوكن المحفوظ بكلمة السر؛ يرجّع null إذا ما في ربط */
async function unlockToken() {
  if (token) return token;
  const blob = await fetchAccess();
  linked = Boolean(blob);
  if (!blob) return null;
  token = await decryptToken(blob, loginPassword);
  return token;
}

/* ---------- أدوات ---------- */
function b64encode(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

let toastTimer;
function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('is-error', isError);
  el.classList.add('is-shown');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-shown'), isError ? 6000 : 3200);
}

/* ---------- GitHub ---------- */
async function ghRequest(path, token, options = {}) {
  const res = await fetch(`https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/${path}`, {
    ...options,
    cache: 'no-store',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

async function getRemoteFile(token, path = CONFIG.dataPath) {
  const file = await ghRequest(`contents/${path}?ref=${CONFIG.branch}`, token);
  return { sha: file.sha, text: b64decode(file.content) };
}

async function putFile(token, text, path = CONFIG.dataPath, message = 'تحديث جدول المحاضرات') {
  for (let attempt = 0; ; attempt++) {
    let sha;
    try {
      sha = (await getRemoteFile(token, path)).sha;
    } catch (err) {
      if (err.status !== 404) throw err;
    }
    try {
      return await ghRequest(`contents/${path}`, token, {
        method: 'PUT',
        body: JSON.stringify({
          message,
          content: b64encode(text),
          branch: CONFIG.branch,
          ...(sha ? { sha } : {}),
        }),
      });
    } catch (err) {
      // تعارض نسخة (حدا نشر بنفس اللحظة): نجيب الـ sha الجديد ونعيد مرة وحدة
      if ((err.status === 409 || err.status === 422) && attempt === 0) continue;
      throw err;
    }
  }
}

/* ---------- تحميل البيانات ---------- */
async function loadData() {
  const draft = readDraft();
  if (draft && draft.dirty && draft.data) {
    data = normalizeData(draft.data);
    dirty = true;
    return;
  }
  if (token) {
    try {
      data = normalizeData(JSON.parse((await getRemoteFile(token)).text));
      dirty = false;
      return;
    } catch {}
  }
  data = await fetchPublished();
  dirty = false;
}

function commit() {
  dirty = true;
  const saved = writeDraft({ data, dirty: true, savedAt: new Date().toISOString() });
  if (!saved && !draftWarned) {
    draftWarned = true;
    toast('ما قدرنا نحفظ التعديلات على هالجهاز. انشرها قبل ما تسكّر الصفحة.', true);
  }
  renderAll();
}

/* ---------- العرض ---------- */
function renderAll() {
  renderList();
  renderQuizzes();
  renderZoom();
  renderPublishBar();
  renderTokenState();
}

function attendanceTag(value) {
  if (!value) return '';
  return `<span class="att-tag att-${value}">حضور ${ATTENDANCE[value]}</span>`;
}

function renderList() {
  const lectures = data.lectures;
  $('count-title').textContent = lectures.length ? `المحاضرات (${lectures.length})` : 'المحاضرات';
  if (!lectures.length) {
    $('lecture-list').innerHTML = '<div class="card state"><p>لسا ما في محاضرات. اضغط «إضافة محاضرة» لتبلش.</p></div>';
    return;
  }
  const colors = subjectColors(lectures);
  const conflicts = findConflicts(lectures);
  $('lecture-list').innerHTML = DAYS
    .map((d) => ({ day: d, items: lectures.filter((l) => l.day === d.key) }))
    .filter((g) => g.items.length)
    .map((g) => `
      <section class="card day-group">
        <h3>${g.day.name}</h3>
        ${g.items.map((l) => {
          const meta = [l.room, l.doctor].filter(Boolean).map(escapeHtml).join(' · ');
          return `
          <div class="lec-item" style="--c:${colors[l.subject]}">
            <span class="lec-bar" aria-hidden="true"></span>
            <div class="lec-info">
              <strong>${escapeHtml(l.subject)}${conflicts[l.id] ? `<button class="clash-dot" type="button" data-clash="${l.id}" aria-expanded="false" aria-label="في تعارض، اضغط للتفاصيل"></button>` : ''}</strong>
              <span>${timeText(l.from)} – ${timeText(l.to)}${meta ? ` · ${meta}` : ''}</span>
              ${l.attendance || l.note ? `<span class="lec-extra">${attendanceTag(l.attendance)}${l.note ? `<span class="lec-note">${escapeHtml(l.note)}</span>` : ''}</span>` : ''}
              ${conflicts[l.id] ? `<p class="clash-note" id="clash-${l.id}" hidden>${conflictHtml(conflicts[l.id])}</p>` : ''}
            </div>
            <div class="lec-actions">
              <button class="btn btn-sm" type="button" data-edit="${l.id}">تعديل</button>
              <button class="btn btn-sm btn-danger" type="button" data-delete="${l.id}">حذف</button>
            </div>
          </div>`;
        }).join('')}
      </section>`).join('');
}

function renderQuizzes() {
  const quizzes = data.quizzes;
  const upcoming = quizzes.filter((q) => !quizEnded(q));
  $('quiz-title').textContent = upcoming.length ? `الكويزات (${upcoming.length} جاية)` : 'الكويزات';
  if (!quizzes.length) {
    $('quiz-list').innerHTML = '<div class="card state"><p>ما في كويزات. لما يكون في كويز اضغط «إضافة كويز».</p></div>';
    return;
  }
  const row = (q) => {
    const ended = quizEnded(q);
    return `
      <div class="lec-item quiz-item${ended ? ' is-ended' : ''}">
        <span class="lec-bar" aria-hidden="true"></span>
        <div class="lec-info">
          <strong>${escapeHtml(q.subject)}</strong>
          <span>${longDate(q.date)} · ${timeText(q.from)} – ${timeText(q.to)}</span>
          <span class="lec-extra"><span class="quiz-when">${ended ? 'خلص' : daysUntilText(q.date)}</span>${q.note ? `<span class="lec-note">${escapeHtml(q.note)}</span>` : ''}</span>
        </div>
        <div class="lec-actions">
          <button class="btn btn-sm" type="button" data-edit-quiz="${q.id}">تعديل</button>
          <button class="btn btn-sm btn-danger" type="button" data-delete-quiz="${q.id}">حذف</button>
        </div>
      </div>`;
  };
  const ended = quizzes.filter((q) => quizEnded(q));
  $('quiz-list').innerHTML = `
    <section class="card day-group">
      ${upcoming.length ? upcoming.map(row).join('') : '<p class="tools-intro">ما في كويزات جاية.</p>'}
      ${ended.length ? `
        <details class="ended-quizzes">
          <summary>كويزات خلصت (${ended.length})</summary>
          ${ended.slice().reverse().map(row).join('')}
        </details>` : ''}
    </section>`;
}

function renderPublishBar() {
  $('publish-bar').classList.toggle('is-dirty', dirty);
  if (busy) $('publish-state').textContent = 'جاري النشر…';
  else if (dirty) $('publish-state').textContent = 'في تعديلات ما انتشرت. الطلاب لسا بشوفوا الجدول القديم.';
  else $('publish-state').textContent = data.updatedAt ? `كل شي منشور · ${formatUpdated(data.updatedAt)}` : 'كل شي منشور.';
  $('publish').disabled = !dirty || busy;
  $('discard').disabled = !dirty || busy;
}

function renderTokenState() {
  $('token-state').textContent = linked
    ? 'النشر مربوط بـ GitHub: أي حدا معه كلمة سر اللوحة بينشر من أي جهاز.'
    : 'النشر مش مربوط بـ GitHub لسا. أول نشر رح يطلب الربط مرة وحدة.';
  $('token-change').textContent = linked ? 'تغيير توكن GitHub' : 'ربط GitHub';
}

/* ---------- نموذج المحاضرة والكويز (أزرار بدل خانات الوقت) ---------- */
const HOURS = Array.from({ length: 14 }, (_, i) => i + 7); // 7 ص لـ 8 م
const MINUTES = [0, 15, 30, 45];
const DURATIONS = [30, 60, 90, 120, 150, 180];
const ATTENDANCE_CHOICES = [['required', 'إجباري'], ['optional', 'مش إجباري'], ['', 'مش محدد']];
// mode: lecture أو quiz. الكويز بتاريخ محدد بدل يوم بالأسبوع
const form = { mode: 'lecture', day: 'sat', date: null, hour: null, minute: 0, duration: 60, attendance: '' };
let lastDay = 'sat';
let lastDuration = 60;
let timeTouched = false;

function hourLabel(h) {
  return `${h % 12 || 12} ${h < 12 ? 'ص' : 'م'}`;
}

function chip(group, value, label, active) {
  return `<button type="button" class="chip${active ? ' is-on' : ''}" role="radio" aria-checked="${active}" data-group="${group}" data-value="${value}">${label}</button>`;
}

function dateChoices() {
  const today = new Date();
  const dates = Array.from({ length: 28 }, (_, i) => dateKey(addDays(today, i)));
  if (form.date && !dates.includes(form.date)) dates.unshift(form.date);
  return dates;
}

function dateChipLabel(key) {
  const n = daysUntil(key);
  const top = n === 0 ? 'اليوم' : n === 1 ? 'بكرة' : DAYS.find((d) => d.key === dayKeyOf(key)).name;
  return `<span class="date-top">${top}</span><span class="date-num">${shortDate(key)}</span>`;
}

function renderChips() {
  const quiz = form.mode === 'quiz';
  if (quiz) {
    $('date-chips').innerHTML = dateChoices().map((k) => chip('date', k, dateChipLabel(k), form.date === k)).join('');
  } else {
    $('day-chips').innerHTML = DAYS.map((d) => chip('day', d.key, d.name, form.day === d.key)).join('');
    $('attendance-chips').innerHTML = ATTENDANCE_CHOICES.map(([v, label]) => chip('attendance', v, label, form.attendance === v)).join('');
  }

  const hours = form.hour !== null && !HOURS.includes(form.hour) ? [...HOURS, form.hour].sort((a, b) => a - b) : HOURS;
  $('hour-chips').innerHTML = hours.map((h) => chip('hour', h, hourLabel(h), form.hour === h)).join('');

  const minutes = MINUTES.includes(form.minute) ? MINUTES : [...MINUTES, form.minute].sort((a, b) => a - b);
  $('minute-chips').innerHTML = minutes.map((m) => chip('minute', m, `<span class="ltr">:${String(m).padStart(2, '0')}</span>`, form.minute === m)).join('');

  $('duration-chips').innerHTML = DURATIONS.map((d) => chip('duration', d, d === 30 ? 'نص ساعة' : durationText(d), form.duration === d)).join('');
  $('duration-text').textContent = durationText(form.duration);

  const start = form.hour === null ? null : form.hour * 60 + form.minute;
  const where = quiz ? (form.date ? `كويز · ${longDate(form.date)}` : '') : dayName(form.day);
  if (quiz && !form.date) $('summary').innerHTML = 'اختار تاريخ الكويز';
  else if (start === null) $('summary').innerHTML = quiz ? 'اختار الساعة اللي بيبلش فيها الكويز' : 'اختار الساعة اللي بتبلش فيها المحاضرة';
  else $('summary').innerHTML = `<b>${where}</b> · من ${timeText(start)} لـ ${timeText(start + form.duration)}`;
}

function renderSubjectChips() {
  const typed = $('f-subject').value.trim();
  const names = [...new Set(data.lectures.map((l) => l.subject))].sort((a, b) => a.localeCompare(b, 'ar'));
  $('subject-chips').hidden = !names.length;
  $('subject-chips').innerHTML = names.map((n) => `<button type="button" class="chip chip-soft${n === typed ? ' is-on' : ''}" data-subject="${escapeHtml(n)}">${escapeHtml(n)}</button>`).join('');
}

/* الكويز غالباً بوقت المحاضرة: إذا في محاضرة لنفس المادة بنفس اليوم، بنعبّي وقتها */
function prefillQuizTime() {
  if (form.mode !== 'quiz' || timeTouched || !form.date) return;
  const subject = $('f-subject').value.trim();
  const lecture = data.lectures.find((l) => l.subject === subject && l.day === dayKeyOf(form.date));
  if (!lecture) return;
  const start = toMinutes(lecture.from);
  Object.assign(form, { hour: Math.floor(start / 60), minute: start % 60, duration: toMinutes(lecture.to) - start });
}

function openForm(mode, item = null) {
  const quiz = mode === 'quiz';
  editingId = item ? item.id : null;
  timeTouched = Boolean(item);
  form.mode = mode;
  $('lec-title').textContent = item ? (quiz ? 'تعديل كويز' : 'تعديل محاضرة') : (quiz ? 'إضافة كويز' : 'إضافة محاضرة');
  $('day-field').hidden = quiz;
  $('date-field').hidden = !quiz;
  $('attendance-field').hidden = quiz;
  $('place-row').hidden = quiz;
  $('extra-title').textContent = quiz ? 'ملاحظة (اختياري)' : 'ملاحظة والقاعة والمحاضر (اختياري)';
  $('f-note').placeholder = quiz ? 'مثلاً: من محاضرة 1 لـ 4' : 'مثلاً: جيب اللابتوب معك';
  $('save-again-btn').hidden = Boolean(item) || quiz;
  $('form-error').textContent = '';

  if (item) {
    const start = toMinutes(item.from);
    Object.assign(form, { hour: Math.floor(start / 60), minute: start % 60, duration: toMinutes(item.to) - start });
    if (quiz) form.date = item.date;
    else Object.assign(form, { day: item.day, attendance: item.attendance });
    $('f-subject').value = item.subject;
    $('f-note').value = item.note;
    $('f-room').value = item.room || '';
    $('f-doctor').value = item.doctor || '';
  } else {
    Object.assign(form, { hour: null, minute: 0 });
    if (quiz) Object.assign(form, { date: null, duration: 30 });
    else Object.assign(form, { day: lastDay, duration: lastDuration, attendance: '' });
    ['f-subject', 'f-note', 'f-room', 'f-doctor'].forEach((id) => { $(id).value = ''; });
  }
  $('extra').open = Boolean(item && (item.note || item.room || item.doctor));
  renderChips();
  renderSubjectChips();
  if (!$('lec-dialog').open) $('lec-dialog').showModal();
  $('lec-form').scrollTop = 0;
}

$('lec-form').addEventListener('click', (e) => {
  const c = e.target.closest('[data-group]');
  if (c) {
    const group = c.dataset.group;
    const v = c.dataset.value;
    if (group === 'day' || group === 'date' || group === 'attendance') form[group] = v;
    else form[group] = Number(v);
    if (group === 'hour' || group === 'minute' || group === 'duration') timeTouched = true;
    if (group === 'date') prefillQuizTime();
    $('form-error').textContent = '';
    renderChips();
    return;
  }
  const s = e.target.closest('[data-subject]');
  if (s) {
    $('f-subject').value = s.dataset.subject;
    renderSubjectChips();
    prefillQuizTime();
    renderChips();
    return;
  }
  const step = e.target.closest('[data-step]');
  if (step) {
    form.duration = Math.min(360, Math.max(15, form.duration + Number(step.dataset.step)));
    timeTouched = true;
    renderChips();
    return;
  }
  if (e.target.closest('[data-close]')) $('lec-dialog').close();
});

$('f-subject').addEventListener('input', () => {
  const typed = $('f-subject').value.trim();
  $('subject-chips').querySelectorAll('[data-subject]').forEach((b) => b.classList.toggle('is-on', b.dataset.subject === typed));
});

$('lec-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const quiz = form.mode === 'quiz';
  const again = e.submitter && e.submitter.value === 'again';
  const fail = (msg) => { $('form-error').textContent = msg; };
  const subject = $('f-subject').value.trim();
  if (!subject) return fail('اكتب اسم المادة.');
  if (quiz && !form.date) return fail('اختار تاريخ الكويز.');
  if (form.hour === null) return fail(quiz ? 'اختار الساعة اللي بيبلش فيها الكويز.' : 'اختار الساعة اللي بتبلش فيها المحاضرة.');
  const start = form.hour * 60 + form.minute;
  const end = start + form.duration;
  if (end > 24 * 60) return fail('الوقت بيعدّي نص الليل. قصّر المدة.');
  const note = $('f-note').value.trim();

  if (quiz) {
    const v = { date: form.date, from: fromMinutes(start), to: fromMinutes(end), subject, note };
    if (editingId) Object.assign(data.quizzes.find((q) => q.id === editingId), v);
    else data.quizzes.push({ id: makeId(), ...v });
    data.quizzes.sort(sortQuizzes);
    toast(editingId ? 'انحفظ تعديل الكويز.' : `انضاف كويز «${subject}» ${daysUntilText(form.date)}.`);
    commit();
    $('lec-dialog').close();
    return;
  }

  const v = {
    day: form.day,
    from: fromMinutes(start),
    to: fromMinutes(end),
    subject,
    room: $('f-room').value.trim(),
    doctor: $('f-doctor').value.trim(),
    attendance: form.attendance,
    note,
  };
  // التعارض ما بيمنع الحفظ؛ بس بنبّه وبتطلع نقطة حمرا جنب المادة
  const clash = data.lectures.find((l) => l.id !== editingId && l.day === v.day
    && toMinutes(l.from) < end && start < toMinutes(l.to));
  const clashNote = clash ? ` بس في تعارض مع «${clash.subject}».` : '';

  if (editingId) {
    const lecture = data.lectures.find((l) => l.id === editingId);
    const oldSubject = lecture.subject;
    Object.assign(lecture, v);
    // إذا تغيّر اسم المادة، رابط الزوم بينتقل معها
    if (oldSubject !== subject && data.zoom[oldSubject] && !data.zoom[subject]
      && !data.lectures.some((l) => l.subject === oldSubject)) {
      data.zoom[subject] = data.zoom[oldSubject];
      delete data.zoom[oldSubject];
    }
    toast(`انحفظ التعديل.${clashNote}`, Boolean(clash));
  } else {
    data.lectures.push({ id: makeId(), ...v });
    toast(`انضافت «${subject}».${clashNote}`, Boolean(clash));
  }
  data.lectures.sort(sortLectures);
  lastDay = form.day;
  lastDuration = form.duration;
  commit();

  if (again) {
    // المحاضرة الجاية: نفس اليوم، بتبلش لما تخلص هاي وبنفس المدة
    openForm('lecture');
    if (end + form.duration <= 24 * 60) {
      form.hour = Math.floor(end / 60);
      form.minute = end % 60;
    }
    renderChips();
  } else {
    $('lec-dialog').close();
  }
});

$('add-btn').addEventListener('click', () => openForm('lecture'));
$('add-quiz-btn').addEventListener('click', () => openForm('quiz'));

$('lecture-list').addEventListener('click', (e) => {
  const dot = e.target.closest('[data-clash]');
  if (dot) {
    const note = $(`clash-${dot.dataset.clash}`);
    note.hidden = !note.hidden;
    dot.setAttribute('aria-expanded', String(!note.hidden));
    return;
  }
  const edit = e.target.closest('[data-edit]');
  if (edit) return openForm('lecture', data.lectures.find((l) => l.id === edit.dataset.edit));
  const del = e.target.closest('[data-delete]');
  if (!del) return;
  const lecture = data.lectures.find((l) => l.id === del.dataset.delete);
  if (!lecture || !confirm(`تحذف «${lecture.subject}» يوم ${dayName(lecture.day)} ${timeText(lecture.from)}؟`)) return;
  data.lectures = data.lectures.filter((l) => l.id !== lecture.id);
  commit();
  toast('انحذفت.');
});

$('quiz-list').addEventListener('click', (e) => {
  const edit = e.target.closest('[data-edit-quiz]');
  if (edit) return openForm('quiz', data.quizzes.find((q) => q.id === edit.dataset.editQuiz));
  const del = e.target.closest('[data-delete-quiz]');
  if (!del) return;
  const quiz = data.quizzes.find((q) => q.id === del.dataset.deleteQuiz);
  if (!quiz || !confirm(`تحذف كويز «${quiz.subject}» ${longDate(quiz.date)}؟`)) return;
  data.quizzes = data.quizzes.filter((q) => q.id !== quiz.id);
  commit();
  toast('انحذف الكويز.');
});

/* ---------- روابط الزوم ---------- */
let zoomSubjects = [];
const zoomTyping = {}; // اللي انكتب وما انحفظ، حتى ما يضيع لو انعادت الرسمة

function renderZoom() {
  zoomSubjects = [...new Set(data.lectures.map((l) => l.subject))].sort((a, b) => a.localeCompare(b, 'ar'));
  if (!zoomSubjects.length) {
    $('zoom-list').innerHTML = '<p class="tools-intro">ضيف محاضرات أول، وبعدين بتحط روابطها هون.</p>';
    return;
  }
  const colors = subjectColors(data.lectures);
  $('zoom-list').innerHTML = zoomSubjects.map((subject, i) => {
    const z = data.zoom[subject];
    const value = zoomTyping[subject] ?? (z ? z.url : '');
    const when = z && z.updatedAt
      ? `آخر مرة انحط الرابط: <b>${timeAgo(z.updatedAt)}</b> · ${exactTime(z.updatedAt)}`
      : 'ما انحط رابط لسا';
    return `
      <div class="zoom-row" style="--c:${colors[subject]}">
        <label for="zoom-${i}"><i class="zoom-dot" aria-hidden="true"></i>${escapeHtml(subject)}</label>
        <div class="zoom-input">
          <input id="zoom-${i}" type="url" inputmode="url" dir="ltr" autocomplete="off" spellcheck="false"
            placeholder="https://zoom.us/j/…" value="${escapeHtml(value)}" data-zoom-input="${i}">
          <button class="btn btn-sm btn-primary" type="button" data-zoom-save="${i}">حفظ ونشر</button>
        </div>
        <p class="zoom-meta${z ? '' : ' is-empty'}">${when}</p>
      </div>`;
  }).join('');
}

$('zoom-list').addEventListener('input', (e) => {
  const input = e.target.closest('[data-zoom-input]');
  if (input) zoomTyping[zoomSubjects[input.dataset.zoomInput]] = input.value;
});

$('zoom-list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-zoom-save]');
  if (!btn) return;
  const subject = zoomSubjects[btn.dataset.zoomSave];
  const url = $(`zoom-${btn.dataset.zoomSave}`).value.trim();
  if (url && !isWebUrl(url)) {
    toast('الرابط لازم يبلش بـ https://', true);
    return;
  }
  delete zoomTyping[subject];
  if (url) data.zoom[subject] = { url, updatedAt: new Date().toISOString() };
  else delete data.zoom[subject];
  commit();
  toast(url ? `انحفظ رابط «${subject}». جاري النشر…` : `انمسح رابط «${subject}». جاري النشر…`);
  publish();
});

/* ---------- عنوان الجدول ---------- */
$('title-form').addEventListener('submit', (e) => {
  e.preventDefault();
  data.title = $('t-title').value.trim() || DEFAULT_TITLE;
  data.subtitle = $('t-subtitle').value.trim();
  $('t-title').value = data.title;
  commit();
  toast('انحفظ العنوان. انشر التعديلات ليظهر للطلاب.');
});

function fillTitleForm() {
  $('t-title').value = data.title;
  $('t-subtitle').value = data.subtitle;
}

/* ---------- النشر ---------- */
function setBusy(on) {
  busy = on;
  $('publish').textContent = on ? 'جاري النشر…' : 'نشر التعديلات';
  renderPublishBar();
}

async function publish() {
  setBusy(true);
  try {
    let t;
    try {
      t = await unlockToken();
    } catch (err) {
      // فشل فك التشفير: التوكن المحفوظ مقفول بكلمة سر غير الحالية
      if (err.name === 'OperationError') return openTokenDialog('توكن GitHub المحفوظ مقفول بكلمة سر مختلفة. اربط GitHub من جديد.');
      throw err;
    }
    if (!t) return openTokenDialog();
    const payload = { updatedAt: new Date().toISOString(), title: data.title, subtitle: data.subtitle, lectures: data.lectures, quizzes: data.quizzes, zoom: data.zoom };
    await putFile(t, JSON.stringify(payload, null, 2) + '\n');
    data.updatedAt = payload.updatedAt;
    dirty = false;
    clearDraft();
    toast('انتشر الجدول. بيظهر للطلاب خلال دقيقة تقريباً.');
  } catch (err) {
    if (err.status === 401) {
      token = null;
      openTokenDialog('توكن GitHub المحفوظ خلصت صلاحيته أو انلغى. اعمل توكن جديد واربطه.');
    } else if (err.status === 403 || err.status === 404) {
      token = null;
      openTokenDialog(`توكن GitHub المحفوظ ما عنده صلاحية كتابة على مستودع ${CONFIG.repo}. اعمل توكن جديد حسب الخطوات.`);
    } else {
      toast('ما زبط النشر. تأكد من الإنترنت وجرّب كمان مرة؛ تعديلاتك محفوظة على هالجهاز.', true);
    }
  } finally {
    setBusy(false);
    renderAll();
  }
}

$('publish').addEventListener('click', publish);

$('discard').addEventListener('click', async () => {
  if (!confirm('تتراجع عن كل التعديلات اللي ما انتشرت؟')) return;
  clearDraft();
  await showEditor();
  toast('رجعت اللوحة للجدول المنشور.');
});

/* ---------- ربط GitHub (مرة وحدة لكل الموقع) ---------- */
function openTokenDialog(message = '') {
  $('token-error').textContent = message;
  $('token-input').value = '';
  $('token-save').textContent = dirty ? 'ربط ونشر' : 'ربط';
  if (!$('token-dialog').open) $('token-dialog').showModal();
}

$('token-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (e.submitter && e.submitter.value === 'cancel') {
    $('token-dialog').close();
    return;
  }
  const value = $('token-input').value.trim();
  if (!/^(github_pat_|ghp_)\w{20,}$/.test(value)) {
    $('token-error').textContent = 'هاد مش شكل توكن GitHub. التوكن بيبلش بـ github_pat_';
    return;
  }
  const save = $('token-save');
  save.disabled = true;
  save.textContent = 'جاري الربط…';
  $('token-error').textContent = '';
  try {
    // التوكن بينحفظ بالمستودع مشفّر بكلمة سر اللوحة؛ الحفظ نفسه بيتأكد إن عنده صلاحية كتابة
    const blob = await encryptToken(value, loginPassword);
    await putFile(value, JSON.stringify(blob, null, 2) + '\n', CONFIG.accessPath, 'ربط لوحة الإدارة بـ GitHub');
    token = value;
    linked = true;
    $('token-dialog').close();
    renderTokenState();
    if (dirty) publish();
    else toast('تم الربط. أي حدا معه كلمة سر اللوحة بينشر هلأ من أي جهاز.');
  } catch (err) {
    $('token-error').textContent = err.status === 401
      ? 'GitHub رفض هالتوكن. تأكد إنك نسخته كامل.'
      : err.status === 403 || err.status === 404
        ? `التوكن ما عنده صلاحية كتابة على مستودع ${CONFIG.repo}. راجع الخطوة 2 و3.`
        : 'ما قدرنا نوصل لـ GitHub. تأكد من الإنترنت وجرّب كمان مرة.';
  } finally {
    save.disabled = false;
    save.textContent = dirty ? 'ربط ونشر' : 'ربط';
  }
});

$('token-change').addEventListener('click', () => openTokenDialog());

/* إغلاق النوافذ بالضغط برا */
document.querySelectorAll('dialog.sheet').forEach((d) => {
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
});

/* ---------- نسخة احتياطية ---------- */
$('export').addEventListener('click', () => {
  const payload = { updatedAt: data.updatedAt, title: data.title, subtitle: data.subtitle, lectures: data.lectures, quizzes: data.quizzes, zoom: data.zoom };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `jadwal-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let imported = null;
  try {
    imported = normalizeData(JSON.parse(await file.text()));
  } catch {}
  if (!imported || !imported.lectures.length) return toast('الملف ما فيه جدول صالح.', true);
  if (!confirm('تستبدل الجدول اللي باللوحة بمحتوى الملف؟ ما رح يتغير شي عند الطلاب لحتى تنشر.')) return;
  data = imported;
  fillTitleForm();
  commit();
  toast('رجعت النسخة. راجعها وبعدين انشرها.');
});

/* ---------- الدخول ---------- */
function showLogin() {
  $('editor').hidden = true;
  $('hero-links').hidden = true;
  $('login').hidden = false;
  $('pass').focus();
}

async function showEditor() {
  $('login').hidden = true;
  $('editor').hidden = false;
  $('hero-links').hidden = false;
  $('workspace').hidden = true;
  $('load-error').hidden = true;
  $('loading').hidden = false;
  try {
    await loadData();
  } catch {
    $('loading').hidden = true;
    $('load-error').hidden = false;
    return;
  }
  $('loading').hidden = true;
  $('workspace').hidden = false;
  fillTitleForm();
  renderAll();
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!window.crypto || !crypto.subtle) {
    $('login-error').textContent = 'افتح لوحة الإدارة من رابط الموقع (https) حتى يزبط الدخول.';
    return;
  }
  const btn = $('login-btn');
  btn.disabled = true;
  btn.textContent = 'جاري الدخول…';
  try {
    const password = $('pass').value;
    if (!(await checkPassword(password))) {
      $('login-error').textContent = 'كلمة السر غلط.';
      $('pass').select();
      return;
    }
    $('login-error').textContent = '';
    $('pass').value = '';
    loginPassword = password;
    token = null;
    try {
      await unlockToken();
    } catch {
      // ما قدرنا نفك أو نجيب التوكن هلأ؛ زر النشر بيحاول مرة ثانية ويوضّح السبب
    }
    showEditor();
  } finally {
    btn.disabled = false;
    btn.textContent = 'دخول';
  }
});

$('logout').addEventListener('click', () => {
  loginPassword = null;
  token = null;
  linked = false;
  showLogin();
});

$('retry-load').addEventListener('click', showEditor);

$('token-link').href = TOKEN_URL;
$('token-repo').textContent = CONFIG.repo;

showLogin();
