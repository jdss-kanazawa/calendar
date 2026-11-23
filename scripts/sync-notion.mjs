import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
// イベント配列と最終更新時刻を含むデータは、この1ファイルだけに保存する。
const EVENTS_JSON_PATH = path.join(ROOT_DIR, 'events.json');

// Notion APIキーはリポジトリに保存せず、GitHub ActionsのSecretから環境変数で渡す。
const NOTION_API_KEY = process.env.NOTION_API_KEY;
// Database IDは既定値を持つが、Secret経由のNOTION_DATABASE_IDがあればそちらを優先する。
// ハイフンが付いていてもNotion API用のIDとして使えるよう、ここで除去する。
const NOTION_DATABASE_ID = (process.env.NOTION_DATABASE_ID || '2074219514d48027b9e6e1b6daed35d5').replace(/-/g, '');

if (!NOTION_API_KEY) {
  console.error('エラー: 環境変数 NOTION_API_KEY が設定されていません。');
  process.exit(1);
}

// 表示対象を限定するための分類・対象リスト。
// ALLOWED_CATSまたはALLOWED_TGTSに含まれない行事は、取得後のフィルタで除外する。
const ALLOWED_CATS = ['自支部／青年', 'ご講演', '共通'];
const ALLOWED_TGTS = ['班長以上', '学徒全員', '縁正含む', '希望者（講）'];
// 場所名や場所詳細に配信を示す語が含まれている場合は配信行事として扱う。
const HAISHIN_WORD = /(オンライン|Zoom|zoom|配信|LINE|ＬＩＮＥ)/;


/**
 * プロパティヘルパー
 *
 * Notion APIのプロパティ形式は種類ごとに異なるため、
 * タイトル、本文、選択肢などを画面で使いやすい文字列または配列に変換する。
 */
function getTitle(prop) {
  if (!prop || !prop.title || !Array.isArray(prop.title)) return '';
  return prop.title.map(t => t.plain_text).join('').trim();
}

function getText(prop) {
  if (!prop || !prop.rich_text || !Array.isArray(prop.rich_text)) return '';
  return prop.rich_text.map(t => t.plain_text).join('').trim();
}

function getSelect(prop) {
  if (!prop || !prop.select || !prop.select.name) return '';
  return prop.select.name.trim();
}

function getMultiSelect(prop) {
  if (!prop || !prop.multi_select || !Array.isArray(prop.multi_select)) return [];
  return prop.multi_select.map(m => m.name.trim()).filter(Boolean);
}

function getCheckbox(prop) {
  if (!prop) return false;
  return Boolean(prop.checkbox);
}

function getUrl(prop) {
  if (!prop) return '';
  return prop.url || '';
}

/**
 * Notionの日時オブジェクトをJST形式に変換
 *
 * 日付のみのプロパティは時刻を空文字として返す。
 * ISO8601形式に時刻が含まれる場合はDateを経由せず、明示的にAsia/Tokyoへ変換する。
 */
function parseNotionDate(dateObj) {
  if (!dateObj || !dateObj.start) return null;

  function toJST(str) {
    if (!str) return null;
    if (!str.includes('T')) {
      return { date: str, time: '' };
    }
    const d = new Date(str);
    const jstFormatter = new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: 'numeric',
      minute: '2-digit',
      hour12: false,
    });
    const parts = jstFormatter.formatToParts(d);
    const getPart = (type) => parts.find(p => p.type === type)?.value || '';
    const date = `${getPart('year')}-${getPart('month')}-${getPart('day')}`;
    const hour = parseInt(getPart('hour'), 10);
    const minute = getPart('minute');
    const time = `${hour}:${minute}`;
    return { date, time };
  }

  const start = toJST(dateObj.start);
  const end = dateObj.end ? toJST(dateObj.end) : null;

  const s = start.date;
  const e = end ? end.date : s;
  const st = start.time || '';
  const et = end ? (end.time || '') : '';

  return { s, e, st, et };
}

/**
 * Notion APIから全件ページを取得
 *
 * Notionのquery APIは100件ごとに分割されるため、
 * has_moreとnext_cursorを確認して次ページを繰り返し取得する。
 */
async function fetchAllDatabasePages() {
  const pages = [];
  let cursor = undefined;

  while (true) {
    const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_API_KEY}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        page_size: 100,
        start_cursor: cursor,
        filter: {
          and: [
            {
              property: '確定',
              checkbox: {
                equals: true,
              },
            },
            {
              property: '日時',
              date: {
                is_not_empty: true,
              },
            },
          ],
        },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to query Notion database: ${res.status} ${res.statusText}\n${errText}`);
    }

    const data = await res.json();
    pages.push(...data.results);

    if (!data.has_more || !data.next_cursor) {
      break;
    }
    cursor = data.next_cursor;
  }

  return pages;
}

async function main() {
  // 最初にNotionから確定済みかつ日時が入力された行事だけを全件取得する。
  // ページネーション処理はfetchAllDatabasePages内で完結している。
  console.log('Notionデータベースから行事を取得しています...');
  const pages = await fetchAllDatabasePages();
  console.log(`日時が設定された確定済みページを${pages.length}件取得しました。`);

  // サーバーがUTCでも正しい日本時間で更新時刻と期間フィルタを作れるよう、
  // 実行時刻をIntlのAsia/Tokyoタイムゾーンで明示的に取得する。
  const now = new Date();
  const jstNowParts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const getNowPart = (type) => jstNowParts.find(p => p.type === type)?.value || '';
  const nowYear = getNowPart('year');
  const nowMonth = getNowPart('month');
  const nowDay = getNowPart('day');
  const nowHour = getNowPart('hour');
  const nowMinute = getNowPart('minute');

  // 過去行事を画面から切り詰めるため、終了日が実行日の当月1日以降の行事だけ残す。
  // 更新時刻はこのJSTの実行時刻から作り、イベント差分がある場合にだけ保存する。
  const currentMonthFirstDay = `${nowYear}-${nowMonth}-01`;
  const updateTimestamp = `${nowYear}/${nowMonth}/${nowDay} ${nowHour}:${nowMinute}`;

  // Notionの各ページから画面が参照する短いフィールド名のオブジェクトへ変換する。
  const events = [];

  for (const page of pages) {
    const props = page.properties;
    if (!props) continue;

    // 分類が許可リスト外なら表示対象ではないため、以降の日時変換を行わず除外する。
    const category = getSelect(props['分類']);
    if (!ALLOWED_CATS.includes(category)) continue;

    // 対象が許可リスト外なら、この同期処理では公開しない。
    const target = getSelect(props['対象']);
    if (!ALLOWED_TGTS.includes(target)) continue;

    // 森宏嗣さんを担当に含む行事は公開対象外として除外する。
    const handlers = getMultiSelect(props['担当']);
    if (handlers.includes('森宏嗣さん')) continue;

    // Notionの開始・終了日時を日付と時刻に分解し、開始時刻・終了時刻を個別に保持する。
    const dateParsed = parseNotionDate(props['日時']?.date);
    if (!dateParsed) continue;
    const { s, e, st, et } = dateParsed;

    // 期間フィルタ: 実行日の当月1日以降（終了日または開始日が当月1日以降）
    if (e < currentMonthFirstDay) continue;

    // 画面表示名では「青年勉強会」を統一名へ置換する。
    // 対象が縁正含むの場合は画面名を統一し、元のNotion上の行事名を正式名として別項目へ残す。
    let rawTitle = getTitle(props['行事名']);
    let title = rawTitle.replace(/青年勉強会/g, '青年縁正行事');
    let originalTitle = '';

    if (target === '縁正含む') {
      originalTitle = title;
      title = '青年縁正行事';
    }

    // 場所名に配信を示す語がある場合、または配信チェックがONの場合は配信行事として扱う。
    // 配信のみがONで場所名に配信語がない場合は、表示用の場所名へ「（配信）」を付ける。
    const rawPlace = getSelect(props['場所']) || getText(props['場所']);
    const hasHaishinWord = HAISHIN_WORD.test(rawPlace);
    const isHaishin = getCheckbox(props['配信']);
    const stt = isHaishin || hasHaishinWord;

    let place = rawPlace;
    if (isHaishin && !hasHaishinWord && place) {
      place = `${place}（配信）`;
    }

    const placeDetail = getText(props['場所詳細']);
    const description = getText(props['説明']);
    const url = getUrl(props['URL']) || getUrl(props['userDefined:URL']);

    events.push({
      s,
      e,
      st,
      et,
      t: title,
      ot: originalTitle,
      c: category,
      g: target,
      p: place,
      pd: placeDetail,
      stt,
      ha: handlers,
      d: description,
      u: url,
    });
  }

  // イベントを日付昇順で並べ、同日の複数行事は開始時刻が早い順にする。
  // 時刻未設定の行事は-1分として扱うため、同日の時刻あり行事より前に並ぶ。
  events.sort((a, b) => {
    if (a.s !== b.s) return a.s.localeCompare(b.s);
    const toMin = (t) => {
      if (!t) return -1;
      const [h, m] = t.split(':').map(Number);
      return h * 60 + m;
    };
    return toMin(a.st) - toMin(b.st);
  });

  // 連番IDの付与
  events.forEach((ev, idx) => {
    ev.i = idx;
  });

  console.log(`${currentMonthFirstDay}以降の有効な行事を${events.length}件処理しました。`);

  // 既存events.jsonを読み込み、lastUpdatedとeventsを含むオブジェクトとして保持する。
  // ファイルがない、またはJSONが壊れている場合は「差分あり」と判断する。
  let existingEvents = null;

  if (fs.existsSync(EVENTS_JSON_PATH)) {
    try {
      const existingData = JSON.parse(fs.readFileSync(EVENTS_JSON_PATH, 'utf8'));
      // イベント比較では lastUpdated を除外し、eventsプロパティだけを見る。
      existingEvents = existingData.events;
    } catch {
      // JSONの解析に失敗した場合は、壊れたファイルを安全な新しい内容で再生成する。
      existingEvents = null;
    }
  }

  // イベント配列だけを比較する。
  // JSON文字列で比較するため、項目の順序と各イベントの内容も差分判定に含める。
  const eventsChanged = existingEvents === null
    || JSON.stringify(existingEvents) !== JSON.stringify(events);

  // イベントに差分がなければ、events.jsonを一切書き換えない。
  // GitHub Actionsもコミット対象を検知できず、更新時刻は変わらないままになる。
  if (!eventsChanged) {
    console.log('行事情報に変更はありません。events.jsonは更新しませんでした。');
    return;
  }

  // イベント情報と更新時刻を同じJSONオブジェクトにまとめる。
  // 比較時にはeventsだけを使うため、更新時刻だけの変更では差分にならない。
  const calendarData = {
    lastUpdated: updateTimestamp,
    events,
  };
  const calendarJson = JSON.stringify(calendarData, null, 2);
  fs.writeFileSync(EVENTS_JSON_PATH, `${calendarJson}\n`, 'utf8');

  console.log(`${EVENTS_JSON_PATH}を更新しました。`);
}

main().catch(err => {
  console.error('同期処理中に致命的なエラーが発生しました:', err);
  process.exit(1);
});
