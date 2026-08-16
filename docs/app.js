/* 健康記録PWA フロントエンド */

// ---------- 設定(端末に保存) ----------
const CONF = {
  get url() { return localStorage.getItem('gasUrl') || ''; },
  set url(v) { localStorage.setItem('gasUrl', v.trim()); },
  get token() { return localStorage.getItem('token') || ''; },
  set token(v) { localStorage.setItem('token', v.trim()); }
};

const $ = (id) => document.getElementById(id);
const VIEWS = ['view-home', 'view-confirm', 'view-favorites', 'view-settings', 'view-meals'];

function showView(id) {
  VIEWS.forEach(v => $(v).classList.toggle('hidden', v !== id));
  window.scrollTo(0, 0);
}

function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), ms);
}

function spinner(on, text = '処理中…') {
  $('spinner-text').textContent = text;
  $('spinner').classList.toggle('hidden', !on);
}

// ---------- API ----------
async function api(action, payload = {}) {
  if (!CONF.url || !CONF.token) {
    showView('view-settings');
    throw new Error('先に設定画面で接続設定を入力してください');
  }
  const res = await fetch(CONF.url, {
    method: 'POST',
    // Content-Typeを付けないことでプリフライトを避ける(GASの制約対応)
    body: JSON.stringify(Object.assign({ token: CONF.token, action }, payload))
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || '不明なエラー');
  return data;
}

// ---------- ホーム ----------
function fmt(n, digits = 0) {
  if (n == null) return '--';
  return Number(n).toLocaleString('ja-JP', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

async function loadHome() {
  const today = new Date();
  const w = '日月火水木金土'[today.getDay()];
  $('header-date').textContent = `${today.getMonth() + 1}/${today.getDate()}(${w})`;

  if (!CONF.url || !CONF.token) {
    showView('view-settings');
    toast('最初に接続設定を入力してください');
    return;
  }

  try {
    spinner(true, '読み込み中…');
    const s = await api('summary');
    spinner(false);

    $('home-weight').textContent = s.weight != null ? `${fmt(s.weight, 1)}kg` : '未記録';
    $('home-avg2w').textContent = s.avg2w != null ? `2週間平均 ${fmt(s.avg2w, 1)}kg` : '2週間平均 --';

    const kcalLeft = (s.targets.kcal || 0) - (s.kcalToday || 0);
    const kcalEl = $('home-kcal-left');
    if (kcalLeft >= 0) {
      kcalEl.textContent = `${fmt(kcalLeft)}kcal`;
      kcalEl.className = 'mid-number blue';
    } else {
      kcalEl.textContent = `+${fmt(-kcalLeft)}kcal オーバー`;
      kcalEl.className = 'mid-number red';
    }
    $('home-kcal-detail').textContent = `目標 ${fmt(s.targets.kcal)}kcal / 摂取 ${fmt(s.kcalToday)}kcal`;
    const kcalPct = s.targets.kcal ? Math.min(100, (s.kcalToday / s.targets.kcal) * 100) : 0;
    const kcalBar = $('home-kcal-bar');
    kcalBar.style.width = kcalPct + '%';
    kcalBar.className = 'bar-fill ' + (kcalLeft >= 0 ? 'blue-bg' : 'red-bg');

    const pLeft = (s.targets.protein || 0) - (s.proteinToday || 0);
    $('home-protein-left').textContent = pLeft > 0 ? `${fmt(pLeft, 1)}g` : '達成!';
    $('home-protein-detail').textContent = `目標 ${fmt(s.targets.protein)}g / 摂取 ${fmt(s.proteinToday, 1)}g`;
    const pPct = s.targets.protein ? Math.min(100, (s.proteinToday / s.targets.protein) * 100) : 0;
    $('home-protein-bar').style.width = pPct + '%';

    const stepsEl = $('home-steps');
    if (s.stepsYesterday != null) {
      stepsEl.textContent = `昨日の歩数 ${fmt(s.stepsYesterday)}歩`;
      stepsEl.parentElement.classList.add('recorded');
    } else {
      stepsEl.textContent = '昨日の歩数 未記録';
      stepsEl.parentElement.classList.remove('recorded');
    }

    document.querySelectorAll('#meal-chips .chip').forEach(chip => {
      const done = s.meals[chip.dataset.slot];
      chip.classList.toggle('done', !!done);
      chip.textContent = chip.dataset.slot + (done ? ' ✓' : '');
    });

    if (s.lastLog) {
      $('undo-text').textContent = '✅ ' + s.lastLog.summary;
      $('undo-banner').classList.remove('hidden');
    } else {
      $('undo-banner').classList.add('hidden');
    }
  } catch (err) {
    spinner(false);
    toast('読み込みに失敗: ' + err.message, 4000);
  }
}

// ---------- 入力 → 解析 ----------
function slotByTime() {
  const h = new Date().getHours() + new Date().getMinutes() / 60;
  if (h < 10.5) return '朝食';
  if (h < 15) return '昼食';
  if (h < 20) return '夕食';
  return '間食';
}

async function analyzeAndHandle(inputType, data, mimeType) {
  try {
    spinner(true, 'AIが内容を確認しています…');
    const res = await api('analyze', { inputType, data, mimeType });
    spinner(false);

    if (!res.records.length) {
      toast('記録として読み取れませんでした。' + (res.notes || ''), 4000);
      return;
    }

    const autoWritten = [];
    const needConfirm = [];
    for (const rec of res.records) {
      if (rec.type === 'meal' && !rec.slot) rec.slot = slotByTime();
      if (rec.type === 'meal' && rec.favoriteMatch) {
        autoWritten.push(rec);
      } else {
        needConfirm.push(rec);
      }
    }

    // 定番ヒットは確認なしで即書き
    for (const rec of autoWritten) {
      try {
        spinner(true, '記録しています…');
        await api('write', { record: rec });
      } catch (err) {
        needConfirm.push(rec);
        toast('自動記録に失敗したため確認画面に回します: ' + err.message, 3500);
      }
    }
    spinner(false);

    if (needConfirm.length) {
      renderConfirm(needConfirm, res.notes);
      showView('view-confirm');
    } else {
      toast('記録しました');
      loadHome();
    }
  } catch (err) {
    spinner(false);
    toast('判定に失敗: ' + err.message, 4000);
  }
}

// 写真: 縮小してから送る
$('btn-photo').addEventListener('click', () => $('photo-input').click());
$('photo-input').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files);
  e.target.value = '';
  if (!files.length) return;
  try {
    spinner(true, files.length > 1 ? `写真${files.length}枚を準備中…` : '写真を準備中…');
    const base64s = [];
    for (const file of files) {
      const dataUrl = await resizeImage(file, 1280, 0.8);
      base64s.push(dataUrl.split(',')[1]);
    }
    spinner(false);
    analyzeAndHandle('image', base64s.length === 1 ? base64s[0] : base64s, 'image/jpeg');
  } catch (err) {
    spinner(false);
    toast('写真の読み込みに失敗: ' + err.message, 4000);
  }
});

function resizeImage(file, maxSize, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', quality));
      URL.revokeObjectURL(img.src);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

// 音声: 録音してそのまま送る(文字起こしはGemini側)
let recorder = null;
let recChunks = [];
let recCancelled = false;

$('btn-voice').addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recChunks = [];
    recCancelled = false;
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      $('voice-overlay').classList.add('hidden');
      if (recCancelled || !recChunks.length) return;
      const blob = new Blob(recChunks, { type: recorder.mimeType || 'audio/mp4' });
      const base64 = await blobToBase64(blob);
      analyzeAndHandle('audio', base64, blob.type);
    };
    recorder.start();
    $('voice-overlay').classList.remove('hidden');
  } catch (err) {
    toast('マイクを使えませんでした: ' + err.message, 4000);
  }
});
$('btn-voice-stop').addEventListener('click', () => recorder && recorder.stop());
$('btn-voice-cancel').addEventListener('click', () => { recCancelled = true; recorder && recorder.stop(); });

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

// テキスト
$('btn-text').addEventListener('click', () => {
  $('text-input').value = '';
  $('text-overlay').classList.remove('hidden');
  $('text-input').focus();
});
$('btn-text-cancel').addEventListener('click', () => $('text-overlay').classList.add('hidden'));
$('btn-text-send').addEventListener('click', () => {
  const text = $('text-input').value.trim();
  if (!text) return;
  $('text-overlay').classList.add('hidden');
  analyzeAndHandle('text', text);
});

// ---------- 確認画面 ----------
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function renderConfirm(records, notes) {
  $('confirm-note').textContent = notes || '内容を確認して、1件ずつ送信してください。';
  const wrap = $('confirm-cards');
  wrap.innerHTML = '';
  records.forEach(rec => wrap.appendChild(buildRecordCard(rec)));
}

function el(tag, attrs = {}, text = '') {
  const e = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
  if (text) e.textContent = text;
  return e;
}

function buildRecordCard(rec) {
  const card = el('div', { class: 'card record-card' });
  const typeLabel = { meal: '食事', weight: '体重・体脂肪', steps: '歩数', training: '筋トレ' }[rec.type] || rec.type;
  card.appendChild(el('span', { class: 'record-type' }, typeLabel));

  if (rec.type === 'meal' && (rec.kcal == null || rec.protein == null)) {
    card.appendChild(el('div', { class: 'need-input' }, 'カロリーとたんぱく質が分かりませんでした。入力してください。'));
  }
  if (rec.confidence != null && rec.confidence <= 0.6 && rec.type === 'meal') {
    card.appendChild(el('div', { class: 'need-input' }, '写真からの推定値です。値を確認してください。'));
  }

  card.appendChild(el('label', { class: 'field-label' }, '日付'));
  const dateIn = el('input', { type: 'date' });
  dateIn.value = rec.date || todayISO();
  card.appendChild(dateIn);

  const fields = {};

  if (rec.type === 'meal') {
    card.appendChild(el('label', { class: 'field-label' }, '食事の区分'));
    const slotSel = el('select');
    ['朝食', '昼食', '夕食', '間食'].forEach(s => {
      const o = el('option', { value: s }, s);
      if (s === rec.slot) o.selected = true;
      slotSel.appendChild(o);
    });
    card.appendChild(slotSel);
    fields.slot = slotSel;

    card.appendChild(el('label', { class: 'field-label' }, '品名'));
    const nameIn = el('input', { type: 'text' });
    nameIn.value = rec.name || '';
    card.appendChild(nameIn);
    fields.name = nameIn;

    card.appendChild(el('label', { class: 'field-label' }, 'カロリー(kcal)'));
    const kcalIn = el('input', { type: 'number', inputmode: 'decimal' });
    if (rec.kcal != null) kcalIn.value = rec.kcal;
    card.appendChild(kcalIn);
    fields.kcal = kcalIn;

    card.appendChild(el('label', { class: 'field-label' }, 'たんぱく質(g)'));
    const pIn = el('input', { type: 'number', inputmode: 'decimal' });
    if (rec.protein != null) pIn.value = rec.protein;
    card.appendChild(pIn);
    fields.protein = pIn;

  } else if (rec.type === 'weight') {
    card.appendChild(el('label', { class: 'field-label' }, '体重(kg)'));
    const wIn = el('input', { type: 'number', inputmode: 'decimal', step: '0.1' });
    if (rec.weightKg != null) wIn.value = rec.weightKg;
    card.appendChild(wIn);
    fields.weightKg = wIn;

    card.appendChild(el('label', { class: 'field-label' }, '体脂肪率(%) ※無ければ空欄'));
    const bIn = el('input', { type: 'number', inputmode: 'decimal', step: '0.1' });
    if (rec.bodyFatPct != null) bIn.value = rec.bodyFatPct;
    card.appendChild(bIn);
    fields.bodyFatPct = bIn;

  } else if (rec.type === 'steps') {
    card.appendChild(el('label', { class: 'field-label' }, '歩数'));
    const sIn = el('input', { type: 'number', inputmode: 'numeric' });
    if (rec.steps != null) sIn.value = rec.steps;
    card.appendChild(sIn);
    fields.steps = sIn;

  } else if (rec.type === 'training') {
    card.appendChild(el('label', { class: 'field-label' }, '筋トレ内容'));
    const tIn = el('textarea', { rows: '3' });
    tIn.value = rec.text || '';
    card.appendChild(tIn);
    fields.text = tIn;
  }

  const sendBtn = el('button', { class: 'btn primary full' }, 'この内容で記録する');
  sendBtn.addEventListener('click', async () => {
    const record = { type: rec.type, date: dateIn.value };
    if (rec.type === 'meal') {
      record.slot = fields.slot.value;
      record.name = fields.name.value.trim();
      record.kcal = fields.kcal.value === '' ? null : Number(fields.kcal.value);
      record.protein = fields.protein.value === '' ? null : Number(fields.protein.value);
      if (!record.name) { toast('品名を入力してください'); return; }
      if (record.kcal == null || record.protein == null) {
        toast('カロリーとたんぱく質を入力してください'); return;
      }
    } else if (rec.type === 'weight') {
      record.weightKg = fields.weightKg.value === '' ? null : Number(fields.weightKg.value);
      record.bodyFatPct = fields.bodyFatPct.value === '' ? null : Number(fields.bodyFatPct.value);
      if (record.weightKg == null && record.bodyFatPct == null) { toast('体重か体脂肪率を入力してください'); return; }
    } else if (rec.type === 'steps') {
      record.steps = Number(fields.steps.value);
      if (!record.steps) { toast('歩数を入力してください'); return; }
    } else if (rec.type === 'training') {
      record.text = fields.text.value.trim();
      if (!record.text) { toast('内容を入力してください'); return; }
    }
    await sendRecord(record, card);
  });
  card.appendChild(sendBtn);
  return card;
}

async function sendRecord(record, card, force = false) {
  try {
    spinner(true, '記録しています…');
    const res = await api('write', { record, force });
    spinner(false);

    if (res.needConfirm) {
      const lines = res.existing.map(x => `${x.label}: ${x.value}`).join('\n');
      const ok = confirm(`${res.dateLabel} には既に記録があります。\n${lines}\n\n上書きしてよいですか?`);
      if (ok) await sendRecord(record, card, true);
      return;
    }

    toast('記録しました: ' + res.summary);
    if (card) card.remove();
    if (!$('confirm-cards').children.length) {
      showView('view-home');
      loadHome();
    }
  } catch (err) {
    spinner(false);
    toast('記録に失敗: ' + err.message, 4000);
  }
}

$('btn-confirm-back').addEventListener('click', () => { showView('view-home'); loadHome(); });

// ---------- 取り消し ----------
$('btn-undo').addEventListener('click', async () => {
  if (!confirm('直近の記録を取り消しますか?')) return;
  try {
    spinner(true, '取り消しています…');
    const res = await api('undo');
    spinner(false);
    toast('取り消しました: ' + res.summary);
    loadHome();
  } catch (err) {
    spinner(false);
    toast('取り消しに失敗: ' + err.message, 4000);
  }
});

// ---------- 食事の一覧・修正 ----------
$('btn-meals').addEventListener('click', () => {
  $('meals-date').value = todayISO();
  showView('view-meals');
  loadMeals();
});
$('btn-meals-back').addEventListener('click', () => { showView('view-home'); loadHome(); });
$('meals-date').addEventListener('change', loadMeals);

async function loadMeals() {
  try {
    spinner(true, '読み込み中…');
    const res = await api('meals_list', { date: $('meals-date').value });
    spinner(false);
    renderMeals(res.items);
  } catch (err) {
    spinner(false);
    toast('読み込みに失敗: ' + err.message, 4000);
  }
}

function renderMeals(items) {
  const wrap = $('meals-list');
  wrap.innerHTML = '';
  if (!items.length) {
    wrap.appendChild(el('p', { class: 'view-note' }, 'この日はアプリからの食事記録がありません。'));
    $('meals-total').textContent = '--';
    return;
  }
  let totalKcal = 0, totalProtein = 0;
  items.forEach(it => {
    totalKcal += it.kcal;
    totalProtein += it.protein;
    wrap.appendChild(buildMealEditCard(it));
  });
  $('meals-total').textContent = `${fmt(totalKcal)}kcal / たんぱく質${fmt(totalProtein, 1)}g`;
}

function buildMealEditCard(item) {
  const card = el('div', { class: 'card record-card' });

  card.appendChild(el('label', { class: 'field-label' }, '食事の区分'));
  const slotSel = el('select');
  ['朝食', '昼食', '夕食', '間食'].forEach(s => {
    const o = el('option', { value: s }, s);
    if (s === item.slot) o.selected = true;
    slotSel.appendChild(o);
  });
  card.appendChild(slotSel);

  card.appendChild(el('label', { class: 'field-label' }, '品名'));
  const nameIn = el('input', { type: 'text' });
  nameIn.value = item.name;
  card.appendChild(nameIn);

  card.appendChild(el('label', { class: 'field-label' }, 'カロリー(kcal)'));
  const kcalIn = el('input', { type: 'number', inputmode: 'decimal' });
  kcalIn.value = item.kcal;
  card.appendChild(kcalIn);

  card.appendChild(el('label', { class: 'field-label' }, 'たんぱく質(g)'));
  const pIn = el('input', { type: 'number', inputmode: 'decimal' });
  pIn.value = item.protein;
  card.appendChild(pIn);

  const row = el('div', { class: 'row-buttons' });
  const delBtn = el('button', { class: 'btn danger' }, '削除');
  delBtn.addEventListener('click', async () => {
    if (!confirm(`「${item.name}」を削除しますか?\nシートの食事欄と合計も自動で直ります。`)) return;
    try {
      spinner(true, '削除しています…');
      const res = await api('meal_delete', { row: item.row });
      spinner(false);
      toast('削除しました');
      renderMeals(res.items);
    } catch (err) {
      spinner(false);
      toast('削除に失敗: ' + err.message, 4000);
    }
  });
  const saveBtn = el('button', { class: 'btn primary' }, '修正を保存');
  saveBtn.addEventListener('click', async () => {
    const name = nameIn.value.trim();
    if (!name) { toast('品名を入力してください'); return; }
    try {
      spinner(true, '保存しています…');
      const res = await api('meal_update', {
        row: item.row,
        slot: slotSel.value,
        name: name,
        kcal: Number(kcalIn.value) || 0,
        protein: Number(pIn.value) || 0
      });
      spinner(false);
      toast('修正しました');
      renderMeals(res.items);
    } catch (err) {
      spinner(false);
      toast('保存に失敗: ' + err.message, 4000);
    }
  });
  row.appendChild(delBtn);
  row.appendChild(saveBtn);
  card.appendChild(row);
  return card;
}

// ---------- 定番メニュー ----------
$('btn-favorites').addEventListener('click', async () => {
  showView('view-favorites');
  loadFavorites();
});
$('btn-favorites-back').addEventListener('click', () => { showView('view-home'); loadHome(); });

async function loadFavorites() {
  try {
    spinner(true, '読み込み中…');
    const res = await api('favorites_list');
    spinner(false);
    renderFavorites(res.favorites);
  } catch (err) {
    spinner(false);
    toast('読み込みに失敗: ' + err.message, 4000);
  }
}

function renderFavorites(favorites) {
  const wrap = $('favorites-list');
  wrap.innerHTML = '';
  if (!favorites.length) {
    wrap.appendChild(el('p', { class: 'view-note' }, 'まだ登録がありません。下のフォームから追加してください。'));
    return;
  }
  favorites.forEach(f => {
    const row = el('div', { class: 'fav-row' });
    const info = el('div', { class: 'fav-info' });
    info.appendChild(el('div', {}, f.name));
    info.appendChild(el('div', { class: 'fav-nutrition' }, `${f.kcal}kcal / たんぱく質${f.protein}g`));
    row.appendChild(info);
    const del = el('button', { class: 'fav-del' }, '削除');
    del.addEventListener('click', async () => {
      if (!confirm(`「${f.name}」を削除しますか?`)) return;
      try {
        spinner(true);
        const res = await api('favorites_delete', { row: f.row });
        spinner(false);
        renderFavorites(res.favorites);
      } catch (err) {
        spinner(false);
        toast('削除に失敗: ' + err.message, 4000);
      }
    });
    row.appendChild(del);
    wrap.appendChild(row);
  });
}

$('btn-fav-add').addEventListener('click', async () => {
  const name = $('fav-name').value.trim();
  const kcal = Number($('fav-kcal').value);
  const protein = Number($('fav-protein').value);
  if (!name || !kcal) { toast('名前とカロリーを入力してください'); return; }
  try {
    spinner(true, '登録しています…');
    const res = await api('favorites_add', { name, kcal, protein });
    spinner(false);
    $('fav-name').value = ''; $('fav-kcal').value = ''; $('fav-protein').value = '';
    renderFavorites(res.favorites);
    toast('登録しました');
  } catch (err) {
    spinner(false);
    toast('登録に失敗: ' + err.message, 4000);
  }
});

// ---------- 設定 ----------
$('btn-settings').addEventListener('click', async () => {
  showView('view-settings');
  $('setting-url').value = CONF.url;
  $('setting-token').value = CONF.token;
  if (CONF.url && CONF.token) {
    try {
      const res = await api('settings_get');
      $('setting-kcal').value = res.targets.kcal;
      $('setting-protein').value = res.targets.protein;
    } catch (err) { /* 未接続時は無視 */ }
  }
});
$('btn-settings-back').addEventListener('click', () => { showView('view-home'); loadHome(); });

$('btn-save-conn').addEventListener('click', () => {
  CONF.url = $('setting-url').value;
  CONF.token = $('setting-token').value;
  toast('接続設定を保存しました');
  showView('view-home');
  loadHome();
});

$('btn-save-targets').addEventListener('click', async () => {
  try {
    spinner(true, '保存しています…');
    await api('settings_set', {
      kcal: Number($('setting-kcal').value) || null,
      protein: Number($('setting-protein').value) || null
    });
    spinner(false);
    toast('目標を保存しました');
  } catch (err) {
    spinner(false);
    toast('保存に失敗: ' + err.message, 4000);
  }
});

// ---------- 起動 ----------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
loadHome();
