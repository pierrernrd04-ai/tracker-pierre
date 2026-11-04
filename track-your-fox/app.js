/* TRACK YOUR FOX — suivi nutritionnel par photo (PWA autonome) */
const SDK_URL = "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.137.0/+esm";
const MODEL = "claude-opus-5-5";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const R = Math.round;
const fmt = (n, d = 0) => (Number(n) || 0).toLocaleString("fr-FR", { maximumFractionDigits: d, minimumFractionDigits: d });
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad2 = n => String(n).padStart(2, "0");
const dayKey = d => { const x = new Date(d); return x.getFullYear() + "-" + pad2(x.getMonth() + 1) + "-" + pad2(x.getDate()); };
const keyDate = k => new Date(k + "T12:00:00");
const todayKey = () => dayKey(Date.now());
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const raf2 = fn => requestAnimationFrame(() => requestAnimationFrame(fn));
const FOX = '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M4 6 L20 22 L32 18 L44 22 L60 6 L57 34 Q52 52 32 60 Q12 52 7 34 Z" fill="var(--fox)"/><path d="M15 38 Q32 31 49 38 Q44 51 32 56 Q20 51 15 38Z" fill="var(--surface)"/><circle cx="23" cy="32" r="3" fill="var(--ink)"/><circle cx="41" cy="32" r="3" fill="var(--ink)"/><path d="M28.5 44 L35.5 44 L32 48Z" fill="var(--ink)"/></svg>';
const FORK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M7 3v8a2 2 0 0 0 2 2v8M11 3v8M7 7h4M17 3c-2 0-3 2-3 6s1 4 3 4v8"/></svg>';

/* ---------- références ---------- */
const MICRO = {
  vit: [["vA", "Vit. A", "µg", 800], ["vC", "Vit. C", "mg", 80], ["vD", "Vit. D", "µg", 5], ["vE", "Vit. E", "mg", 12], ["vK", "Vit. K", "µg", 75], ["vB6", "Vit. B6", "mg", 1.4], ["vB9", "Vit. B9", "µg", 200], ["vB12", "Vit. B12", "µg", 2.5]],
  min: [["ca", "Calcium", "mg", 800], ["fe", "Fer", "mg", 14], ["mg", "Magnésium", "mg", 375], ["k", "Potassium", "mg", 2000], ["zn", "Zinc", "mg", 10], ["na", "Sodium", "mg", 2000]]
};
const MICRO_KEYS = [...MICRO.vit, ...MICRO.min].map(m => m[0]);
const MACRO_KEYS = ["kcal", "protein", "carbs", "fat", "fiber", "sugar"];
const MEALTYPES = { "petit-dej": "Petit-déj", "dejeuner": "Déjeuner", "diner": "Dîner", "collation": "Collation" };
const MT_COLOR = { "petit-dej": "var(--c)", "dejeuner": "var(--fox)", "diner": "var(--f)", "collation": "var(--fi)" };
const TAB_ORDER = ["today", "scan", "history", "report", "profile"];
// Rythme attendu de la journée : part cumulée de l'énergie selon l'heure
const PACE = [[0, 0], [7, 0], [9.5, .25], [12, .25], [14, .6], [16, .6], [17, .7], [19, .7], [21.5, 1], [24, 1]];
const paceAt = h => { for (let i = 1; i < PACE.length; i++) { const [h1, v1] = PACE[i - 1], [h2, v2] = PACE[i]; if (h <= h2) return v1 + (v2 - v1) * (h - h1) / (h2 - h1); } return 1; };

/* ---------- état ---------- */
const st = {
  meals: [], realMeals: null, demo: false,
  profile: { name: "", sex: "m", age: 28, weight: 75, height: 178, act: 1.55, goal: "maintain" },
  settings: { apiKey: "", effort: "high", theme: "auto" },
  view: todayKey(), micro: "vit", histRange: "7", repRange: 7, tab: null,
  photo: null, mealType: null, analysis: null, stream: null
};

/* ---------- stockage : IndexedDB pour les repas, localStorage pour le reste ---------- */
const LS = k => "tyf." + k;
const lsGet = (k, d) => { try { const v = localStorage.getItem(LS(k)); return v == null ? d : JSON.parse(v); } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(LS(k), JSON.stringify(v)); } catch { } };
const idb = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      if (!("indexedDB" in window)) return rej(new Error("no idb"));
      const r = indexedDB.open("track-your-fox", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("meals", { keyPath: "id" });
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction("meals", mode), s = t.objectStore("meals"); const out = fn(s);
      t.oncomplete = () => res(out?.result ?? out); t.onerror = () => rej(t.error);
    });
  },
  all() { return this.tx("readonly", s => s.getAll()); },
  put(m) { return this.tx("readwrite", s => s.put(m)); },
  del(id) { return this.tx("readwrite", s => s.delete(id)); },
  clear() { return this.tx("readwrite", s => s.clear()); }
};
let useIdb = false;
async function loadData() {
  st.profile = { ...st.profile, ...lsGet("profile", {}) };
  st.settings = { ...st.settings, ...lsGet("settings", {}) };
  try { await idb.open(); useIdb = true; st.meals = await idb.all(); }
  catch { st.meals = lsGet("meals", []); }
  try { navigator.storage?.persist?.(); } catch { }
}
async function persistMeal(m) { if (useIdb) await idb.put(m); else lsSet("meals", st.meals); }
async function saveMeal(m) {
  if (st.demo) exitDemo();
  const i = st.meals.findIndex(x => x.id === m.id);
  if (i >= 0) st.meals[i] = m; else st.meals.push(m);
  try { await persistMeal(m); } catch (e) { toast("Enregistrement impossible : stockage plein ?"); }
  renderAll();
}
async function deleteMeal(id) {
  st.meals = st.meals.filter(m => m.id !== id); renderAll();
  if (st.demo) return;
  try { if (useIdb) await idb.del(id); else lsSet("meals", st.meals); } catch { }
}
const saveProfile = () => lsSet("profile", st.profile);
const saveSettings = () => lsSet("settings", st.settings);

/* ---------- cibles ---------- */
function targets(p = st.profile) {
  const bmr = 10 * p.weight + 6.25 * p.height - 5 * p.age + (p.sex === "f" ? -161 : 5);
  let tdee = bmr * Number(p.act);
  if (p.goal === "cut") tdee -= 400; if (p.goal === "bulk") tdee += 250;
  const kcal = Math.max(1200, R(tdee / 10) * 10);
  const protein = R(p.weight * (p.goal === "cut" ? 2.0 : 1.6));
  const fat = R(kcal * 0.30 / 9);
  const carbs = Math.max(0, R((kcal - protein * 4 - fat * 9) / 4));
  const fiber = Math.max(25, R(kcal / 1000 * 14));
  return { kcal, protein, carbs, fat, fiber, bmr: R(bmr) };
}

/* ---------- agrégats ---------- */
function sumMeals(list) {
  const t = {}; [...MACRO_KEYS, ...MICRO_KEYS].forEach(k => t[k] = 0);
  list.forEach(m => { MACRO_KEYS.forEach(k => t[k] += Number(m.totals?.[k]) || 0); MICRO_KEYS.forEach(k => t[k] += Number(m.micro?.[k]) || 0); });
  return t;
}
function totalsFromItems(items) {
  const totals = {}, micro = {}; MACRO_KEYS.forEach(k => totals[k] = 0); MICRO_KEYS.forEach(k => micro[k] = 0);
  items.forEach(it => { MACRO_KEYS.forEach(k => totals[k] += Number(it[k]) || 0); MICRO_KEYS.forEach(k => micro[k] += Number(it.micro?.[k]) || 0); });
  return { totals, micro };
}
const mealsOn = key => st.meals.filter(m => dayKey(m.at) === key).sort((a, b) => a.at - b.at);
function byDay() { const map = {}; st.meals.forEach(m => (map[dayKey(m.at)] ||= []).push(m)); return map; }
function streak() {
  const days = new Set(st.meals.map(m => dayKey(m.at))); let n = 0; const d = new Date();
  if (!days.has(dayKey(d))) d.setDate(d.getDate() - 1);
  while (days.has(dayKey(d))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

/* ---------- animations ---------- */
function countUp(el, to, { dur = 1100, dec = 0, suffix = "" } = {}) {
  if (!el) return;
  const from = Number(el.dataset.v || 0); el.dataset.v = to;
  if (reduce || from === to) { el.textContent = fmt(to, dec) + suffix; return; }
  const t0 = performance.now();
  const step = t => { const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 4); el.textContent = fmt(from + (to - from) * e, dec) + suffix; if (p < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("on"); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("on"), 3000); }
function confetti() {
  if (reduce) return;
  const c = $("#confetti"), x = c.getContext("2d"), dpr = Math.min(2, devicePixelRatio || 1);
  c.width = innerWidth * dpr; c.height = innerHeight * dpr; x.scale(dpr, dpr);
  const cs = getComputedStyle(document.documentElement); const cols = ["--fox", "--fox-2", "--p", "--c", "--f", "--fi"].map(v => cs.getPropertyValue(v).trim());
  const ps = Array.from({ length: 140 }, () => ({ x: innerWidth / 2, y: innerHeight * .5, vx: (Math.random() - .5) * 16, vy: -Math.random() * 16 - 5, r: Math.random() * 7 + 3, c: cols[Math.random() * cols.length | 0], a: Math.random() * 6, s: (Math.random() - .5) * .35 }));
  let f = 0; (function loop() { x.clearRect(0, 0, innerWidth, innerHeight); ps.forEach(p => { p.vy += .42; p.vx *= .99; p.x += p.vx; p.y += p.vy; p.a += p.s; x.save(); x.translate(p.x, p.y); x.rotate(p.a); x.fillStyle = p.c; x.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2); x.restore(); }); if (++f < 130) requestAnimationFrame(loop); else x.clearRect(0, 0, innerWidth, innerHeight); })();
}
function success() { const s = $("#success"); s.hidden = false; const d = s.firstElementChild; d.style.animation = "none"; d.offsetWidth; d.style.animation = ""; setTimeout(() => s.hidden = true, 1300); }
document.addEventListener("pointerdown", e => {
  const b = e.target.closest(".btn"); if (!b || reduce) return;
  const r = b.getBoundingClientRect(), s = Math.max(r.width, r.height), sp = document.createElement("span");
  sp.className = "ripple"; sp.style.cssText = `width:${s}px;height:${s}px;left:${e.clientX - r.left - s / 2}px;top:${e.clientY - r.top - s / 2}px`;
  b.appendChild(sp); setTimeout(() => sp.remove(), 650);
});

/* ---------- splash ---------- */
function splash() {
  const sp = $("#splash"), w = $("#splashWord");
  if (reduce || sessionStorage.getItem("tyf.splash")) { sp.remove(); return; }
  try { sessionStorage.setItem("tyf.splash", "1"); } catch { }
  w.innerHTML = [..."TRACK YOUR FOX"].map((c, i) => `<span class="${i > 10 ? "o" : ""}" style="animation-delay:${.55 + i * .04}s">${c === " " ? "&nbsp;" : c}</span>`).join("");
  setTimeout(() => { sp.classList.add("out"); setTimeout(() => sp.remove(), 650); }, 1650);
}

/* ---------- horloge ---------- */
let lastClock = "";
function clock() {
  const d = new Date(), hm = pad2(d.getHours()) + pad2(d.getMinutes()), sec = pad2(d.getSeconds());
  const t = $("#clkT");
  if (!t.children.length) t.innerHTML = '<span class="dg"><i></i></span><span class="dg"><i></i></span><span class="colon">:</span><span class="dg"><i></i></span><span class="dg"><i></i></span><span class="sec"></span>';
  const dgs = t.querySelectorAll(".dg");
  [...hm].forEach((ch, i) => { if (lastClock[i] !== ch) { const g = dgs[i]; g.firstChild.textContent = ch; g.classList.remove("tick"); void g.offsetWidth; g.classList.add("tick"); } });
  t.querySelector(".sec").textContent = sec;
  $("#clkD").textContent = d.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });
  if (lastClock && lastClock.slice(0, 4) !== hm) onMinute(lastClock.slice(0, 4), hm);
  lastClock = hm;
}
function onMinute(prev, now) {
  if (now === "0000") { st.view = todayKey(); renderAll(); return; }
  if (st.tab === "today" && st.view === todayKey()) { renderTimeline(); renderPaceMark(); }
  if (st.tab === "scan" && !$("#mealTime").dataset.touched) setScanNow();
}

/* ---------- onglets ---------- */
function go(tab, push = true) {
  if (!$("#v-" + tab)) tab = "today";
  const prev = st.tab; st.tab = tab;
  const dir = prev && TAB_ORDER.indexOf(tab) < TAB_ORDER.indexOf(prev) ? "from-left" : "from-right";
  $$(".view").forEach(v => { v.classList.remove("on", "from-left", "from-right"); });
  const v = $("#v-" + tab); v.classList.add("on"); if (prev && prev !== tab) v.classList.add(dir);
  $$("[data-tab]").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === tab ? "true" : "false"));
  movePill();
  if (push && location.hash.slice(1) !== tab) history.replaceState(null, "", "#" + tab);
  renderTab();
  window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
}
function movePill() { const b = $("nav.tabs button[aria-selected='true']"), p = $("#pill"); if (!b || !b.offsetWidth) return; p.style.left = b.offsetLeft + "px"; p.style.width = b.offsetWidth + "px"; }
$$("[data-tab]").forEach(b => b.addEventListener("click", () => go(b.dataset.tab)));
document.addEventListener("click", e => { const g = e.target.closest("[data-go]"); if (g) go(g.dataset.go); const d = e.target.closest("[data-demo]"); if (d) enterDemo(); });
addEventListener("resize", movePill);
addEventListener("hashchange", () => { const h = location.hash.slice(1); if (h && h !== st.tab) go(h, false); });

function renderAll() {
  $("#streakChip").innerHTML = `<span class="flame">🔥</span> ${streak()} j de suite`;
  $("#demoChip").hidden = !st.demo;
  renderTab();
}
function renderTab() { ({ today: renderToday, history: renderHistory, report: renderReport, profile: renderProfile, scan: renderScan })[st.tab]?.(); }

/* ---------- JOURNÉE ---------- */
function renderToday() {
  const T = targets(), isToday = st.view === todayKey(), list = mealsOn(st.view), s = sumMeals(list), vd = keyDate(st.view);
  const now = new Date(), h = now.getHours();
  $("#dayLabel").textContent = vd.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" }) + (st.demo ? " · exemple" : "");
  const nm = st.profile.name ? esc(st.profile.name) : "renard";
  $("#greet").innerHTML = isToday ? `${h < 5 ? "Bonne nuit" : h < 12 ? "Bonjour" : h < 18 ? "Bon après-midi" : "Bonsoir"}, <em>${nm}</em>.`
    : `${vd.toLocaleDateString("fr-FR", { weekday: "long" }).replace(/^./, c => c.toUpperCase())} <em>${vd.getDate()} ${vd.toLocaleDateString("fr-FR", { month: "long" })}</em>.`;
  $("#backToday").hidden = isToday;
  $("#mealsTitle").textContent = isToday ? "Repas du jour" : "Repas de la journée";
  renderWeek();

  countUp($("#kcalNow"), R(s.kcal)); $("#kcalGoal").textContent = fmt(T.kcal);
  const left = T.kcal - s.kcal; countUp($("#kcalLeft"), R(Math.abs(left)));
  $("#kcalLeftL").textContent = left >= 0 ? "kcal restantes" : "kcal au-dessus";
  countUp($("#mealCount"), list.length);
  const sc = list.filter(m => m.score != null);
  $("#qScore").textContent = sc.length ? R(sc.reduce((a, m) => a + m.score, 0) / sc.length) + "/100" : "—";
  countUp($("#fiberNow"), R(s.fiber), { suffix: " g" });
  const ratio = s.kcal / T.kcal, C = 590.6;
  $("#ringArc").style.strokeDashoffset = C;
  raf2(() => { $("#ringArc").style.strokeDashoffset = C * (1 - Math.min(ratio, 1)); });
  $("#ringArc").setAttribute("stroke", ratio > 1.1 ? "var(--bad)" : "url(#rg)");
  const stt = ratio === 0 ? ["st-neutral", "Aucun repas"] : ratio < .9 ? ["st-warn", R(ratio * 100) + " % de l'objectif"] : ratio <= 1.1 ? ["st-good", "Dans la cible"] : ["st-bad", "+" + R((ratio - 1) * 100) + " % au-dessus"];
  $("#kcalState").innerHTML = `<span class="pill ${stt[0]}">${stt[1]}</span>`;
  renderPaceMark();

  const macros = [["Protéines", "protein", "--p"], ["Glucides", "carbs", "--c"], ["Lipides", "fat", "--f"], ["Fibres", "fiber", "--fi"]];
  const e = s.protein * 4 + s.carbs * 4 + s.fat * 9 || 1;
  $("#macroBars").innerHTML = macros.map(([n, k, c]) => `<div class="mrow"><div class="lab"><b><i style="background:var(${c})"></i>${n}</b><span class="num">${fmt(s[k])} / ${fmt(T[k])} g</span></div><div class="bar"><i data-w="${Math.min(100, s[k] / T[k] * 100)}" style="background:var(${c})"></i></div></div>`).join("")
    + `<div><div class="note" style="display:flex;justify-content:space-between"><span>Répartition de l'énergie</span><span class="num">P ${R(s.protein * 400 / e)} % · G ${R(s.carbs * 400 / e)} % · L ${R(s.fat * 900 / e)} %</span></div>
       <div class="split"><i style="flex-grow:0;background:var(--p)" data-g="${s.protein * 4}"></i><i style="flex-grow:0;background:var(--c)" data-g="${s.carbs * 4}"></i><i style="flex-grow:0;background:var(--f)" data-g="${s.fat * 9}"></i></div></div>`;
  raf2(() => { $$("#macroBars .bar>i").forEach(i => i.style.width = i.dataset.w + "%"); $$("#macroBars .split i").forEach(i => i.style.flexGrow = i.dataset.g || .0001); });
  renderTimeline();
  renderMicro(s);
  $("#dayMeals").innerHTML = list.length ? list.map((m, i) => mealRow(m, i)).join("") : emptyMeals(isToday);
  bindMealRows($("#dayMeals"));
}
function renderPaceMark() {
  const isToday = st.view === todayKey(), n = new Date();
  const f = isToday ? paceAt(n.getHours() + n.getMinutes() / 60) : 1;
  const g = $("#paceMark"); g.style.transform = `rotate(${f * 360}deg)`; g.style.opacity = isToday && f > 0 && f < 1 ? 1 : 0;
}
function renderWeek() {
  const vd = keyDate(st.view), mon = new Date(vd); mon.setDate(vd.getDate() - ((vd.getDay() + 6) % 7));
  const T = targets(), map = byDay(), tk = todayKey(), C = 2 * Math.PI * 14;
  let html = `<button class="nav" data-wk="-7" aria-label="Semaine précédente"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M15 6l-6 6 6 6"/></svg></button>`;
  for (let i = 0; i < 7; i++) {
    const d = new Date(mon); d.setDate(mon.getDate() + i); const k = dayKey(d);
    const kc = sumMeals(map[k] || []).kcal, r = Math.min(1, kc / T.kcal), dev = Math.abs(kc / T.kcal - 1);
    const col = !kc ? "var(--line)" : dev <= .1 ? "var(--good)" : dev <= .25 ? "var(--warn)" : kc < T.kcal ? "var(--fox)" : "var(--bad)";
    html += `<button class="wd${k === tk ? " today" : ""}${k > tk ? " future" : ""}" data-day="${k}" aria-pressed="${k === st.view}" aria-label="${d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" })}">
      <span class="l">${d.toLocaleDateString("fr-FR", { weekday: "short" }).slice(0, 3)}</span>
      <span class="mr"><svg viewBox="0 0 34 34"><circle class="t" cx="17" cy="17" r="14"/><circle class="a" cx="17" cy="17" r="14" stroke="${col}" stroke-dasharray="${C}" stroke-dashoffset="${C}" data-o="${C * (1 - r)}"/></svg><b>${d.getDate()}</b></span></button>`;
  }
  html += `<button class="nav" data-wk="7" aria-label="Semaine suivante"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg></button>`;
  $("#week").innerHTML = html;
  raf2(() => $$("#week .a").forEach(c => c.style.strokeDashoffset = c.dataset.o));
}
$("#week").addEventListener("click", e => {
  const d = e.target.closest("[data-day]"), w = e.target.closest("[data-wk]");
  if (d) { if (d.dataset.day > todayKey()) return; st.view = d.dataset.day; renderToday(); }
  if (w) { const x = keyDate(st.view); x.setDate(x.getDate() + Number(w.dataset.wk)); let k = dayKey(x); if (k > todayKey()) k = todayKey(); st.view = k; renderToday(); }
});
$("#backToday").addEventListener("click", () => { st.view = todayKey(); renderToday(); });

function renderTimeline() {
  const isToday = st.view === todayKey(), list = mealsOn(st.view), T = targets(), n = new Date();
  const hNow = n.getHours() + n.getMinutes() / 60, pct = isToday ? hNow / 24 * 100 : 100;
  let html = `<div class="track"><i></i></div>`;
  [0, 6, 12, 18, 24].forEach(h => html += `<span class="tk" style="left:${h / 24 * 100}%">${pad2(h % 24 === 0 && h ? 24 : h)}h</span>`);
  list.forEach((m, i) => { const d = new Date(m.at), x = (d.getHours() + d.getMinutes() / 60) / 24 * 100, sz = 14 + Math.min(18, m.totals.kcal / 50);
    html += `<span class="dot" data-id="${esc(m.id)}" title="${esc(m.dish)} · ${fmt(m.totals.kcal)} kcal" style="left:${x}%;width:${sz}px;height:${sz}px;background:${MT_COLOR[m.type] || "var(--fox)"};animation-delay:${.3 + i * .1}s"></span>`; });
  if (isToday) html += `<span class="now" style="left:0"><span>${pad2(n.getHours())}:${pad2(n.getMinutes())}</span></span>`;
  const tl = $("#timeline"); tl.innerHTML = html;
  raf2(() => { tl.querySelector(".track i").style.width = pct + "%"; const nw = tl.querySelector(".now"); if (nw) nw.style.left = pct + "%"; });
  tl.querySelectorAll(".dot").forEach(d => d.addEventListener("click", () => openMeal(d.dataset.id)));
  $("#dayPct").textContent = isToday ? `${R(pct)} % de la journée écoulée` : "journée terminée";
  // rythme
  const s = sumMeals(list), exp = R(T.kcal * (isToday ? paceAt(hNow) : 1)), diff = R(s.kcal - exp);
  const types = new Set(list.map(m => m.type));
  let next = "";
  if (isToday) {
    if (hNow < 10.5 && !types.has("petit-dej")) next = "Petit-déjeuner";
    else if (hNow < 14.5 && !types.has("dejeuner")) next = "Déjeuner";
    else if (hNow < 18 && !types.has("collation")) next = "Collation";
    else if (hNow < 22.5 && !types.has("diner")) next = "Dîner";
  }
  const leftP = Math.max(0, R(T.protein - s.protein));
  $("#pacing").innerHTML = `<span>${isToday ? `Rythme attendu à ${pad2(n.getHours())}:${pad2(n.getMinutes())}` : "Objectif"} : <b class="num">${fmt(exp)} kcal</b></span>
    <span class="pill ${!s.kcal ? "st-neutral" : Math.abs(diff) <= T.kcal * .08 ? "st-good" : diff < 0 ? "st-warn" : "st-bad"}">${diff >= 0 ? "+" : "−"}${fmt(Math.abs(diff))} kcal</span>
    ${next ? `<span>Prochain repas : <b>${next}</b></span>` : ""}
    ${leftP > 0 ? `<span>Protéines restantes : <b class="num">${leftP} g</b></span>` : `<span style="color:var(--good)"><b>Objectif protéines atteint ✓</b></span>`}`;
}
function renderMicro(s) {
  const C = 2 * Math.PI * 21;
  $("#microGrid").innerHTML = MICRO[st.micro].map(([k, n, u, ref], i) => {
    const v = s[k] || 0, p = v / ref, col = p >= .8 ? "var(--good)" : p >= .4 ? "var(--warn)" : "var(--bad)";
    return `<div class="mi" style="animation-delay:${i * .04}s"><div class="pct"><svg viewBox="0 0 54 54"><circle class="t" cx="27" cy="27" r="21"/><circle class="a" cx="27" cy="27" r="21" stroke="${col}" stroke-dasharray="${C}" stroke-dashoffset="${C}" data-o="${C * (1 - Math.min(p, 1))}"/></svg><em>${R(p * 100)}%</em></div><div class="n">${n}</div><div class="v">${fmt(v, v < 10 ? 1 : 0)} ${u}</div></div>`;
  }).join("");
  raf2(() => $$("#microGrid .a").forEach(c => c.style.strokeDashoffset = c.dataset.o));
}
$$("[data-micro]").forEach(b => b.addEventListener("click", () => { st.micro = b.dataset.micro; $$("[data-micro]").forEach(x => x.setAttribute("aria-pressed", x === b)); renderMicro(sumMeals(mealsOn(st.view))); }));

function mealRow(m, i = 0) {
  const t = new Date(m.at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  return `<button class="meal" data-id="${esc(m.id)}" style="animation-delay:${Math.min(i, 10) * .05}s"><span class="th">${m.thumb ? `<img src="${m.thumb}" alt="" loading="lazy">` : FORK}</span>
    <span style="min-width:0"><div class="nm">${esc(m.dish)}</div><div class="mt"><span>${MEALTYPES[m.type] || "Repas"} · ${t}</span><i style="color:var(--p)">P ${fmt(m.totals.protein)}</i><i style="color:var(--c)">G ${fmt(m.totals.carbs)}</i><i style="color:var(--f)">L ${fmt(m.totals.fat)}</i></div></span>
    <span class="kc num">${fmt(m.totals.kcal)}<small>kcal</small></span></button>`;
}
function emptyMeals(isToday = true) {
  return `<div class="empty"><svg class="fox" viewBox="0 0 64 64">${FOX.slice(FOX.indexOf(">") + 1, -6)}</svg><b>${isToday ? "Aucun repas noté aujourd'hui" : "Aucun repas ce jour-là"}</b><span>Prends ton repas en photo : le renard calcule tout.</span><div class="row" style="justify-content:center"><button class="btn primary" data-go="scan">Scanner un repas</button>${st.meals.length ? "" : '<button class="btn" data-demo>Voir un exemple</button>'}</div></div>`;
}
function bindMealRows(root) { root.querySelectorAll(".meal").forEach(b => b.addEventListener("click", () => openMeal(b.dataset.id))); }

/* ---------- fiche repas ---------- */
function openMeal(id) {
  const m = st.meals.find(x => x.id === id); if (!m) return;
  const d = new Date(m.at);
  $("#sheet").innerHTML = `<div class="grab"></div>${m.thumb ? `<img src="${m.thumb}" alt="">` : ""}
    <div class="result-head"><div style="min-width:0"><div class="eyebrow">${MEALTYPES[m.type] || "Repas"} · ${d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" })} · ${d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</div><h2>${esc(m.dish)}</h2>
      <div class="tags">${(m.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join("")}</div></div>
    <div class="kcal-big"><b class="num">${fmt(m.totals.kcal)}</b><span>kcal · ${fmt(m.kcal_low ?? m.totals.kcal - 50)}–${fmt(m.kcal_high ?? m.totals.kcal + 50)}</span></div></div>
    ${macro4(m.totals)}
    <div class="items-wrap"><table class="items"><thead><tr><th>Aliment</th><th>g</th><th>kcal</th><th>P</th><th>G</th><th>L</th><th>Fib.</th></tr></thead><tbody>
    ${m.items.map((it, i) => `<tr style="animation-delay:${i * .05}s"><td>${esc(it.name)}</td><td>${fmt(it.grams)}</td><td>${fmt(it.kcal)}</td><td>${fmt(it.protein, 1)}</td><td>${fmt(it.carbs, 1)}</td><td>${fmt(it.fat, 1)}</td><td>${fmt(it.fiber, 1)}</td></tr>`).join("")}</tbody></table></div>
    ${m.advice ? `<div class="advice">${FORK}<div>${esc(m.advice)}</div></div>` : ""}
    <div class="sep"></div>
    <div class="row" style="justify-content:space-between"><button class="btn danger sm" id="mDel">Supprimer</button><div class="row"><button class="btn sm" id="mAgain" title="Ajouter ce repas maintenant">Remanger maintenant</button><button class="btn primary sm" id="mClose">Fermer</button></div></div>
    <div id="mDelC" hidden style="margin-top:10px"><p class="note">Supprimer ce repas ?</p><div class="row"><button class="btn danger sm" id="mDelY">Supprimer</button><button class="btn ghost sm" id="mDelN">Annuler</button></div></div>`;
  $("#modal").hidden = false; document.body.style.overflow = "hidden";
  $("#mClose").onclick = closeModal;
  $("#mDel").onclick = () => $("#mDelC").hidden = false; $("#mDelN").onclick = () => $("#mDelC").hidden = true;
  $("#mDelY").onclick = () => { deleteMeal(id); closeModal(); toast("Repas supprimé"); };
  $("#mAgain").onclick = () => { const copy = { ...structuredClone(m), id: newId(), at: Date.now(), type: autoMealType() }; saveMeal(copy); closeModal(); success(); toast("Repas ajouté : " + fmt(copy.totals.kcal) + " kcal"); st.view = todayKey(); go("today"); };
}
function closeModal() { $("#modal").hidden = true; document.body.style.overflow = ""; }
$("#modal").addEventListener("click", e => { if (e.target.id === "modal") closeModal(); });
addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });
function macro4(t) {
  return `<div class="mac4"><div style="border-color:var(--p)"><b class="num">${fmt(t.protein)} g</b><span>Protéines</span></div><div style="border-color:var(--c)"><b class="num">${fmt(t.carbs)} g</b><span>Glucides</span></div><div style="border-color:var(--f)"><b class="num">${fmt(t.fat)} g</b><span>Lipides</span></div><div style="border-color:var(--fi)"><b class="num">${fmt(t.fiber)} g</b><span>Fibres</span></div></div>`;
}
const newId = () => "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/* ---------- SCANNER ---------- */
function autoMealType(h = new Date().getHours()) { return h < 11 ? "petit-dej" : h < 15 ? "dejeuner" : h < 18 ? "collation" : "diner"; }
function setMealType(t) { st.mealType = t; $$("#mealType button").forEach(b => b.setAttribute("aria-pressed", b.dataset.mt === t)); }
$$("#mealType button").forEach(b => b.addEventListener("click", () => setMealType(b.dataset.mt)));
function setScanNow() { const n = new Date(); $("#mealDate").value = dayKey(n); $("#mealTime").value = pad2(n.getHours()) + ":" + pad2(n.getMinutes()); $("#mealDate").max = dayKey(n); }
$("#mealTime").addEventListener("input", e => { e.target.dataset.touched = "1"; const h = Number(e.target.value.split(":")[0]); if (!isNaN(h)) setMealType(autoMealType(h)); });
$("#mealDate").addEventListener("input", e => { $("#mealTime").dataset.touched = "1"; });
function scanAt() { const d = $("#mealDate").value || todayKey(), t = $("#mealTime").value || "12:00"; const at = new Date(d + "T" + t + ":00").getTime(); return isNaN(at) ? Date.now() : Math.min(at, Date.now()); }
const hasKey = () => !!st.settings.apiKey;
function renderScan() {
  $("#keyCard").hidden = hasKey();
  if (!$("#mealTime").dataset.touched) setScanNow();
  updateAnalyzeBtn();
}
function updateAnalyzeBtn() { $("#analyzeBtn").disabled = !(st.photo && hasKey()) || !!st.stream; $("#textOnlyBtn").disabled = !hasKey() || !!st.stream; }

async function loadImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image(); img.src = url; await img.decode();
    const draw = (max, q) => { const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight)); const c = document.createElement("canvas"); c.width = R(img.naturalWidth * s); c.height = R(img.naturalHeight * s); c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); return c.toDataURL("image/jpeg", q); };
    const big = draw(1568, .86), thumb = draw(360, .72);
    return { b64: big.split(",")[1], preview: big, thumb, ratio: img.naturalWidth / img.naturalHeight };
  } finally { URL.revokeObjectURL(url); }
}
async function onFile(file) {
  if (!file || !file.type.startsWith("image/")) { toast("Choisis une image (JPEG, PNG, HEIC, WebP)."); return; }
  try { st.photo = await loadImage(file); } catch { toast("Impossible de lire cette image."); return; }
  const drop = $("#drop"), s = $("#shot");
  drop.style.aspectRatio = Math.max(.75, Math.min(1.6, st.photo.ratio));
  s.src = st.photo.preview; s.hidden = false; $("#dropPh").hidden = true; $("#clearShot").hidden = false; drop.classList.add("has"); $("#labels").innerHTML = "";
  s.animate?.([{ opacity: 0, transform: "scale(1.08)", filter: "blur(8px)" }, { opacity: 1, transform: "none", filter: "none" }], { duration: 600, easing: "cubic-bezier(.2,.8,.2,1)" });
  st.analysis = null; $("#result").hidden = true; $("#resultEmpty").hidden = false;
  updateAnalyzeBtn();
  if (hasKey()) analyze(true); else { toast("Ajoute ta clé API dans Profil pour lancer l'analyse."); }
}
function clearPhoto() { st.photo = null; const d = $("#drop"); d.classList.remove("has"); d.style.aspectRatio = ""; $("#shot").hidden = true; $("#dropPh").hidden = false; $("#clearShot").hidden = true; $("#labels").innerHTML = ""; updateAnalyzeBtn(); }
$("#clearShot").addEventListener("click", clearPhoto);
$("#camInput").addEventListener("change", e => { onFile(e.target.files[0]); e.target.value = ""; });
$("#galInput").addEventListener("change", e => { onFile(e.target.files[0]); e.target.value = ""; });
const drop = $("#drop");
drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", e => { e.preventDefault(); drop.classList.remove("over"); onFile(e.dataTransfer.files[0]); });
document.addEventListener("paste", e => { const f = [...(e.clipboardData?.files || [])].find(f => f.type.startsWith("image/")); if (f && st.tab === "scan") onFile(f); });

/* --- Claude --- */
let sdkPromise = null;
const loadSDK = () => (sdkPromise ||= import(SDK_URL).then(m => m.default).catch(e => { sdkPromise = null; throw e; }));
async function client() { const Anthropic = await loadSDK(); return { Anthropic, c: new Anthropic({ apiKey: st.settings.apiKey, dangerouslyAllowBrowser: true, maxRetries: 1 }) }; }
/* Appel en streaming avec repli serveur en cas de refus ; si le compte n'accepte pas le paramètre de repli, on relance sans. */
async function callClaude(c, A, params, onText, track = true) {
  const run = async withFallback => {
    const stream = c.beta.messages.stream(withFallback ? { ...params, betas: [FALLBACK_BETA], fallbacks: "default" } : params);
    if (track) { st.stream = stream; updateAnalyzeBtn(); }
    let any = false; stream.on("text", d => { any = true; onText?.(d); });
    try { return await stream.finalMessage(); }
    catch (e) { if (withFallback && !any && e instanceof A.BadRequestError && /fallback/i.test(e.message)) return run(false); throw e; }
    finally { if (track) st.stream = null; }
  };
  return run(true);
}

const NUM = { type: "number" };
const ANALYSIS_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["food", "reason", "dish", "items", "kcal_low", "kcal_high", "confidence", "score", "tags", "advice"],
  properties: {
    food: { type: "boolean" }, reason: { type: "string" }, dish: { type: "string" },
    items: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["name", "grams", "kcal", "protein", "carbs", "fat", "fiber", "sugar", "x", "y", "micro"],
      properties: { name: { type: "string" }, grams: NUM, kcal: NUM, protein: NUM, carbs: NUM, fat: NUM, fiber: NUM, sugar: NUM, x: NUM, y: NUM,
        micro: { type: "object", additionalProperties: false, required: MICRO_KEYS, properties: Object.fromEntries(MICRO_KEYS.map(k => [k, NUM])) } } } },
    kcal_low: NUM, kcal_high: NUM, confidence: NUM, score: NUM, tags: { type: "array", items: { type: "string" } }, advice: { type: "string" }
  }
};
const SYSTEM_NUTRI = `Tu es un nutritionniste-diététicien diplômé, expert en estimation visuelle des portions et en composition des aliments (tables CIQUAL de l'ANSES et USDA FoodData Central). Tu es rigoureux, analytique et prudent. Tu réponds en français.`;
function buildPrompt(withPhoto) {
  const hint = $("#hint").value.trim();
  return `${withPhoto ? "MISSION : analyser la photo de repas jointe." : "MISSION : analyser le repas décrit ci-dessous (pas de photo)."}
Type de repas : ${MEALTYPES[st.mealType] || "inconnu"}.
${hint ? "Précisions de l'utilisateur (prioritaires sur ton estimation visuelle) : " + hint : "Aucune précision de l'utilisateur."}

Méthode :
1. Identifie chaque aliment distinct, y compris boissons, pain, sauces et assaisonnements visibles.
2. Estime le poids cuit de chaque portion en grammes avec des repères d'échelle : assiette plate ≈ 26–27 cm, fourchette ≈ 19 cm, cuillère à soupe ≈ 15 ml, poing ≈ 250 ml, paume ≈ 100 g de viande.
3. Déduis le mode de cuisson et ajoute en lignes séparées les matières grasses cachées probables (huile, beurre, crème, vinaigrette) quand elles sont plausibles.
4. Pour chaque ligne : kcal, protéines, glucides, lipides, fibres, sucres (g) et micronutriments.
5. Contrôle : kcal ≈ 4×protéines + 4×glucides + 9×lipides + 2×fibres (±8 %). Corrige si besoin.
6. kcal_low et kcal_high encadrent le total avec une largeur de 100 kcal maximum (±50 kcal) quand l'image est nette ; élargis seulement si l'image est ambiguë, et baisse alors la confiance.

Champs :
- dish : nom court et appétissant du plat.
- x, y : position approximative du centre de l'aliment dans la photo, de 0 à 1 (x de gauche à droite, y de haut en bas). Sans photo, mets 0.5.
- micro : vA µg ER, vC mg, vD µg, vE mg, vK µg, vB6 mg, vB9 µg, vB12 µg, ca mg (calcium), fe mg (fer), mg mg (magnésium), k mg (potassium), zn mg (zinc), na mg (sodium).
- confidence : de 0 à 1.
- score : qualité nutritionnelle du repas de 0 à 100 (densité nutritionnelle, fibres, protéines, ultra-transformation, sodium, sucres ajoutés).
- tags : 3 étiquettes courtes au maximum.
- advice : 2 phrases maximum, conseil professionnel concret et bienveillant sur ce repas.
- Si l'image ne montre pas de nourriture : food = false, reason = explication courte, items vide, autres nombres à 0. Sinon food = true et reason vide.
${!withPhoto ? "\nDescription du repas : " + (hint || "(vide)") : ""}`;
}
function apiErrorText(e, A) {
  if (!A) return "Impossible de charger le module IA. Vérifie ta connexion internet.";
  if (e instanceof A.APIUserAbortError) return null;
  if (e instanceof A.AuthenticationError) return "Clé API invalide. Vérifie-la dans l'onglet Profil.";
  if (e instanceof A.PermissionDeniedError) return "Cette clé n'a pas accès au modèle. Vérifie ton compte Anthropic.";
  if (e instanceof A.RateLimitError) return "Limite de requêtes atteinte. Réessaie dans une minute.";
  if (e instanceof A.BadRequestError) return /credit|balance|billing/i.test(e.message) ? "Crédit API insuffisant : recharge ton compte sur console.anthropic.com." : "Requête refusée : " + (e.error?.error?.message || e.message);
  if (e instanceof A.APIConnectionError) return "Pas de connexion à internet ou serveur injoignable.";
  if (e instanceof A.InternalServerError || e?.status === 529) return "Les serveurs d'Anthropic sont surchargés. Réessaie dans un instant.";
  return "Une erreur est survenue : " + (e?.message || e);
}

let stepTimer, elapsedTimer;
function setThinking(on) {
  $("#thinking").hidden = !on; $("#resultEmpty").hidden = true; if (on) $("#result").hidden = true;
  drop.classList.toggle("scanning", on && !!st.photo);
  clearInterval(stepTimer); clearInterval(elapsedTimer);
  const steps = $$("#steps div"); steps.forEach(s => s.classList.remove("on", "done"));
  $("#prog").style.width = "0%";
  if (on) {
    const t0 = Date.now(); let i = 0; steps[0].classList.add("on");
    stepTimer = setInterval(() => { if (i < steps.length - 1) { steps[i].classList.add("done"); i++; steps[i].classList.add("on"); } }, 4500);
    elapsedTimer = setInterval(() => { const s = (Date.now() - t0) / 1000; $("#elapsed").textContent = R(s) + " s"; $("#prog").style.width = Math.min(92, 100 * (1 - Math.exp(-s / 18))) + "%"; }, 250);
    $("#elapsed").textContent = "0 s";
    if (innerWidth < 880) $("#resultCard").scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "nearest" });
  }
  updateAnalyzeBtn();
}
async function analyze(withPhoto) {
  if (!hasKey()) { toast("Ajoute ta clé API dans Profil."); go("profile"); return; }
  if (!withPhoto && !$("#hint").value.trim()) { toast("Décris ton repas dans « Précisions » pour l'analyser sans photo."); $("#hint").focus(); return; }
  if (withPhoto && !st.photo) return;
  st.stream?.abort();
  $("#labels").innerHTML = "";
  let A = null;
  setThinking(true);
  try {
    const { Anthropic, c } = await client(); A = Anthropic;
    const content = [];
    if (withPhoto) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: st.photo.b64 } });
    content.push({ type: "text", text: buildPrompt(withPhoto) });
    let got = 0;
    const msg = await callClaude(c, A, {
      model: MODEL, max_tokens: 16000, system: SYSTEM_NUTRI,
      output_config: { effort: st.settings.effort || "high", format: { type: "json_schema", schema: ANALYSIS_SCHEMA } },
      messages: [{ role: "user", content }]
    }, d => { got += d.length; $("#prog").style.width = Math.min(99, 70 + got / 40) + "%"; $$("#steps div").forEach(s => s.classList.add("on")); });
    if (msg.stop_reason === "refusal") throw { friendly: "L'analyse a été refusée pour cette image. Essaie une autre photo." };
    if (msg.stop_reason === "max_tokens") throw { friendly: "Réponse trop longue, interrompue. Relance l'analyse." };
    const text = msg.content.filter(b => b.type === "text").map(b => b.text).join("");
    let r; try { r = JSON.parse(text); } catch { throw { friendly: "Réponse illisible du nutritionniste. Relance l'analyse." }; }
    setThinking(false);
    if (!r.food) { showMsg("Pas de nourriture détectée", r.reason || "Reprends la photo en cadrant bien l'assiette."); return; }
    if (!Array.isArray(r.items) || !r.items.length) throw { friendly: "Aucun aliment identifié. Relance l'analyse ou ajoute des précisions." };
    r.items = r.items.map(it => {
      const o = { name: String(it.name || "Aliment"), x: clamp01(it.x), y: clamp01(it.y), micro: {} };
      ["grams", ...MACRO_KEYS].forEach(k => o[k] = Math.max(0, +it[k] || 0)); MICRO_KEYS.forEach(k => o.micro[k] = Math.max(0, +it.micro?.[k] || 0));
      o.base = { ...o, micro: { ...o.micro } }; return o;
    });
    st.analysis = { ...r, withPhoto };
    renderResult(true);
    if (withPhoto) placeLabels();
  } catch (e) {
    st.stream = null; setThinking(false);
    const msg = e?.friendly || apiErrorText(e, A);
    if (msg === null) { $("#resultEmpty").hidden = false; toast("Analyse arrêtée"); return; }
    showMsg("Analyse impossible", msg);
  }
}
const clamp01 = v => Math.max(.06, Math.min(.94, Number.isFinite(+v) ? +v : .5));
function placeLabels() {
  const a = st.analysis; if (!a) return;
  $("#labels").innerHTML = a.items.filter(it => it.grams > 0 && !/huile|beurre|vinaigrette|sel|poivre/i.test(it.name) || a.items.length <= 2).slice(0, 7)
    .map((it, i) => `<div class="lbl" style="left:${it.x * 100}%;top:${it.y * 100}%"><span class="d" style="animation-delay:${i * .12}s,${i * .12}s"></span><span class="tx" style="animation-delay:${.1 + i * .12}s">${esc(it.name)}<b>${fmt(it.kcal)}</b></span></div>`).join("");
}
function showMsg(title, msg) { const r = $("#result"); r.hidden = false; r.innerHTML = `<div class="empty"><svg class="fox" viewBox="0 0 64 64">${FOX.slice(FOX.indexOf(">") + 1, -6)}</svg><b>${esc(title)}</b><span>${esc(msg)}</span></div>`; }
$("#analyzeBtn").addEventListener("click", () => analyze(true));
$("#textOnlyBtn").addEventListener("click", () => analyze(false));
$("#stopBtn").addEventListener("click", () => st.stream?.abort());

function renderResult(animate) {
  const a = st.analysis, { totals } = totalsFromItems(a.items);
  const spread = Math.min(150, Math.max(50, ((a.kcal_high || 0) - (a.kcal_low || 0)) / 2 || 50));
  const lo = Math.max(0, R((totals.kcal - spread) / 10) * 10), hi = R((totals.kcal + spread) / 10) * 10;
  const sc = Math.max(0, Math.min(100, R(+a.score || 0))), scCol = sc >= 70 ? "var(--good)" : sc >= 45 ? "var(--warn)" : "var(--bad)";
  const r = $("#result"); r.hidden = false;
  r.innerHTML = `<div class="result-head"><div style="min-width:0"><div class="eyebrow">${MEALTYPES[st.mealType]} · confiance ${R((+a.confidence || 0) * 100)} %</div><h2>${esc(a.dish || "Ton repas")}</h2>
      <div class="tags">${(a.tags || []).slice(0, 3).map(t => `<span class="tag">${esc(t)}</span>`).join("")}</div></div>
    <div class="kcal-big"><b class="num" id="resKcal">${animate ? 0 : fmt(totals.kcal)}</b><span>kcal · ${fmt(lo)}–${fmt(hi)}</span></div></div>
    ${macro4(totals)}
    <div class="score"><div class="s" style="background:color-mix(in srgb,${scCol} 16%,transparent);color:${scCol}">${sc}</div><div><b style="font-size:14px">Score qualité nutritionnelle</b><div class="note">Densité en nutriments, fibres, protéines, transformation, sodium.</div></div></div>
    <div class="sep"></div>
    <div class="items-wrap"><table class="items"><thead><tr><th>Aliment</th><th>Poids (g)</th><th>kcal</th><th>P</th><th>G</th><th>L</th><th></th></tr></thead><tbody>
      ${a.items.map((it, i) => `<tr style="animation-delay:${animate ? i * .07 : 0}s"><td>${esc(it.name)}</td><td><input type="number" inputmode="numeric" min="0" step="5" value="${R(it.grams)}" data-i="${i}" aria-label="Poids de ${esc(it.name)} en grammes"></td><td>${fmt(it.kcal)}</td><td>${fmt(it.protein, 1)}</td><td>${fmt(it.carbs, 1)}</td><td>${fmt(it.fat, 1)}</td><td><button class="x" data-rm="${i}" aria-label="Retirer ${esc(it.name)}">✕</button></td></tr>`).join("")}
    </tbody></table></div>
    <p class="note">Tu connais le poids exact ? Modifie-le : toutes les valeurs se recalculent.</p>
    ${a.advice ? `<div class="advice">${FORK}<div>${esc(a.advice)}</div></div>` : ""}
    <div class="sep"></div>
    <div class="row"><button class="btn primary" id="saveMeal" style="flex:1"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 12l5 5L20 7"/></svg>Ajouter au journal</button><button class="btn" id="reanalyze">Réanalyser</button></div>`;
  if (animate) countUp($("#resKcal"), R(totals.kcal), { dur: 1500 });
  r.querySelectorAll("input[data-i]").forEach(inp => inp.addEventListener("change", () => {
    const it = a.items[+inp.dataset.i], b = it.base, g = Math.max(0, +inp.value || 0), f = b.grams ? g / b.grams : 0;
    MACRO_KEYS.forEach(k => it[k] = b[k] * f); MICRO_KEYS.forEach(k => it.micro[k] = b.micro[k] * f); it.grams = g;
    renderResult(false); if (a.withPhoto) placeLabels();
  }));
  r.querySelectorAll("[data-rm]").forEach(btn => btn.addEventListener("click", () => {
    a.items.splice(+btn.dataset.rm, 1);
    if (!a.items.length) { showMsg("Plus aucun aliment", "Relance une analyse."); return; }
    renderResult(false); if (a.withPhoto) placeLabels();
  }));
  $("#reanalyze").onclick = () => analyze(a.withPhoto && !!st.photo);
  $("#saveMeal").onclick = () => {
    const t = totalsFromItems(a.items), round = (v, d) => +(+v).toFixed(d);
    const meal = {
      id: newId(), at: scanAt(), type: st.mealType, dish: a.dish || "Repas",
      items: a.items.map(({ base, x, y, ...it }) => ({ ...it, grams: R(it.grams), kcal: R(it.kcal), protein: round(it.protein, 1), carbs: round(it.carbs, 1), fat: round(it.fat, 1), fiber: round(it.fiber, 1), sugar: round(it.sugar, 1), micro: Object.fromEntries(MICRO_KEYS.map(k => [k, round(it.micro[k], 2)])) })),
      totals: Object.fromEntries(MACRO_KEYS.map(k => [k, round(t.totals[k], 1)])), micro: Object.fromEntries(MICRO_KEYS.map(k => [k, round(t.micro[k], 2)])),
      kcal_low: lo, kcal_high: hi, score: sc, confidence: +a.confidence || 0, advice: a.advice || "", tags: (a.tags || []).slice(0, 3),
      thumb: a.withPhoto && st.photo ? st.photo.thumb : null
    };
    saveMeal(meal); success(); setTimeout(confetti, 250); toast("Repas ajouté : " + fmt(meal.totals.kcal) + " kcal");
    st.view = dayKey(meal.at); resetScan(); setTimeout(() => go("today"), 900);
  };
}
function resetScan() { clearPhoto(); st.analysis = null; $("#hint").value = ""; $("#result").hidden = true; $("#resultEmpty").hidden = false; delete $("#mealTime").dataset.touched; setScanNow(); setMealType(autoMealType()); updateAnalyzeBtn(); }

/* ---------- HISTORIQUE ---------- */
$$("#histRange button").forEach(b => b.addEventListener("click", () => { st.histRange = b.dataset.r; $$("#histRange button").forEach(x => x.setAttribute("aria-pressed", x === b)); renderHistory(); }));
$("#search").addEventListener("input", () => renderHistory());
function renderHistory() {
  const q = $("#search").value.trim().toLowerCase(), T = targets();
  const cutoff = st.histRange === "all" ? 0 : Date.now() - (+st.histRange) * 864e5;
  const map = {};
  st.meals.filter(m => m.at >= cutoff).filter(m => !q || m.dish.toLowerCase().includes(q) || m.items.some(i => i.name.toLowerCase().includes(q))).forEach(m => (map[dayKey(m.at)] ||= []).push(m));
  const keys = Object.keys(map).sort().reverse();
  if (!keys.length) { $("#histList").innerHTML = `<div class="card">${q ? `<div class="empty"><b>Aucun résultat pour « ${esc(q)} »</b></div>` : emptyMeals()}</div>`; return; }
  $("#histList").innerHTML = keys.map((k, di) => {
    const list = map[k].sort((a, b) => a.at - b.at), s = sumMeals(list), d = keyDate(k), e = s.protein * 4 + s.carbs * 4 + s.fat * 9 || 1, w = v => (v / e * 100).toFixed(1);
    const ratio = s.kcal / T.kcal, cl = Math.abs(ratio - 1) <= .1 ? "st-good" : Math.abs(ratio - 1) <= .25 ? "st-warn" : "st-bad";
    return `<div class="day" style="animation-delay:${Math.min(di, 8) * .06}s"><div class="day-h"><b>${k === todayKey() ? "Aujourd'hui" : d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" })}</b>
      <div class="mini"><span class="spark" title="Répartition P / G / L"><i style="width:${w(s.protein * 4)}%;background:var(--p)"></i><i style="width:${w(s.carbs * 4)}%;background:var(--c)"></i><i style="width:${w(s.fat * 9)}%;background:var(--f)"></i></span><span class="num">${fmt(s.kcal)} kcal</span><span class="pill ${cl}">${R(ratio * 100)} %</span></div></div>
      <div class="meals">${list.map((m, i) => mealRow(m, i)).join("")}</div></div>`;
  }).join("");
  bindMealRows($("#histList"));
}

/* ---------- BILAN ---------- */
$$("#repRange button").forEach(b => b.addEventListener("click", () => { st.repRange = +b.dataset.r; $$("#repRange button").forEach(x => x.setAttribute("aria-pressed", x === b)); renderReport(); }));
function periodDays(n) { const out = [], d = new Date(); d.setHours(12, 0, 0, 0); for (let i = n - 1; i >= 0; i--) { const x = new Date(d); x.setDate(d.getDate() - i); out.push(dayKey(x)); } return out; }
function renderReport() {
  const T = targets(), days = periodDays(st.repRange), map = byDay();
  const rows = days.map(k => ({ k, s: sumMeals(map[k] || []), n: (map[k] || []).length })), logged = rows.filter(r => r.n);
  const avg = key => logged.length ? logged.reduce((a, r) => a + r.s[key], 0) / logged.length : 0;
  $("#repRangeLabel").textContent = keyDate(days[0]).toLocaleDateString("fr-FR", { day: "numeric", month: "short" }) + " → " + keyDate(days.at(-1)).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" }) + (st.demo ? " · exemple" : "");
  const aK = avg("kcal"), aP = avg("protein"), aF = avg("fiber"), dK = aK - T.kcal;
  const inT = logged.filter(r => Math.abs(r.s.kcal / T.kcal - 1) <= .1).length;
  const kp = (label, val, sub, col) => `<div class="card kpi lift"><span>${label}</span><b class="num">${val}</b><small style="color:${col}">${sub}</small></div>`;
  $("#kpis").innerHTML = [
    kp("Moyenne / jour", fmt(aK) + " kcal", logged.length ? (dK >= 0 ? "+" : "−") + fmt(Math.abs(dK)) + " vs objectif" : "aucune donnée", Math.abs(dK) <= T.kcal * .1 ? "var(--good)" : "var(--warn)"),
    kp("Protéines / jour", fmt(aP) + " g", R(aP / T.protein * 100 || 0) + " % de la cible", aP >= T.protein * .9 ? "var(--good)" : "var(--warn)"),
    kp("Fibres / jour", fmt(aF) + " g", R(aF / T.fiber * 100 || 0) + " % de la cible", aF >= T.fiber * .8 ? "var(--good)" : "var(--bad)"),
    kp("Jours dans la cible", inT + " / " + logged.length, logged.length + " jours suivis sur " + days.length, "var(--muted)")
  ].join("");
  $("#kcalChart").innerHTML = barChart(rows.map(r => ({ k: r.k, v: r.s.kcal, stack: [[r.s.protein * 4, "--p"], [r.s.carbs * 4, "--c"], [r.s.fat * 9, "--f"]] })), T.kcal, "kcal");
  $("#protChart").innerHTML = barChart(rows.map(r => ({ k: r.k, v: r.s.protein, stack: [[r.s.protein, "--p"]] })), T.protein, "g", rows.map(r => r.s.fiber), T.fiber);
  bindTips();
  const P = avg("protein") * 4, Cc = avg("carbs") * 4, F = avg("fat") * 9, tot = P + Cc + F || 1, circ = 2 * Math.PI * 52;
  let off = 0; const seg = (v, c) => { const len = v / tot * circ; const s = `<circle cx="70" cy="70" r="52" stroke="var(${c})" stroke-dasharray="0 ${circ}" data-d="${Math.max(0, len - 2)} ${circ - len + 2}" stroke-dashoffset="${-off}"/>`; off += len; return s; };
  $("#donut").innerHTML = `<svg viewBox="0 0 140 140"><circle cx="70" cy="70" r="52" stroke="var(--surface-2)"/>${seg(P, "--p")}${seg(Cc, "--c")}${seg(F, "--f")}</svg>
    <div class="legend"><div><span><i style="background:var(--p)"></i>Protéines</span><b class="num">${R(P / tot * 100)} %</b></div><div><span><i style="background:var(--c)"></i>Glucides</span><b class="num">${R(Cc / tot * 100)} %</b></div><div><span><i style="background:var(--f)"></i>Lipides</span><b class="num">${R(F / tot * 100)} %</b></div>
    <p class="note" style="margin:6px 0 0">Repères ANSES : protéines 10–20 %, glucides 40–55 %, lipides 35–40 %.</p></div>`;
  raf2(() => $$("#donut circle[data-d]").forEach(c => c.setAttribute("stroke-dasharray", c.dataset.d)));
  const pad = (keyDate(days[0]).getDay() + 6) % 7;
  $("#heat").innerHTML = ["L", "M", "M", "J", "V", "S", "D"].map(d => `<span class="note" style="text-align:center;font-size:10px">${d}</span>`).join("") + Array(pad).fill("<span></span>").join("") +
    rows.map((r, i) => { let bg = "var(--surface-2)"; if (r.n) { const dev = Math.abs(r.s.kcal / T.kcal - 1); bg = dev <= .1 ? "var(--good)" : dev <= .25 ? "var(--warn)" : "var(--bad)"; }
      return `<div style="background:${bg};animation-delay:${Math.min(i * .015, 1.2)}s" title="${keyDate(r.k).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })} : ${r.n ? fmt(r.s.kcal) + " kcal" : "non suivi"}"></div>`; }).join("");
  // aliments fréquents
  const cnt = {}; days.forEach(k => (map[k] || []).forEach(m => m.items.forEach(it => { const n = it.name.trim(); (cnt[n] ||= { n, c: 0, k: 0 }); cnt[n].c++; cnt[n].k += it.kcal; })));
  const top = Object.values(cnt).sort((a, b) => b.c - a.c || b.k - a.k).slice(0, 6), mx = top[0]?.c || 1;
  $("#topFoods").innerHTML = top.length ? top.map(t => `<div class="tf"><b>${esc(t.n)}</b><span>${t.c}× · ${fmt(t.k)} kcal</span><div class="bar"><i data-w="${t.c / mx * 100}" style="background:var(--fox)"></i></div></div>`).join("") : `<p class="note">Aucun aliment sur la période.</p>`;
  raf2(() => $$("#topFoods .bar>i").forEach(i => i.style.width = i.dataset.w + "%"));
}
function barChart(data, target, unit, line, lineTarget) {
  const W = 640, H = 230, pl = 42, pr = 12, pt = 14, pb = 26, iw = W - pl - pr, ih = H - pt - pb;
  const max = Math.max(target * 1.25, ...data.map(d => d.v), ...(line || [])) || 1;
  const step = niceStep(max / 4), top = Math.ceil(max / step) * step, y = v => pt + ih - v / top * ih;
  const bw = iw / data.length, gap = Math.min(6, bw * .25), sec = reduce ? 0.01 : .8;
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Graphique ${unit} par jour">`;
  for (let v = 0; v <= top + 1e-6; v += step) s += `<line class="gl" x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}"/><text class="tx" x="${pl - 6}" y="${y(v) + 3}" text-anchor="end">${fmt(v)}</text>`;
  const every = Math.ceil(data.length / 10);
  data.forEach((d, i) => {
    const x = pl + i * bw + gap / 2, w = bw - gap, sum = d.stack.reduce((a, [v]) => a + v, 0) || 1; let acc = 0;
    const tip = `${keyDate(d.k).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" })} · ${fmt(d.v)} ${unit}${line ? " · fibres " + fmt(line[i]) + " g" : ""}`;
    d.stack.forEach(([v, c], j) => {
      const hgt = Math.max(0, d.v * (v / sum) / top * ih), yy = pt + ih - acc - hgt; acc += hgt;
      s += `<rect x="${x}" y="${yy}" width="${w}" height="${hgt}" rx="${j === d.stack.length - 1 ? Math.min(4, w / 2) : 0}" fill="var(${c})" data-tip="${tip}"><animate attributeName="height" from="0" to="${hgt}" dur="${sec}s" begin="${reduce ? 0 : i * .025}s" fill="freeze" calcMode="spline" keySplines=".2 .8 .2 1"/><animate attributeName="y" from="${yy + hgt}" to="${yy}" dur="${sec}s" begin="${reduce ? 0 : i * .025}s" fill="freeze" calcMode="spline" keySplines=".2 .8 .2 1"/></rect>`;
    });
    if (i % every === 0) s += `<text class="tx" x="${x + w / 2}" y="${H - 8}" text-anchor="middle">${data.length <= 7 ? keyDate(d.k).toLocaleDateString("fr-FR", { weekday: "short" }) : d.k.slice(8) + "/" + d.k.slice(5, 7)}</text>`;
  });
  s += `<line class="target" x1="${pl}" x2="${W - pr}" y1="${y(target)}" y2="${y(target)}"/><text class="tx" x="${W - pr}" y="${y(target) - 5}" text-anchor="end" style="fill:var(--fox)">${fmt(target)} ${unit}</text>`;
  if (line) {
    const pts = line.map((v, i) => [pl + i * bw + bw / 2, y(v)]), dpath = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
    const len = pts.reduce((a, p, i) => i ? a + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0, 0);
    s += `<path class="line" d="${dpath}" stroke="var(--fi)" stroke-dasharray="${len}" stroke-dashoffset="${len}"><animate attributeName="stroke-dashoffset" from="${len}" to="0" dur="${reduce ? .01 : 1.4}s" begin=".3s" fill="freeze"/></path>`;
    const lp = pts.at(-1); s += `<circle cx="${lp[0]}" cy="${lp[1]}" r="4" fill="var(--fi)" stroke="var(--surface)" stroke-width="2"/>`;
    s += `<text class="tx" x="${pl + 4}" y="${pt + 8}" style="fill:var(--fi)">— fibres (cible ${lineTarget} g)</text>`;
  }
  return s + "</svg>";
}
function niceStep(x) { const p = Math.pow(10, Math.floor(Math.log10(x))), n = x / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; }
function bindTips() {
  const tip = $("#tip");
  $$("[data-tip]").forEach(el => {
    const show = e => { const p = e.touches?.[0] || e; tip.textContent = el.dataset.tip; tip.style.opacity = 1; tip.style.left = Math.max(8, Math.min(p.clientX + 12, innerWidth - tip.offsetWidth - 8)) + "px"; tip.style.top = (p.clientY - 38) + "px"; };
    el.onmousemove = show; el.ontouchstart = e => { show(e); clearTimeout(bindTips._t); bindTips._t = setTimeout(() => tip.style.opacity = 0, 1800); };
    el.onmouseleave = () => tip.style.opacity = 0;
  });
}
$("#aiReportBtn").addEventListener("click", async () => {
  const out = $("#aiReport"), btn = $("#aiReportBtn");
  if (!hasKey()) { out.innerHTML = `<span class="note">Ajoute ta clé API dans l'onglet Profil pour générer le bilan.</span>`; return; }
  const T = targets(), days = periodDays(st.repRange), map = byDay();
  const lines = days.filter(k => map[k]).map(k => { const s = sumMeals(map[k]); return `${k} : ${R(s.kcal)} kcal, P ${R(s.protein)} g, G ${R(s.carbs)} g, L ${R(s.fat)} g, fibres ${R(s.fiber)} g, sucres ${R(s.sugar)} g, sodium ${R(s.na)} mg, vit C ${R(s.vC)} mg, vit D ${s.vD.toFixed(1)} µg, B12 ${s.vB12.toFixed(1)} µg, fer ${s.fe.toFixed(1)} mg, calcium ${R(s.ca)} mg, magnésium ${R(s.mg)} mg | repas : ${map[k].map(m => m.dish).join(" ; ")}`; });
  if (!lines.length) { out.textContent = "Aucun repas sur cette période : ajoute des repas pour obtenir un bilan."; return; }
  const p = st.profile;
  const prompt = `Rédige le bilan nutritionnel professionnel de ${p.name || "l'utilisateur"} sur ${days.length} jours (${lines.length} jours renseignés).
Profil : ${p.sex === "f" ? "femme" : "homme"}, ${p.age} ans, ${p.weight} kg, ${p.height} cm, objectif ${({ cut: "perte de gras", maintain: "maintien", bulk: "prise de muscle" })[p.goal]}.
Cibles quotidiennes : ${T.kcal} kcal, protéines ${T.protein} g, glucides ${T.carbs} g, lipides ${T.fat} g, fibres ${T.fiber} g.
Données journalières :
${lines.join("\n")}

Format : texte brut sans markdown ni astérisques, environ 230 mots, avec exactement ces intitulés en majuscules, chacun sur sa propre ligne :
VERDICT (2 phrases chiffrées)
POINTS FORTS (2 tirets)
À CORRIGER (2 à 3 tirets chiffrés, dont les micronutriments à risque)
PLAN D'ACTION (3 tirets concrets avec des exemples d'aliments et de quantités)
Ne pose pas de diagnostic médical.`;
  btn.disabled = true; out.innerHTML = '<span class="row note"><span class="loader" style="width:26px;height:26px"><svg viewBox="0 0 64 64" style="width:26px;height:26px"><circle cx="32" cy="32" r="28"/></svg></span> Le renard étudie ta période…</span>';
  let A = null;
  try {
    const { Anthropic, c } = await client(); A = Anthropic;
    let txt = "";
    const msg = await callClaude(c, A, { model: MODEL, max_tokens: 8000, system: SYSTEM_NUTRI, output_config: { effort: "medium" }, messages: [{ role: "user", content: prompt }] }, d => { txt += d; out.textContent = txt; }, false);
    if (msg.stop_reason === "refusal") out.textContent = "Le bilan n'a pas pu être généré. Réessaie.";
  } catch (e) { out.textContent = apiErrorText(e, A) || "Bilan arrêté."; }
  finally { btn.disabled = false; }
});

/* ---------- PROFIL & RÉGLAGES ---------- */
function fillProfile() { const p = st.profile; $("#pName").value = p.name || ""; $("#pSex").value = p.sex; $("#pAge").value = p.age; $("#pWeight").value = p.weight; $("#pHeight").value = p.height; $("#pAct").value = String(p.act); $("#pGoal").value = p.goal; }
function readProfile() { return { name: $("#pName").value.trim(), sex: $("#pSex").value, age: +$("#pAge").value || 28, weight: +$("#pWeight").value || 75, height: +$("#pHeight").value || 178, act: +$("#pAct").value, goal: $("#pGoal").value }; }
function renderProfile() {
  const T = targets(readProfile()), box = (v, l, i) => `<div style="animation-delay:${i * .05}s"><b class="num">${fmt(v)}</b><span>${l}</span></div>`;
  $("#targets").innerHTML = [[T.kcal, "kcal / jour"], [T.protein, "g protéines"], [T.carbs, "g glucides"], [T.fat, "g lipides"], [T.fiber, "g fibres"], [T.bmr, "kcal métab. de base"]].map((x, i) => box(x[0], x[1], i)).join("");
  $("#apiKey").value = st.settings.apiKey ? st.settings.apiKey : "";
  setKeyStatus(st.settings.apiKey ? (st.settings.keyOk ? "ok" : "saved") : "none");
  $("#effort").value = st.settings.effort; $("#theme").value = st.settings.theme;
  const standalone = navigator.standalone || matchMedia("(display-mode: standalone)").matches;
  $("#installState").textContent = standalone ? "Installée sur ton écran d'accueil ✓" : "Ajoute Fox à ton écran d'accueil";
  $("#demoBtn").textContent = st.demo ? "Revenir à mes données" : "Voir avec des données d'exemple";
}
function setKeyStatus(s) { const el = $("#keyStatus"); const m = { none: ["Non configurée", "var(--muted)"], saved: ["Enregistrée", "var(--warn)"], ok: ["Connectée", "var(--good)"], bad: ["Invalide", "var(--bad)"], test: ["Test…", "var(--muted)"] }[s]; el.textContent = m[0]; el.style.color = m[1]; }
$("#profForm").addEventListener("input", e => { if (e.target.closest(".form")) { const T = targets(readProfile()); $$("#targets b").forEach((b, i) => b.textContent = fmt([T.kcal, T.protein, T.carbs, T.fat, T.fiber, T.bmr][i])); } });
$("#profForm").addEventListener("submit", e => { e.preventDefault(); st.profile = readProfile(); saveProfile(); renderAll(); success(); toast("Objectifs enregistrés : " + fmt(targets().kcal) + " kcal / jour"); });
$("#keyShow").addEventListener("click", () => { const i = $("#apiKey"); i.type = i.type === "password" ? "text" : "password"; });
$("#keySave").addEventListener("click", async () => {
  const k = $("#apiKey").value.trim();
  if (!/^sk-ant-/.test(k)) { toast("La clé doit commencer par « sk-ant- »."); setKeyStatus("bad"); return; }
  st.settings.apiKey = k; st.settings.keyOk = false; saveSettings(); setKeyStatus("test");
  let A = null;
  try { const { Anthropic, c } = await client(); A = Anthropic; await c.models.retrieve(MODEL); st.settings.keyOk = true; saveSettings(); setKeyStatus("ok"); toast("Clé connectée ✓ L'analyse IA est prête."); success(); }
  catch (e) { setKeyStatus(A && e instanceof A.AuthenticationError ? "bad" : "saved"); toast(apiErrorText(e, A) || "Test interrompu"); }
});
$("#keyDel").addEventListener("click", () => { st.settings.apiKey = ""; st.settings.keyOk = false; saveSettings(); $("#apiKey").value = ""; setKeyStatus("none"); toast("Clé supprimée de cet appareil"); });
$("#effort").addEventListener("change", e => { st.settings.effort = e.target.value; saveSettings(); });
$("#theme").addEventListener("change", e => { st.settings.theme = e.target.value; saveSettings(); applyTheme(); });
function applyTheme() {
  const t = st.settings.theme; if (t === "auto") document.documentElement.removeAttribute("data-theme"); else document.documentElement.setAttribute("data-theme", t);
  const dark = t === "dark" || (t === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  $$('meta[name="theme-color"]').forEach(m => { m.setAttribute("content", dark ? "#0E141A" : "#EDF0F3"); m.removeAttribute("media"); });
}
$("#demoBtn").addEventListener("click", () => st.demo ? exitDemo() : enterDemo());
$("#wipeBtn").addEventListener("click", () => $("#wipeConfirm").hidden = false);
$("#wipeNo").addEventListener("click", () => $("#wipeConfirm").hidden = true);
$("#wipeYes").addEventListener("click", async () => {
  $("#wipeConfirm").hidden = true; if (st.demo) exitDemo();
  st.meals = []; try { if (useIdb) await idb.clear(); else lsSet("meals", []); } catch { }
  renderAll(); toast("Toutes les données ont été supprimées");
});
$("#exportBtn").addEventListener("click", async () => {
  const data = JSON.stringify({ app: "track-your-fox", version: 1, exportedAt: new Date().toISOString(), profile: st.profile, meals: st.demo ? st.realMeals : st.meals });
  const name = `track-your-fox-${todayKey()}.json`, file = new File([data], name, { type: "application/json" });
  try { if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: "Sauvegarde Track Your Fox" }); return; } } catch (e) { if (e.name === "AbortError") return; }
  const a = document.createElement("a"); a.href = URL.createObjectURL(file); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  toast("Sauvegarde exportée");
});
$("#importInput").addEventListener("change", async e => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  try {
    const j = JSON.parse(await f.text()); if (!Array.isArray(j.meals)) throw 0;
    if (st.demo) exitDemo();
    const ids = new Set(st.meals.map(m => m.id)); let n = 0;
    for (const m of j.meals) { if (!m?.id || !m.totals || ids.has(m.id)) continue; st.meals.push(m); n++; try { await persistMeal(m); } catch { } }
    if (j.profile) { st.profile = { ...st.profile, ...j.profile }; saveProfile(); fillProfile(); }
    renderAll(); toast(`${n} repas importés`);
  } catch { toast("Fichier de sauvegarde invalide."); }
});

/* ---------- données d'exemple (jamais enregistrées) ---------- */
function enterDemo() { if (st.demo) return; st.realMeals = st.meals; st.meals = demoMeals(); st.demo = true; renderAll(); toast("Données d'exemple affichées (non enregistrées)"); }
function exitDemo() { if (!st.demo) return; st.meals = st.realMeals || []; st.demo = false; renderAll(); }
function demoMeals() {
  const lib = [
    ["petit-dej", "Porridge avoine, banane & beurre de cacahuète", [["Flocons d'avoine", 60, 226, 8, 36, 4.2, 6], ["Lait demi-écrémé", 200, 92, 6.4, 9.6, 3.2, 0], ["Banane", 110, 98, 1.2, 22, .3, 2.9], ["Beurre de cacahuète", 15, 94, 3.8, 2.3, 7.8, 1]], 78],
    ["petit-dej", "Tartines complètes & œufs brouillés", [["Pain complet", 80, 198, 7.5, 34, 2.5, 5.6], ["Œufs brouillés", 120, 178, 14.6, 1.4, 12.6, 0], ["Beurre", 8, 59, 0, 0, 6.6, 0]], 70],
    ["dejeuner", "Poulet rôti, riz basmati & brocolis", [["Blanc de poulet rôti", 150, 240, 45, 0, 6, 0], ["Riz basmati cuit", 180, 230, 4.9, 50, .5, .7], ["Brocolis vapeur", 120, 42, 3.4, 4.3, .5, 3.6], ["Huile d'olive", 10, 90, 0, 0, 10, 0]], 82],
    ["dejeuner", "Bowl saumon, quinoa & avocat", [["Saumon cuit", 130, 270, 29, 0, 16.5, 0], ["Quinoa cuit", 150, 180, 6.6, 32, 2.9, 4.2], ["Avocat", 70, 112, 1.4, 1.3, 10.3, 4.7], ["Edamame", 50, 61, 5.5, 4.4, 2.6, 2.6]], 86],
    ["diner", "Pâtes bolognaise maison", [["Pâtes cuites", 220, 317, 11, 64, 1.8, 3.9], ["Sauce bolognaise bœuf 5 %", 160, 184, 16, 8, 9.6, 1.6], ["Parmesan", 10, 39, 3.5, 0, 2.8, 0]], 60],
    ["diner", "Omelette aux légumes & salade verte", [["Omelette 3 œufs", 170, 260, 19, 2, 19.5, 0], ["Poêlée de légumes", 150, 75, 2.5, 9, 3, 3.5], ["Salade verte vinaigrette", 80, 70, 1, 2, 6.5, 1.2]], 74],
    ["collation", "Skyr & fruits rouges", [["Skyr nature", 150, 93, 16.5, 6, .3, 0], ["Fruits rouges", 80, 37, .8, 6, .3, 3.2], ["Miel", 10, 30, 0, 8, 0, 0]], 80],
    ["collation", "Pomme & amandes", [["Pomme", 150, 78, .4, 17, .3, 3.6], ["Amandes", 20, 124, 4.3, 1.5, 10.6, 2.5]], 84],
    ["diner", "Burger maison & frites au four", [["Burger bœuf cheddar", 230, 560, 32, 38, 30, 2], ["Frites au four", 150, 240, 3.8, 36, 8.5, 3.3]], 38]
  ];
  const out = [], now = new Date();
  for (let d = 40; d >= 0; d--) {
    const day = new Date(now); day.setDate(now.getDate() - d);
    if (d > 0 && (d * 7) % 11 === 3) continue;
    const pick = (type, h, off) => { const o = lib.filter(x => x[0] === type); return [o[(d + off) % o.length], h]; };
    const plan = [pick("petit-dej", 8, 0), pick("dejeuner", 12, 1), ...(d % 2 ? [pick("collation", 16, d)] : []), pick("diner", 20, d)];
    plan.forEach(([m, h], j) => {
      const at = new Date(day); at.setHours(h, 10 + j * 7, 0, 0); if (at > now) return;
      const f = 1.38 + ((d * 13 + j * 7) % 34) / 100;
      const items = m[2].map(([name, g, k, p, c, fa, fi]) => ({ name, grams: R(g * f), kcal: R(k * f), protein: +(p * f).toFixed(1), carbs: +(c * f).toFixed(1), fat: +(fa * f).toFixed(1), fiber: +(fi * f).toFixed(1), sugar: +(c * f * .15).toFixed(1),
        micro: { vA: k * f * .25, vC: fi * f * 6, vD: p * f * .04, vE: fa * f * .25, vK: fi * f * 9, vB6: p * f * .012, vB9: fi * f * 14, vB12: p * f * .04, ca: k * f * .35, fe: k * f * .005, mg: k * f * .14, k: k * f * 1.1, zn: p * f * .07, na: k * f * .9 } }));
      const t = totalsFromItems(items);
      out.push({ id: "demo" + d + "_" + j, at: at.getTime(), type: m[0], dish: m[1], items, totals: t.totals, micro: t.micro, kcal_low: R(t.totals.kcal - 50), kcal_high: R(t.totals.kcal + 50), score: m[3], confidence: .8, advice: "Exemple : ce repas illustre le tableau de bord.", tags: ["exemple"], thumb: null });
    });
  }
  return out;
}

/* ---------- démarrage ---------- */
async function start() {
  splash();
  clock(); setInterval(clock, 1000);
  await loadData();
  applyTheme(); fillProfile(); setMealType(autoMealType()); setScanNow();
  go(location.hash.slice(1) || "today", false);
  setTimeout(movePill, 350); document.fonts?.ready.then(movePill);
  if (hasKey()) loadSDK().catch(() => { });
  let lastToday = todayKey();
  document.addEventListener("visibilitychange", () => { if (document.hidden) return; const tk = todayKey(); if (tk !== lastToday) { if (st.view === lastToday) st.view = tk; lastToday = tk; } renderAll(); });
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", applyTheme);
  if ("serviceWorker" in navigator && location.protocol !== "file:") { navigator.serviceWorker.register("sw.js").catch(() => { }); repairParentShell(); }
}
/* Si l'app est hébergée dans le sous-dossier d'un autre site qui a son propre service worker,
   celui-ci a pu enregistrer cette page comme sa page hors ligne lors de la première visite : on la remet. */
async function repairParentShell() {
  try {
    const ctl = navigator.serviceWorker.controller; if (!ctl) return;
    const mine = new URL("sw.js", location.href).href; if (ctl.scriptURL === mine) return;
    const parentBase = new URL(".", ctl.scriptURL).href, key = new URL(parentBase).pathname;
    if (!(await caches.has("rp-shell-v1"))) return;
    const res = await fetch(parentBase, { cache: "no-cache" }); if (!res.ok) return;
    await (await caches.open("rp-shell-v1")).put(key, res);
  } catch { }
}
start();
