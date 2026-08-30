#!/usr/bin/env node
/**
 * Tool-CityU-Course-Fetcher-1.0.0
 * CityU Banweb 公開課程資料爬蟲 (免登入)
 * - 來源: Banner "Dynamic Schedule" (bwckschd.*) 公開頁面
 * - 範圍: 指定 subject (預設 CS + GE), term 預設 202609 (Semester A 2026/27)
 * - 用 Playwright + 系統 Chrome, 通過 Incapsula WAF
 *
 * 用法:
 *   node fetch-courses.mjs                          # 預設 CS+GE, term 202609
 *   node fetch-courses.mjs --subjects CS,GE         # 指定 subject
 *   node fetch-courses.mjs --term 202609 --limit 5  # limit 只抓 N 個 detail (測試用)
 *   node fetch-courses.mjs --headed                 # 可見視窗
 *   node fetch-courses.mjs --delay 1500             # 每請求延遲(ms)
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = "https://banweb.cityu.edu.hk";
const OUT_ROOT = path.join(__dirname, "output");

// ---------- CLI / config ----------
const args = process.argv.slice(2);
function argVal(name, def) {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const TERM = argVal("term", process.env.CITYU_TERM || "202609");
const SUBJECTS_INPUT = argVal("subjects", "")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const DELAY_MIN = Number(argVal("delay", "1200"));
const DELAY_MAX = Math.round(DELAY_MIN * 1.7);
const LIMIT = Number(argVal("limit", "0"));
const HEADED = args.includes("--headed");
const BACHELOR_ONLY = !args.includes("--all-levels");
const MAX_RETRY = 3;

const dateFolder = new Date().toISOString().replace("T", "_").slice(0, 16).replace(":", "H");
const OUT_DIR = path.join(OUT_ROOT, `${dateFolder}-term${TERM}`);
fs.mkdirSync(OUT_DIR, { recursive: true });

const t0 = Date.now();
function log(msg) {
  const el = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`[${String(el).padStart(6)}s] ${msg}`);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function randDelay() {
  return DELAY_MIN + Math.floor(Math.random() * (DELAY_MAX - DELAY_MIN));
}
const toNum = (s) => {
  const n = String(s || "").replace(/,/g, "").trim();
  if (n === "" || n === "N/A" || n === "n/a") return null;
  if (/^FULL$/i.test(n)) return 0;
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
};

// ---------- page.evaluate 解析函式 (在瀏覽器內執行) ----------
function parseList() {
  const rows = Array.from(document.querySelectorAll("tr"));
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const th = rows[i].querySelector("th.ddtitle");
    if (!th) continue;
    const a = th.querySelector("a[href*='crn_in=']");
    if (!a) continue;
    const href = a.getAttribute("href") || "";
    const cm = href.match(/crn_in=(\d+)/);
    const crn = cm ? cm[1] : "";
    const titleText = (a.textContent || "").trim();
    const parts = titleText.split(" - ");
    const section = parts.length >= 1 ? parts[parts.length - 1].trim() : "";
    const code = parts.length >= 2 ? parts[parts.length - 2].trim() : "";
    const title = parts.length > 3 ? parts.slice(0, parts.length - 3).join(" - ").trim() : titleText;

    let td = null;
    for (let j = i + 1; j < rows.length; j++) {
      const c = rows[j].querySelector("td.dddefault");
      if (c) { td = c; break; }
    }
    if (!td) continue;

    const lines = (td.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean);
    const grab = (prefix) => {
      const l = lines.find((x) => x.startsWith(prefix));
      return l ? l.slice(prefix.length).trim() : "";
    };
    const associatedTerm = grab("Associated Term:");
    const regDates = grab("Registration Dates:");
    const levels = grab("Levels:");
    const campus = lines.find((x) => /Campus$/.test(x)) || "";
    const schedType = lines.find((x) => /Schedule Type$/.test(x)) || "";
    const creditLine = lines.find((x) => /^\d+(\.\d+)?\s+Credits?$/i.test(x)) || "";
    const credits = parseFloat(creditLine) || null;

    const catA = td.querySelector("a[href*='bwckctlg.p_display_courses']");
    const catalogHref = catA ? catA.getAttribute("href") : "";

    const mt = td.querySelector("table[summary*='scheduled meeting']");
    const meetings = [];
    if (mt) {
      const headRow = mt.querySelector("tr");
      const heads = headRow
        ? Array.from(headRow.querySelectorAll("th,td")).map((h) => (h.textContent || "").trim())
        : [];
      const dataRows = Array.from(mt.querySelectorAll("tbody tr")).filter((tr) => tr.querySelectorAll("td").length > 0);
      for (const tr of dataRows) {
        const tds = Array.from(tr.querySelectorAll("td")).map((td) => (td.textContent || "").trim());
        const cell = (h) => {
          const idx = heads.indexOf(h);
          return idx >= 0 ? tds[idx] ?? "" : "";
        };
        const where = cell("Where") || "";
        const wt = where.trim();
        const room = wt && wt !== "TBA" && wt.includes(" ") ? wt.slice(wt.lastIndexOf(" ") + 1) : "";
        const building = wt.includes(" ") ? wt.slice(0, wt.lastIndexOf(" ")) : "";
        meetings.push({
          type: cell("Type") || tds[0] || "",
          time: cell("Time") || "",
          days: cell("Days") || "",
          where,
          room,
          building,
          dateRange: cell("Date Range") || "",
          scheduleType: cell("Schedule Type") || "",
          instructors: cell("Instructors") || "",
        });
      }
    }
    out.push({ crn, code, section, title, levels, associatedTerm, regDates, campus, schedType, credits, catalogHref, meetings });
  }
  return out;
}

function parseDetail() {
  const toNum = (s) => {
    const n = String(s || "").replace(/,/g, "").trim();
    if (n === "" || n === "N/A" || n === "n/a") return null;
    if (/^FULL$/i.test(n)) return 0;
    const v = Number(n);
    return Number.isFinite(v) ? v : null;
  };
  const result = { seats: null, restrictions: [], rawRestrictions: "", mutualExclusion: [] };
  const td = document.querySelector("td.dddefault");
  if (!td) return result;
  const lines = (td.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean);

  const seatsTable = td.querySelector("table[summary*='seating numbers']");
  if (seatsTable) {
    for (const r of Array.from(seatsTable.querySelectorAll("tr"))) {
      const cells = Array.from(r.querySelectorAll("th,td")).map((c) => (c.textContent || "").trim()).filter(Boolean);
      if (cells[0] === "Seats" && cells.length >= 4) {
        const raw = [cells[1], cells[2], cells[3]];
        result.seats = {
          capacity: toNum(raw[0]),
          actual: toNum(raw[1]),
          remaining: toNum(raw[2]),
          raw: raw.join("/"),
        };
      }
    }
  }

  const reIdx = lines.findIndex((l) => l.startsWith("Restrictions:"));
  const meIdx = lines.findIndex((l) => l.startsWith("Mutual Exclusion:"));
  const endLine = meIdx >= 0 ? meIdx : lines.length;
  if (reIdx >= 0 && reIdx < endLine) {
    const block = lines.slice(reIdx + 1, endLine);
    result.rawRestrictions = block.join("\n");
    const groups = [];
    let cur = null;
    for (const l of block) {
      const posM = l.match(/^Must be enrolled in one of the following ([^:]+):$/);
      const negM = l.match(/^May not be assigned to one of the following ([^:]+):$/);
      if (posM || negM) { cur = { type: posM ? posM[1] : negM[1], items: [], neg: !!negM }; groups.push(cur); }
      else if (cur && l) cur.items.push(l);
    }
    result.restrictions = groups;
  }
  if (meIdx >= 0) {
    result.mutualExclusion = lines
      .slice(meIdx + 1)
      .filter((l) => /^[A-Z]{2,5}\s+\d/.test(l))
      .map((l) => l.trim());
  }
  return result;
}

// ---------- main ----------
let browser;
let failCount = 0;
try {
  log("Tool-CityU-Course-Fetcher v1.0.0");
  log(`term=${TERM} subjects=${SUBJECTS_INPUT.length ? SUBJECTS_INPUT.join(", ") : "(auto-discover ALL)"} ${BACHELOR_ONLY ? "僅本科" : "全部學制"} delay=${DELAY_MIN}-${DELAY_MAX}ms limit=${LIMIT || "all"}`);
  log(`output dir: ${OUT_DIR}`);

  browser = await chromium.launch({ channel: "chrome", headless: !HEADED });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  // --- step 1: 開 Dynamic Schedule 並提交 term ---
  log("[1/4] 初始化 session 並提交 term");
  await page.goto(`${BASE}/pls/PROD/bwckschd.p_disp_dyn_sched`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  await page.selectOption('select[name="p_term"]', TERM);
  await page.click('input[type="submit"]');
  await page.waitForLoadState("domcontentloaded");
  await page.waitForSelector('form[action*="bwckschd.p_get_crse_unsec"]', { timeout: 30000 });
  const subjectOptions = await page.locator('select[name="sel_subj"] option').evaluateAll((opts) =>
    opts.map((o) => o.value)
  );
  log(`  search form 就緒, subject 選項: ${subjectOptions.length} 個`);
  const SUBJECTS = SUBJECTS_INPUT.length > 0
    ? SUBJECTS_INPUT.filter(s => {
        if (!subjectOptions.includes(s)) log(`  !注意: subject "${s}" 不在選項內, 跳過`);
        return subjectOptions.includes(s);
      })
    : subjectOptions;
  log(`  將搜尋 ${SUBJECTS.length} 個 subjects`);

  // --- step 2: 各 subject 搜尋, 收集 sections ---
  log("[2/4] 搜尋 subjects, 收集 sections");
  const allSections = [];
  const seenCrn = new Set();
  for (const subj of SUBJECTS) {
    await page.selectOption('select[name="sel_subj"]', subj);
    await page.click('input[type="submit"]');
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(2000);
    const html = await page.content();
    if (html.includes("No Classes were found")) {
      log(`  ${subj}: 無課程`);
      await page.goBack().catch(() => {});
      await page.waitForTimeout(1500);
      continue;
    }
    const sections = await page.evaluate(parseList);
    let added = 0;
    for (const s of sections) {
      if (BACHELOR_ONLY && !String(s.levels || "").includes("Bachelor's Degree")) continue;
      if (!seenCrn.has(s.crn)) {
        seenCrn.add(s.crn);
        allSections.push(s);
        added++;
      }
    }
    log(`  ${subj}: ${sections.length} sections (新增本科 ${added})`);
    await page.goBack().catch(() => {});
    await page.waitForTimeout(2000);
  }
  log(`  合計 unique sections: ${allSections.length}`);

  // --- step 3: 逐 CRN 抓 detail (seats + restrictions) ---
  const crns = [...new Set(allSections.map((s) => s.crn))].slice(0, LIMIT || undefined);
  log(`[3/4] 抓取 ${crns.length} 個 section detail (seats/限制)`);
  const detailMap = new Map();
  let done = 0;
  for (const crn of crns) {
    let parsed = null;
    for (let attempt = 1; attempt <= MAX_RETRY && !parsed; attempt++) {
      try {
        await page.goto(`${BASE}/pls/PROD/bwckschd.p_disp_detail_sched?term_in=${TERM}&crn_in=${crn}`, {
          waitUntil: "domcontentloaded",
        });
        await page.waitForTimeout(1200);
        parsed = await page.evaluate(parseDetail);
        if (!parsed.seats && attempt < MAX_RETRY) {
          parsed = null;
          throw new Error("no seats parsed");
        }
      } catch (e) {
        if (attempt >= MAX_RETRY) {
          failCount++;
          log(`  !${crn} 抓取失敗(第${attempt}次): ${e.message.slice(0, 60)}`);
        } else {
          await sleep(2000 * attempt);
        }
      }
    }
    if (parsed) detailMap.set(crn, parsed);
    done++;
    if (done % 20 === 0 || done === crns.length) {
      const el = (Date.now() - t0) / 1000;
      const eta = (el / done) * (crns.length - done);
      log(`    ${done}/${crns.length} (${((el / done) * 1000).toFixed(0)}ms/筆, 剩約 ${(eta / 60).toFixed(1)}min)`);
    }
    await sleep(randDelay());
  }
  log(`  detail 完成, 成功 ${detailMap.size}/${crns.length}, 失敗 ${failCount}`);

  // --- step 4: 彙整 + 輸出 ---
  log("[4/4] 彙整並輸出");
  const courses = new Map();
  for (const sec of allSections) {
    if (!courses.has(sec.code)) {
      courses.set(sec.code, {
        code: sec.code,
        title: sec.title,
        credits: sec.credits,
        levels: new Set(),
        catalogHref: sec.catalogHref,
        sections: [],
      });
    }
    const c = courses.get(sec.code);
    if (sec.levels) c.levels.add(sec.levels);
    const d = detailMap.get(sec.crn) || { seats: null, restrictions: [], rawRestrictions: "", mutualExclusion: [] };
    c.sections.push({
      crn: sec.crn,
      section: sec.section,
      campus: sec.campus,
      scheduleType: sec.schedType,
      credits: sec.credits,
      level: sec.levels,
      associatedTerm: sec.associatedTerm,
      regDates: sec.regDates,
      seats: d.seats,
      restrictions: d.restrictions,
      rawRestrictions: d.rawRestrictions,
      mutualExclusion: d.mutualExclusion,
      meetings: sec.meetings,
    });
  }
  const courseArr = [...courses.values()].map((c) => ({
    code: c.code,
    title: c.title,
    credits: c.credits,
    level: [...c.levels].join(", "),
    sectionCount: c.sections.length,
    catalogHref: c.catalogHref,
    sections: c.sections,
  }));

  const meta = {
    tool: "Tool-CityU-Course-Fetcher",
    version: "1.0.0",
    fetchedAt: new Date().toISOString(),
    term: TERM,
    termLabel: "Semester A 2026/27",
    subjects: SUBJECTS,
    bachelorOnly: BACHELOR_ONLY,
    source: `${BASE}/pls/PROD/bwckschd.p_disp_dyn_sched`,
    note: "Avail/Cap 為擷取當下快照, 非即時數據; 請以 CityU AIMS 系統為準",
    courseCount: courseArr.length,
    sectionCount: courseArr.reduce((a, c) => a + c.sections.length, 0),
    seatDataComplete: courseArr.reduce((a, c) => a + c.sections.filter((s) => s.seats).length, 0),
  };

  const jsonPath = path.join(OUT_DIR, "courses.json");
  const metaPath = path.join(OUT_DIR, "meta.json");
  fs.writeFileSync(jsonPath, JSON.stringify({ meta, courses: courseArr }, null, 2));
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  log(`  courses.json 已寫入 (${courseArr.length} 課 / ${meta.sectionCount} sections)`);

  // CSV
  const BOM = "\uFEFF";
  const sectionsCsv = [["crn","code","title","section","campus","scheduleType","credits","level","capacity","actual","remaining","restrictions","mutualExclusion","meetings"]];
  for (const c of courseArr) {
    for (const s of c.sections) {
      const rest = s.restrictions.map((g) => `${g.type}:${g.items.join("|")}`).join(";");
      const meets = s.meetings
        .map((m) => [m.type, m.time, m.days, m.where, m.dateRange, m.scheduleType, m.instructors].join("\u2022"))
        .join(" || ");
      sectionsCsv.push([
        s.crn, c.code, c.title, s.section, s.campus, s.scheduleType, s.credits ?? "", s.level ?? "",
        s.seats?.capacity ?? "", s.seats?.actual ?? "", s.seats?.remaining ?? "",
        rest, s.mutualExclusion.join(";"), meets,
      ]);
    }
  }
  const coursesCsv = [["code","title","credits","level","sectionCount","catalogHref"]];
  for (const c of courseArr) {
    coursesCsv.push([c.code, c.title, c.credits ?? "", c.level, c.sectionCount, `${BASE}${c.catalogHref}`]);
  }
  const csvStr = (arr) =>
    arr.map((row) => row.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  fs.writeFileSync(path.join(OUT_DIR, "sections.csv"), BOM + csvStr(sectionsCsv));
  fs.writeFileSync(path.join(OUT_DIR, "courses.csv"), BOM + csvStr(coursesCsv));
  log("  sections.csv / courses.csv 已寫入");

  log("完成");
  log(`輸出位置: ${OUT_DIR}`);
  log(`摘要: ${courseArr.length} 課, ${meta.sectionCount} sections, ${meta.seatDataComplete} 筆有座位資料`);
} catch (err) {
  console.error("FETCH ERROR: " + err.message);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
}
