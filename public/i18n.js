// Interface translations. English text is the key; each entry lists [简体中文, 繁體中文, 日本語].
// The language follows the browser/OS language unless the user picks one in the top bar.
(() => {
'use strict';
const LANGS = ['zh-CN', 'zh-TW', 'ja'];
const T = {
  // top bar
  'Search symbol or company…': ['搜索代码或公司…', '搜尋代號或公司…', '銘柄コードまたは会社名で検索…'],
  'Chart type': ['图表类型', '圖表類型', 'チャートの種類'],
  'Candles': ['K线', 'K線', 'ローソク足'],
  'Heikin Ashi': ['平均K线', '平均K線', '平均足'],
  'Bars': ['美国线', '美國線', 'バー'],
  'Line': ['折线', '折線', 'ライン'],
  'Area': ['面积', '面積', 'エリア'],
  'Indicators ▾': ['指标 ▾', '指標 ▾', 'インジケーター ▾'],
  'Log': ['对数', '對數', '対数'],
  'Ext. hours': ['盘前盘后', '盤前盤後', '時間外'],
  'Show pre-market and after-hours trading on the 1m–1h charts (shaded) and in the watchlist. Stocks and ETFs only.': [
    '在1分钟至1小时图表（阴影部分）和自选列表中显示盘前、盘后交易。仅限股票和ETF。',
    '在1分鐘至1小時圖表（陰影部分）和自選清單中顯示盤前、盤後交易。僅限股票和ETF。',
    '1分足〜1時間足チャート（網掛け部分）とウォッチリストにプレマーケット・アフターマーケットの取引を表示します。株式とETFのみ。'],
  'Chart': ['图表', '圖表', 'チャート'],
  'Screener': ['选股器', '選股器', 'スクリーナー'],
  'Language': ['语言', '語言', '言語'],
  'Auto': ['自动', '自動', '自動'],
  // indicators
  'Moving Average (SMA)': ['简单移动平均线 (SMA)', '簡單移動平均線 (SMA)', '単純移動平均線 (SMA)'],
  'Exponential MA (EMA)': ['指数移动平均线 (EMA)', '指數移動平均線 (EMA)', '指数平滑移動平均線 (EMA)'],
  'Bollinger Bands': ['布林带', '布林通道', 'ボリンジャーバンド'],
  'Volume': ['成交量', '成交量', '出来高'],
  'Vol': ['量', '量', '出来高'],
  'Period': ['周期', '週期', '期間'],
  'Remove': ['移除', '移除', '削除'],
  // drawing tools
  'Select / pan (Esc)': ['选择 / 平移 (Esc)', '選取 / 平移 (Esc)', '選択 / 移動 (Esc)'],
  'Trend line': ['趋势线', '趨勢線', 'トレンドライン'],
  'Horizontal line': ['水平线', '水平線', '水平線'],
  'Vertical line': ['垂直线', '垂直線', '垂直線'],
  'Rectangle': ['矩形', '矩形', '長方形'],
  'Fibonacci retracement': ['斐波那契回撤', '費波那契回撤', 'フィボナッチ・リトレースメント'],
  'Measure price / % / bars': ['测量价格 / % / K线数', '測量價格 / % / K線數', '価格 / % / 本数を計測'],
  'Click two points to draw a trend line': ['点击两点绘制趋势线', '點擊兩點繪製趨勢線', '2点をクリックしてトレンドラインを描画'],
  'Click to place a horizontal line': ['点击放置水平线', '點擊放置水平線', 'クリックして水平線を配置'],
  'Click to place a vertical line': ['点击放置垂直线', '點擊放置垂直線', 'クリックして垂直線を配置'],
  'Click two corners': ['点击两个对角', '點擊兩個對角', '2つの角をクリック'],
  'Click the swing start, then the swing end': ['先点击波段起点，再点击波段终点', '先點擊波段起點，再點擊波段終點', 'スイングの始点、次に終点をクリック'],
  'Click two points to measure': ['点击两点进行测量', '點擊兩點進行測量', '2点をクリックして計測'],
  'Delete selected drawing, or all drawings on this symbol if none is selected (Del)': [
    '删除选中的绘图；未选中时删除该代码的全部绘图 (Del)', '刪除選取的繪圖；未選取時刪除該代號的全部繪圖 (Del)', '選択した描画を削除。未選択の場合はこの銘柄のすべての描画を削除 (Del)'],
  'Remove all {0} drawings on {1}?': ['确定移除 {1} 上的全部 {0} 个绘图吗？', '確定移除 {1} 上的全部 {0} 個繪圖嗎？', '{1} の描画 {0} 件をすべて削除しますか？'],
  'bars': ['根K线', '根K線', '本'],
  // chart messages
  'Loading {0}…': ['正在加载 {0}…', '正在載入 {0}…', '{0} を読み込み中…'],
  'No data for {0} on this timeframe': ['{0} 在该周期没有数据', '{0} 在此週期沒有資料', '{0} のこの時間足のデータがありません'],
  ' — try another symbol or timeframe.': ['，请尝试其他代码或周期。', '，請嘗試其他代號或週期。', '。別の銘柄または時間足をお試しください。'],
  'Could not load the charting library (needs an internet connection). Reload to retry.': [
    '无法加载图表库（需要联网）。请刷新重试。', '無法載入圖表庫（需要連線）。請重新整理再試。', 'チャートライブラリを読み込めませんでした（インターネット接続が必要です）。再読み込みしてください。'],
  'Pre-market': ['盘前', '盤前', 'プレマーケット'],
  'After-hours': ['盘后', '盤後', 'アフターマーケット'],
  // watchlist
  'Watchlist': ['自选列表', '自選清單', 'ウォッチリスト'],
  'Import': ['导入', '匯入', 'インポート'],
  'Import a watchlist exported from another charting app': ['导入从其他图表软件导出的自选列表', '匯入從其他圖表軟體匯出的自選清單', '他のチャートアプリからエクスポートしたウォッチリストをインポート'],
  '+ Section': ['+ 分组', '+ 分組', '+ セクション'],
  'Add a section heading': ['添加分组标题', '新增分組標題', 'セクション見出しを追加'],
  '+ Add': ['+ 添加', '+ 新增', '+ 追加'],
  'Add the charted symbol': ['添加当前图表的代码', '新增目前圖表的代號', '表示中の銘柄を追加'],
  'Remove this heading (its symbols stay)': ['移除此分组标题（保留其中的代码）', '移除此分組標題（保留其中的代號）', 'この見出しを削除（銘柄は残ります）'],
  'Rename': ['重命名', '重新命名', '名前を変更'],
  'Click to collapse or expand · drag to move': ['点击折叠或展开 · 拖动可移动', '點擊收合或展開 · 拖曳可移動', 'クリックで折りたたみ/展開 · ドラッグで移動'],
  'New section': ['新分组', '新分組', '新しいセクション'],
  'ext ': ['盘外 ', '盤外 ', '時間外 '],
  'Latest extended-hours price': ['最新盘前/盘后价格', '最新盤前/盤後價格', '最新の時間外価格'],
  'Change from the regular-session close': ['相对正常交易时段收盘价的涨跌', '相對正常交易時段收盤價的漲跌', '通常取引終値からの変化'],
  // import dialog
  'Import watchlist': ['导入自选列表', '匯入自選清單', 'ウォッチリストをインポート'],
  'Choose an exported watchlist file (.txt or .csv), or paste symbols below — e.g. NASDAQ:AAPL, NYSE:BRK.B, BINANCE:BTCUSDT': [
    '选择导出的自选列表文件（.txt 或 .csv），或在下方粘贴代码，例如 NASDAQ:AAPL, NYSE:BRK.B, BINANCE:BTCUSDT',
    '選擇匯出的自選清單檔案（.txt 或 .csv），或在下方貼上代號，例如 NASDAQ:AAPL, NYSE:BRK.B, BINANCE:BTCUSDT',
    'エクスポートしたウォッチリストのファイル（.txt または .csv）を選択するか、下に銘柄コードを貼り付けてください。例: NASDAQ:AAPL, NYSE:BRK.B, BINANCE:BTCUSDT'],
  'Paste symbols here': ['在此粘贴代码', '在此貼上代號', 'ここに銘柄コードを貼り付け'],
  'Replace my current watchlist instead of adding to it': ['替换当前自选列表，而不是追加', '取代目前的自選清單，而不是追加', '追加せずに現在のウォッチリストを置き換える'],
  'Cancel': ['取消', '取消', 'キャンセル'],
  'No new symbols found — choose a file or paste a list first.': ['未找到新的代码，请先选择文件或粘贴列表。', '未找到新的代號，請先選擇檔案或貼上清單。', '新しい銘柄が見つかりません。先にファイルを選択するかリストを貼り付けてください。'],
  // screener
  'Universe': ['范围', '範圍', '対象'],
  'Symbols, comma separated (e.g. AAPL, SHOP, BTC-USD)': ['代码，用逗号分隔（例如 AAPL, SHOP, BTC-USD）', '代號，以逗號分隔（例如 AAPL, SHOP, BTC-USD）', '銘柄コードをカンマ区切りで入力（例: AAPL, SHOP, BTC-USD）'],
  'Preset': ['预设', '預設', 'プリセット'],
  'Scan': ['扫描', '掃描', 'スキャン'],
  'Price': ['价格', '價格', '価格'],
  'Change %': ['涨跌幅 %', '漲跌幅 %', '騰落率 %'],
  'Rel. volume ≥': ['量比 ≥', '量比 ≥', '出来高倍率 ≥'],
  'Within': ['距52周高点', '距52週高點', '52週高値から'],
  '% of 52w high': ['% 以内', '% 以內', '% 以内'],
  'Above SMA 50': ['高于50日均线', '高於50日均線', 'SMA 50 より上'],
  'Above SMA 200': ['高于200日均线', '高於200日均線', 'SMA 200 より上'],
  'Reset filters': ['重置筛选', '重設篩選', 'フィルターをリセット'],
  'min': ['最低', '最低', '最小'],
  'max': ['最高', '最高', '最大'],
  'US large caps': ['美股大盘股', '美股大型股', '米国大型株'],
  'ETFs & sectors': ['ETF与行业', 'ETF與產業', 'ETF・セクター'],
  'Crypto': ['加密货币', '加密貨幣', '暗号資産'],
  'FX & commodities': ['外汇与大宗商品', '外匯與大宗商品', '為替・商品'],
  'Japan large caps (Tokyo)': ['日本大盘股（东京）', '日本大型股（東京）', '日本大型株（東証）'],
  'My watchlist': ['我的自选列表', '我的自選清單', 'マイウォッチリスト'],
  'Custom list…': ['自定义列表…', '自訂清單…', 'カスタムリスト…'],
  'None': ['无', '無', 'なし'],
  'Oversold (RSI < 30)': ['超卖 (RSI < 30)', '超賣 (RSI < 30)', '売られすぎ (RSI < 30)'],
  'Overbought (RSI > 70)': ['超买 (RSI > 70)', '超買 (RSI > 70)', '買われすぎ (RSI > 70)'],
  'Uptrend (above SMA 50 & 200)': ['上升趋势（高于50日和200日均线）', '上升趨勢（高於50日和200日均線）', '上昇トレンド（SMA 50・200 より上）'],
  'Volume spike (≥ 1.5× average)': ['放量（≥ 1.5 倍均量）', '爆量（≥ 1.5 倍均量）', '出来高急増（平均の1.5倍以上）'],
  'Near 52-week high (within 3%)': ['接近52周高点（3%以内）', '接近52週高點（3%以內）', '52週高値付近（3%以内）'],
  'Top gainers (≥ +2%)': ['涨幅居前 (≥ +2%)', '漲幅居前 (≥ +2%)', '値上がり上位 (≥ +2%)'],
  'Top losers (≤ −2%)': ['跌幅居前 (≤ −2%)', '跌幅居前 (≤ −2%)', '値下がり上位 (≤ −2%)'],
  'Symbol': ['代码', '代號', '銘柄'],
  'Name': ['名称', '名稱', '名称'],
  'Last': ['最新价', '最新價', '現在値'],
  'Chg': ['涨跌额', '漲跌額', '前日比'],
  'Chg %': ['涨跌幅', '漲跌幅', '騰落率'],
  'Rel vol': ['量比', '量比', '出来高倍率'],
  'vs SMA 50': ['较50日均线', '較50日均線', 'SMA 50 比'],
  'vs SMA 200': ['较200日均线', '較200日均線', 'SMA 200 比'],
  'From 52w high': ['距52周高点', '距52週高點', '52週高値比'],
  '1W': ['1周', '1週', '1週'],
  '1M': ['1个月', '1個月', '1か月'],
  '3M': ['3个月', '3個月', '3か月'],
  '30 days': ['30天', '30天', '30日'],
  '+ Watch': ['+ 自选', '+ 自選', '+ 追加'],
  'Add to watchlist': ['加入自选列表', '加入自選清單', 'ウォッチリストに追加'],
  'No symbols match these filters.': ['没有符合筛选条件的代码。', '沒有符合篩選條件的代號。', '条件に一致する銘柄がありません。'],
  'Press Scan to load this universe.': ['点击“扫描”加载该范围。', '點擊「掃描」載入此範圍。', '「スキャン」を押して読み込みます。'],
  '{0} of {1} match · click a row to chart it': ['{1} 个中有 {0} 个符合 · 点击行查看图表', '{1} 個中有 {0} 個符合 · 點擊列查看圖表', '{1} 件中 {0} 件が一致 · 行をクリックでチャート表示'],
  ' · no data for {0}': [' · 无数据：{0}', ' · 無資料：{0}', ' · データなし: {0}'],
  'Scanning {0} symbols…': ['正在扫描 {0} 个代码…', '正在掃描 {0} 個代號…', '{0} 銘柄をスキャン中…'],
  'This list is empty.': ['该列表为空。', '此清單是空的。', 'このリストは空です。'],
  'Scan failed: ': ['扫描失败：', '掃描失敗：', 'スキャン失敗: '],
};

function detect() {
  const prefs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'en'];
  for (const p of prefs) {
    const l = String(p).toLowerCase();
    if (l.startsWith('zh')) return /tw|hk|mo|hant/.test(l) ? 'zh-TW' : 'zh-CN';
    if (l.startsWith('ja')) return 'ja';
    if (l.startsWith('en')) return 'en';
  }
  return 'en';
}
let choice = 'auto';
try { choice = localStorage.getItem('cd.lang') || 'auto'; } catch { /* storage unavailable */ }
const lang = choice === 'auto' || (choice !== 'en' && !LANGS.includes(choice)) ? detect() : choice;
const col = LANGS.indexOf(lang);

function t(key, ...args) {
  const row = T[key];
  const s = col >= 0 && row && row[col] ? row[col] : key;
  return args.length ? s.replace(/\{(\d)\}/g, (_, i) => args[i]) : s;
}

// translate the static page
document.documentElement.lang = lang;
for (const e of document.querySelectorAll('[data-i18n]')) e.textContent = t(e.textContent.trim());
for (const e of document.querySelectorAll('[data-i18n-title]')) e.title = t(e.title);
for (const e of document.querySelectorAll('[data-i18n-ph]')) e.placeholder = t(e.placeholder);
const sel = document.querySelector('#lang');
if (sel) {
  sel.value = choice;
  sel.addEventListener('change', () => { try { localStorage.setItem('cd.lang', sel.value); } catch { /* ignore */ } location.reload(); });
}

window.I18N = { t, lang, locale: lang === 'en' ? 'en-US' : lang };
})();
