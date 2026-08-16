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
    const items = Array.isArray(req.data) ? req.data : [req.data];
    if (!items.length || !items[0]) return { error: 'データがありません' };
    items.forEach(function (d) {
      parts.push({ inline_data: { mime_type: req.mimeType || 'image/jpeg', data: d } });
    });
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
    '- 写真が複数枚ある場合は、1枚ずつすべて判定してrecordsに全部入れる(例: 惣菜3品の写真3枚 → 食事レコード3件)。',
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
