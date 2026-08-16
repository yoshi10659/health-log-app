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
