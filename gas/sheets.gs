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
    const dSheet = dailySheet_(date);
    const ySheet = yearSheet_(date);
    const dRow = ensureRow_(dSheet, date, 'daily');
    const yRow = ensureRow_(ySheet, date, 'year');
    const col = SLOT_COL[slot];

    pushChange_(changes, dSheet, dRow, col);
    const cur = String(dSheet.getRange(dRow, col).getValue() || '').trim();
    dSheet.getRange(dRow, col).setValue(cur ? cur + ' ' + rec.name : rec.name);

    const kcal = Number(rec.kcal) || 0;
    const protein = Number(rec.protein) || 0;
    if (kcal) {
      addToNumberCell_(changes, dSheet, dRow, DAILY_COL.kcal, kcal, 'kcal0');
      addToNumberCell_(changes, ySheet, yRow, YEAR_COL.kcal, kcal, 'kcal1');
    }
    if (protein) {
      addToNumberCell_(changes, dSheet, dRow, DAILY_COL.protein, protein, 'g');
    }
    summary = dateLabel + ' ' + slot + 'に「' + rec.name + '」(' + kcal + 'kcal / ' + protein + 'g)を追記';

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
    summary: summary,
    changes: changes
  }));
  return { written: true, summary: summary };
}

// ---------- 取り消し(直近1件) ----------

function undoLast_() {
  const raw = PROPS.getProperty('LAST_LOG');
  if (!raw) return { error: '取り消せる記録がありません' };
  const log = JSON.parse(raw);
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
