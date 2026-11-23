import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const EVENTS_JSON_PATH = path.join(ROOT_DIR, 'events.json');

const NOTION_API_KEY = process.env.NOTION_API_KEY;
// デフォルトのDatabase ID（青年部金沢地区の日程表）
const NOTION_DATABASE_ID = (process.env.NOTION_DATABASE_ID || '2074219514d48027b9e6e1b6daed35d5').replace(/-/g, '');

if (!NOTION_API_KEY) {
  console.error('Error: NOTION_API_KEY environment variable is required.');
  process.exit(1);
}

// 許可された分類・対象
const ALLOWED_CATS = ['自支部／青年', 'ご講演', '共通'];
const ALLOWED_TGTS = ['班長以上', '学徒全員', '縁正含む', '希望者（講）'];
const HAISHIN_WORD = /(オンライン|Zoom|zoom|配信|LINE|ＬＩＮＥ)/;


/**
 * プロパティヘルパー
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
  console.log('Fetching events from Notion database...');
  const pages = await fetchAllDatabasePages();
  console.log(`Retrieved ${pages.length} confirmed pages with dates.`);

  // JST現在日時の取得
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

  // 期間フィルタ基準: 実行日の当月1日以降
  const currentMonthFirstDay = `${nowYear}-${nowMonth}-01`;
  const updateTimestamp = `${nowYear}/${nowMonth}/${nowDay} ${nowHour}:${nowMinute}`;

  const events = [];

  for (const page of pages) {
    const props = page.properties;
    if (!props) continue;

    // 分類フィルタ
    const category = getSelect(props['分類']);
    if (!ALLOWED_CATS.includes(category)) continue;

    // 対象フィルタ
    const target = getSelect(props['対象']);
    if (!ALLOWED_TGTS.includes(target)) continue;

    // 担当フィルタ（森宏嗣さんを除外）
    const handlers = getMultiSelect(props['担当']);
    if (handlers.includes('森宏嗣さん')) continue;

    // 日時パース
    const dateParsed = parseNotionDate(props['日時']?.date);
    if (!dateParsed) continue;
    const { s, e, st, et } = dateParsed;

    // 期間フィルタ: 実行日の当月1日以降（終了日または開始日が当月1日以降）
    if (e < currentMonthFirstDay) continue;

    // 行事名と正式名
    let rawTitle = getTitle(props['行事名']);
    let title = rawTitle.replace(/青年勉強会/g, '青年縁正行事');
    let originalTitle = '';

    if (target === '縁正含む') {
      originalTitle = title;
      title = '青年縁正行事';
    }

    // 場所と配信
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

  // ソート: 日付昇順、同日内は開始時刻（分換算）昇順
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

  console.log(`Processed ${events.length} valid events (from ${currentMonthFirstDay} onwards).`);

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
    console.log('No event changes detected. events.json was left unchanged.');
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

  console.log(`Successfully updated ${EVENTS_JSON_PATH}!`);
}

main().catch(err => {
  console.error('Fatal error during sync:', err);
  process.exit(1);
});
