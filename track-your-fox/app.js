/* TRACK YOUR FOX — suivi nutritionnel par photo (PWA autonome, IA sur l'appareil, gratuite) */
const TF_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1";
const MODEL_ID = "onnx-community/swin-finetuned-food101-ONNX";

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
  settings: { theme: "auto" }, dl: null, runId: 0,
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
const hasKey = () => true;
function renderScan() {
  $("#keyCard").hidden = lsGet("modelReady", false);
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

/* --- IA locale : reconnaissance du plat sur l'iPhone (gratuit, sans compte, photos jamais envoyées) --- */
// [id, nom, portion (g), kcal, protéines, glucides, lipides, fibres, sucres (pour 100 g), profil micronutriments]
const DISHES = [
  ["apple_pie", "Tarte aux pommes", 125, 265, 2.4, 37, 12.5, 1.6, 16, "patisserie_fruit"],
  ["baby_back_ribs", "Travers de porc (ribs)", 250, 290, 22, 6, 20, .2, 5, "viande_porc"],
  ["baklava", "Baklava", 60, 430, 6.7, 37, 29, 2.5, 20, "patisserie_noix"],
  ["beef_carpaccio", "Carpaccio de bœuf", 120, 160, 21, 1, 8, .2, .5, "viande_boeuf"],
  ["beef_tartare", "Tartare de bœuf", 180, 190, 20, 2, 11, .3, 1, "viande_boeuf"],
  ["beet_salad", "Salade de betteraves", 200, 110, 3, 10, 6.5, 2.5, 7, "legumes"],
  ["beignets", "Beignets", 100, 390, 6, 45, 21, 1.4, 18, "patisserie_frit"],
  ["bibimbap", "Bibimbap", 450, 130, 6.5, 17, 4, 1.8, 2, "plat_riz"],
  ["bread_pudding", "Pudding au pain", 150, 220, 5.5, 32, 8, .8, 18, "dessert_lacte"],
  ["breakfast_burrito", "Burrito petit-déjeuner", 250, 215, 10, 20, 10.5, 2, 1.5, "sandwich"],
  ["bruschetta", "Bruschetta", 120, 190, 5.5, 25, 7.5, 2, 3, "pain"],
  ["caesar_salad", "Salade César", 300, 145, 8, 6, 10, 1.5, 1.5, "salade_composee"],
  ["cannoli", "Cannoli", 90, 360, 8, 36, 21, 1, 20, "patisserie_lait"],
  ["caprese_salad", "Salade caprese", 220, 160, 9, 4, 12, 1, 3, "salade_fromage"],
  ["carrot_cake", "Carrot cake", 120, 400, 4.5, 50, 21, 1.5, 33, "patisserie"],
  ["ceviche", "Ceviche", 200, 95, 14, 6, 1.5, 1, 2.5, "poisson"],
  ["cheesecake", "Cheesecake", 125, 320, 5.5, 26, 22, .4, 21, "dessert_lacte"],
  ["cheese_plate", "Plateau de fromages", 100, 370, 23, 2, 30, 0, .5, "fromage"],
  ["chicken_curry", "Curry de poulet", 350, 135, 11, 6, 7.5, 1.3, 2.5, "plat_poulet_sauce"],
  ["chicken_quesadilla", "Quesadilla au poulet", 220, 275, 15, 23, 13.5, 1.5, 2, "sandwich"],
  ["chicken_wings", "Ailes de poulet", 200, 270, 24, 3, 18, 0, .5, "poulet_frit"],
  ["chocolate_cake", "Gâteau au chocolat", 110, 390, 5, 50, 19, 2.5, 35, "patisserie_choco"],
  ["chocolate_mousse", "Mousse au chocolat", 100, 280, 5.5, 25, 18, 2, 22, "dessert_choco"],
  ["churros", "Churros", 100, 410, 5, 45, 23, 1.5, 15, "patisserie_frit"],
  ["clam_chowder", "Chaudrée de palourdes", 300, 90, 4.5, 8, 4.5, .6, 1.5, "soupe_creme"],
  ["club_sandwich", "Club sandwich", 250, 245, 13, 20, 12.5, 1.6, 3, "sandwich"],
  ["crab_cakes", "Galettes de crabe", 150, 220, 14, 12, 13, .6, 1.5, "fruits_mer_frit"],
  ["creme_brulee", "Crème brûlée", 120, 300, 4.5, 23, 21, 0, 22, "dessert_lacte"],
  ["croque_madame", "Croque-madame", 220, 270, 15, 18, 15.5, 1, 3, "sandwich"],
  ["cup_cakes", "Cupcakes", 75, 390, 4, 55, 18, .8, 38, "patisserie"],
  ["deviled_eggs", "Œufs mimosa", 100, 200, 11, 1.5, 16.5, 0, 1, "oeufs"],
  ["donuts", "Donuts", 75, 420, 5, 50, 22, 1.5, 22, "patisserie_frit"],
  ["dumplings", "Raviolis chinois", 200, 200, 9, 25, 7, 1.5, 2, "asiatique"],
  ["edamame", "Edamame", 150, 120, 11, 9, 5, 5, 2, "legumineuses"],
  ["eggs_benedict", "Œufs Bénédicte", 250, 230, 11, 13, 15, .6, 1.5, "oeufs"],
  ["escargots", "Escargots au beurre", 100, 300, 15, 3, 26, .3, .5, "fruits_mer"],
  ["falafel", "Falafels", 150, 330, 13, 32, 18, 5, 2, "legumineuses"],
  ["filet_mignon", "Filet mignon", 200, 220, 28, 0, 12, 0, 0, "viande_boeuf"],
  ["fish_and_chips", "Fish and chips", 350, 230, 11, 22, 11, 1.8, .5, "poisson_frit"],
  ["foie_gras", "Foie gras", 60, 460, 7, 4.5, 45, 0, 1, "abats"],
  ["french_fries", "Frites", 150, 310, 3.4, 41, 15, 3.8, .3, "frit"],
  ["french_onion_soup", "Soupe à l'oignon gratinée", 350, 80, 3.8, 8, 3.5, .8, 3, "soupe_fromage"],
  ["french_toast", "Pain perdu", 150, 230, 7.5, 27, 10, 1, 10, "petitdej_sucre"],
  ["fried_calamari", "Calamars frits", 150, 260, 15, 18, 14, .5, .5, "fruits_mer_frit"],
  ["fried_rice", "Riz cantonais", 300, 170, 6, 24, 5.5, 1, 1, "plat_riz"],
  ["frozen_yogurt", "Yaourt glacé", 150, 130, 4, 22, 3.5, 0, 20, "dessert_lacte"],
  ["garlic_bread", "Pain à l'ail", 80, 350, 8, 42, 16, 2, 3, "pain"],
  ["gnocchi", "Gnocchis en sauce", 300, 160, 4.5, 26, 4.5, 1.8, 2, "pates"],
  ["greek_salad", "Salade grecque", 250, 110, 4, 5, 9, 1.8, 3, "salade_fromage"],
  ["grilled_cheese_sandwich", "Sandwich au fromage grillé", 150, 330, 13, 28, 19, 1.5, 3, "sandwich"],
  ["grilled_salmon", "Saumon grillé", 180, 210, 22, 0, 13.5, 0, 0, "poisson_gras"],
  ["guacamole", "Guacamole", 100, 155, 2, 8.5, 14, 6, 1, "legumes_gras"],
  ["gyoza", "Gyozas", 150, 210, 9, 24, 8.5, 1.5, 2, "asiatique"],
  ["hamburger", "Hamburger", 220, 255, 14, 23, 12, 1.5, 4.5, "burger"],
  ["hot_and_sour_soup", "Soupe aigre-piquante", 350, 40, 2.6, 4.5, 1.3, .5, 1, "soupe"],
  ["hot_dog", "Hot-dog", 150, 270, 10, 23, 15, 1, 4, "sandwich"],
  ["huevos_rancheros", "Huevos rancheros", 300, 150, 7.5, 12, 8, 3, 2, "oeufs"],
  ["hummus", "Houmous", 100, 240, 8, 14, 17, 6, .3, "legumineuses"],
  ["ice_cream", "Glace", 100, 210, 3.7, 24, 11, .7, 21, "dessert_lacte"],
  ["lasagna", "Lasagnes", 350, 150, 8.5, 13, 7, 1.2, 3, "pates_viande"],
  ["lobster_bisque", "Bisque de homard", 300, 100, 4, 6, 7, .3, 2, "soupe_creme"],
  ["lobster_roll_sandwich", "Lobster roll", 200, 230, 13, 22, 10, 1, 3, "sandwich_mer"],
  ["macaroni_and_cheese", "Macaroni au fromage", 300, 165, 7, 18, 7.5, 1, 2, "pates_fromage"],
  ["macarons", "Macarons", 60, 410, 6, 55, 18, 2, 50, "patisserie_noix"],
  ["miso_soup", "Soupe miso", 250, 25, 2, 3, .8, .5, .8, "soupe"],
  ["mussels", "Moules marinières", 400, 95, 11, 4, 3.5, .2, .5, "fruits_mer"],
  ["nachos", "Nachos garnis", 250, 300, 8, 32, 16, 3.5, 2, "frit"],
  ["omelette", "Omelette", 180, 155, 11, 1, 12, 0, .6, "oeufs"],
  ["onion_rings", "Rondelles d'oignon frites", 120, 330, 4.5, 35, 19, 2, 4, "frit"],
  ["oysters", "Huîtres", 120, 70, 7, 4, 2.5, 0, 0, "fruits_mer"],
  ["pad_thai", "Pad thaï", 350, 160, 7.5, 21, 5.5, 1.3, 5, "nouilles"],
  ["paella", "Paella", 400, 150, 9, 18, 4.5, 1, 1, "plat_riz_mer"],
  ["pancakes", "Pancakes", 150, 230, 6, 30, 9.5, 1, 10, "petitdej_sucre"],
  ["panna_cotta", "Panna cotta", 120, 230, 3, 20, 15, 0, 19, "dessert_lacte"],
  ["peking_duck", "Canard laqué", 200, 260, 19, 6, 18, .3, 4, "volaille_gras"],
  ["pho", "Phở (soupe de nouilles)", 600, 60, 4.5, 7, 1.5, .4, .8, "soupe_nouilles"],
  ["pizza", "Pizza", 300, 260, 11, 30, 10.5, 2, 3.5, "pizza"],
  ["pork_chop", "Côte de porc", 200, 230, 27, 0, 13, 0, 0, "viande_porc"],
  ["poutine", "Poutine", 400, 205, 6, 20, 11.5, 1.8, 1, "frit"],
  ["prime_rib", "Côte de bœuf", 250, 290, 24, 0, 21, 0, 0, "viande_boeuf"],
  ["pulled_pork_sandwich", "Sandwich au porc effiloché", 250, 250, 15, 25, 10, 1.3, 9, "sandwich"],
  ["ramen", "Ramen", 550, 85, 4.5, 10, 3, .6, 1, "soupe_nouilles"],
  ["ravioli", "Raviolis", 300, 175, 7.5, 22, 6, 1.5, 2.5, "pates_viande"],
  ["red_velvet_cake", "Red velvet", 120, 370, 4, 48, 18, .7, 35, "patisserie"],
  ["risotto", "Risotto", 300, 145, 4, 20, 5.5, .6, .8, "plat_riz"],
  ["samosa", "Samoussas", 120, 260, 5, 28, 14, 2.5, 2, "frit"],
  ["sashimi", "Sashimi", 150, 140, 22, 0, 5.5, 0, 0, "poisson_gras"],
  ["scallops", "Saint-Jacques poêlées", 150, 140, 20, 5, 4.5, 0, 0, "fruits_mer"],
  ["seaweed_salad", "Salade d'algues", 120, 70, 1.5, 9, 3, 2.5, 4, "legumes"],
  ["shrimp_and_grits", "Crevettes et polenta", 350, 140, 9, 13, 6, .8, 1, "fruits_mer"],
  ["spaghetti_bolognese", "Spaghetti bolognaise", 350, 150, 7, 19, 5, 1.6, 2.5, "pates_viande"],
  ["spaghetti_carbonara", "Spaghetti carbonara", 350, 200, 8.5, 22, 9, 1.2, 1, "pates_fromage"],
  ["spring_rolls", "Nems / rouleaux de printemps", 150, 220, 6.5, 24, 11, 1.5, 2, "asiatique"],
  ["steak", "Steak", 200, 250, 26, 0, 16, 0, 0, "viande_boeuf"],
  ["strawberry_shortcake", "Fraisier", 130, 300, 4, 38, 15, 1.2, 25, "patisserie_fruit"],
  ["sushi", "Sushis", 250, 145, 6, 26, 2, .6, 5, "poisson_riz"],
  ["tacos", "Tacos", 200, 215, 10, 20, 10.5, 2.5, 2, "sandwich"],
  ["takoyaki", "Takoyaki", 150, 190, 7, 23, 8, .8, 3, "fruits_mer_frit"],
  ["tiramisu", "Tiramisu", 120, 290, 5, 28, 17, .6, 20, "dessert_lacte"],
  ["tuna_tartare", "Tartare de thon", 150, 145, 22, 2, 5.5, .8, .5, "poisson"],
  ["waffles", "Gaufres", 120, 290, 7, 33, 14, 1.3, 9, "petitdej_sucre"]
];
const BASICS = [
  ["baguette", "Pain (baguette)", 60, 270, 9, 55, 1.3, 2.8, 2.5, "pain"],
  ["pain_complet", "Pain complet", 60, 250, 9, 45, 3, 7, 3, "pain"],
  ["croissant", "Croissant", 60, 420, 8, 46, 22, 2.5, 10, "patisserie"],
  ["cereales", "Céréales du petit-déjeuner", 40, 380, 8, 78, 3, 4, 25, "cereales"],
  ["avoine", "Flocons d'avoine", 50, 370, 13, 60, 7, 10, 1, "cereales_completes"],
  ["riz", "Riz blanc cuit", 180, 130, 2.7, 28, .3, .4, .1, "plat_riz"],
  ["pates", "Pâtes cuites", 200, 150, 5.5, 30, .9, 1.8, .6, "pates"],
  ["quinoa", "Quinoa cuit", 150, 120, 4.4, 21, 1.9, 2.8, .9, "cereales_completes"],
  ["pdt", "Pommes de terre vapeur", 200, 80, 2, 17, .1, 1.8, .8, "legumes"],
  ["poulet", "Blanc de poulet", 150, 165, 31, 0, 3.6, 0, 0, "poulet"],
  ["steak_hache", "Steak haché 5 %", 125, 140, 21, 0, 5, 0, 0, "viande_boeuf"],
  ["jambon", "Jambon blanc", 50, 115, 20, 1, 3.5, 0, 1, "viande_porc"],
  ["saumon", "Saumon", 150, 200, 21, 0, 13, 0, 0, "poisson_gras"],
  ["thon", "Thon au naturel", 100, 110, 25, 0, 1, 0, 0, "poisson"],
  ["crevettes", "Crevettes", 100, 100, 24, 0, .3, 0, 0, "fruits_mer"],
  ["oeuf", "Œuf", 55, 140, 12.5, .7, 9.5, 0, .4, "oeufs"],
  ["tofu", "Tofu", 150, 120, 13, 2, 7, 1, .5, "legumineuses"],
  ["lentilles", "Lentilles cuites", 200, 115, 9, 17, .4, 8, 1.8, "legumineuses"],
  ["pois_chiches", "Pois chiches cuits", 150, 140, 7.5, 18, 2.5, 7, 3, "legumineuses"],
  ["yaourt", "Yaourt nature", 125, 60, 4, 5, 3.2, 0, 5, "dessert_lacte"],
  ["fromage_blanc", "Fromage blanc 3 %", 100, 75, 7.5, 4, 3, 0, 4, "dessert_lacte"],
  ["skyr", "Skyr", 150, 62, 11, 4, .2, 0, 4, "dessert_lacte"],
  ["lait", "Lait demi-écrémé", 250, 46, 3.2, 4.8, 1.6, 0, 4.8, "lait"],
  ["fromage", "Fromage (emmental, comté…)", 30, 390, 28, 0, 31, 0, 0, "fromage"],
  ["salade_verte", "Salade verte", 80, 15, 1.3, 1.7, .2, 1.3, .8, "legumes_verts"],
  ["tomate", "Tomate", 120, 18, .9, 3, .2, 1.2, 2.6, "legumes"],
  ["carottes", "Carottes", 100, 40, .9, 7, .2, 2.8, 4.7, "legumes_orange"],
  ["brocoli", "Brocoli", 150, 35, 2.8, 4, .4, 2.6, 1.7, "legumes_verts"],
  ["haricots_verts", "Haricots verts", 150, 30, 1.8, 4, .2, 3, 1.5, "legumes_verts"],
  ["legumes_poeles", "Poêlée de légumes", 200, 50, 1.8, 6, 2, 2.5, 3.5, "legumes"],
  ["soupe_legumes", "Soupe de légumes", 300, 35, 1.2, 5, 1, 1.5, 2, "legumes"],
  ["avocat", "Avocat", 80, 160, 2, 1.8, 15, 6.7, .7, "legumes_gras"],
  ["pomme", "Pomme", 150, 52, .3, 12, .2, 2.4, 10, "fruit"],
  ["banane", "Banane", 120, 90, 1.1, 20, .3, 2.6, 12, "fruit_banane"],
  ["orange", "Orange", 150, 47, .9, 9, .1, 2.4, 9, "agrume"],
  ["fruits_rouges", "Fruits rouges", 100, 45, .8, 8, .3, 4, 7, "agrume"],
  ["compote", "Compote", 100, 70, .3, 16, .1, 1.5, 14, "fruit"],
  ["amandes", "Amandes / noix", 30, 600, 21, 8, 52, 12, 4.4, "noix"],
  ["chocolat", "Chocolat noir 70 %", 20, 570, 8, 33, 42, 11, 24, "chocolat"],
  ["huile", "Huile d'olive", 10, 900, 0, 0, 100, 0, 0, "huile"],
  ["beurre", "Beurre", 10, 745, .7, .6, 82, 0, .6, "beurre"],
  ["cafe_lait", "Café au lait", 250, 30, 1.7, 2.6, 1.4, 0, 2.6, "lait"],
  ["jus_orange", "Jus d'orange", 250, 45, .7, 10, .2, .2, 9, "agrume"],
  ["soda", "Soda sucré", 330, 42, 0, 10.6, 0, 0, 10.6, "boisson"],
  ["biere", "Bière", 330, 43, .5, 3.6, 0, 0, 0, "boisson"],
  ["vin", "Vin", 150, 85, .1, 2.6, 0, 0, .6, "boisson"],
  ["kebab", "Kebab", 350, 215, 12, 20, 9.5, 1.5, 2, "sandwich"],
  ["salade_pates", "Salade de pâtes", 250, 160, 5, 22, 6, 1.5, 2, "pates"]
];
// Micronutriments pour 100 g par type d'aliment : vA µg, vC mg, vD µg, vE mg, vK µg, vB6 mg, vB9 µg, vB12 µg, ca mg, fe mg, mg mg, k mg, zn mg, na mg
const MICRO_CAT = {
  patisserie: [80, 1, .4, 1.5, 4, .05, 15, .2, 40, 1.2, 12, 110, .4, 220], patisserie_noix: [30, .5, .2, 6, 4, .1, 25, .1, 60, 1.6, 60, 220, 1.2, 150],
  patisserie_frit: [30, 0, .2, 2.5, 8, .05, 30, .1, 30, 1.5, 15, 100, .4, 300], patisserie_lait: [120, .5, .4, 1, 2, .05, 15, .4, 120, .8, 15, 140, .6, 120],
  patisserie_choco: [60, 0, .4, 1.5, 3, .05, 15, .2, 45, 2.5, 50, 250, .9, 300], patisserie_fruit: [90, 8, .3, 1, 3, .05, 15, .2, 40, .8, 10, 140, .3, 180],
  dessert_lacte: [120, .5, .5, .4, 1, .05, 8, .4, 110, .3, 12, 160, .5, 70], dessert_choco: [100, 0, .6, 1, 2, .05, 15, .4, 60, 2, 50, 220, .9, 60],
  viande_boeuf: [5, 0, .2, .4, 1.5, .45, 7, 2.2, 12, 2.6, 22, 330, 5, 60], viande_porc: [3, .5, .6, .3, 0, .5, 5, .7, 20, 1, 24, 350, 2.6, 250],
  volaille_gras: [25, 0, .1, .7, 4, .25, 10, .3, 15, 2.5, 18, 250, 2, 350], poulet: [9, 0, .1, .3, .3, .6, 4, .3, 15, .9, 29, 255, 1, 74],
  poulet_frit: [40, 0, .2, .5, 3, .4, 5, .3, 15, 1, 18, 200, 1.7, 450], plat_poulet_sauce: [60, 4, .1, 1, 8, .25, 12, .2, 25, 1.1, 25, 260, 1, 350],
  poisson: [10, 6, 3, .8, 2, .4, 10, 2, 20, .7, 30, 350, .5, 250], poisson_gras: [30, 0, 10, 2.5, .5, .6, 20, 3.5, 12, .5, 30, 380, .5, 70],
  poisson_frit: [10, 5, 1.5, 2, 8, .3, 15, .8, 20, .8, 25, 350, .4, 300], poisson_riz: [15, 1, 2, .4, 3, .15, 8, .8, 10, .4, 15, 110, .6, 400],
  fruits_mer: [30, 4, .3, 1.5, 1, .1, 30, 12, 60, 4, 40, 250, 5, 350], fruits_mer_frit: [15, 1, .2, 2, 10, .1, 15, 1.5, 40, 1, 25, 200, 1.2, 450],
  abats: [1000, 1, .5, .5, 5, .1, 60, 9, 10, 5, 12, 140, .9, 700], oeufs: [140, 1, 1.5, 1.2, 4, .12, 40, .8, 55, 1.5, 12, 140, 1.1, 350],
  fromage: [250, 0, .5, .6, 3, .08, 20, 1.5, 650, .4, 28, 100, 3.5, 650], lait: [15, 1, .03, .03, .2, .04, 5, .45, 120, 0, 11, 150, .4, 44],
  salade_fromage: [100, 12, .1, 1.8, 25, .1, 25, .4, 180, .6, 15, 220, .9, 380], salade_composee: [120, 8, .2, 1.2, 60, .15, 40, .3, 90, 1, 15, 250, .8, 400],
  legumes: [30, 6, 0, .8, 8, .06, 80, 0, 20, .8, 20, 300, .3, 200], legumes_verts: [300, 15, 0, .6, 120, .1, 100, 0, 40, 1, 15, 250, .3, 20],
  legumes_orange: [830, 6, 0, .7, 13, .14, 19, 0, 33, .3, 12, 320, .2, 69], legumes_gras: [10, 10, 0, 2, 20, .25, 80, 0, 15, .6, 28, 450, .6, 250],
  legumineuses: [2, 1, 0, 1, 6, .2, 80, 0, 50, 2.5, 60, 300, 1.5, 300], frit: [10, 5, 0, 1.5, 15, .3, 25, 0, 18, .8, 30, 500, .4, 300],
  pain: [20, 3, 0, 1, 10, .1, 60, 0, 60, 2, 25, 150, .8, 480], sandwich: [50, 2, .2, .8, 6, .2, 40, .6, 120, 2, 22, 220, 1.6, 600],
  sandwich_mer: [40, 1, .2, 1, 6, .15, 35, 1.5, 70, 1.2, 25, 200, 2, 600], burger: [20, 1, .1, .4, 3, .15, 35, 1, 60, 2.3, 20, 230, 2.3, 450],
  pizza: [70, 2, .2, .9, 5, .1, 40, .5, 190, 2, 22, 180, 1.3, 600], pates: [30, 4, 0, .8, 5, .08, 15, .1, 30, 1, 20, 150, .6, 300],
  pates_viande: [60, 4, .1, 1, 6, .12, 15, .6, 70, 1.4, 22, 250, 1.5, 380], pates_fromage: [70, 0, .3, .4, 1, .06, 12, .4, 130, .8, 18, 110, 1, 400],
  nouilles: [20, 3, .3, 1, 10, .12, 20, .3, 40, 1, 25, 150, .9, 550], plat_riz: [40, 2, .2, .6, 10, .12, 15, .3, 25, .9, 18, 130, .8, 380],
  plat_riz_mer: [30, 4, 1, .8, 6, .15, 15, 2, 35, 1.5, 25, 200, 1, 400], asiatique: [20, 2, .1, .8, 10, .15, 20, .3, 25, 1.2, 18, 170, 1, 500],
  soupe: [20, 1, 0, .2, 3, .05, 10, .1, 20, .6, 12, 130, .3, 450], soupe_creme: [50, 2, .3, .3, 2, .05, 8, 3, 50, 1.2, 12, 180, .6, 400],
  soupe_fromage: [40, 2, .1, .2, 2, .05, 10, .2, 90, .5, 10, 120, .5, 420], soupe_nouilles: [10, 1, .1, .2, 5, .08, 8, .3, 15, .7, 10, 120, .6, 380],
  petitdej_sucre: [60, .5, .5, .6, 2, .05, 20, .3, 90, 1.6, 15, 140, .5, 400], cereales: [0, 10, 2, 1, 1, 1.4, 200, 1.5, 100, 12, 40, 200, 3, 400],
  cereales_completes: [0, 0, 0, .4, 2, .12, 32, 0, 50, 4, 140, 360, 3.6, 5], fruit: [3, 5, 0, .2, 2, .04, 3, 0, 6, .1, 5, 107, .04, 1],
  fruit_banane: [3, 9, 0, .1, .5, .37, 20, 0, 5, .3, 27, 360, .15, 1], agrume: [11, 45, 0, .2, 1, .06, 30, 0, 40, .1, 10, 180, .07, 1],
  noix: [0, 0, 0, 25, 0, .14, 44, 0, 270, 3.7, 270, 730, 3.1, 1], chocolat: [2, 0, 0, .6, 7, .04, 12, .3, 73, 11, 228, 715, 3.3, 20],
  huile: [0, 0, 0, 14, 60, 0, 0, 0, 1, .6, 0, 1, 0, 2], beurre: [680, 0, 1.5, 2.3, 7, 0, 3, .2, 24, 0, 2, 24, .1, 11],
  boisson: [0, 0, 0, 0, 0, .02, 1, 0, 5, 0, 5, 20, 0, 5], defaut: [30, 2, .2, .5, 5, .1, 15, .3, 40, 1, 20, 200, .6, 300]
};
const FOODS = {};
[...DISHES, ...BASICS].forEach(([id, name, portion, kcal, p, c, f, fib, sug, cat]) => FOODS[id] = { id, name, portion, kcal, p, c, f, fib, sug, cat });
const norm = s => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
function makeItem(id, grams) {
  const F = FOODS[id], k = grams / 100, mc = MICRO_CAT[F.cat] || MICRO_CAT.defaut;
  const it = { name: F.name, food: id, cat: F.cat, grams, kcal: F.kcal * k, protein: F.p * k, carbs: F.c * k, fat: F.f * k, fiber: F.fib * k, sugar: F.sug * k, micro: Object.fromEntries(MICRO_KEYS.map((m, i) => [m, mc[i] * k])) };
  it.base = { ...it, micro: { ...it.micro } };
  return it;
}
function searchFoods(q) {
  const n = norm(q.trim()); if (!n) return [];
  return Object.values(FOODS).map(F => { const nm = norm(F.name), i = nm.indexOf(n); return { F, s: i < 0 ? -1 : (i === 0 ? 0 : 1) + (DISHES.some(d => d[0] === F.id) ? .5 : 0) }; })
    .filter(x => x.s >= 0).sort((a, b) => a.s - b.s || a.F.name.localeCompare(b.F.name)).slice(0, 7).map(x => x.F);
}
let clfPromise = null;
function getClassifier() {
  if (!clfPromise) clfPromise = (async () => {
    const { pipeline } = await import(TF_URL);
    const files = {};
    return pipeline("image-classification", MODEL_ID, { dtype: "q4", device: "wasm", progress_callback: p => {
      if (p.status === "progress" && p.total) { files[p.file] = [p.loaded, p.total]; const v = Object.values(files); st.dl = v.reduce((a, x) => a + x[0], 0) / v.reduce((a, x) => a + x[1], 0); onModelProgress(); }
    } });
  })().then(c => { st.dl = null; lsSet("modelReady", true); onModelProgress(); return c; }).catch(e => { clfPromise = null; st.dl = null; onModelProgress(); throw e; });
  return clfPromise;
}
function onModelProgress() {
  const el = $("#modelStatus"); if (!el) return;
  if (st.dl != null) { el.textContent = "Téléchargement " + R(st.dl * 100) + " %"; el.style.color = "var(--warn)"; }
  else if (lsGet("modelReady", false)) { el.textContent = "Prêt sur cet appareil ✓"; el.style.color = "var(--good)"; $("#modelDl").hidden = true; $("#keyCard").hidden = true; }
  else { el.textContent = "Pas encore téléchargé"; el.style.color = "var(--muted)"; }
}
function computeScore(items, t) {
  if (!t.kcal) return 0;
  let s = 62; const pPct = t.protein * 4 / t.kcal, fPct = t.fat * 9 / t.kcal, fib = t.fiber / t.kcal * 1000;
  if (pPct >= .2) s += 10; else if (pPct < .1) s -= 8;
  if (fib >= 14) s += 12; else if (fib >= 8) s += 5; else s -= 6;
  if (fPct > .45) s -= 10;
  if (t.sugar > 30) s -= 12; else if (t.sugar > 15) s -= 5;
  if (items.reduce((a, it) => a + (it.micro?.na || 0), 0) > 1500) s -= 8;
  const cats = items.map(i => i.cat || "");
  if (cats.some(c => /legume|salade|fruit|agrume|legumineuse/.test(c))) s += 8;
  if (cats.some(c => /frit|patisserie|dessert|boisson|chocolat/.test(c))) s -= 6;
  return Math.max(5, Math.min(97, R(s)));
}
function adviceFor(t) {
  const out = [];
  if (t.protein < 20 && t.kcal > 300) out.push("Ajoute une source de protéines (œuf, poulet, poisson, skyr ou légumineuses) pour tenir jusqu'au prochain repas.");
  if (t.fiber < 5) out.push("Complète avec des légumes ou un fruit : c'est le moyen le plus simple d'augmenter les fibres.");
  if (t.sugar > 30) out.push("Repas riche en sucres : garde-le pour une occasion et accompagne-le d'une source de protéines.");
  if (t.kcal && t.fat * 9 > t.kcal * .45) out.push("Repas riche en graisses : alterne avec une cuisson vapeur ou au four la prochaine fois.");
  if (!out.length) out.push("Repas bien équilibré : protéines, fibres et énergie sont dans de bonnes proportions.");
  return out.slice(0, 2).join(" ");
}
function tagsFor(t) {
  const tags = [];
  if (t.protein >= 30 || (t.kcal && t.protein * 4 / t.kcal >= .25)) tags.push("riche en protéines");
  if (t.fiber >= 8) tags.push("riche en fibres");
  if (t.sugar > 25) tags.push("sucré");
  if (t.kcal && t.fat * 9 / t.kcal > .45) tags.push("gras");
  if (t.kcal && t.kcal < 350) tags.push("léger");
  return tags.slice(0, 3);
}
function showMsg(title, msg) { const r = $("#result"); r.hidden = false; r.innerHTML = `<div class="empty"><svg class="fox" viewBox="0 0 64 64">${FOX.slice(FOX.indexOf(">") + 1, -6)}</svg><b>${esc(title)}</b><span>${esc(msg)}</span></div>`; }

let stepTimer, elapsedTimer;
function setThinking(on) {
  $("#thinking").hidden = !on; $("#resultEmpty").hidden = true; if (on) $("#result").hidden = true;
  drop.classList.toggle("scanning", on && !!st.photo);
  clearInterval(stepTimer); clearInterval(elapsedTimer);
  const steps = $$("#steps div"); steps.forEach(s => s.classList.remove("on", "done"));
  $("#prog").style.width = "0%"; $("#elapsed").textContent = "";
  if (on) {
    const t0 = Date.now(); let i = 0; steps[0].classList.add("on");
    stepTimer = setInterval(() => { if (st.dl != null) return; if (i < steps.length - 1) { steps[i].classList.add("done"); i++; steps[i].classList.add("on"); } }, 600);
    elapsedTimer = setInterval(() => {
      if (st.dl != null) { $("#elapsed").textContent = "téléchargement du modèle " + R(st.dl * 100) + " %"; $("#prog").style.width = R(st.dl * 100) + "%"; return; }
      const s = (Date.now() - t0) / 1000; $("#elapsed").textContent = R(s) + " s"; $("#prog").style.width = Math.min(95, 100 * (1 - Math.exp(-s / 1.5))) + "%";
    }, 150);
    if (innerWidth < 880) $("#resultCard").scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "nearest" });
  }
  updateAnalyzeBtn();
}
async function analyze(withPhoto) {
  if (!withPhoto) { st.analysis = { dish: "", items: [], withPhoto: false, confidence: 1, alts: [] }; $("#resultEmpty").hidden = true; $("#thinking").hidden = true; renderResult(false); setTimeout(() => $("#addFood")?.focus(), 60); return; }
  if (!st.photo) return;
  const run = st.runId = (st.runId || 0) + 1;
  st.stream = { abort() { st.runId++; st.stream = null; setThinking(false); $("#resultEmpty").hidden = false; toast("Analyse arrêtée"); } };
  $("#labels").innerHTML = ""; setThinking(true);
  try {
    const clf = await getClassifier();
    if (run !== st.runId) return;
    const res = await clf(st.photo.preview, { top_k: 5 });
    if (run !== st.runId) return;
    st.stream = null; setThinking(false);
    const top = res.filter(r => FOODS[r.label]);
    if (!top.length) throw new Error("aucun résultat");
    const best = top[0];
    st.analysis = { dish: FOODS[best.label].name, items: [makeItem(best.label, FOODS[best.label].portion)], withPhoto: true, confidence: best.score, alts: top.slice(0, 4).map(r => ({ id: r.label, score: r.score })) };
    renderResult(true); placeLabels();
  } catch (e) {
    if (run !== st.runId) return;
    st.stream = null; setThinking(false);
    showMsg("Analyse impossible", !lsGet("modelReady", false) ? "Le modèle doit être téléchargé une première fois (60 Mo) : vérifie ta connexion internet, idéalement en Wi-Fi, puis réessaie." : "La photo n'a pas pu être analysée. Réessaie, ou utilise la saisie manuelle.");
  }
}
const clamp01 = v => Math.max(.06, Math.min(.94, Number.isFinite(+v) ? +v : .5));
function placeLabels() {
  const a = st.analysis; if (!a?.withPhoto || !a.items.length) { $("#labels").innerHTML = ""; return; }
  const it = a.items[0];
  $("#labels").innerHTML = `<div class="lbl" style="left:50%;top:50%"><span class="d"></span><span class="tx" style="animation-delay:.12s">${esc(it.name)}<b>${fmt(it.kcal)}</b></span></div>`;
}
$("#analyzeBtn").addEventListener("click", () => analyze(true));
$("#textOnlyBtn").addEventListener("click", () => analyze(false));
$("#stopBtn").addEventListener("click", () => st.stream?.abort());

function renderResult(animate) {
  const a = st.analysis, r = $("#result"); r.hidden = false;
  const search = `<div class="field" style="margin-top:14px"><label for="addFood">${a.items.length ? "Ajouter un aliment à l'assiette" : "Cherche un plat ou un aliment"}</label>
    <input class="input" id="addFood" type="search" placeholder="Ex. : pizza, riz, poulet, salade, soda…" autocomplete="off"><div id="sugg" style="display:grid;gap:6px;margin-top:6px"></div></div>`;
  if (!a.items.length) {
    r.innerHTML = `<div class="result-head"><div><div class="eyebrow">Saisie manuelle</div><h2>Compose ton repas</h2></div></div><p class="note" style="margin-top:6px">Ajoute chaque élément de ton assiette, puis ajuste les grammes.</p>${search}`;
    bindSearch(); return;
  }
  const { totals } = totalsFromItems(a.items);
  const spread = Math.max(50, R(totals.kcal * .2 / 10) * 10), lo = Math.max(0, R((totals.kcal - spread) / 10) * 10), hi = R((totals.kcal + spread) / 10) * 10;
  const sc = computeScore(a.items, totals), scCol = sc >= 70 ? "var(--good)" : sc >= 45 ? "var(--warn)" : "var(--bad)", tags = tagsFor(totals), advice = adviceFor(totals);
  const title = a.items.length > 1 ? a.items.slice(0, 2).map(i => i.name).join(" + ") + (a.items.length > 2 ? " …" : "") : a.items[0].name;
  const conf = a.withPhoto ? `reconnu sur l'iPhone · confiance ${R(a.confidence * 100)} %` : "saisie manuelle";
  const altList = (a.alts || []).slice(1).filter(x => x.score >= .02);
  const alts = !a.withPhoto ? "" : !altList.length ? `<div class="note" style="margin-top:10px">Ce n'est pas ça ? Retire-le avec ✕ et cherche le bon plat plus bas.</div>` : `<div class="note" style="margin-top:10px">${a.confidence < .6 ? "<b style='color:var(--warn)'>Pas sûr ?</b> " : ""}Ce n'est pas ça ? Touche le bon plat :</div><div class="tags">${altList.map(x => `<button class="tag" type="button" data-alt="${x.id}" style="border:0;cursor:pointer">${esc(FOODS[x.id].name)} · ${R(x.score * 100)} %</button>`).join("")}</div>`;
  r.innerHTML = `<div class="result-head"><div style="min-width:0"><div class="eyebrow">${MEALTYPES[st.mealType]} · ${conf}</div><h2>${esc(title)}</h2>
      <div class="tags">${tags.map(t => `<span class="tag">${esc(t)}</span>`).join("")}</div></div>
    <div class="kcal-big"><b class="num" id="resKcal">${animate ? 0 : fmt(totals.kcal)}</b><span>kcal · ${fmt(lo)}–${fmt(hi)}</span></div></div>
    ${alts}
    ${macro4(totals)}
    <div class="score"><div class="s" style="background:color-mix(in srgb,${scCol} 16%,transparent);color:${scCol}">${sc}</div><div><b style="font-size:14px">Score qualité nutritionnelle</b><div class="note">Protéines, fibres, sucres, graisses et sel du repas.</div></div></div>
    <div class="sep"></div>
    <div class="items-wrap"><table class="items"><thead><tr><th>Aliment</th><th>Poids (g)</th><th>kcal</th><th>P</th><th>G</th><th>L</th><th></th></tr></thead><tbody>
      ${a.items.map((it, i) => `<tr style="animation-delay:${animate ? i * .07 : 0}s"><td>${esc(it.name)}</td><td><input type="number" inputmode="numeric" min="0" step="5" value="${R(it.grams)}" data-i="${i}" aria-label="Poids de ${esc(it.name)} en grammes"></td><td>${fmt(it.kcal)}</td><td>${fmt(it.protein, 1)}</td><td>${fmt(it.carbs, 1)}</td><td>${fmt(it.fat, 1)}</td><td><button class="x" type="button" data-rm="${i}" aria-label="Retirer ${esc(it.name)}">✕</button></td></tr>`).join("")}
    </tbody></table></div>
    <p class="note">Ajuste le poids de chaque élément : tout se recalcule. Valeurs moyennes issues des tables CIQUAL et USDA.</p>
    ${search}
    <div class="advice">${FORK}<div>${esc(advice)}</div></div>
    <div class="sep"></div>
    <div class="row"><button class="btn primary" id="saveMeal" type="button" style="flex:1"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 12l5 5L20 7"/></svg>Ajouter au journal</button>${a.withPhoto && st.photo ? '<button class="btn" id="reanalyze" type="button">Réanalyser</button>' : ""}</div>`;
  if (animate) countUp($("#resKcal"), R(totals.kcal), { dur: 1500 });
  r.querySelectorAll("input[data-i]").forEach(inp => inp.addEventListener("change", () => {
    const it = a.items[+inp.dataset.i], b = it.base, g = Math.max(0, +inp.value || 0), f = b.grams ? g / b.grams : 0;
    MACRO_KEYS.forEach(k => it[k] = b[k] * f); MICRO_KEYS.forEach(k => it.micro[k] = b.micro[k] * f); it.grams = g;
    renderResult(false); placeLabels();
  }));
  r.querySelectorAll("[data-rm]").forEach(btn => btn.addEventListener("click", () => { a.items.splice(+btn.dataset.rm, 1); renderResult(false); placeLabels(); }));
  r.querySelectorAll("[data-alt]").forEach(btn => btn.addEventListener("click", () => {
    const id = btn.dataset.alt, alt = a.alts.find(x => x.id === id);
    a.items[0] = makeItem(id, FOODS[id].portion); a.confidence = alt.score; a.alts = [alt, ...a.alts.filter(x => x.id !== id)];
    renderResult(false); placeLabels(); toast("Plat corrigé : " + FOODS[id].name);
  }));
  const re = $("#reanalyze"); if (re) re.onclick = () => analyze(true);
  $("#saveMeal").onclick = () => {
    const t = totalsFromItems(a.items), round = (v, d) => +(+v).toFixed(d);
    const meal = {
      id: newId(), at: scanAt(), type: st.mealType, dish: title,
      items: a.items.map(({ base, ...it }) => ({ ...it, grams: R(it.grams), kcal: R(it.kcal), protein: round(it.protein, 1), carbs: round(it.carbs, 1), fat: round(it.fat, 1), fiber: round(it.fiber, 1), sugar: round(it.sugar, 1), micro: Object.fromEntries(MICRO_KEYS.map(k => [k, round(it.micro[k], 2)])) })),
      totals: Object.fromEntries(MACRO_KEYS.map(k => [k, round(t.totals[k], 1)])), micro: Object.fromEntries(MICRO_KEYS.map(k => [k, round(t.micro[k], 2)])),
      kcal_low: lo, kcal_high: hi, score: sc, confidence: a.withPhoto ? a.confidence : 1, advice, tags,
      thumb: a.withPhoto && st.photo ? st.photo.thumb : null
    };
    saveMeal(meal); success(); setTimeout(confetti, 250); toast("Repas ajouté : " + fmt(meal.totals.kcal) + " kcal");
    st.view = dayKey(meal.at); resetScan(); setTimeout(() => go("today"), 900);
  };
  bindSearch();
}
function bindSearch() {
  const inp = $("#addFood"), box = $("#sugg"); if (!inp) return;
  const draw = () => {
    const list = searchFoods(inp.value);
    box.innerHTML = list.map(F => `<button class="meal" type="button" data-add="${F.id}" style="grid-template-columns:minmax(0,1fr) auto;padding:10px 12px;animation:none"><span class="nm">${esc(F.name)}</span><span class="note num">${F.portion} g · ${fmt(F.kcal * F.portion / 100)} kcal</span></button>`).join("")
      || (inp.value.trim() ? `<span class="note">Aucun résultat. Essaie un autre mot (ex. : « riz », « poulet », « gâteau »).</span>` : "");
    box.querySelectorAll("[data-add]").forEach(b => b.addEventListener("click", () => { const F = FOODS[b.dataset.add]; st.analysis.items.push(makeItem(F.id, F.portion)); renderResult(false); placeLabels(); toast(F.name + " ajouté"); }));
  };
  inp.addEventListener("input", draw);
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
$("#aiReportBtn").addEventListener("click", () => {
  const out = $("#aiReport"), T = targets(), days = periodDays(st.repRange), map = byDay();
  const logged = days.filter(k => map[k]).map(k => sumMeals(map[k]));
  if (!logged.length) { out.textContent = "Aucun repas sur cette période : ajoute des repas pour obtenir un bilan."; return; }
  const n = logged.length, avg = k => logged.reduce((a, s) => a + s[k], 0) / n;
  const K = avg("kcal"), P = avg("protein"), F = avg("fiber"), S = avg("sugar"), NA = avg("na"), dK = K - T.kcal;
  const inT = logged.filter(s => Math.abs(s.kcal / T.kcal - 1) <= .1).length;
  const low = [...MICRO.vit, ...MICRO.min].filter(m => m[0] !== "na").map(([k, nm, u, ref]) => ({ nm, p: avg(k) / ref })).sort((a, b) => a.p - b.p).filter(m => m.p < .6).slice(0, 3);
  const good = [], fix = [], plan = [], s = x => (x > 1 ? "s" : "");
  if (P >= T.protein * .9) good.push(`Protéines solides : ${fmt(P)} g par jour en moyenne (${R(P / T.protein * 100)} % de ta cible).`);
  if (F >= T.fiber * .8) good.push(`Bon apport en fibres : ${fmt(F)} g par jour.`);
  if (inT >= n / 2) good.push(`Régularité : ${inT} jour${s(inT)} sur ${n} dans ta cible calorique (±10 %).`);
  if (S <= 50) good.push(`Sucres maîtrisés : ${fmt(S)} g par jour en moyenne.`);
  if (!good.length) good.push(`Tu as suivi ${n} jour${s(n)} : c'est la base pour progresser.`);
  if (Math.abs(dK) > T.kcal * .1) { fix.push(`Énergie ${dK > 0 ? "au-dessus" : "en dessous"} de l'objectif : ${fmt(K)} kcal par jour pour ${fmt(T.kcal)} visées (${dK > 0 ? "+" : "−"}${fmt(Math.abs(dK))} kcal).`); plan.push(dK > 0 ? "Réduis d'un tiers les portions de féculents et remplace les boissons sucrées par de l'eau : environ −300 kcal par jour." : "Ajoute une collation de 250 à 300 kcal : un yaourt, un fruit et une poignée d'amandes."); }
  if (P < T.protein * .9) { fix.push(`Protéines un peu justes : ${fmt(P)} g pour ${T.protein} g visés.`); plan.push("Vise 25 à 30 g de protéines par repas : 150 g de poulet, 2 œufs avec 150 g de skyr, ou 200 g de lentilles."); }
  if (F < T.fiber * .8) { fix.push(`Fibres insuffisantes : ${fmt(F)} g pour ${T.fiber} g visés.`); plan.push("Ajoute 150 g de légumes au déjeuner et au dîner, et un fruit entier en collation."); }
  if (S > 50) { fix.push(`Sucres élevés : ${fmt(S)} g par jour.`); plan.push("Remplace le dessert sucré par un fruit ou un yaourt nature 4 jours sur 7."); }
  if (NA > 2300) { fix.push(`Sel élevé : environ ${fmt(NA / 400, 1)} g de sel par jour.`); plan.push("Limite charcuteries, plats préparés et sauces : cuisine maison avec herbes et épices."); }
  if (low.length) {
    fix.push(`Micronutriments à surveiller : ${low.map(m => `${m.nm} (${R(m.p * 100)} %)`).join(", ")}.`);
    const l = low[0].nm;
    plan.push(/Vit\. D/.test(l) ? "Mange un poisson gras (saumon, sardines, maquereau) deux fois par semaine." : /Fer/.test(l) ? "Associe légumineuses ou viande rouge maigre à un aliment riche en vitamine C (agrumes, poivron)." : /Calcium/.test(l) ? "Prévois 2 à 3 produits laitiers par jour : yaourt, fromage blanc ou lait." : /Magnésium|Potassium/.test(l) ? "Ajoute chaque jour des légumineuses, des oléagineux ou une banane." : "Varie davantage : un légume vert, un fruit coloré et une portion de céréales complètes chaque jour.");
  }
  if (!fix.length) fix.push("Rien d'important à corriger sur cette période : continue ainsi.");
  const extra = ["Garde ce rythme : scanne chaque repas pour que ton bilan soit le plus juste possible.", "Bois 1,5 à 2 L d'eau par jour, surtout les jours d'entraînement.", "Prépare tes déjeuners à l'avance deux fois par semaine pour garder le cap."];
  for (let i = 0; plan.length < 3; i++) plan.push(extra[i]);
  const text = `VERDICT\nSur ${n} jour${s(n)} suivi${s(n)}, tu es en moyenne à ${fmt(K)} kcal par jour pour un objectif de ${fmt(T.kcal)} kcal (${dK >= 0 ? "+" : "−"}${fmt(Math.abs(dK))}). Protéines : ${fmt(P)} g, fibres : ${fmt(F)} g par jour.\n\nPOINTS FORTS\n${good.slice(0, 2).map(x => "– " + x).join("\n")}\n\nÀ CORRIGER\n${fix.slice(0, 3).map(x => "– " + x).join("\n")}\n\nPLAN D'ACTION\n${plan.slice(0, 3).map(x => "– " + x).join("\n")}\n\nBilan calculé sur ton appareil à partir de tes repas. Ce n'est pas un avis médical.`;
  clearInterval(out._t); out.textContent = "";
  if (reduce) { out.textContent = text; return; }
  let i = 0; out._t = setInterval(() => { i += 9; out.textContent = text.slice(0, i); if (i >= text.length) clearInterval(out._t); }, 16);
});

/* ---------- PROFIL & RÉGLAGES ---------- */
function fillProfile() { const p = st.profile; $("#pName").value = p.name || ""; $("#pSex").value = p.sex; $("#pAge").value = p.age; $("#pWeight").value = p.weight; $("#pHeight").value = p.height; $("#pAct").value = String(p.act); $("#pGoal").value = p.goal; }
function readProfile() { return { name: $("#pName").value.trim(), sex: $("#pSex").value, age: +$("#pAge").value || 28, weight: +$("#pWeight").value || 75, height: +$("#pHeight").value || 178, act: +$("#pAct").value, goal: $("#pGoal").value }; }
function renderProfile() {
  const T = targets(readProfile()), box = (v, l, i) => `<div style="animation-delay:${i * .05}s"><b class="num">${fmt(v)}</b><span>${l}</span></div>`;
  $("#targets").innerHTML = [[T.kcal, "kcal / jour"], [T.protein, "g protéines"], [T.carbs, "g glucides"], [T.fat, "g lipides"], [T.fiber, "g fibres"], [T.bmr, "kcal métab. de base"]].map((x, i) => box(x[0], x[1], i)).join("");
  onModelProgress(); $("#theme").value = st.settings.theme;
  const standalone = navigator.standalone || matchMedia("(display-mode: standalone)").matches;
  $("#installState").textContent = standalone ? "Installée sur ton écran d'accueil ✓" : "Ajoute Fox à ton écran d'accueil";
  $("#demoBtn").textContent = st.demo ? "Revenir à mes données" : "Voir avec des données d'exemple";
}
$("#profForm").addEventListener("input", e => { if (e.target.closest(".form")) { const T = targets(readProfile()); $$("#targets b").forEach((b, i) => b.textContent = fmt([T.kcal, T.protein, T.carbs, T.fat, T.fiber, T.bmr][i])); } });
$("#profForm").addEventListener("submit", e => { e.preventDefault(); st.profile = readProfile(); saveProfile(); renderAll(); success(); toast("Objectifs enregistrés : " + fmt(targets().kcal) + " kcal / jour"); });
$("#modelDl").addEventListener("click", async () => {
  $("#modelDl").disabled = true;
  try { await getClassifier(); toast("Modèle prêt : l'analyse fonctionne maintenant même hors connexion"); success(); }
  catch { toast("Téléchargement impossible : vérifie ta connexion internet."); }
  finally { $("#modelDl").disabled = false; onModelProgress(); }
});
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

function initInstallBanner() {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone || matchMedia("(display-mode: standalone)").matches;
  const b = $("#installBanner"); if (!b) return;
  b.hidden = !(ios && !standalone && !lsGet("ibClosed", false));
  $("#ibClose").addEventListener("click", () => { b.hidden = true; lsSet("ibClosed", true); });
}

/* ---------- démarrage ---------- */
async function start() {
  splash();
  clock(); setInterval(clock, 1000);
  await loadData();
  applyTheme(); fillProfile(); setMealType(autoMealType()); setScanNow();
  go(location.hash.slice(1) || "today", false);
  setTimeout(movePill, 350); document.fonts?.ready.then(movePill);
  initInstallBanner();
  if (lsGet("modelReady", false)) setTimeout(() => getClassifier().catch(() => { }), 1500);
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
