const app = document.getElementById('app');
const titleEl = document.getElementById('title');
const updatedEl = document.getElementById('updated');
const isPreview = new URLSearchParams(location.search).has('preview');

let data = null;
let liveTimer = null;
let liveLectures = [];

async function load() {
  app.innerHTML = '<p class="loading">جاري تحميل الجدول…</p>';
  try {
    if (isPreview) {
      const draft = readDraft();
      data = normalizeData(draft && draft.data);
      document.getElementById('preview-note').hidden = false;
    } else {
      data = await fetchPublished();
    }
  } catch {
    app.innerHTML = `
      <div class="notice">
        <p>تعذّر تحميل الجدول. تأكد من اتصالك بالإنترنت ثم أعد المحاولة.</p>
        <button class="btn" type="button" data-action="retry">إعادة المحاولة</button>
      </div>`;
    return;
  }
  updatedEl.textContent = isPreview ? '' : formatUpdated(data.updatedAt);
  route();
}

function selectedBatch() {
  const name = decodeURIComponent(location.hash.slice(1));
  return name ? data.batches.find((b) => b.name === name) : null;
}

function route() {
  clearInterval(liveTimer);
  if (!data) return;
  const batch = selectedBatch();
  if (batch) {
    renderSchedule(batch);
    liveTimer = setInterval(updateLive, 30000);
  } else {
    renderPicker();
  }
}

function renderPicker() {
  titleEl.textContent = 'أنت من أي دفعة؟';
  document.title = 'جدول المحاضرات';
  if (!data.batches.length) {
    app.innerHTML = '<p class="empty">لم يُنشر أي جدول بعد.</p>';
    return;
  }
  app.innerHTML = `
    <p class="lede">اختر دفعتك ليظهر جدول محاضراتك.</p>
    <nav class="batches" aria-label="الدفعات">
      ${data.batches.map((b) => `
        <a class="batch" href="#${encodeURIComponent(b.name)}">
          <span class="batch-label">دفعة</span>
          <span class="batch-year">${escapeHtml(b.name)}</span>
          <span class="batch-count">${lectureCountText(b.lectures.length)}</span>
        </a>`).join('')}
    </nav>`;
}

function renderSchedule(batch) {
  titleEl.innerHTML = `دفعة <span class="title-year">${escapeHtml(batch.name)}</span>`;
  document.title = `جدول دفعة ${batch.name}`;
  liveLectures = batch.lectures.slice().sort(sortLectures);

  const toolbar = `
    <div class="toolbar">
      <a class="btn" href="#">تغيير الدفعة</a>
      ${liveLectures.length ? '<button class="btn" type="button" data-action="print">طباعة الجدول</button>' : ''}
    </div>`;

  if (!liveLectures.length) {
    app.innerHTML = toolbar + `<p class="empty">لم يُضف جدول دفعة ${escapeHtml(batch.name)} بعد.</p>`;
    return;
  }

  const hasRoom = liveLectures.some((l) => l.room);
  const hasDoctor = liveLectures.some((l) => l.doctor);
  const groups = DAYS
    .map((d) => ({ day: d, items: liveLectures.filter((l) => l.day === d.key) }))
    .filter((g) => g.items.length);

  const body = groups.map((g) => `
    <tbody class="day" data-day="${g.day.key}">
      ${g.items.map((l, i) => {
        const meta = [l.room, l.doctor].filter(Boolean).map(escapeHtml).join(' · ');
        return `
        <tr data-day="${l.day}" data-from="${toMinutes(l.from)}" data-to="${toMinutes(l.to)}">
          ${i === 0 ? `
          <th scope="rowgroup" rowspan="${g.items.length}" class="day-cell">
            <span class="day-name">${g.day.name}</span>
            <span class="today-tag">اليوم</span>
          </th>` : ''}
          <td class="t from">${timeHtml(l.from)}</td>
          <td class="t to">${timeHtml(l.to)}</td>
          <td class="subj">
            <span class="subj-name">${escapeHtml(l.subject)}</span>
            ${meta ? `<span class="meta">${meta}</span>` : ''}
          </td>
          ${hasRoom ? `<td class="extra">${escapeHtml(l.room) || '—'}</td>` : ''}
          ${hasDoctor ? `<td class="extra">${escapeHtml(l.doctor) || '—'}</td>` : ''}
        </tr>`;
      }).join('')}
    </tbody>`).join('');

  app.innerHTML = toolbar + `
    <section class="status" id="status" aria-live="polite"></section>
    <table class="timetable">
      <caption class="sr-only">جدول محاضرات دفعة ${escapeHtml(batch.name)}</caption>
      <thead>
        <tr>
          <th scope="col">اليوم</th>
          <th scope="col">من</th>
          <th scope="col">إلى</th>
          <th scope="col">المادة</th>
          ${hasRoom ? '<th scope="col">القاعة</th>' : ''}
          ${hasDoctor ? '<th scope="col">المحاضر</th>' : ''}
        </tr>
      </thead>
      ${body}
    </table>`;
  updateLive();
}

/* يحدّد المحاضرة الحالية أو القادمة حسب ساعة الجهاز */
function computeStatus(now) {
  const tk = todayKey(now);
  const mins = now.getHours() * 60 + now.getMinutes();
  const today = liveLectures.filter((l) => l.day === tk);

  const current = today.find((l) => toMinutes(l.from) <= mins && mins < toMinutes(l.to));
  if (current) return { type: 'now', lecture: current, left: toMinutes(current.to) - mins };

  const next = today.find((l) => toMinutes(l.from) > mins);
  if (next) return { type: 'next', lecture: next, wait: toMinutes(next.from) - mins };

  const ti = DAY_ORDER[tk];
  for (let k = 1; k <= 7; k++) {
    const day = DAYS[(ti + k) % 7].key;
    const first = liveLectures.find((l) => l.day === day);
    if (first) return { type: today.length ? 'done' : 'free', lecture: first, offset: k };
  }
  return null;
}

function statusHtml(st) {
  if (!st) return '';
  const l = st.lecture;
  const place = [l.room, l.doctor].filter(Boolean).map(escapeHtml).join(' · ');
  const placeHtml = place ? ` · ${place}` : '';
  const subject = escapeHtml(l.subject);

  if (st.type === 'now') {
    return `
      <p class="status-eyebrow">الآن</p>
      <p class="status-title"><span class="hl">${subject}</span></p>
      <p class="status-meta">تنتهي ${timeText(l.to)} · باقي ${durationText(st.left)}${placeHtml}</p>`;
  }
  if (st.type === 'next') {
    return `
      <p class="status-eyebrow">المحاضرة القادمة اليوم</p>
      <p class="status-title">${subject}</p>
      <p class="status-meta">تبدأ ${timeText(l.from)} · بعد ${durationText(st.wait)}${placeHtml}</p>`;
  }
  const when = st.offset === 1 ? 'غداً' : `يوم ${dayName(l.day)}`;
  return `
    <p class="status-eyebrow">${st.type === 'done' ? 'انتهت محاضرات اليوم' : 'لا محاضرات اليوم'} · القادمة</p>
    <p class="status-title">${subject}</p>
    <p class="status-meta">${when} ${timeText(l.from)}${placeHtml}</p>`;
}

function updateLive() {
  const statusEl = document.getElementById('status');
  if (!statusEl) return;
  const now = new Date();
  const tk = todayKey(now);
  const mins = now.getHours() * 60 + now.getMinutes();

  app.querySelectorAll('tbody.day').forEach((tb) => tb.classList.toggle('is-today', tb.dataset.day === tk));
  app.querySelectorAll('tbody.day tr').forEach((tr) => {
    const isToday = tr.dataset.day === tk;
    const from = Number(tr.dataset.from);
    const to = Number(tr.dataset.to);
    tr.classList.toggle('is-now', isToday && from <= mins && mins < to);
    tr.classList.toggle('is-past', isToday && mins >= to);
  });
  statusEl.innerHTML = statusHtml(computeStatus(now));
}

app.addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]');
  if (!action) return;
  if (action.dataset.action === 'print') window.print();
  if (action.dataset.action === 'retry') load();
});

window.addEventListener('hashchange', () => {
  route();
  window.scrollTo(0, 0);
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) updateLive();
});

load();
