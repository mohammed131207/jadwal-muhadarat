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
let currentBatch = null;
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
  $('token-state').textContent = linked
    ? 'النشر مربوط بـ GitHub: أي شخص يعرف كلمة سر اللوحة يستطيع النشر من أي جهاز.'
    : 'النشر غير مربوط بـ GitHub بعد. أول نشر سيطلب ربطه مرة واحدة.';
  $('token-change').textContent = linked ? 'تغيير توكن GitHub' : 'ربط GitHub';
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
    const payload = { updatedAt: new Date().toISOString(), batches: data.batches };
    await putFile(t, JSON.stringify(payload, null, 2) + '\n');
    data.updatedAt = payload.updatedAt;
    dirty = false;
    clearDraft();
    toast('تم النشر. يظهر للطلاب خلال دقيقة تقريباً.');
  } catch (err) {
    if (err.status === 401) {
      token = null;
      openTokenDialog('توكن GitHub المحفوظ انتهت صلاحيته أو أُلغي. أنشئ توكن جديداً واربطه.');
    } else if (err.status === 403 || err.status === 404) {
      token = null;
      openTokenDialog(`توكن GitHub المحفوظ لا يملك صلاحية الكتابة على مستودع ${CONFIG.repo}. أنشئ توكن جديداً حسب الخطوات.`);
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

/* ---------- ربط GitHub (مرة واحدة لكل الموقع) ---------- */
function openTokenDialog(message = '') {
  $('token-error').textContent = message;
  $('token-input').value = '';
  $('token-save').textContent = dirty ? 'ربط ونشر' : 'ربط';
  if (!$('token-dialog').open) $('token-dialog').showModal();
  $('token-input').focus();
}

$('token-form').addEventListener('submit', async (e) => {
  if (e.submitter && e.submitter.value === 'cancel') return;
  e.preventDefault();
  const value = $('token-input').value.trim();
  if (!/^(github_pat_|ghp_)\w{20,}$/.test(value)) {
    $('token-error').textContent = 'هذا لا يشبه توكن GitHub. التوكن يبدأ بـ github_pat_';
    return;
  }
  const save = $('token-save');
  save.disabled = true;
  save.textContent = 'جاري الربط…';
  $('token-error').textContent = '';
  try {
    // التوكن ينحفظ بالمستودع مشفّراً بكلمة سر اللوحة؛ الحفظ نفسه يتأكد إن عنده صلاحية الكتابة
    const blob = await encryptToken(value, loginPassword);
    await putFile(value, JSON.stringify(blob, null, 2) + '\n', CONFIG.accessPath, 'ربط لوحة الإدارة بـ GitHub');
    token = value;
    linked = true;
    $('token-dialog').close();
    renderTokenState();
    if (dirty) publish();
    else toast('تم الربط. أي شخص يعرف كلمة سر اللوحة يستطيع النشر الآن من أي جهاز.');
  } catch (err) {
    $('token-error').textContent = err.status === 401
      ? 'GitHub رفض هذا التوكن. تأكد أنك نسخته كاملاً.'
      : err.status === 403 || err.status === 404
        ? `التوكن لا يملك صلاحية الكتابة على مستودع ${CONFIG.repo}. راجع الخطوتين 2 و3.`
        : 'تعذّر الاتصال بـ GitHub. تأكد من الإنترنت ثم حاول مرة ثانية.';
  } finally {
    save.disabled = false;
    save.textContent = dirty ? 'ربط ونشر' : 'ربط';
  }
});

$('token-change').addEventListener('click', () => openTokenDialog());

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
  const btn = $('login-btn');
  btn.disabled = true;
  btn.textContent = 'جاري الدخول…';
  try {
    const password = $('pass').value;
    if (!(await checkPassword(password))) {
      $('login-error').textContent = 'كلمة السر غير صحيحة.';
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

$('f-day').innerHTML = DAYS.map((d) => `<option value="${d.key}">${d.name}</option>`).join('');
$('token-link').href = TOKEN_URL;
$('token-repo').textContent = CONFIG.repo;

showLogin();
