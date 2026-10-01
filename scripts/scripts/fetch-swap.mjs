// GitHub Actions で毎日実行して、各社のスワップを swap.json に保存するスクリプト
// （以前の Supabase Edge Function「fetch-swap」と同じ取得ロジック）
//
// 各社の公開スワップカレンダーから、通貨ペアごとに
//   ・「付与日数が1日」の行のうち、いちばん新しい日
//   ・買い／売りのうち、プラス（大きい方）
//   ・1万通貨あたりの金額に換算
// して、アプリが読む swap.json に書き出します。
import { writeFile } from "node:fs/promises";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15";
const pad = (n) => String(n).padStart(2, "0");
// 数値化。空欄・「-」・「公表前」などは NaN。カンマ（1,550.0）は除く
const num = (s) => {
  if (s === undefined || s === null) return NaN;
  const t = String(s).replace(/,/g, "").trim();
  return t === "" || t === "-" ? NaN : Number(t);
};
const strip = (h) => String(h).replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

// 日本時間の今月・先月
function months(nowMs) {
  const jst = new Date(nowMs + 9 * 3600 * 1000);
  const y = jst.getUTCFullYear(), m = jst.getUTCMonth() + 1;
  const p = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
  return { jstYear: y, jstMonth: m, list: [{ y: p.y, m: p.m }, { y, m }] };
}

// records: [{ date:"YYYY-MM-DD", days:number, buy:number, sell:number }]
// 付与日数が1日で、買い・売りとも数値がある行のうち、いちばん新しい日
function latestOneDay(records) {
  let found = null;
  for (const r of records) {
    if (r.days !== 1) continue;
    if (!isFinite(r.buy) || !isFinite(r.sell)) continue;   // 未確定（空欄・公表前）は除く
    if (!found || r.date >= found.date) found = r;
  }
  return found;
}
// unit: 会社が公表している単位（何通貨あたりか）。1万通貨あたりに換算する
function toResult(pair, found, unit) {
  const side = found.buy >= found.sell ? "buy" : "sell";      // プラス（大きい）方
  const best = Math.max(found.buy, found.sell);
  const swapPer10k = Math.round(best * (10000 / unit) * 100) / 100;
  return { pair, side, swapPer10k, buy: found.buy, sell: found.sell, date: found.date, unit };
}
const get = async (fetchImpl, url, headers) => {
  const res = await fetchImpl(url, { headers: { "User-Agent": UA, "Accept-Language": "ja", ...headers } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
};

// ============ 外為どっとコム（月別CSV・Shift-JIS） ============
const GAITAME = {
  names: {
    "TRY/JPY": "トルコ/円", "MXN/JPY": "メキシコペソ/円", "ZAR/JPY": "南アランド/円", "HUF/JPY": "ハンガリー/円",
    "PLN/JPY": "ポーランドズロチ/円", "CHF/MXN": "スイス/メキシコペソ", "CHF/TRY": "スイス/トルコリラ", "CHF/ZAR": "スイス/南アランド",
  },
  // ページの注記:「10Lot（1万通貨、RUB/JPY・HUF/JPYは10万通貨）あたりの金額」
  unit: { "HUF/JPY": 100000, "RUB/JPY": 100000 },
};
// 引用符・引用符内の改行に対応した簡易CSVパーサ
function parseCsv(text) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { row.push(f); f = ""; }
    else if (ch === "\n") { row.push(f); rows.push(row); row = []; f = ""; }
    else if (ch === "\r") { /* 無視 */ }
    else f += ch;
  }
  if (f !== "" || row.length) { row.push(f); rows.push(row); }
  return rows;
}
function readGaitameMonth(text, ym) {
  const rows = parseCsv(text), cols = {};
  (rows[0] || []).forEach((h, j) => { const n = h.trim(); if (n) cols[n] = j; });
  const y = Number(ym.slice(0, 4)), out = [];
  for (let i = 2; i < rows.length; i++) {
    const r = rows[i], m = (r[0] || "").match(/^(\d{1,2})\/(\d{1,2})/);
    if (m) out.push({ date: `${y}-${pad(m[1])}-${pad(m[2])}`, r });
  }
  return { cols, rows: out };
}
async function fetchGaitame(pairs, fetchImpl, nowMs) {
  const ms = [];
  for (const { y, m } of months(nowMs).list) {
    const ym = `${y}${pad(m)}`;
    try {
      const res = await get(fetchImpl, `https://www.gaitame.com/products/nextneo/csv/${ym}.csv?_=${nowMs}`, {
        "Referer": "https://www.gaitame.com/service/fx/swap-cal.html", "Accept": "text/plain, */*; q=0.01" });
      ms.push({ ym, ...readGaitameMonth(new TextDecoder("shift_jis").decode(await res.arrayBuffer()), ym) });
    } catch (e) { ms.push({ ym, error: String(e && e.message || e) }); }
  }
  if (ms.every((m) => m.error)) throw new Error("CSVを取得できませんでした: " + ms.map((m) => `${m.ym}: ${m.error}`).join(" / "));
  const results = [], skipped = [];
  for (const pair of pairs) {
    const name = GAITAME.names[pair];
    if (!name) { skipped.push({ pair, reason: "外為どっとコムでは取り扱いなし（対応表にありません）" }); continue; }
    const recs = [];
    for (const m of ms) {
      if (m.error) continue;
      const j = m.cols[name]; if (j == null) continue;
      for (const row of m.rows) {
        recs.push({ date: row.date, days: Number(row.r[j]), buy: num(row.r[j + 1]), sell: num(row.r[j + 2]) });
      }
    }
    const found = latestOneDay(recs);
    if (!found) { skipped.push({ pair, reason: "付与日数1日のデータが見つかりません" }); continue; }
    results.push(toResult(pair, found, GAITAME.unit[pair] || 10000));
  }
  return { broker: "外為どっとコム", results, skipped };
}

// ============ GMOクリック証券（通貨ペア×月ごとのHTML表） ============
const GMO = {
  codes: { "TRY/JPY": "TRYJPY", "MXN/JPY": "MXNJPY", "ZAR/JPY": "ZARJPY", "HUF/JPY": "HUFJPY", "PLN/JPY": "PLNJPY" },
  // ページの注記:「1万通貨単位（ハンガリーフォリント/円・南アフリカランド/円・メキシコペソ/円は10万通貨単位）」
  unit: { "HUF/JPY": 100000, "ZAR/JPY": 100000, "MXN/JPY": 100000 },
};
// 表の列: 取引日 / 売Swap / 買Swap / 付与日数
function parseGmoHtml(html, year) {
  const t = html.match(/<table[^>]*m-swplog-table__matrix[^>]*>([\s\S]*?)<\/table>/);
  if (!t) return [];
  const out = [];
  for (const tr of t[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const tds = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => strip(x[1]));
    if (tds.length < 4) continue;
    const d = tds[0].match(/(\d{1,2})月(\d{1,2})日/);
    if (!d) continue;
    out.push({ date: `${year}-${pad(d[1])}-${pad(d[2])}`, sell: num(tds[1]), buy: num(tds[2]), days: Number(tds[3]) });
  }
  return out;
}
async function fetchGmo(pairs, fetchImpl, nowMs) {
  const results = [], skipped = [];
  const mm = months(nowMs).list;
  const jobs = pairs.map(async (pair) => {
    const code = GMO.codes[pair];
    if (!code) { skipped.push({ pair, reason: "GMOクリック証券では取り扱いなし" }); return null; }
    const recs = []; let ok = 0, err = "";
    for (const { y, m } of mm) {
      try {
        const res = await get(fetchImpl, `https://www.click-sec.com/corp/guide/fxneo/swplog/?year=${y}&month=${pad(m)}&pare=${code}`, { "Accept": "text/html" });
        recs.push(...parseGmoHtml(await res.text(), y)); ok++;
      } catch (e) { err = String(e && e.message || e); }
    }
    return { pair, recs, ok, err };
  });
  const outs = (await Promise.all(jobs)).filter(Boolean);
  if (outs.length && outs.every((o) => !o.ok)) throw new Error("ページを取得できませんでした: " + outs[0].err);
  for (const o of outs) {
    const found = latestOneDay(o.recs);
    if (!found) { skipped.push({ pair: o.pair, reason: o.ok ? "付与日数1日のデータが見つかりません" : o.err }); continue; }
    results.push(toResult(o.pair, found, GMO.unit[o.pair] || 10000));
  }
  return { broker: "GMOクリック証券", results, skipped };
}

// ============ みんなのFX（1ページに全通貨ペアの表。通常版とLIGHT版は別の列） ============
// 公式FAQ:「HUF/JPY・HUF/JPY LIGHT・RUB/JPY は1.0Lot＝100,000通貨、上記以外は1.0Lot＝10,000通貨」
// 表は「1Lotあたり」の値。
function parseMinfxHtml(html, nowMs) {
  const { jstYear, jstMonth } = months(nowMs);
  const map = new Map();   // "CODE|light" -> records
  for (const tb of html.matchAll(/<table[^>]*table-swap[^>]*>([\s\S]*?)<\/table>/g)) {
    const trs = [...tb[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((x) => x[1]);
    if (trs.length < 4) continue;
    const ths = [...trs[0].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((x) => x[1]);
    if (ths.length < 3 || strip(ths[0]) !== "取引日" || strip(ths[1]) !== "") continue;   // 日別の表だけを対象にする
    const cols = ths.slice(2).map((h) => {
      const sp = h.match(/<span[^>]*>([\s\S]*?)<\/span>/); const txt = strip(sp ? sp[1] : h);
      return { code: txt.split(" ")[0], light: /LIGHT/.test(txt) };
    });
    const cells = (tr) => [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => strip(x[1]));
    for (let i = 1; i + 2 < trs.length; i += 3) {
      const c0 = cells(trs[i]), cb = cells(trs[i + 1]), cs = cells(trs[i + 2]);
      const d = (c0[0] || "").match(/(\d{1,2})\/(\d{1,2})/);
      if (!d || c0[1] !== "付与日数") continue;
      const mo = Number(d[1]);
      const year = mo - jstMonth > 6 ? jstYear - 1 : jstMonth - mo > 6 ? jstYear + 1 : jstYear;
      const date = `${year}-${pad(mo)}-${pad(d[2])}`;
      cols.forEach((c, k) => {
        const key = `${c.code}|${c.light}`;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push({ date, days: num(c0[2 + k]), buy: num(cb[1 + k]), sell: num(cs[1 + k]) });
      });
    }
  }
  return map;
}
async function fetchMinfx(pairs, fetchImpl, nowMs) {
  const res = await get(fetchImpl, "https://min-fx.jp/market/swap/", { "Accept": "text/html" });
  const map = parseMinfxHtml(await res.text(), nowMs);
  if (!map.size) throw new Error("スワップの表が見つかりません（ページの作りが変わった可能性があります）");
  const results = [], skipped = [];
  for (const pair of pairs) {
    const light = /\(LIGHT\)$/.test(pair), base = pair.replace(/\(LIGHT\)$/, ""), code = base.replace("/", "");
    const recs = map.get(`${code}|${light}`);
    if (!recs) { skipped.push({ pair, reason: "みんなのFXでは取り扱いなし" }); continue; }
    const found = latestOneDay(recs);
    if (!found) { skipped.push({ pair, reason: "付与日数1日のデータが見つかりません" }); continue; }
    results.push(toResult(pair, found, code === "HUFJPY" || code === "RUBJPY" ? 100000 : 10000));
  }
  return { broker: "みんなのFX", results, skipped };
}

// ============ トライオートFX（月別のJSONが2本：スワップ／付与日数）。「1万通貨あたり」 ============
const TRIAUTO_PAIRS = ["TRY/JPY", "MXN/JPY", "ZAR/JPY", "HUF/JPY", "PLN/JPY", "CHF/MXN", "CHF/TRY", "CHF/ZAR"];
async function fetchTriauto(pairs, fetchImpl, nowMs) {
  const hdr = { "Accept": "application/json, text/javascript, */*; q=0.01", "X-Requested-With": "XMLHttpRequest", "Referer": "https://www.invast.jp/triauto/swap-calendar/" };
  const ms = [];
  for (const { y, m } of months(nowMs).list) {
    try {
      const [a, b] = await Promise.all([
        get(fetchImpl, `https://www.invast.jp/triauto/service/summary/swap_csv/dailyswap.php?year=${y}&month=${m}&_=${nowMs}`, hdr),
        get(fetchImpl, `https://www.invast.jp/swappoint/adddays/adddays.php?year=${y}&month=${m}&_=${nowMs}`, hdr),
      ]);
      ms.push({ ym: `${y}${pad(m)}`, sw: JSON.parse(await a.text()), ad: JSON.parse(await b.text()) });
    } catch (e) { ms.push({ ym: `${y}${pad(m)}`, error: String(e && e.message || e) }); }
  }
  if (ms.every((m) => m.error)) throw new Error("データを取得できませんでした: " + ms.map((m) => `${m.ym}: ${m.error}`).join(" / "));
  const results = [], skipped = [];
  for (const pair of pairs) {
    if (!TRIAUTO_PAIRS.includes(pair)) { skipped.push({ pair, reason: "トライオートFXでは取り扱いなし" }); continue; }
    const key = pair.replace("/", ""), recs = [];
    for (const m of ms) {
      if (m.error) continue;
      for (const d of Object.keys(m.sw)) {
        const s = m.sw[d] && m.sw[d][key], a = m.ad[d] && m.ad[d][key];
        if (!s || !a) continue;
        // スワップの並びは [通貨ペア, 売り, 買い]（付与日数は [日付, 通貨ペア, 日数]）
        recs.push({ date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, sell: num(s[1]), buy: num(s[2]), days: Number(a[2]) });
      }
    }
    const found = latestOneDay(recs);
    if (!found) { skipped.push({ pair, reason: "付与日数1日のデータが見つかりません" }); continue; }
    results.push(toResult(pair, found, 10000));
  }
  return { broker: "トライオートFX", results, skipped };
}

// ============ セントラル短資（POSTするJSON API）。「10,000通貨あたり」 ============
async function fetchCentral(pairs, fetchImpl, nowMs) {
  const res = await fetchImpl("https://info.ctfx.jp/pub_api/swap_list/", {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/json; charset=utf-8", "Accept": "application/json, text/javascript, */*; q=0.01",
      "Origin": "https://www.central-tanshifx.com", "Referer": "https://www.central-tanshifx.com/" },
    body: JSON.stringify({ is_latest: "1", month: "" }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = JSON.parse(await res.text());
  const days = data && data.result;
  if (!Array.isArray(days)) throw new Error("想定外の形式です（APIの仕様が変わった可能性があります）");
  const results = [], skipped = [];
  for (const pair of pairs) {
    const recs = []; let offered = false;
    for (const day of days) {
      // 行: [通貨ペア, 番号, 買い, 売り, 付与日数, 受渡日]
      const row = (day.swap_list || []).find((r) => r[0] === pair);
      if (!row) continue;
      offered = true;
      recs.push({ date: String(day.date).replace(/\//g, "-"), buy: num(row[2]), sell: num(row[3]), days: Number(row[4]) });
    }
    if (!offered) { skipped.push({ pair, reason: "セントラル短資では取り扱いなし" }); continue; }
    const found = latestOneDay(recs);
    if (!found) { skipped.push({ pair, reason: "付与日数1日のデータが見つかりません" }); continue; }
    results.push(toResult(pair, found, 10000));
  }
  return { broker: "セントラル短資", results, skipped };
}

const FETCHERS = {
  "外為どっとコム": fetchGaitame,
  "GMOクリック証券": fetchGmo,
  "みんなのFX": fetchMinfx,
  "トライオートFX": fetchTriauto,
  "セントラル短資": fetchCentral,
};

// ---- アプリ（index.html）と同じ通貨ペアの一覧
const PAIRS = ["TRY/JPY","MXN/JPY","ZAR/JPY","HUF/JPY","PLN/JPY","CHF/MXN","CHF/TRY","CHF/ZAR"];
const LIGHT_PAIRS = { "みんなのFX": ["TRY/JPY","MXN/JPY","ZAR/JPY","HUF/JPY"] };
const pairsFor = (broker) => {
  const extra = new Set(LIGHT_PAIRS[broker] || []);
  const out = [];
  PAIRS.forEach((p) => { out.push(p); if (extra.has(p)) out.push(p + "(LIGHT)"); });
  return out;
};

const OUT = new URL("../swap.json", import.meta.url);
const out = { updatedAt: new Date().toISOString(), brokers: {} };
let okCount = 0;
for (const [broker, fetcher] of Object.entries(FETCHERS)) {
  try {
    const r = await fetcher(pairsFor(broker), fetch, Date.now());
    out.brokers[broker] = { results: r.results, skipped: r.skipped };
    okCount++;
    console.log(`${broker}: ${r.results.length}件（取得できなかったペア ${r.skipped.length}件）`);
  } catch (e) {
    out.brokers[broker] = { error: String((e && e.message) || e) };
    console.log(`${broker}: 失敗 ${out.brokers[broker].error}`);
  }
}

if (!okCount) {
  // 全社失敗したときは、前回の swap.json をそのまま残して異常終了（Actionsが赤くなり、メールで知らせが届く）
  console.error("すべての証券会社で取得に失敗しました。swap.json は更新しません。");
  process.exit(1);
}
await writeFile(OUT, JSON.stringify(out, null, 1) + "\n");
console.log("swap.json を書き出しました");
