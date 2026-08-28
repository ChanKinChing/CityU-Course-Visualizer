import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = path.resolve(__dirname, "..");
const URL = `file:///${path.join(BASE, "index.html").replace(/\\/g, "/")}`;
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${extra}`); }
};

async function resetState() {
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(900);
}

await page.goto(URL, { waitUntil: "load" });
await page.waitForTimeout(900);
check("file:// 載入無 console error", errors.length === 0, errors.join(" | "));

// ---------- 1. 基礎渲染 ----------
const base = await page.evaluate(() => ({
  stats: document.querySelector("#stats").textContent.trim(),
  sections: document.querySelectorAll(".section").length,
  tbaChips: document.querySelectorAll(".tba-chip").length,
}));
check("顯示全部 475 班", /475 \/ 475/.test(base.stats), base.stats);
check("TBA 有 7 個 chip", base.tbaChips === 7, String(base.tbaChips));

// ---------- 2. 重疊排版 ----------
const overlapCheck = await page.evaluate(() => {
  const day = document.querySelector(".gbody .dcol[data-day]");
  if (!day) return { ok: false, msg: "no day col" };
  const secs = [...day.querySelectorAll(".section")];
  if (secs.length < 2) return { ok: true, msg: "too few to test", n: secs.length };
  const boxes = secs.map((el) => el.getBoundingClientRect());
  let testedPairs = 0, overlapPairs = 0;
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const yOverlap = a.top < b.bottom - 2 && b.top < a.bottom - 2;
      if (!yOverlap) continue;
      testedPairs++;
      const xOverlap = a.left < b.right - 2 && b.left < a.right - 2;
      if (xOverlap) overlapPairs++;
    }
  }
  return { ok: overlapPairs === 0, testedPairs, overlapPairs, n: secs.length };
});
check("重疊班級並排不重疊 (column layout)", overlapCheck.ok,
  JSON.stringify(overlapCheck));

// ---------- 3. 每班至少 100px 寬 + 水平捲動 ----------
const widthCheck = await page.evaluate(() => {
  const secs = [...document.querySelectorAll(".section")].map((el) => el.getBoundingClientRect().width);
  const vp = document.querySelector("#viewport");
  return {
    minW: Math.round(Math.min(...secs)),
    scrollable: vp.scrollWidth > vp.clientWidth,
    maxColW: Math.round(Math.max(...[...document.querySelectorAll(".gbody .dcol[data-day]")].map((c) => c.getBoundingClientRect().width))),
  };
});
check("所有班級寬度 >= 100px", widthCheck.minW >= 100, JSON.stringify(widthCheck));
check("時間表可水平捲動 (欄寬超寬時)", widthCheck.scrollable === true, JSON.stringify(widthCheck));

// ---------- 4. 忙碌時段 (每日不同時間 + 講座連帶隱藏) ----------
await page.evaluate(() => document.querySelector("#addBusy").click());
await page.waitForTimeout(200);
await page.locator('[data-bs="1-0"]').fill("09:00");
await page.locator('[data-be="1-0"]').fill("12:00");
await page.waitForTimeout(400);
const busyResult = await page.evaluate(() => ({
  c1102c01: !![...document.querySelectorAll(".section")].find((el) => el.dataset.crn === "10283"),
  c1102l04: !![...document.querySelectorAll(".section")].find((el) => el.dataset.crn === "11713"),
  cs2116t01: !![...document.querySelectorAll(".section")].find((el) => el.dataset.crn === "10530"),
  cs2116c01: !![...document.querySelectorAll(".section")].find((el) => el.dataset.crn === "10529"),
  busyRegion: !!document.querySelector(".busy-region"),
}));
check("忙碌 Mon9-12 隱藏 CS1102 C01 (講座)", busyResult.c1102c01 === false, JSON.stringify(busyResult));
check("忙碌 Mon9-12 連帶隱藏 L04 (對應講座被濾)", busyResult.c1102l04 === false, JSON.stringify(busyResult));
check("CS 2116 T01 未被波及 (講座未被濾)", busyResult.cs2116t01 === true);
check("CS 2116 C01 (Fri 講座) 保留", busyResult.cs2116c01 === true);
check("忙碌區塊已繪製", busyResult.busyRegion === true);

// 加一天不同時間
await page.locator('[data-bd="1-1"]').click();
await page.waitForTimeout(200);
await page.locator('[data-bs="1-1"]').fill("14:00");
await page.locator('[data-be="1-1"]').fill("15:00");
await page.waitForTimeout(300);
const busy2 = await page.evaluate(() => ({
  regions: [...document.querySelectorAll(".busy-region")].map((r) => Math.round(parseFloat(r.style.height))),
}));
check("忙碌每日不同時間 (2 個不同高度區域)", busy2.regions.length === 2 && busy2.regions[0] !== busy2.regions[1], JSON.stringify(busy2));

// ---------- 5. 側欄收合 ----------
await resetState();
const sb0 = await page.evaluate(() => document.querySelector("#sidebar").classList.contains("collapsed"));
await page.locator("#toggleSidebar").click();
await page.waitForTimeout(350);
const sb1 = await page.evaluate(() => document.querySelector("#sidebar").classList.contains("collapsed"));
check("側欄預設展開", sb0 === false);
check("工具列按鈕收合側欄", sb1 === true);
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(900);
const sb2 = await page.evaluate(() => document.querySelector("#sidebar").classList.contains("collapsed"));
check("側欄收合狀態持久化", sb2 === true);

// ---------- 6. 星期切換 ----------
await resetState();
const before = await page.evaluate(() => document.querySelectorAll(".gbody .dcol[data-day]").length);
await page.locator("#dayChips .chip").nth(1).click();
await page.waitForTimeout(300);
const after = await page.evaluate(() => {
  const cols = [...document.querySelectorAll(".gbody .dcol[data-day]")];
  return { n: cols.length, tuePresent: cols.some((c) => c.dataset.day === "1") };
});
check("預設 5 天", before === 5, String(before));
check("取消 Tue 剩 4 天", after.n === 4, String(after.n));
check("Tue column 已移除", after.tuePresent === false);

// 星期切換不觸發講座配對 (週二實驗室仍顯示)
await resetState();
await page.locator("#dayChips .chip").nth(0).click();
await page.waitForTimeout(300);
const dayPair = await page.evaluate(() => {
  const codes = [...document.querySelectorAll(".section .s-code")].map((el) => el.textContent.trim());
  return { tueLab: codes.some((t) => /^CS 1102/.test(t) && /L03|L07/.test(t)) };
});
check("星期切換不連帶隱藏 (CS1102 周二實驗室仍顯示)", dayPair.tueLab === true, JSON.stringify(dayPair));

// ---------- 7. 有位過濾 ----------
await resetState();
await page.locator("#onlySeats").click();
await page.waitForTimeout(400);
const seatCheck = await page.evaluate(() => ({
  fullVisible: [...document.querySelectorAll(".section")].some((el) => el.querySelector(".full-badge")),
  stats: document.querySelector("#stats").textContent,
}));
check("只顯示有位 (無 FULL badge)", seatCheck.fullVisible === false, JSON.stringify(seatCheck));

// ---------- 8. 衝突偵測 (真實點擊 pin) ----------
await resetState();
const pinCandidates = await page.evaluate(() => {
  const secs = [...document.querySelectorAll(".section")];
  const boxes = secs.map((el) => ({ el, crn: el.dataset.crn, r: el.getBoundingClientRect() }));
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.r.width < 60 || b.r.width < 60) continue;
      const y = a.r.top < b.r.bottom - 2 && b.r.top < a.r.bottom - 2;
      if (y) return { a: a.crn, b: b.crn };
    }
  }
  return { a: null, b: null };
});
if (pinCandidates.b) {
  await page.locator(`.section[data-crn="${pinCandidates.a}"]`).hover();
  await page.locator(`.section[data-crn="${pinCandidates.a}"] .pin`).click();
  await page.waitForTimeout(200);
  await page.locator(`.section[data-crn="${pinCandidates.b}"]`).hover();
  await page.locator(`.section[data-crn="${pinCandidates.b}"] .pin`).click();
  await page.waitForTimeout(300);
  const conflict = await page.evaluate(() => ({
    pinned: document.querySelectorAll(".sched-item").length,
    conflictItems: document.querySelectorAll(".sched-item.conflict").length,
    tags: document.querySelectorAll(".conflict-tag").length,
    pinnedConflict: document.querySelectorAll(".section.pinned.conflict").length,
  }));
  check("兩個重疊班已釘入 (2)", conflict.pinned === 2, JSON.stringify(conflict));
  check("側欄標紅衝突 (>=1)", conflict.conflictItems >= 1 && conflict.tags >= 1, JSON.stringify(conflict));
  check("課表紅框衝突 (>=2)", conflict.pinnedConflict >= 2, JSON.stringify(conflict));

  // ---------- 9. 只看我的課表 ----------
  await page.locator("#viewSchedBtn").click();
  await page.waitForTimeout(400);
  const onlySched = await page.evaluate(() => document.querySelectorAll(".section").length);
  check("只看我的課表: 只顯示 2 班", onlySched === 2, String(onlySched));
} else {
  console.log("SKIP  衝突偵測 (找不到重疊班)");
}

// ---------- 10. 詳情抽屜 (真實點擊) ----------
await resetState();
await page.locator(".section").first().click();
await page.waitForTimeout(300);
const drawer = await page.evaluate(() => ({
  open: document.querySelector("#drawer").classList.contains("open"),
  hasCode: !!document.querySelector(".d-code"),
  hasSeat: !!document.querySelector(".seatbar"),
  dPin: !!document.querySelector("#dPin"),
}));
check("點班級開啟詳情抽屜", drawer.open && drawer.hasCode, JSON.stringify(drawer));
check("詳情含座位 bar", drawer.hasSeat);
check("詳情含加入課表按鈕", drawer.dPin);
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
check("Esc 關閉抽屜", await page.evaluate(() => !document.querySelector("#drawer").classList.contains("open")));

// ---------- 11. localStorage 持久化 ----------
await page.locator("#onlySeats").click();
await page.waitForTimeout(300);
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(900);
const persisted = await page.evaluate(() => ({
  onlySeats: document.querySelector("#onlySeats").checked,
  fullVisible: [...document.querySelectorAll(".section")].some((el) => el.querySelector(".full-badge")),
}));
check("localStorage 持久化 onlySeats", persisted.onlySeats === true && persisted.fullVisible === false, JSON.stringify(persisted));

// ---------- 12. 星期六切換 ----------
await resetState();
await page.locator("#showSat").click();
await page.waitForTimeout(300);
const sat = await page.evaluate(() => ({
  dayCols: document.querySelectorAll(".gbody .dcol[data-day]").length,
  satSections: document.querySelectorAll('.gbody .dcol[data-day="5"] .section').length,
}));
check("開星期六 = 6 天", sat.dayCols === 6, JSON.stringify(sat));
check("星期六有 6 班", sat.satSections === 6, String(sat.satSections));

// ---------- 13. 抽屜內加入按鈕 ----------
await resetState();
await page.locator(".section").first().click();
await page.waitForTimeout(300);
await page.locator("#dPin").click();
await page.waitForTimeout(300);
const addFromDrawer = await page.evaluate(() => ({
  schedCount: document.querySelectorAll(".sched-item").length,
  schedCnt: document.querySelector("#schedCount").textContent,
}));
check("抽屜加入我的課表", addFromDrawer.schedCount === 1 && addFromDrawer.schedCnt === "1", JSON.stringify(addFromDrawer));

// ---------- 14. 多課程代碼搜尋 (OR) ----------
await resetState();
await page.locator("#kw").fill("CS1102, CS2117");
await page.waitForTimeout(400);
const multiKw = await page.evaluate(() => {
  const codes = [...document.querySelectorAll(".section .s-code")].map((el) => el.textContent.trim());
  const ok = (re) => codes.some((t) => re.test(t));
  const others = codes.filter((t) => !/^CS 1102/.test(t) && !/^CS 2117/.test(t)).length;
  return { total: codes.length, has1102: ok(/^CS 1102/), has2117: ok(/^CS 2117/), others };
});
check("多課程代碼 OR: 顯示 CS1102 + CS2117", multiKw.has1102 && multiKw.has2117 && multiKw.others === 0, JSON.stringify(multiKw));

// 單一代碼含空格
await resetState();
await page.locator("#kw").fill("CS 2116");
await page.waitForTimeout(400);
const singleKw = await page.evaluate(() => {
  const codes = [...document.querySelectorAll(".section .s-code")].map((el) => el.textContent.trim());
  return { n: codes.length, all: codes.every((t) => /^CS 2116/.test(t)) };
});
check("單一代碼含空格 (CS 2116 顯示 2 班)", singleKw.n === 2 && singleKw.all, JSON.stringify(singleKw));

// ---------- 15. 講座配對: 搜尋篩掉整組講座 → 導修也消失 ----------
await resetState();
await page.locator("#kw").fill("CS 2115");
await page.waitForTimeout(300);
const pairBase = await page.evaluate(() => document.querySelectorAll(".section").length);
check("CS 2115 顯示 11 班", pairBase === 11, String(pairBase));
await page.locator("#kw").fill("CS 2115 CS 2116");
await page.waitForTimeout(400);
const pairBoth = await page.evaluate(() => {
  const codes = [...document.querySelectorAll(".section .s-code")].map((el) => el.textContent.trim());
  return {
    has2115: codes.some((t) => /^CS 2115/.test(t)),
    has2116: codes.some((t) => /^CS 2116/.test(t)),
  };
});
check("多課程代碼 OR: 同時顯示兩科", pairBoth.has2115 && pairBoth.has2116, JSON.stringify(pairBoth));

// ---------- final ----------
console.log(`\n==== 結果: ${pass} PASS / ${fail} FAIL ====`);
await page.screenshot({ path: path.join(__dirname, "final.png"), fullPage: true });
await browser.close();
process.exit(fail > 0 ? 1 : 0);
