/* ===== 健康記録アプリ GAS(全部入り・これ1つ貼ればOK) ===== */

/* ---------- main.gs ---------- */
/**
 * 健康記録PWA バックエンド(エントリポイント)
 * PWAからのリクエストを受け取り、合言葉を確認して各処理に振り分ける。
 */

const PROPS = PropertiesService.getScriptProperties();

function doGet() {
  return json_({ ok: true, message: '健康記録API 稼働中' });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'リクエストの形式が不正です' });
  }

  const token = PROPS.getProperty('TOKEN');
  if (!token || req.token !== token) {
    return json_({ ok: false, error: '合言葉が違います。設定画面を確認してください。' });
  }

  try {
    let res;
    switch (req.action) {
      case 'summary':          res = getSummary_(); break;
      case 'analyze':          res = analyze_(req); break;
      case 'write':            res = writeRecord_(req.record, !!req.force); break;
      case 'undo':             res = undoLast_(); break;
      case 'meals_list':       res = mealsList_(req); break;
      case 'meal_update':      res = mealUpdate_(req); break;
      case 'meal_delete':      res = mealDelete_(req); break;
      case 'favorites_list':   res = { favorites: favList_() }; break;
      case 'favorites_add':    res = favAdd_(req); break;
      case 'favorites_update': res = favUpdate_(req); break;
      case 'favorites_delete': res = favDelete_(req); break;
      case 'settings_get':     res = settingsGet_(); break;
      case 'settings_set':     res = settingsSet_(req); break;
      default:                 res = { error: '不明な操作です: ' + req.action };
    }
    if (!('ok' in res)) res.ok = !res.error;
    return json_(res);
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ---------- sheets.gs ---------- */
/**
 * スプレッドシートの読み書き。
 *
 * 対象タブ:
 *   - 「YYYY」        : 日付 / 体重 / 2週間平均(数式) / 摂取カロリー / 1週間平均(数式) / 歩数 / 1週間平均(数式) / 1ヶ月の変化(数式)
 *   - 「YYYY日常記録」 : 日付 / 体重 / 体脂肪率 / 朝食 / 昼食 / 夕食 / 間食・補食 / 筋トレ / 総摂取カロリー / 総たんぱく質
 *   - 「定番マスタ」   : 名前 / カロリー / たんぱく質(g)
 *   - 「設定」        : 目標カロリー / 目標たんぱく質
 *
 * 既存セルが「57.5kg」のような文字列でも、数値+表示形式でも動くように、
 * 直前の行のセル型を見て同じ形式で書き込む。
 */

const YEAR_COL = { date: 1, weight: 2, avg2w: 3, kcal: 4, steps: 6 };
const DAILY_COL = { date: 1, weight: 2, bodyFat: 3, breakfast: 4, lunch: 5, dinner: 6, snack: 7, training: 8, kcal: 9, protein: 10 };
const SLOT_COL = { '朝食': 4, '昼食': 5, '夕食': 6, '間食': 7 };

function ss_() {
  const id = PROPS.getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('SPREADSHEET_ID が未設定です(スクリプトプロパティ)');
  return SpreadsheetApp.openById(id);
}

// ---------- 年別タブの取得(無ければ前年のタブをコピーして作成) ----------

function yearSheet_(date) {
  return getOrCreateYearTab_(String(date.getFullYear()), String(date.getFullYear() - 1));
}

function dailySheet_(date) {
  const y = date.getFullYear();
  return getOrCreateYearTab_(y + '日常記録', (y - 1) + '日常記録');
}

function getOrCreateYearTab_(name, templateName) {
  const ss = ss_();
  let sheet = ss.getSheetByName(name);
  if (sheet) return sheet;

  const template = ss.getSheetByName(templateName);
  if (!template) throw new Error('タブ「' + name + '」が無く、コピー元「' + templateName + '」も見つかりません');

  sheet = template.copyTo(ss).setName(name);
  // データ行を削除し、2行目だけ書式と数式のひな形として残して値を消す
  const last = sheet.getLastRow();
  if (last > 2) sheet.deleteRows(3, last - 2);
  if (last >= 2) {
    const isYear = !/日常記録$/.test(name);
    const clearCols = isYear ? [1, 2, 4, 6, 9, 10] : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    clearCols.forEach(function (c) {
      if (c <= sheet.getLastColumn()) sheet.getRange(2, c).clearContent();
    });
  }
  return sheet;
}

// ---------- 行の検索・作成 ----------

function lastDataRow_(sheet) {
  const lastRow = Math.max(sheet.getLastRow(), 1);
  const disp = sheet.getRange(1, 1, lastRow, 1).getDisplayValues();
  for (let i = disp.length - 1; i >= 0; i--) {
    if (String(disp[i][0]).trim()) return i + 1;
  }
  return 1;
}

function parseDateCell_(s, sheet) {
  s = String(s).trim();
  let m = s.match(/^(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})/);
  if (m) return { y: +m[1], m: +m[2], d: +m[3] };
  m = s.match(/^(\d{1,2})\/(\d{1,2})/);
  if (m) {
    const ym = String(sheet.getName()).match(/\d{4}/);
    const yr = ym ? +ym[0] : new Date().getFullYear();
    return { y: yr, m: +m[1], d: +m[2] };
  }
  return null;
}

function findRowByDate_(sheet, date) {
  const lastRow = Math.max(sheet.getLastRow(), 1);
  const disp = sheet.getRange(1, 1, lastRow, 1).getDisplayValues();
  for (let i = disp.length - 1; i >= 1; i--) {
    const s = String(disp[i][0]).trim();
    if (!s) continue;
    const p = parseDateCell_(s, sheet);
    if (p && p.y === date.getFullYear() && p.m === date.getMonth() + 1 && p.d === date.getDate()) {
      return i + 1;
    }
  }
  return 0;
}

function ensureRow_(sheet, date, kind) {
  const row = findRowByDate_(sheet, date);
  if (row) return row;
  return appendDateRow_(sheet, date, kind);
}

function appendDateRow_(sheet, date, kind) {
  const last = lastDataRow_(sheet);
  const newRow = last + 1;
  const cols = sheet.getLastColumn();
  if (last >= 2) {
    // 直前の行をコピーして書式と数式(平均列など)を引き継ぎ、値だけ消す
    sheet.getRange(last, 1, 1, cols).copyTo(sheet.getRange(newRow, 1, 1, cols));
    const clearCols = kind === 'year' ? [1, 2, 4, 6, 9, 10] : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    clearCols.forEach(function (c) {
      if (c <= cols) sheet.getRange(newRow, c).clearContent();
    });
  }
  setDateCell_(sheet, newRow, date, kind);
  return newRow;
}

function prevDataRow_(sheet, row) {
  for (let r = row - 1; r >= 2; r--) {
    const v = sheet.getRange(r, 1).getDisplayValue();
    if (String(v).trim()) return r;
  }
  return 0;
}

function setDateCell_(sheet, row, date, kind) {
  const prev = prevDataRow_(sheet, row);
  const prevVal = prev ? sheet.getRange(prev, 1).getValue() : null;
  const cell = sheet.getRange(row, 1);
  if (prevVal instanceof Date) {
    cell.setValue(date);
    return;
  }
  if (kind === 'year') {
    const w = '日月火水木金土'.charAt(date.getDay());
    cell.setValue((date.getMonth() + 1) + '/' + date.getDate() + '(' + w + ')');
  } else {
    cell.setValue(Utilities.formatDate(date, 'Asia/Tokyo', 'yyyy/MM/dd'));
  }
}

// ---------- 数値の読み書き(文字列/数値どちらの列でも動く) ----------

function comma_(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fmtNum_(n, fmt) {
  switch (fmt) {
    case 'kg':    return n.toFixed(1) + 'kg';
    case 'pct':   return n.toFixed(2) + '%';
    case 'kcal1': { const s = n.toFixed(1); const i = s.split('.'); return comma_(i[0]) + '.' + i[1] + 'kcal'; }
    case 'kcal0': return String(Math.round(n)) + 'kcal';
    case 'g':     return (n % 1 ? n.toFixed(1) : String(Math.round(n))) + 'g';
    case 'steps': return comma_(Math.round(n)) + '歩';
    default:      return String(n);
  }
}

function readNum_(v, fmt) {
  if (typeof v === 'number') {
    if (fmt === 'pct' && v <= 1) return v * 100;
    return v;
  }
  if (typeof v === 'string' && v.trim() !== '') {
    const n = parseFloat(v.replace(/[^0-9.\-]/g, ''));
    return isNaN(n) ? null : n;
  }
  return null;
}

function cellHasValue_(sheet, row, col) {
  const v = sheet.getRange(row, col).getValue();
  return v !== '' && v !== null && v !== undefined;
}

function setNumberCell_(sheet, row, col, num, fmt) {
  const prev = prevDataRow_(sheet, row);
  const sample = prev ? sheet.getRange(prev, col).getValue() : null;
  const cell = sheet.getRange(row, col);
  if (typeof sample === 'string' && sample.trim() !== '') {
    cell.setValue(fmtNum_(num, fmt));
  } else if (fmt === 'pct' && typeof sample === 'number' && sample <= 1) {
    cell.setValue(num / 100);
  } else {
    cell.setValue(fmt === 'pct' && sample === null ? num / 100 : num);
  }
}

// ---------- 書き込み本体 ----------

function pushChange_(changes, sheet, row, col) {
  changes.push({
    sheet: sheet.getName(),
    row: row,
    col: col,
    before: sheet.getRange(row, col).getValue()
  });
}

function addToNumberCell_(changes, sheet, row, col, delta, fmt) {
  pushChange_(changes, sheet, row, col);
  const cur = readNum_(sheet.getRange(row, col).getValue(), fmt) || 0;
  setNumberCell_(sheet, row, col, cur + delta, fmt);
}

function parseISO_(s) {
  const m = String(s).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return dateOnly_(new Date());
  return new Date(+m[1], +m[2] - 1, +m[3]);
}

function dateOnly_(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function writeRecord_(rec, force) {
  if (!rec || !rec.type) return { error: '記録の内容がありません' };
  const date = rec.date ? parseISO_(rec.date) : dateOnly_(new Date());
  const dateLabel = (date.getMonth() + 1) + '/' + date.getDate();
  const changes = [];
  let summary = '';

  if (rec.type === 'meal') {
    const slot = SLOT_COL[rec.slot] ? rec.slot : '間食';
    const kcal = Number(rec.kcal) || 0;
    const protein = Number(rec.protein) || 0;
    const dateStr = Utilities.formatDate(date, 'Asia/Tokyo', 'yyyy-MM-dd');

    const detail = detailSheet_();
    detail.appendRow([dateStr, slot, rec.name, kcal, protein, new Date()]);
    const detailRow = detail.getLastRow();
    rebuildDay_(date);

    summary = dateLabel + ' ' + slot + 'に「' + rec.name + '」(' + kcal + 'kcal / ' + protein + 'g)を追記';
    PROPS.setProperty('LAST_LOG', JSON.stringify({
      ts: new Date().toISOString(),
      kind: 'meal',
      summary: summary,
      detailRow: detailRow,
      dateStr: dateStr
    }));
    return { written: true, summary: summary };

  } else if (rec.type === 'weight') {
    const dSheet = dailySheet_(date);
    const ySheet = yearSheet_(date);
    const dRow = ensureRow_(dSheet, date, 'daily');
    const yRow = ensureRow_(ySheet, date, 'year');

    const existing = [];
    if (rec.weightKg != null && cellHasValue_(ySheet, yRow, YEAR_COL.weight)) {
      existing.push({ label: '体重', value: ySheet.getRange(yRow, YEAR_COL.weight).getDisplayValue() });
    }
    if (rec.bodyFatPct != null && cellHasValue_(dSheet, dRow, DAILY_COL.bodyFat)) {
      existing.push({ label: '体脂肪率', value: dSheet.getRange(dRow, DAILY_COL.bodyFat).getDisplayValue() });
    }
    if (existing.length && !force) {
      return { needConfirm: true, existing: existing, dateLabel: dateLabel };
    }

    const parts = [];
    if (rec.weightKg != null) {
      pushChange_(changes, ySheet, yRow, YEAR_COL.weight);
      setNumberCell_(ySheet, yRow, YEAR_COL.weight, Number(rec.weightKg), 'kg');
      pushChange_(changes, dSheet, dRow, DAILY_COL.weight);
      setNumberCell_(dSheet, dRow, DAILY_COL.weight, Number(rec.weightKg), 'kg');
      parts.push('体重' + Number(rec.weightKg).toFixed(1) + 'kg');
    }
    if (rec.bodyFatPct != null) {
      pushChange_(changes, dSheet, dRow, DAILY_COL.bodyFat);
      setNumberCell_(dSheet, dRow, DAILY_COL.bodyFat, Number(rec.bodyFatPct), 'pct');
      parts.push('体脂肪率' + Number(rec.bodyFatPct).toFixed(2) + '%');
    }
    summary = dateLabel + ' ' + parts.join('・') + 'を記録';

  } else if (rec.type === 'steps') {
    const ySheet = yearSheet_(date);
    const yRow = ensureRow_(ySheet, date, 'year');
    if (cellHasValue_(ySheet, yRow, YEAR_COL.steps) && !force) {
      return {
        needConfirm: true,
        existing: [{ label: '歩数', value: ySheet.getRange(yRow, YEAR_COL.steps).getDisplayValue() }],
        dateLabel: dateLabel
      };
    }
    pushChange_(changes, ySheet, yRow, YEAR_COL.steps);
    setNumberCell_(ySheet, yRow, YEAR_COL.steps, Number(rec.steps), 'steps');
    summary = dateLabel + ' 歩数' + comma_(Math.round(Number(rec.steps))) + '歩を記録';

  } else if (rec.type === 'training') {
    const dSheet = dailySheet_(date);
    const dRow = ensureRow_(dSheet, date, 'daily');
    pushChange_(changes, dSheet, dRow, DAILY_COL.training);
    const cur = String(dSheet.getRange(dRow, DAILY_COL.training).getValue() || '').trim();
    dSheet.getRange(dRow, DAILY_COL.training).setValue(cur ? cur + ' ' + rec.text : rec.text);
    summary = dateLabel + ' 筋トレを記録';

  } else {
    return { error: '不明な記録の種類です: ' + rec.type };
  }

  PROPS.setProperty('LAST_LOG', JSON.stringify({
    ts: new Date().toISOString(),
    kind: 'cells',
    summary: summary,
    changes: changes
  }));
  return { written: true, summary: summary };
}

// ---------- 食事明細(1件=1行。食事セルと合計はここから再構築する) ----------

const DETAIL_SHEET_NAME = '食事明細';

function detailSheet_() {
  const ss = ss_();
  let sheet = ss.getSheetByName(DETAIL_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(DETAIL_SHEET_NAME);
    sheet.getRange(1, 1, 1, 6).setValues([['日付', '区分', '品名', 'カロリー', 'たんぱく質', '登録時刻']]);
  }
  return sheet;
}

function detailDateStr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM-dd');
  return String(v).trim();
}

function detailItems_(dateStr) {
  const sheet = detailSheet_();
  const last = sheet.getLastRow();
  const out = [];
  if (last < 2) return out;
  const values = sheet.getRange(2, 1, last - 1, 5).getValues();
  values.forEach(function (r, i) {
    if (detailDateStr_(r[0]) !== dateStr) return;
    out.push({
      row: i + 2,
      slot: String(r[1]).trim() || '間食',
      name: String(r[2]),
      kcal: Number(r[3]) || 0,
      protein: Number(r[4]) || 0
    });
  });
  return out;
}

/** その日の食事セル(朝〜間食)と合計カロリー・たんぱく質を、食事明細から作り直す */
function rebuildDay_(date) {
  const dateStr = Utilities.formatDate(date, 'Asia/Tokyo', 'yyyy-MM-dd');
  const items = detailItems_(dateStr);
  const dSheet = dailySheet_(date);
  const ySheet = yearSheet_(date);
  const dRow = ensureRow_(dSheet, date, 'daily');
  const yRow = ensureRow_(ySheet, date, 'year');

  const texts = { '朝食': [], '昼食': [], '夕食': [], '間食': [] };
  let kcal = 0, protein = 0;
  items.forEach(function (it) {
    (texts[it.slot] || texts['間食']).push(it.name);
    kcal += it.kcal;
    protein += it.protein;
  });

  Object.keys(SLOT_COL).forEach(function (slot) {
    const cell = dSheet.getRange(dRow, SLOT_COL[slot]);
    const t = texts[slot].join(' ');
    if (t) cell.setValue(t); else cell.clearContent();
  });

  if (kcal > 0) {
    setNumberCell_(dSheet, dRow, DAILY_COL.kcal, kcal, 'kcal0');
    setNumberCell_(ySheet, yRow, YEAR_COL.kcal, kcal, 'kcal1');
  } else {
    dSheet.getRange(dRow, DAILY_COL.kcal).clearContent();
    ySheet.getRange(yRow, YEAR_COL.kcal).clearContent();
  }
  if (protein > 0) {
    setNumberCell_(dSheet, dRow, DAILY_COL.protein, protein, 'g');
  } else {
    dSheet.getRange(dRow, DAILY_COL.protein).clearContent();
  }
}

function mealsList_(req) {
  const dateStr = req.date || Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  return { date: dateStr, items: detailItems_(dateStr) };
}

function mealUpdate_(req) {
  const sheet = detailSheet_();
  const row = Number(req.row);
  const dateStr = detailDateStr_(sheet.getRange(row, 1).getValue());
  sheet.getRange(row, 2, 1, 4).setValues([[
    SLOT_COL[req.slot] ? req.slot : '間食',
    String(req.name || '').trim(),
    Number(req.kcal) || 0,
    Number(req.protein) || 0
  ]]);
  rebuildDay_(parseISO_(dateStr));
  PROPS.deleteProperty('LAST_LOG');
  return { date: dateStr, items: detailItems_(dateStr) };
}

function mealDelete_(req) {
  const sheet = detailSheet_();
  const row = Number(req.row);
  const dateStr = detailDateStr_(sheet.getRange(row, 1).getValue());
  sheet.deleteRow(row);
  rebuildDay_(parseISO_(dateStr));
  PROPS.deleteProperty('LAST_LOG');
  return { date: dateStr, items: detailItems_(dateStr) };
}

// ---------- 取り消し(直近1件) ----------

function undoLast_() {
  const raw = PROPS.getProperty('LAST_LOG');
  if (!raw) return { error: '取り消せる記録がありません' };
  const log = JSON.parse(raw);

  if (log.kind === 'meal') {
    detailSheet_().deleteRow(log.detailRow);
    rebuildDay_(parseISO_(log.dateStr));
    PROPS.deleteProperty('LAST_LOG');
    return { undone: true, summary: log.summary };
  }

  const ss = ss_();
  log.changes.reverse().forEach(function (ch) {
    const sh = ss.getSheetByName(ch.sheet);
    if (!sh) return;
    const cell = sh.getRange(ch.row, ch.col);
    if (ch.before === '' || ch.before === null || ch.before === undefined) {
      cell.clearContent();
    } else {
      cell.setValue(ch.before);
    }
  });
  PROPS.deleteProperty('LAST_LOG');
  return { undone: true, summary: log.summary };
}

// ---------- ホーム用サマリー ----------

function getSummary_() {
  const now = new Date();
  const today = dateOnly_(now);
  const yesterday = new Date(today.getTime() - 86400000);

  const ySheet = yearSheet_(today);
  const dSheet = dailySheet_(today);
  const yRow = findRowByDate_(ySheet, today);
  const dRow = findRowByDate_(dSheet, today);

  const res = {
    date: Utilities.formatDate(today, 'Asia/Tokyo', 'yyyy-MM-dd'),
    weight: null, avg2w: null, bodyFat: null,
    kcalToday: 0, proteinToday: 0,
    stepsYesterday: null,
    meals: { '朝食': false, '昼食': false, '夕食': false, '間食': false },
    targets: settingsGet_().targets,
    lastLog: null
  };

  if (yRow) {
    res.weight = readNum_(ySheet.getRange(yRow, YEAR_COL.weight).getValue(), 'kg');
    res.avg2w = readNum_(ySheet.getRange(yRow, YEAR_COL.avg2w).getValue(), 'kg');
  }
  if (dRow) {
    res.bodyFat = readNum_(dSheet.getRange(dRow, DAILY_COL.bodyFat).getValue(), 'pct');
    res.kcalToday = readNum_(dSheet.getRange(dRow, DAILY_COL.kcal).getValue(), 'kcal0') || 0;
    res.proteinToday = readNum_(dSheet.getRange(dRow, DAILY_COL.protein).getValue(), 'g') || 0;
    Object.keys(SLOT_COL).forEach(function (slot) {
      res.meals[slot] = String(dSheet.getRange(dRow, SLOT_COL[slot]).getValue() || '').trim() !== '';
    });
  }

  const ySheetPrev = yearSheet_(yesterday);
  const yRowPrev = findRowByDate_(ySheetPrev, yesterday);
  if (yRowPrev) {
    res.stepsYesterday = readNum_(ySheetPrev.getRange(yRowPrev, YEAR_COL.steps).getValue(), 'steps');
  }

  const rawLog = PROPS.getProperty('LAST_LOG');
  if (rawLog) {
    const log = JSON.parse(rawLog);
    res.lastLog = { summary: log.summary, ts: log.ts };
  }
  return res;
}

// ---------- 定番マスタ ----------

function favSheet_() {
  const ss = ss_();
  let sheet = ss.getSheetByName('定番マスタ');
  if (!sheet) {
    sheet = ss.insertSheet('定番マスタ');
    sheet.getRange(1, 1, 1, 3).setValues([['名前', 'カロリー', 'たんぱく質(g)']]);
  }
  return sheet;
}

function favList_() {
  const sheet = favSheet_();
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const values = sheet.getRange(2, 1, last - 1, 3).getValues();
  const out = [];
  values.forEach(function (r, i) {
    const name = String(r[0]).trim();
    if (!name) return;
    out.push({
      row: i + 2,
      name: name,
      kcal: readNum_(r[1], 'kcal0') || 0,
      protein: readNum_(r[2], 'g') || 0
    });
  });
  return out;
}

function favAdd_(req) {
  const sheet = favSheet_();
  sheet.appendRow([String(req.name || '').trim(), Number(req.kcal) || 0, Number(req.protein) || 0]);
  return { favorites: favList_() };
}

function favUpdate_(req) {
  const sheet = favSheet_();
  sheet.getRange(Number(req.row), 1, 1, 3).setValues([[
    String(req.name || '').trim(), Number(req.kcal) || 0, Number(req.protein) || 0
  ]]);
  return { favorites: favList_() };
}

function favDelete_(req) {
  favSheet_().deleteRow(Number(req.row));
  return { favorites: favList_() };
}

// ---------- 設定(目標値) ----------

function settingsSheet_() {
  const ss = ss_();
  let sheet = ss.getSheetByName('設定');
  if (!sheet) {
    sheet = ss.insertSheet('設定');
    sheet.getRange(1, 1, 2, 2).setValues([['目標カロリー', 1800], ['目標たんぱく質', 130]]);
  }
  return sheet;
}

function settingsGet_() {
  const sheet = settingsSheet_();
  return {
    targets: {
      kcal: readNum_(sheet.getRange(1, 2).getValue(), 'kcal0') || 0,
      protein: readNum_(sheet.getRange(2, 2).getValue(), 'g') || 0
    }
  };
}

function settingsSet_(req) {
  const sheet = settingsSheet_();
  if (req.kcal != null) sheet.getRange(1, 2).setValue(Number(req.kcal));
  if (req.protein != null) sheet.getRange(2, 2).setValue(Number(req.protein));
  return settingsGet_();
}

/* ---------- gemini.gs ---------- */
/**
 * Gemini API 連携。
 * 写真・音声・テキストを解釈し、シートに書ける形(JSON)に変換する。
 * APIキーはスクリプトプロパティ GEMINI_API_KEY に保管し、スマホ側には渡さない。
 */

function analyze_(req) {
  const key = PROPS.getProperty('GEMINI_API_KEY');
  if (!key) return { error: 'GEMINI_API_KEY が未設定です(スクリプトプロパティ)' };
  const model = PROPS.getProperty('GEMINI_MODEL') || 'gemini-3.6-flash';

  const favorites = favList_();
  const parts = [{ text: buildPrompt_(favorites) }];

  if (req.inputType === 'text') {
    parts.push({ text: 'ユーザーの入力: ' + String(req.data || '') });
  } else if (req.inputType === 'image' || req.inputType === 'audio') {
    if (!req.data) return { error: 'データがありません' };
    parts.push({ inline_data: { mime_type: req.mimeType || 'image/jpeg', data: req.data } });
  } else {
    return { error: '不明な入力種別です: ' + req.inputType };
  }

  const body = {
    contents: [{ role: 'user', parts: parts }],
    generationConfig: {
      response_mime_type: 'application/json'
    }
  };

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + key;
  const resp = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });

  const code = resp.getResponseCode();
  if (code !== 200) {
    return { error: 'Gemini APIエラー(' + code + '): ' + resp.getContentText().slice(0, 300) };
  }

  let parsed;
  try {
    const data = JSON.parse(resp.getContentText());
    const text = data.candidates[0].content.parts[0].text;
    parsed = JSON.parse(text);
  } catch (err) {
    return { error: '判定結果を読み取れませんでした。もう一度お試しください。' };
  }

  const records = Array.isArray(parsed.records) ? parsed.records : [];
  records.forEach(function (rec) {
    if (rec.type === 'meal') {
      matchFavorite_(rec, favorites);
      applyQuantityLabel_(rec);
    }
  });

  return { records: records, notes: parsed.notes || '' };
}

/**
 * 定番マスタとの照合。一致したら「1単位あたりの固定値 × 数量」で上書きし、即書きフラグを立てる。
 * 例: 定番「ゆで卵」65kcal/5.8g + 「ゆで卵二個」→ 130kcal/11.6g
 */
function matchFavorite_(rec, favorites) {
  const norm = function (s) {
    return String(s || '').toLowerCase().replace(/[\s　]/g, '');
  };
  const name = norm(rec.name);
  if (!name) return;
  const qty = Number(rec.quantity) > 0 ? Number(rec.quantity) : 1;
  for (let i = 0; i < favorites.length; i++) {
    const fav = favorites[i];
    const favName = norm(fav.name);
    if (name === favName || name.indexOf(favName) !== -1 || favName.indexOf(name) !== -1) {
      rec.kcal = Math.round(fav.kcal * qty * 10) / 10;
      rec.protein = Math.round(fav.protein * qty * 10) / 10;
      rec.favoriteMatch = fav.name;
      rec.confidence = 1;
      return;
    }
  }
}

/** 品名に数量を含める(ゆで卵 + 2個 → ゆで卵2個)。シートに残る表記を分かりやすくする */
function applyQuantityLabel_(rec) {
  const qty = Number(rec.quantity) > 0 ? Number(rec.quantity) : 1;
  if (rec.unit) {
    rec.name = String(rec.name) + qty + rec.unit;
  } else if (qty !== 1) {
    rec.name = String(rec.name) + '×' + qty;
  }
}

function buildPrompt_(favorites) {
  const now = new Date();
  const nowStr = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');
  const favLines = favorites.length
    ? favorites.map(function (f) { return '- ' + f.name + ': ' + f.kcal + 'kcal / たんぱく質' + f.protein + 'g'; }).join('\n')
    : '(登録なし)';

  return [
    'あなたは健康記録アプリの解析エンジンです。ユーザーが送った写真・音声・テキストを解釈し、以下のJSONだけを返してください。説明文は不要です。',
    '',
    '現在日時(日本時間): ' + nowStr,
    '',
    '# 返すJSONの形式',
    '{',
    '  "records": [',
    '    {"type":"meal","date":"YYYY-MM-DD または null","slot":"朝食/昼食/夕食/間食 または null","name":"品名","quantity":数量(デフォルト1),"unit":"個/粒/枚/杯 など または null","kcal":数値またはnull,"protein":数値またはnull,"confidence":0から1},',
    '    {"type":"weight","date":"YYYY-MM-DD または null","weightKg":数値またはnull,"bodyFatPct":数値またはnull},',
    '    {"type":"steps","date":"YYYY-MM-DD または null","steps":数値},',
    '    {"type":"training","date":"YYYY-MM-DD または null","text":"【部位】種目 重量x回数 ..."}',
    '  ],',
    '  "notes": "補足があれば短く"',
    '}',
    '',
    '# ルール',
    '- 入力に含まれる記録だけをrecordsに入れる。1つの入力に複数の記録(例: 体重と歩数)があれば複数入れる。',
    '- 日付の指定(「8月15日」「昨日」など)があればdateに入れる。指定がなければnull(今日扱い)。',
    '- 音声の文字起こしは日本語として解釈する。',
    '- 食事のslotは発言に「朝食」「昼食」「夕食」「間食」があればそれを使い、なければnull。',
    '- 「ゆで卵二個」「アーモンド20粒」のように同じものを複数食べた場合: nameは「ゆで卵」「アーモンド」のように数量を除いた名前、quantityに数(2, 20)、unitに単位(個, 粒)を入れる。kcalとproteinは合計量(全部でいくつか)を入れる。不明ならnull。',
    '- 「プロテイン30g」「白ごはん150g」のような内容量・グラム数は数量ではないのでnameに含め、quantityは1、unitはnullにする。',
    '- 栄養成分表示の写真: 商品名とカロリー・たんぱく質を読み取り、1包装分に換算する(100gあたり表示なら内容量を考慮)。confidenceは0.9以上。',
    '- 料理の写真(ラベルなし): 内容を推定し、kcalとproteinも推定するが、confidenceは0.6以下にする。',
    '- 体重計や体組成計の画面写真: weightKg(kg)とbodyFatPct(%)を読み取る。',
    '- 歩数計・ヘルスケアの画面写真: stepsを読み取る。日付が画面に見えていればdateに入れる。',
    '- 手書きのトレーニングメモの写真: 内容を読み取り、「【胸トレ】ダンベルプレス 20kg×10×3」のような1行の文章にまとめてtextに入れる。',
    '- 食事の内容からkcal/proteinが判断できない場合はnullにする(勝手に0にしない)。',
    '',
    '# 定番メニュー(この名前に近い食事はこの値を使う)',
    favLines
  ].join('\n');
}

/* ---------- setup.gs ---------- */
/**
 * 初期セットアップ。GASエディタから setup() を1回実行する。
 *
 * 事前にスクリプトプロパティへ以下を設定しておくこと:
 *   SPREADSHEET_ID : スプレッドシートのID(URLの /d/ と /edit の間の文字列)
 *   GEMINI_API_KEY : Google AI Studio で取得したAPIキー
 *
 * setup() を実行すると:
 *   - 「定番マスタ」「設定」タブが無ければ作成される
 *   - 合言葉(TOKEN)が無ければ自動生成され、ログに表示される
 */

function setup() {
  favSheet_();
  settingsSheet_();
  if (!PROPS.getProperty('TOKEN')) {
    PROPS.setProperty('TOKEN', Utilities.getUuid());
  }
  Logger.log('セットアップ完了');
  Logger.log('合言葉(TOKEN): ' + PROPS.getProperty('TOKEN'));
  Logger.log('この合言葉をアプリの設定画面に入力してください。');
}

/** 動作確認用: サマリーをログに出す */
function testSummary() {
  Logger.log(JSON.stringify(getSummary_(), null, 2));
}

/** 動作確認用: テキスト解析を試す */
function testAnalyze() {
  Logger.log(JSON.stringify(analyze_({ inputType: 'text', data: '朝食プロテイン たんぱく質30g' }), null, 2));
}
