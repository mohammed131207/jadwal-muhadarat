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
  renderPublishBar();
  renderTokenState();
}

function renderList() {
  const lectures = data.lectures;
  $('count-title').textContent = lectures.length ? `المحاضرات (${lectures.length})` : 'المحاضرات';
  if (!lectures.length) {
    $('lecture-list').innerHTML = '<div class="card state"><p>لسا ما في محاضرات. اضغط «إضافة محاضرة» لتبلش.</p></div>';
    return;
  }
  const colors = subjectColors(lectures);
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
              <strong>${escapeHtml(l.subject)}</strong>
              <span>${timeText(l.from)} – ${timeText(l.to)}${meta ? ` · ${meta}` : ''}</span>
            </div>
            <div class="lec-actions">
              <button class="btn btn-sm" type="button" data-edit="${l.id}">تعديل</button>
              <button class="btn btn-sm btn-danger" type="button" data-delete="${l.id}">حذف</button>
            </div>
          </div>`;
        }).join('')}
      </section>`).join('');
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

/* ---------- نموذج المحاضرة (أزرار بدل خانات الوقت) ---------- */
const HOURS = Array.from({ length: 14 }, (_, i) => i + 7); // 7 ص لـ 8 م
const MINUTES = [0, 15, 30, 45];
const DURATIONS = [60, 90, 120, 150, 180];
const form = { day: 'sat', hour: null, minute: 0, duration: 60 };
let lastDay = 'sat';
let lastDuration = 60;

function hourLabel(h) {
  return `${h % 12 || 12} ${h < 12 ? 'ص' : 'م'}`;
}

function chip(group, value, label, active) {
  return `<button type="button" class="chip${active ? ' is-on' : ''}" role="radio" aria-checked="${active}" data-group="${group}" data-value="${value}">${label}</button>`;
}

function renderChips() {
  $('day-chips').innerHTML = DAYS.map((d) => chip('day', d.key, d.name, form.day === d.key)).join('');

  const hours = form.hour !== null && !HOURS.includes(form.hour) ? [...HOURS, form.hour].sort((a, b) => a - b) : HOURS;
  $('hour-chips').innerHTML = hours.map((h) => chip('hour', h, hourLabel(h), form.hour === h)).join('');

  const minutes = MINUTES.includes(form.minute) ? MINUTES : [...MINUTES, form.minute].sort((a, b) => a - b);
  $('minute-chips').innerHTML = minutes.map((m) => chip('minute', m, `<span class="ltr">:${String(m).padStart(2, '0')}</span>`, form.minute === m)).join('');

  $('duration-chips').innerHTML = DURATIONS.map((d) => chip('duration', d, durationText(d), form.duration === d)).join('');
  $('duration-text').textContent = durationText(form.duration);

  const start = form.hour === null ? null : form.hour * 60 + form.minute;
  $('summary').innerHTML = start === null
    ? 'اختار الساعة اللي بتبلش فيها المحاضرة'
    : `<b>${dayName(form.day)}</b> · من ${timeText(start)} لـ ${timeText(start + form.duration)}`;
}

function renderSubjectChips() {
  const typed = $('f-subject').value.trim();
  const names = [...new Set(data.lectures.map((l) => l.subject))].sort((a, b) => a.localeCompare(b, 'ar'));
  $('subject-chips').hidden = !names.length;
  $('subject-chips').innerHTML = names.map((n) => `<button type="button" class="chip chip-soft${n === typed ? ' is-on' : ''}" data-subject="${escapeHtml(n)}">${escapeHtml(n)}</button>`).join('');
}

function openLectureForm(lecture = null) {
  editingId = lecture ? lecture.id : null;
  $('lec-title').textContent = lecture ? 'تعديل محاضرة' : 'إضافة محاضرة';
  $('save-again-btn').hidden = Boolean(lecture);
  $('form-error').textContent = '';
  if (lecture) {
    const start = toMinutes(lecture.from);
    Object.assign(form, { day: lecture.day, hour: Math.floor(start / 60), minute: start % 60, duration: toMinutes(lecture.to) - start });
    $('f-subject').value = lecture.subject;
    $('f-room').value = lecture.room;
    $('f-doctor').value = lecture.doctor;
  } else {
    Object.assign(form, { day: lastDay, hour: null, minute: 0, duration: lastDuration });
    $('f-subject').value = '';
    $('f-room').value = '';
    $('f-doctor').value = '';
  }
  $('extra').open = Boolean(lecture && (lecture.room || lecture.doctor));
  renderChips();
  renderSubjectChips();
  if (!$('lec-dialog').open) $('lec-dialog').showModal();
  $('lec-form').scrollTop = 0;
}

$('lec-form').addEventListener('click', (e) => {
  const c = e.target.closest('[data-group]');
  if (c) {
    const v = c.dataset.value;
    if (c.dataset.group === 'day') form.day = v;
    else form[c.dataset.group] = Number(v);
    $('form-error').textContent = '';
    renderChips();
    return;
  }
  const s = e.target.closest('[data-subject]');
  if (s) {
    $('f-subject').value = s.dataset.subject;
    renderSubjectChips();
    return;
  }
  const step = e.target.closest('[data-step]');
  if (step) {
    form.duration = Math.min(360, Math.max(15, form.duration + Number(step.dataset.step)));
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
  const again = e.submitter && e.submitter.value === 'again';
  const fail = (msg) => { $('form-error').textContent = msg; };
  const subject = $('f-subject').value.trim();
  if (!subject) return fail('اكتب اسم المادة.');
  if (form.hour === null) return fail('اختار الساعة اللي بتبلش فيها المحاضرة.');
  const start = form.hour * 60 + form.minute;
  const end = start + form.duration;
  if (end > 24 * 60) return fail('المحاضرة بتعدّي نص الليل. قصّر المدة.');

  const v = {
    day: form.day,
    from: fromMinutes(start),
    to: fromMinutes(end),
    subject,
    room: $('f-room').value.trim(),
    doctor: $('f-doctor').value.trim(),
  };
  const clash = data.lectures.find((l) => l.id !== editingId && l.day === v.day
    && toMinutes(l.from) < end && start < toMinutes(l.to));
  if (clash && !confirm(`هاد الموعد متعارض مع «${clash.subject}» (${timeText(clash.from)} – ${timeText(clash.to)}) يوم ${dayName(clash.day)}. بدك تحفظها برضو؟`)) return;

  if (editingId) {
    Object.assign(data.lectures.find((l) => l.id === editingId), v);
    toast('انحفظ التعديل.');
  } else {
    data.lectures.push({ id: makeId(), ...v });
    toast(`انضافت «${subject}».`);
  }
  data.lectures.sort(sortLectures);
  lastDay = form.day;
  lastDuration = form.duration;
  commit();

  if (again) {
    // المحاضرة الجاية: نفس اليوم، بتبلش لما تخلص هاي وبنفس المدة
    openLectureForm();
    if (end + form.duration <= 24 * 60) {
      form.hour = Math.floor(end / 60);
      form.minute = end % 60;
    }
    renderChips();
  } else {
    $('lec-dialog').close();
  }
});

$('add-btn').addEventListener('click', () => openLectureForm());

$('lecture-list').addEventListener('click', (e) => {
  const edit = e.target.closest('[data-edit]');
  if (edit) return openLectureForm(data.lectures.find((l) => l.id === edit.dataset.edit));
  const del = e.target.closest('[data-delete]');
  if (!del) return;
  const lecture = data.lectures.find((l) => l.id === del.dataset.delete);
  if (!lecture || !confirm(`تحذف «${lecture.subject}» يوم ${dayName(lecture.day)} ${timeText(lecture.from)}؟`)) return;
  data.lectures = data.lectures.filter((l) => l.id !== lecture.id);
  commit();
  toast('انحذفت.');
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
    const payload = { updatedAt: new Date().toISOString(), title: data.title, subtitle: data.subtitle, lectures: data.lectures };
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
  const payload = { updatedAt: data.updatedAt, title: data.title, subtitle: data.subtitle, lectures: data.lectures };
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
