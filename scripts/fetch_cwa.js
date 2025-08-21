// 以 CWA F-D0047-093 取得全台 368 鄉鎮一週預報（含現在/近時段）
// 產出根目錄 tw-forecast.min.json，供 Scriptable 依定位取最近鄉鎮
// 需要 repo secret: CWA_KEY

import fetch from "node-fetch";
import fs from "fs";

const KEY = process.env.CWA_KEY;
if (!KEY) {
  console.error("❌ Missing env CWA_KEY");
  process.exit(1);
}

const API =
  `https://opendata.cwa.gov.tw/api/v1/rest/datastore/F-D0047-093?Authorization=${KEY}&format=JSON`;

function parseNumber(x) {
  const n = Number(String(x).trim());
  return Number.isFinite(n) ? n : null;
}

function parseTime(s) {
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function getElemMap(weatherElement = []) {
  const map = {};
  for (const e of weatherElement) {
    const name = (e.elementName || "").trim();
    // 支援新舊兩種命名：短碼與全名
    const key = {
      "T": "Temperature",
      "AT": "ApparentTemperature",
      "PoP12h": "ProbabilityOfPrecipitation",
      "MaxT": "MaxTemperature",
      "MinT": "MinTemperature"
    }[name] || name;
    map[key] = e.time || [];
  }
  return map;
}

function nearestInstant(times, nowMs) {
  // 針對 dataTime（逐1/3小時）找最接近 now 的一筆
  let best = null, bestDiff = Infinity;
  for (const t of times) {
    const dt = parseTime(t.dataTime);
    if (dt == null) continue;
    const diff = Math.abs(dt - nowMs);
    if (diff < bestDiff) { bestDiff = diff; best = t; }
  }
  return best;
}

function valueFrom(t) {
  // t.elementValue 可能是 [{value:"30", measures:"..."}] 或是物件
  if (!t) return null;
  const ev = t.elementValue;
  if (Array.isArray(ev) && ev.length) {
    const v = ev[0]?.value;
    return v == null ? null : parseNumber(v);
  }
  if (ev && typeof ev === "object") {
    const v = ev.value ?? ev.parameter ?? null;
    return v == null ? null : parseNumber(v);
  }
  return null;
}

function dailySeries(times) {
  // 將 (含 startTime/endTime) 的 time[] 轉為「依日期」的第一筆值
  // 回傳 { "2025-08-18": 34, ... }
  const out = {};
  const sorted = [...(times || [])].sort((a, b) => {
    const as = parseTime(a.startTime) ?? parseTime(a.dataTime) ?? 0;
    const bs = parseTime(b.startTime) ?? parseTime(b.dataTime) ?? 0;
    return as - bs;
  });
  for (const t of sorted) {
    const s = t.startTime ?? t.dataTime ?? t.endTime;
    if (!s) continue;
    const d = new Date(parseTime(s));
    if (!isFinite(d)) continue;
    const key = d.toISOString().slice(0, 10);
    if (!(key in out)) {
      out[key] = valueFrom(t);
    } else {
      // 若當天已有值，取最大者（MaxT/PoP）或最小者（MinT）會在外面再合併
      // 這裡先保留第一筆即可
    }
  }
  return out;
}

function mergeDailyMaxMin(maxMap, minMap) {
  const dates = [...new Set([...Object.keys(maxMap), ...Object.keys(minMap)])]
    .sort();
  return dates.slice(0, 7).map(d => ({
    date: d,
    maxT: maxMap[d] ?? null,
    minT: minMap[d] ?? null
  }));
}

function mergeDailyWithPoP(days, popMap) {
  return days.map(d => ({
    ...d,
    // 12h PoP 只有前三天，取同日所有段落的「最大值」較符合體感
    pop: popMap[d.date] ?? null
  }));
}

function maxPerDay(times) {
  // 將 12h/3h PoP 轉為逐日最大值
  const acc = {};
  for (const t of times || []) {
    const s = t.startTime ?? t.dataTime ?? t.endTime;
    const ts = parseTime(s);
    if (ts == null) continue;
    const key = new Date(ts).toISOString().slice(0, 10);
    const v = valueFrom(t);
    if (v == null) continue;
    acc[key] = Math.max(acc[key] ?? 0, v);
  }
  return acc;
}

async function main() {
  const r = await fetch(API, { headers: { "Accept": "application/json" } });
  if (!r.ok) {
    throw new Error(`CWA HTTP ${r.status}`);
  }
  const j = await r.json();

  const locs = j?.records?.locations?.[0]?.location
            || j?.records?.location  // 保險：有些舊格式
            || [];

  const now = Date.now();
  const out = {
    generatedAt: new Date(now).toISOString(),
    source: "CWA F-D0047-093",
    note: "values in °C and %, now derived from nearest hourly/3-hourly slot",
    locations: []
  };

  for (const L of locs) {
    const town = L.locationName;
    const county = j?.records?.locations?.[0]?.locationsName || L?.parameter?.[0]?.parameterValue;
    const geocode = L.geocode || L.Geocode || null;
    const lat = parseNumber(L.latitude || L.Latitude);
    const lon = parseNumber(L.longitude || L.Longitude);

    const em = getElemMap(L.weatherElement || L.WeatherElement);

    // 近時段（現在）— 取最接近 now 的一筆
    const tNow = nearestInstant(em.Temperature || [], now);
    const atNow = nearestInstant(em.ApparentTemperature || [], now);

    // 降雨機率：3h/12h 以最近的區段或 dataTime 取值
    // 先嘗試 dataTime 最近，若沒有就取包含 now 的 start~end 區段
    const popTimes = em.ProbabilityOfPrecipitation || [];
    let popNow = null;
    if (popTimes.length) {
      // 最近 dataTime
      const byData = popTimes.filter(t => t.dataTime);
      const hit = byData.length ? nearestInstant(byData, now) : null;
      if (hit) popNow = valueFrom(hit);
      if (popNow == null) {
        // 找 now 落在 start~end 的
        for (const t of popTimes) {
          const s = parseTime(t.startTime), e = parseTime(t.endTime);
          if (s != null && e != null && s <= now && now < e) {
            popNow = valueFrom(t);
            break;
          }
        }
      }
    }

    // 七天：Max / Min / PoP (逐日最大)
    const maxMap = dailySeries(em.MaxTemperature || []);
    const minMap = dailySeries(em.MinTemperature || []);
    const days = mergeDailyMaxMin(maxMap, minMap);

    const popDayMax = maxPerDay(popTimes || []);
    const days2 = mergeDailyWithPoP(days, popDayMax);

    out.locations.push({
      geocode, county, town, lat, lon,
      now: {
        T: valueFrom(tNow),
        AT: valueFrom(atNow),
        PoP: popNow
      },
      days: days2
    });
  }

  // 壓縮一點（移除 null 尾端）
  fs.writeFileSync("tw-forecast.min.json", JSON.stringify(out));
  console.log("✅ tw-forecast.min.json generated:", out.locations.length, "locations");
}

main().catch(err => {
  console.error("❌ Build failed:", err);
  process.exit(1);
});
