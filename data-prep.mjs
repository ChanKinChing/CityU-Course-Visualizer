#!/usr/bin/env node
/**
 * Web-CityU-Course-Visualizer-1.0.0 - data-prep.mjs
 * 讀取 Tool-CityU-Course-Fetcher 輸出的 courses.json, 瘦身並產生 data.js
 *
 * 用法: node data-prep.mjs [courses.json 路徑] [data.js 輸出路徑]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = process.argv[2];
const OUT = process.argv[3] || path.join(__dirname, "data.js");

function findLatestSource() {
  const root = path.join(__dirname, "fetcher", "output");
  const dirs = fs.readdirSync(root).filter((d) => /^20\d{2}/.test(d)).sort().reverse();
  for (const d of dirs) {
    const p = path.join(root, d, "courses.json");
    if (fs.existsSync(p)) return p;
  }
  throw new Error("找不到 courses.json");
}

const src = SRC || findLatestSource();
const raw = JSON.parse(fs.readFileSync(src, "utf8"));
const { meta, courses } = raw;

// 時間 "9:00 am" -> 分鐘
function toMins(t) {
  t = String(t || "").trim();
  if (!t) return null;
  const m = t.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const ap = m[3].toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  return h * 60 + mm;
}
const DAYS = { M: 0, T: 1, W: 2, R: 3, F: 4, S: 5 }; // R=星期四

// "Yeung Kin Man Acad Building B7520" / "LT-18" / "TBA" -> {building, room}
function splitWhere(where) {
  const w = String(where || "").trim();
  if (!w || w === "TBA") return { room: "", building: "" };
  const i = w.lastIndexOf(" ");
  if (i <= 0) return { room: w, building: "" };
  return { room: w.slice(i + 1), building: w.slice(0, i) };
}

// 從 rawRestrictions 重新解析 (處理正向/負向限制, 如 "May not be assigned to one of the following Cohorts:")
function parseRest(raw) {
  const groups = [];
  let cur = null;
  for (const line of String(raw || "").split("\n").map((x) => x.trim()).filter(Boolean)) {
    const pos = line.match(/^Must be enrolled in one of the following ([^:]+):$/);
    const neg = line.match(/^May not be assigned to one of the following ([^:]+):$/);
    if (pos || neg) {
      cur = { type: pos ? pos[1] : neg[1], neg: !!neg, items: [] };
      groups.push(cur);
    } else if (cur && line) {
      cur.items.push(line);
    }
  }
  return groups;
}

const outCourses = [];
let totalSections = 0;
let tbaCount = 0;

for (const c of courses) {
  const sections = [];
  for (const s of c.sections) {
    // 合併重複 (day, start, end) 的 meetings, 收集 rooms/instructors
    const blocks = new Map(); // key = day|start|end
    for (const mt of s.meetings || []) {
      const start = toMins(mt.time.split(" - ")[0]);
      const end = toMins(mt.time.split(" - ")[1]);
      const day = DAYS[mt.days] !== undefined ? DAYS[mt.days] : null;
      if (start == null || end == null || day == null) continue;
      const key = `${day}|${start}|${end}`;
      if (!blocks.has(key)) blocks.set(key, { day, start, end, rooms: new Set(), buildings: new Set(), instructors: new Set() });
      const b = blocks.get(key);
      const loc = splitWhere(mt.where || (mt.building ? mt.building + " " + mt.room : mt.room));
      if (loc.room) b.rooms.add(loc.room);
      if (loc.building) b.buildings.add(loc.building);
      if (mt.instructors) b.instructors.add(mt.instructors);
    }
    const blocksArr = [...blocks.values()].map((b) => ({
      day: b.day, start: b.start, end: b.end,
      rooms: [...b.rooms].join(", ") || "",
      building: [...b.buildings].join(", ") || "",
      instructors: [...b.instructors].join(", ") || "",
    })).sort((a, b2) => a.day - b2.day || a.start - b2.start);

    if (blocksArr.length === 0) tbaCount++;

    sections.push({
      crn: s.crn,
      sec: s.section,
      seats: s.seats ? { c: s.seats.capacity, a: s.seats.actual, r: s.seats.remaining } : null,
      blk: blocksArr,
      tba: blocksArr.length === 0,
      rest: parseRest(s.rawRestrictions).length ? parseRest(s.rawRestrictions) : s.restrictions || [],
      mutex: s.mutualExclusion || [],
      reg: s.regDates || "",
      campus: s.campus || "",
      sched: s.scheduleType || "",
    });
    totalSections++;
  }
  outCourses.push({
    code: c.code,
    title: c.title,
    cr: c.credits ?? c.sections.map((x) => x.credits).find((x) => x != null) ?? null,
    lv: c.level,
    sections,
  });
}

const data = {
  meta: {
    tool: "Web-CityU-Course-Visualizer",
    version: "1.0.0",
    source: src,
    fetchedAt: meta.fetchedAt,
    term: meta.term,
    termLabel: meta.termLabel,
    dayNames: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    gridStart: 8 * 60,
    gridEnd: 23 * 60,
  },
  courses: outCourses,
  stats: { courses: outCourses.length, sections: totalSections, tba: tbaCount },
};

const js = `/* 自動產生 - 勿手改 (data-prep.mjs) */\nwindow.COURSE_DATA = ${JSON.stringify(data)};\n`;
const out = OUT;
fs.writeFileSync(out, js, "utf8");

const stats = data.stats;
const tbaSample = outCourses.flatMap((c) => c.sections.filter((s) => s.tba).map((s) => `${c.code} ${s.sec}`));
console.log(`來源: ${src}`);
console.log(`產生: ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
console.log(`統計: ${stats.courses} 課 / ${stats.sections} 班 / TBA ${stats.tba}`);
if (tbaSample.length) console.log(`TBA: ${tbaSample.join(", ")}`);
