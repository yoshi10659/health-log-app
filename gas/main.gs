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
