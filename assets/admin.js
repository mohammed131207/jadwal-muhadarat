/* بصمة SHA-256 لكلمة سر لوحة الإدارة (كلمة السر نفسها مش مكتوبة بالكود) */
const PASS_HASH = '5ffed2e1bd56b37e3a974a269a1c26a9af87f6854ca60448473a729256ee040f';
const SESSION_KEY = 'jadwal.admin';
const TOKEN_KEY = 'jadwal.ghToken';
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
let currentBatch = null;
let editingId = null;
let busy = false;
let draftWarned = false;

/* ---------- تخزين ---------- */
function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}
function setToken(t) {
  try { localStorage.setItem(TOKEN_KEY, t); } catch {}
}
function forgetToken() {
  try { localStorage.removeItem(TOKEN_KEY); } catch {}
}
function isLoggedIn() {
  try { return sessionStorage.getItem(SESSION_KEY) === '1'; } catch { return false; }
}
function setLoggedIn(on) {
  try {
    if (on) sessionStorage.setItem(SESSION_KEY, '1');
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {}
}

/* ---------- أدوات ---------- */
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

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

function getBatch() {
  return data.batches.find((b) => b.name === currentBatch) || null;
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

async function getRemoteFile(token) {
  const file = await ghRequest(`contents/${CONFIG.dataPath}?ref=${CONFIG.branch}`, token);
  return { sha: file.sha, text: b64decode(file.content) };
}

async function putFile(token, text) {
  for (let attempt = 0; ; attempt++) {
    let sha;
    try {
      sha = (await getRemoteFile(token)).sha;
    } catch (err) {
      if (err.status !== 404) throw err;
    }
    try {
      return await ghRequest(`contents/${CONFIG.dataPath}`, token, {
        method: 'PUT',
        body: JSON.stringify({
          message: 'تحديث جدول المحاضرات',
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
  const token = getToken();
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
    toast('تعذّر حفظ التعديلات على هذا الجهاز. انشرها قبل إغلاق الصفحة.', true);
  }
  renderAll();
}

/* ---------- العرض ---------- */
function renderAll() {
  if (!data.batches.some((b) => b.name === currentBatch)) {
    currentBatch = data.batches.length ? data.batches[0].name : null;
  }
  const batch = getBatch();
  $('no-batches').hidden = Boolean(batch);
  $('editor-grid').hidden = !batch;

  $('tabs').innerHTML = data.batches.map((b) => `
    <button type="button" class="btn btn-sm tab" aria-pressed="${b.name === currentBatch}" data-batch="${escapeHtml(b.name)}">${escapeHtml(b.name)}</button>`).join('');

  renderDatalists();
  if (batch) {
    $('form-title').textContent = editingId ? `تعديل محاضرة · دفعة ${batch.name}` : `إضافة محاضرة لدفعة ${batch.name}`;
    $('list-title').textContent = `محاضرات دفعة ${batch.name}`;
    renderList(batch);
  }
  renderPublishBar();
  renderTokenState();
}

function renderList(batch) {
  const list = $('lecture-list');
  if (!batch.lectures.length) {
    list.innerHTML = '<p class="empty">لا محاضرات بعد. أضف أول محاضرة من النموذج.</p>';
    return;
  }
  list.innerHTML = DAYS
    .map((d) => ({ day: d, items: batch.lectures.filter((l) => l.day === d.key) }))
    .filter((g) => g.items.length)
    .map((g) => `
      <div class="admin-day">
        <h3>${g.day.name}</h3>
        <ul>
          ${g.items.map((l) => {
            const meta = [l.room, l.doctor].filter(Boolean).map(escapeHtml).join(' · ');
            return `
            <li class="lec-row${l.id === editingId ? ' is-editing' : ''}">
              <span class="t">${timeHtml(l.from)} – ${timeHtml(l.to)}</span>
              <span class="lec-subj">${escapeHtml(l.subject)}${meta ? `<small>${meta}</small>` : ''}</span>
              <span class="lec-actions">
                <button class="btn btn-sm" type="button" data-edit="${l.id}">تعديل</button>
                <button class="btn btn-sm btn-danger" type="button" data-delete="${l.id}">حذف</button>
              </span>
            </li>`;
          }).join('')}
        </ul>
      </div>`).join('');
}

function renderDatalists() {
  const all = data.batches.flatMap((b) => b.lectures);
  const options = (field) => [...new Set(all.map((l) => l[field]).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'ar'))
    .map((v) => `<option value="${escapeHtml(v)}"></option>`).join('');
  $('subjects').innerHTML = options('subject');
  $('rooms').innerHTML = options('room');
  $('doctors').innerHTML = options('doctor');
}

function renderPublishBar() {
  $('publish-bar').classList.toggle('is-dirty', dirty);
  if (busy) $('publish-state').textContent = 'جاري النشر…';
  else if (dirty) $('publish-state').textContent = 'لديك تعديلات غير منشورة. الطلاب يرون الجدول السابق حتى تنشرها.';
  else $('publish-state').textContent = data.updatedAt ? `كل التعديلات منشورة · ${formatUpdated(data.updatedAt)}` : 'كل التعديلات منشورة.';
  $('publish').disabled = !dirty || busy;
  $('discard').disabled = !dirty || busy;
}

function renderTokenState() {
  const linked = Boolean(getToken());
  $('token-state').textContent = linked
    ? 'هذا الجهاز مربوط بـ GitHub ويستطيع النشر.'
    : 'هذا الجهاز غير مربوط بـ GitHub بعد. سيُطلب التوكن عند أول نشر.';
  $('token-change').textContent = linked ? 'تغيير التوكن' : 'ربط GitHub';
  $('token-forget').hidden = !linked;
}

/* ---------- النموذج ---------- */
function resetForm({ keepDay = true } = {}) {
  editingId = null;
  if (!keepDay) $('f-day').value = DAYS[0].key;
  ['f-from', 'f-to', 'f-subject', 'f-room', 'f-doctor'].forEach((id) => { $(id).value = ''; });
  $('submit-btn').textContent = 'إضافة المحاضرة';
  $('cancel-edit').hidden = true;
  $('form-error').textContent = '';
}

function startEdit(id) {
  const lecture = getBatch().lectures.find((l) => l.id === id);
  if (!lecture) return;
  editingId = id;
  $('f-day').value = lecture.day;
  $('f-from').value = lecture.from;
  $('f-to').value = lecture.to;
  $('f-subject').value = lecture.subject;
  $('f-room').value = lecture.room;
  $('f-doctor').value = lecture.doctor;
  $('submit-btn').textContent = 'حفظ التعديل';
  $('cancel-edit').hidden = false;
  $('form-error').textContent = '';
  renderAll();
  $('lecture-form').scrollIntoView({ block: 'nearest' });
  $('f-subject').focus();
}

$('lecture-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const batch = getBatch();
  if (!batch) return;
  const v = {
    day: $('f-day').value,
    from: $('f-from').value,
    to: $('f-to').value,
    subject: $('f-subject').value.trim(),
    room: $('f-room').value.trim(),
    doctor: $('f-doctor').value.trim(),
  };
  const fail = (msg) => { $('form-error').textContent = msg; };
  if (!v.from || !v.to) return fail('اكتب وقت البداية ووقت النهاية.');
  if (toMinutes(v.to) <= toMinutes(v.from)) return fail('وقت النهاية يجب أن يكون بعد وقت البداية.');
  if (!v.subject) return fail('اكتب اسم المادة.');

  const clash = batch.lectures.find((l) => l.id !== editingId && l.day === v.day
    && toMinutes(l.from) < toMinutes(v.to) && toMinutes(v.from) < toMinutes(l.to));
  if (clash && !confirm(`هذا الموعد يتعارض مع «${clash.subject}» (${timeText(clash.from)} – ${timeText(clash.to)}) يوم ${dayName(clash.day)}. حفظ رغم التعارض؟`)) return;

  if (editingId) {
    Object.assign(batch.lectures.find((l) => l.id === editingId), v);
    resetForm();
    toast('تم حفظ التعديل.');
  } else {
    batch.lectures.push({ id: makeId(), ...v });
    // تجهيز المحاضرة اللي بعدها: نفس اليوم، تبدأ وقت ما خلصت هاي وبنفس المدة
    const duration = toMinutes(v.to) - toMinutes(v.from);
    resetForm();
    $('f-from').value = v.to;
    if (toMinutes(v.to) + duration < 24 * 60) $('f-to').value = fromMinutes(toMinutes(v.to) + duration);
    toast(`أُضيفت «${v.subject}».`);
  }
  batch.lectures.sort(sortLectures);
  commit();
  $('f-subject').focus();
});

$('cancel-edit').addEventListener('click', () => {
  resetForm();
  renderAll();
});

$('lecture-list').addEventListener('click', (e) => {
  const edit = e.target.closest('[data-edit]');
  if (edit) return startEdit(edit.dataset.edit);
  const del = e.target.closest('[data-delete]');
  if (!del) return;
  const batch = getBatch();
  const lecture = batch.lectures.find((l) => l.id === del.dataset.delete);
  if (!lecture || !confirm(`حذف «${lecture.subject}» يوم ${dayName(lecture.day)} ${timeText(lecture.from)}؟`)) return;
  batch.lectures = batch.lectures.filter((l) => l.id !== lecture.id);
  if (editingId === lecture.id) resetForm();
  commit();
  toast('تم الحذف.');
});

/* ---------- الدفعات ---------- */
$('tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-batch]');
  if (!tab) return;
  currentBatch = tab.dataset.batch;
  resetForm();
  renderAll();
});

$('batch-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('batch-name').value.trim();
  if (!name) return $('batch-name').focus();
  if (data.batches.some((b) => b.name === name)) return toast(`دفعة ${name} موجودة.`, true);
  data.batches.push({ name, lectures: [] });
  data.batches.sort((a, b) => a.name.localeCompare(b.name, 'ar', { numeric: true }));
  currentBatch = name;
  $('batch-name').value = '';
  resetForm();
  commit();
  toast(`أُضيفت دفعة ${name}.`);
});

$('delete-batch').addEventListener('click', () => {
  const batch = getBatch();
  if (!batch) return;
  const count = batch.lectures.length ? ` وكل محاضراتها (${lectureCountText(batch.lectures.length)})` : '';
  if (!confirm(`حذف دفعة ${batch.name}${count}؟ لن يتغير شيء للطلاب حتى تضغط «نشر التعديلات».`)) return;
  data.batches = data.batches.filter((b) => b !== batch);
  currentBatch = null;
  resetForm();
  commit();
  toast(`حُذفت دفعة ${batch.name}.`);
});

/* ---------- النشر ---------- */
function setBusy(on) {
  busy = on;
  $('publish').textContent = on ? 'جاري النشر…' : 'نشر التعديلات';
  renderPublishBar();
}

async function publish() {
  const token = getToken();
  if (!token) return openTokenDialog();
  setBusy(true);
  try {
    const payload = { updatedAt: new Date().toISOString(), batches: data.batches };
    await putFile(token, JSON.stringify(payload, null, 2) + '\n');
    data.updatedAt = payload.updatedAt;
    dirty = false;
    clearDraft();
    toast('تم النشر. يظهر للطلاب خلال دقيقة تقريباً.');
  } catch (err) {
    if (err.status === 401) {
      forgetToken();
      openTokenDialog('التوكن غير صالح أو انتهت صلاحيته. أنشئ توكن جديداً.');
    } else if (err.status === 403 || err.status === 404) {
      openTokenDialog(`التوكن لا يملك صلاحية الكتابة على مستودع ${CONFIG.repo}. أنشئه من جديد حسب الخطوات.`);
    } else {
      toast('تعذّر النشر. تأكد من الاتصال بالإنترنت ثم حاول مرة ثانية؛ تعديلاتك محفوظة على هذا الجهاز.', true);
    }
  } finally {
    setBusy(false);
    renderAll();
  }
}

$('publish').addEventListener('click', publish);

$('discard').addEventListener('click', async () => {
  if (!confirm('تجاهل كل التعديلات غير المنشورة والرجوع للجدول المنشور؟')) return;
  clearDraft();
  resetForm();
  await showEditor();
  toast('رجعت اللوحة للجدول المنشور.');
});

/* ---------- التوكن ---------- */
function openTokenDialog(message = '') {
  $('token-error').textContent = message;
  $('token-input').value = '';
  $('token-save').textContent = dirty ? 'حفظ ونشر' : 'حفظ';
  $('token-dialog').showModal();
  $('token-input').focus();
}

$('token-form').addEventListener('submit', (e) => {
  if (e.submitter && e.submitter.value === 'cancel') return;
  e.preventDefault();
  const token = $('token-input').value.trim();
  if (!/^(github_pat_|ghp_)\w{20,}$/.test(token)) {
    $('token-error').textContent = 'هذا لا يشبه توكن GitHub. التوكن يبدأ بـ github_pat_';
    return;
  }
  setToken(token);
  $('token-dialog').close();
  renderTokenState();
  if (dirty) publish();
  else toast('تم ربط GitHub على هذا الجهاز.');
});

$('token-change').addEventListener('click', () => openTokenDialog());

$('token-forget').addEventListener('click', () => {
  if (!confirm('إزالة التوكن من هذا الجهاز؟ ستحتاج إدخاله من جديد للنشر.')) return;
  forgetToken();
  renderTokenState();
  toast('أُزيل الربط من هذا الجهاز.');
});

/* ---------- نسخة احتياطية ---------- */
$('export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ updatedAt: data.updatedAt, batches: data.batches }, null, 2)], { type: 'application/json' });
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
  let imported;
  try {
    imported = normalizeData(JSON.parse(await file.text()));
  } catch {
    imported = null;
  }
  if (!imported || !imported.batches.length) return toast('الملف لا يحتوي على جدول صالح.', true);
  if (!confirm('استبدال الجدول الحالي في اللوحة بمحتوى الملف؟ لن يتغير شيء للطلاب حتى تنشر.')) return;
  data = imported;
  currentBatch = null;
  resetForm();
  commit();
  toast('تم استرجاع النسخة. راجعها ثم انشرها.');
});

/* ---------- الدخول ---------- */
function showLogin() {
  $('editor').hidden = true;
  $('login').hidden = false;
  $('pass').focus();
}

async function showEditor() {
  $('login').hidden = true;
  $('editor').hidden = false;
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
  renderAll();
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!window.crypto || !crypto.subtle) {
    $('login-error').textContent = 'افتح لوحة الإدارة من رابط الموقع (https) حتى يعمل تسجيل الدخول.';
    return;
  }
  if ((await sha256($('pass').value)) !== PASS_HASH) {
    $('login-error').textContent = 'كلمة السر غير صحيحة.';
    $('pass').select();
    return;
  }
  $('login-error').textContent = '';
  $('pass').value = '';
  setLoggedIn(true);
  showEditor();
});

$('logout').addEventListener('click', () => {
  setLoggedIn(false);
  showLogin();
});

$('retry-load').addEventListener('click', showEditor);

$('f-day').innerHTML = DAYS.map((d) => `<option value="${d.key}">${d.name}</option>`).join('');
$('token-link').href = TOKEN_URL;
$('token-repo').textContent = CONFIG.repo;

if (isLoggedIn()) showEditor();
else showLogin();
