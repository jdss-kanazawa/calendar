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
 * Notionのテキスト要素
 * @typedef {Object} NotionText
 * @property {string} plain_text
 */
/**
 * Notionの日付プロパティ
 * @typedef {Object} NotionDate
 * @property {string} start 開始日時
 * @property {string|null} [end] 終了日時
 */
/**
 * Notionページ内の利用対象プロパティ
 * @typedef {Object} NotionProperty
 * @property {NotionText[]} [title]
 * @property {NotionText[]} [rich_text]
 * @property {{name: string}|null} [select]
 * @property {{name: string}[]} [multi_select]
 * @property {boolean} [checkbox]
 * @property {string|null} [url]
 * @property {NotionDate|null} [date]
 */
/**
 * 取得したNotionデータベースのページ
 * @typedef {Object} NotionPage
 * @property {Record<string, NotionProperty|null>} properties
 */
/**
 * Notionの日付をカレンダー用に分解した値
 * @typedef {Object} ParsedEventDate
 * @property {string} s 開始日（YYYY-MM-DD）
 * @property {string} e 終了日（YYYY-MM-DD）
 * @property {string} st 開始時刻（HH:mmまたは空文字）
 * @property {string} et 終了時刻（HH:mmまたは空文字）
 */
/**
 * events.jsonに保存し、画面で表示する行事データ
 * @typedef {Object} CalendarEvent
 * @property {string} s 開始日（YYYY-MM-DD）
 * @property {string} e 終了日（YYYY-MM-DD）
 * @property {string} st 開始時刻
 * @property {string} et 終了時刻
 * @property {string} t 表示用行事名
 * @property {string} ot 正式な行事名
 * @property {string} c 分類
 * @property {string} g 対象
 * @property {string} p 場所
 * @property {string} pd 場所の詳細
 * @property {boolean} stt 配信行事かどうか
 * @property {string[]} ha 担当者一覧
 * @property {string} d 説明
 * @property {string} u 関連URL
 * @property {number} [i] 描画時に使う行事番号
 */
/**
 * イベント一覧と最終更新時刻を含むJSONデータ
 * @typedef {Object} CalendarData
 * @property {string} lastUpdated 最終更新日時
 * @property {CalendarEvent[]} events 行事一覧
 */

/**
 * プロパティヘルパー
 *
 * Notion APIのプロパティ形式は種類ごとに異なるため、
 * タイトル、本文、選択肢などを画面で使いやすい文字列または配列に変換する。
 */
/** @param {NotionProperty|null|undefined} prop @returns {string} */
function getTitle(prop) {
  if (!prop || !prop.title || !Array.isArray(prop.title)) return '';
  return prop.title.map(t => t.plain_text).join('').trim();
}

/** @param {NotionProperty|null|undefined} prop @returns {string} */
function getText(prop) {
  if (!prop || !prop.rich_text || !Array.isArray(prop.rich_text)) return '';
  return prop.rich_text.map(t => t.plain_text).join('').trim();
}

/** @param {NotionProperty|null|undefined} prop @returns {string} */
function getSelect(prop) {
  if (!prop || !prop.select || !prop.select.name) return '';
  return prop.select.name.trim();
}

/** @param {NotionProperty|null|undefined} prop @returns {string[]} */
function getMultiSelect(prop) {
  if (!prop || !prop.multi_select || !Array.isArray(prop.multi_select)) return [];
  return prop.multi_select.map(m => m.name.trim()).filter(Boolean);
}

/** @param {NotionProperty|null|undefined} prop @returns {boolean} */
function getCheckbox(prop) {
  if (!prop) return false;
  return Boolean(prop.checkbox);
}

/** @param {NotionProperty|null|undefined} prop @returns {string} */
function getUrl(prop) {
  if (!prop) return '';
  return prop.url || '';
}

/**
 * Notionの日時オブジェクトをJST形式に変換
 *
 * 日付のみのプロパティは時刻を空文字として返す。
 * ISO8601形式に時刻が含まれる場合はDateを経由せず、明示的にAsia/Tokyoへ変換する。
 * @param {NotionDate|null|undefined} dateObj Notionの日付プロパティ
 * @returns {ParsedEventDate|null} カレンダー用の日付、または日付未設定時のnull
 */
function parseNotionDate(dateObj) {
  if (!dateObj || !dateObj.start) return null;

  /** @param {string|null|undefined} str @returns {{date: string, time: string}|null} */
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
 * Notion APIから条件に合う全ページを取得
 *
 * Notionのquery APIは100件ごとに分割されるため、
 * has_moreとnext_cursorを確認して次ページを繰り返し取得する。
 * @param {string} startDate 開始日がこの日以降の行事を取得する基準日（YYYY-MM-DD）
 * @returns {Promise<NotionPage[]>} 条件に一致したページ
 */
async function fetchAllMatchingDatabasePages(startDate) {
  /** @type {NotionPage[]} */
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
                on_or_after: startDate,
              },
            },
            {
              property: '分類',
              select: {
                equals: ALLOWED_CATS,
              },
            },
            {
              property: '対象',
              select: {
                equals: ALLOWED_TGTS,
              },
            },
            // {
            //   property: '担当',
            //   multi_select: {
            //     does_not_contain: '森宏嗣さん',
            //   },
            // },
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

/**
 * Notionから行事を同期し、差分があればevents.jsonを書き換える。
 * @returns {Promise<void>}
 */
async function main() {
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

  // 当月1日を開始日フィルターに使い、古い行事をNotion側で除外する。
  // 更新時刻はこのJSTの実行時刻から作り、イベント差分がある場合にだけ保存する。
  const currentMonthFirstDay = `${nowYear}-${nowMonth}-01`;
  const updateTimestamp = `${nowYear}/${nowMonth}/${nowDay} ${nowHour}:${nowMinute}`;

  // 確定・日時・開始日・分類・対象・担当の条件をNotion側で適用してから取得する。
  // ページネーション処理もfetchAllMatchingDatabasePages内で完結する。
  console.log('Notionデータベースから条件に合う行事を取得しています...');
  const pages = await fetchAllMatchingDatabasePages(currentMonthFirstDay);
  console.log(`取得条件に一致した行事を${pages.length}件取得しました。`);

  // Notionの各ページから画面が参照する短いフィールド名のオブジェクトへ変換する。
  /** @type {CalendarEvent[]} */
  const events = [];

  for (const page of pages) {
    const props = page.properties;
    if (!props) continue;

    // Notion APIの条件で分類と対象は絞り込み済み。画面表示用に値を取り出す。
    const category = getSelect(props['分類']);

    const target = getSelect(props['対象']);

    // Notion APIの条件で除外済み。イベントデータへ担当者一覧を格納するため取得する。
    const handlers = getMultiSelect(props['担当']);

    // Notionの開始・終了日時を日付と時刻に分解し、開始時刻・終了時刻を個別に保持する。
    const dateParsed = parseNotionDate(props['日時']?.date);
    if (!dateParsed) continue;
    const { s, e, st, et } = dateParsed;

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
  /** @type {CalendarEvent[]|null} */
  let existingEvents = null;

  if (fs.existsSync(EVENTS_JSON_PATH)) {
    try {
      /** @type {CalendarData} */
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
  /** @type {CalendarData} */
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
