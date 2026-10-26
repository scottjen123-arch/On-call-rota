// SOLVER START
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Availability per person per date: "full" (can do either half or both), "half" (one half, either),
// "am" (first half only), "pm" (second half only). Each date has two half-slots that must be covered.
function canCover(state, h) {
  return state === "full" || state === "half" || (state === "am" && h === 0) || (state === "pm" && h === 1);
}

// Every half-slot gets someone. People who offered the slot are always preferred; a slot nobody
// offered goes to whoever has worked least overall and least recently, and is reported in `forced`.
// `history` carries earlier rotas: load/weekend deviation from the team mean, days since each
// person's last shift (negative day index), and who worked the day before this period.
function solveRota({ dates, weekend, members, avail, locked, opts, seed, history }) {
  const N = dates.length, M = members.length, ids = members.map(m => m.id);
  const H = history || {};
  const rand = mulberry32((seed >>> 0) || 1);
  const W = {
    gap: 500, forced: 300, conflict: 2000, recent: 3,
    // dayMode "split": a day two people offered is shared, one half each; "whole": one person
    // does the full day where possible; "fairest": no preference, fairness alone decides.
    split: opts.dayMode === "whole" ? 3 : 0,
    whole: opts.dayMode === "fairest" || opts.dayMode === "whole" ? 0 : 4,
    consec: opts.avoidBackToBack ? 4 : 0,
    weekend: 4, nights: 1.5,
  };
  const st = ids.map(id => dates.map(dt => (avail[id] || {})[dt] || null));
  const offered = dates.map((_, d) => ids.map((_, m) => canCover(st[m][d], 0) || canCover(st[m][d], 1)));
  const priorL = ids.map(id => (H.loadDev || {})[id] || 0);
  const priorW = ids.map(id => (H.wkDev || {})[id] || 0);
  const priorN = ids.map(id => (H.nightDev || {})[id] || 0);
  const last0 = ids.map(id => { const v = (H.last || {})[id]; return v == null ? -99 : v; });
  let prev0 = 0;
  (H.prevDay || []).forEach(id => { const i = ids.indexOf(id); if (i >= 0) prev0 |= 1 << i; });

  const ok = [], opt = [], fixed = [], everyone = ids.map((_, m) => m);
  for (let d = 0; d < N; d++) for (let h = 0; h < 2; h++) {
    const s = d * 2 + h, key = dates[d] + ":" + (h ? "pm" : "am");
    ok[s] = everyone.map(m => canCover(st[m][d], h));
    const li = locked && locked[key] != null ? ids.indexOf(locked[key]) : -1;
    if (li >= 0) { opt[s] = [li]; fixed[s] = true; }
    else { opt[s] = M ? everyone : [-1]; fixed[s] = false; }
  }
  const free = [];
  for (let s = 0; s < 2 * N; s++) if (!fixed[s] && opt[s].length > 1) free.push(s);

  function cost(a) {
    const load = new Array(M).fill(0), wl = new Array(M).fill(0), nl = new Array(M).fill(0), last = last0.slice();
    let c = 0, prev = prev0;
    for (let d = 0; d < N; d++) {
      const x = a[2 * d], y = a[2 * d + 1];
      let mask = 0;
      for (let h = 0; h < 2; h++) {
        const p = h ? y : x;
        if (p < 0) { c += W.gap; continue; }
        load[p]++; if (weekend[d]) wl[p]++; if (h) nl[p]++; mask |= 1 << p;
        if (!ok[2 * d + h][p]) {
          c += W.forced;
          const since = d - last[p];
          if (since < 7) c += W.recent * (7 - since);
        }
      }
      if (x >= 0 && y >= 0) {
        if (x !== y) c += W.split;
        else if (st[x][d] === "half") c += W.conflict;
        else if (W.whole && offered[d].some((o, m) => o && m !== x)) c += W.whole;
      }
      if (W.consec) { let both = mask & prev; while (both) { c += W.consec; both &= both - 1; } }
      for (let m = 0; m < M; m++) if (mask & (1 << m)) last[m] = d;
      prev = mask;
    }
    for (let m = 0; m < M; m++) {
      const l = load[m] + priorL[m], w = wl[m] + priorW[m], n = nl[m] + priorN[m];
      c += l * l + W.weekend * w * w + W.nights * n * n;
    }
    return c;
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
    return arr;
  }

  // Members who could take both halves of day d as one full shift.
  function pairOptions(d) {
    if (fixed[2 * d] || fixed[2 * d + 1]) return [];
    return everyone.filter(m => st[m][d] !== "half");
  }

  function greedy() {
    const a = new Array(2 * N).fill(-1);
    for (let s = 0; s < 2 * N; s++) if (fixed[s] || opt[s].length === 1) a[s] = opt[s][0];
    const order = shuffle(free.slice()).sort((p, q) => ok[p].filter(Boolean).length - ok[q].filter(Boolean).length);
    for (const s of order) {
      let best = Infinity, pick = -1, ties = 0;
      for (const o of opt[s]) {
        a[s] = o; const c = cost(a);
        if (c < best) { best = c; pick = o; ties = 1; }
        else if (c === best && rand() < 1 / ++ties) pick = o;
      }
      a[s] = pick;
    }
    return a;
  }

  function anneal(a) {
    let cur = cost(a), best = cur, bestA = a.slice();
    if (!free.length) return { a: bestA, c: best };
    const iters = 6000, T0 = 8, T1 = 0.05, cool = Math.pow(T1 / T0, 1 / iters);
    let T = T0;
    for (let i = 0; i < iters; i++, T *= cool) {
      if (rand() < 0.3) {
        const d = Math.floor(rand() * N), po = pairOptions(d);
        if (!po.length) continue;
        const m = po[Math.floor(rand() * po.length)], o0 = a[2 * d], o1 = a[2 * d + 1];
        if (o0 === m && o1 === m) continue;
        a[2 * d] = m; a[2 * d + 1] = m;
        const nc = cost(a);
        if (nc <= cur || rand() < Math.exp((cur - nc) / T)) { cur = nc; if (nc < best) { best = nc; bestA = a.slice(); } }
        else { a[2 * d] = o0; a[2 * d + 1] = o1; }
      } else {
        const s = free[Math.floor(rand() * free.length)];
        const o = opt[s][Math.floor(rand() * opt[s].length)], old = a[s];
        if (o === old) continue;
        a[s] = o;
        const nc = cost(a);
        if (nc <= cur || rand() < Math.exp((cur - nc) / T)) { cur = nc; if (nc < best) { best = nc; bestA = a.slice(); } }
        else a[s] = old;
      }
    }
    return { a: bestA, c: best };
  }

  // Deterministic finish: keep applying the best single, full-day or swap move until none helps.
  function polish(a) {
    let cur = cost(a), improved = true;
    while (improved) {
      improved = false;
      for (const s of free) {
        const old = a[s];
        for (const o of opt[s]) {
          if (o === old) continue;
          a[s] = o; const nc = cost(a);
          if (nc < cur) { cur = nc; improved = true; break; }
          a[s] = old;
        }
      }
      for (let d = 0; d < N; d++) {
        const o0 = a[2 * d], o1 = a[2 * d + 1];
        for (const m of pairOptions(d)) {
          if (o0 === m && o1 === m) continue;
          a[2 * d] = m; a[2 * d + 1] = m; const nc = cost(a);
          if (nc < cur) { cur = nc; improved = true; break; }
          a[2 * d] = o0; a[2 * d + 1] = o1;
        }
      }
      // Swap two people's slots, which a single move can't reach without passing through a worse state.
      for (let i = 0; i < free.length; i++) for (let j = i + 1; j < free.length; j++) {
        const s = free[i], t = free[j];
        if (a[s] === a[t]) continue;
        [a[s], a[t]] = [a[t], a[s]];
        const nc = cost(a);
        if (nc < cur) { cur = nc; improved = true; } else [a[s], a[t]] = [a[t], a[s]];
      }
    }
    return { a, c: cur };
  }

  let best = null;
  for (let r = 0; r < 6; r++) {
    const res = polish(anneal(greedy()).a);
    if (!best || res.c < best.c) best = res;
  }
  const assign = {}, forced = [];
  dates.forEach((dt, d) => {
    const x = best.a[2 * d], y = best.a[2 * d + 1];
    assign[dt] = { am: x >= 0 ? ids[x] : null, pm: y >= 0 ? ids[y] : null };
    if (x >= 0 && !ok[2 * d][x]) forced.push(dt + ":am");
    if (y >= 0 && !ok[2 * d + 1][y]) forced.push(dt + ":pm");
  });
  return { assign, forced, score: best.c };
}
// SOLVER END

/* ---------- dates ---------- */
const PERIOD = 14;
const DEFAULT_ANCHOR = "2026-01-05"; // a Monday; rotas run in fortnights counted from here
const DEFAULT_SHIFT = { amName: "Day", amTime: "08:00–20:00", pmName: "Night", pmTime: "20:00–08:00" };
const DEFAULT_OPTS = { dayMode: "split", avoidBackToBack: true };
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const WD = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const pad = n => String(n).padStart(2, "0");
function toUTC(dt) { const [y, m, d] = dt.split("-").map(Number); return Date.UTC(y, m - 1, d); }
function fromUTC(t) { const x = new Date(t); return x.getUTCFullYear() + "-" + pad(x.getUTCMonth() + 1) + "-" + pad(x.getUTCDate()); }
const addDays = (dt, n) => fromUTC(toUTC(dt) + n * 86400000);
const daysBetween = (a, b) => Math.round((toUTC(b) - toUTC(a)) / 86400000);
const dowOf = dt => new Date(toUTC(dt)).getUTCDay();
const isWeekend = dt => { const w = dowOf(dt); return w === 0 || w === 6; };
const dayNum = dt => Number(dt.slice(8));
const monShort = dt => MONTHS[Number(dt.slice(5, 7)) - 1].slice(0, 3);
function todayStr() { const t = new Date(); return t.getFullYear() + "-" + pad(t.getMonth() + 1) + "-" + pad(t.getDate()); }
function periodStartOf(dt, anchor) { return addDays(anchor, Math.floor(daysBetween(anchor, dt) / PERIOD) * PERIOD); }
function upcomingStart(anchor) { const t = todayStr(), s = periodStartOf(t, anchor); return s === t ? s : addDays(s, PERIOD); }
const periodDates = start => Array.from({ length: PERIOD }, (_, i) => addDays(start, i));
const monthsOf = dates => [...new Set(dates.map(d => d.slice(0, 7)))];
function periodLabel(start) {
  const end = addDays(start, PERIOD - 1);
  return `${dayNum(start)} ${monShort(start)} – ${dayNum(end)} ${monShort(end)} ${end.slice(0, 4)}`;
}
const shortDate = dt => `${WD[dowOf(dt)]} ${dayNum(dt)} ${monShort(dt)}`;
const validDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || "");

/* ---------- helpers ---------- */
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clone = o => JSON.parse(JSON.stringify(o));
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }
function uid() { return "m" + Math.random().toString(36).slice(2, 9); }

/* ---------- state ---------- */
const S = {
  anchor: DEFAULT_ANCHOR,
  start: upcomingStart(DEFAULT_ANCHOR),
  navigated: false,
  mode: "loading",          // loading | shared | join | local | demo
  offline: false,
  joinError: null,
  team: null,               // [{id, name}]
  shift: { ...DEFAULT_SHIFT },
  opts: { ...DEFAULT_OPTS },
  availBy: {},              // month -> memberId -> {date: state}
  rotas: {},                // period start -> {start, assign, locked, agreed, seed, generatedAt}
  me: lsGet("rota-me"),
  brush: "full",
  tab: lsGet("rota-tab") || "avail",
  readOnly: false,
  notice: null,
  busy: false,
  sheet: null,
  teamDraft: null,
};
const curRota = () => S.rotas[S.start] || null;

/* ---------- storage ---------- */
// Shared data lives in a Google Sheet, reached through its Apps Script web app (config.js → apiUrl).
// Records: settings/team, availability/<YYYY-MM>_<id> (one person, one calendar month),
// rotas/<start date> (one fortnight). Every request carries the team key from the team link.
const API = ((window.ROTA_CONFIG && window.ROTA_CONFIG.apiUrl) || "").trim();
const POLL_MS = 20000;
let teamKey = null, pollTimer = null, loading = false, reloadAfter = false, writeSeq = 0, sheetUrl = "", lastSig = "";
let L = null; // local / demo store: {team, shift, opts, anchor, avail: {month: {mid: days}}, rotas: {start: rota}}
const pending = {}, timers = {}, chains = {}; // pending: path -> {data} not yet confirmed by the sheet

function loadLocal() {
  try { L = JSON.parse(lsGet("rota-local-v2") || "null"); } catch { L = null; }
  if (!L) L = { team: [], shift: { ...DEFAULT_SHIFT }, opts: { ...DEFAULT_OPTS }, anchor: DEFAULT_ANCHOR, avail: {}, rotas: {} };
  applyLocal();
}
function saveLocal() { if (S.mode === "local") lsSet("rota-local-v2", JSON.stringify(L)); }
function applyLocal() {
  S.team = clone(L.team || []);
  S.shift = { ...DEFAULT_SHIFT, ...(L.shift || {}) };
  S.opts = { ...DEFAULT_OPTS, ...(L.opts || {}) };
  setAnchor(L.anchor || DEFAULT_ANCHOR);
  S.availBy = clone(L.avail || {});
  S.rotas = clone(L.rotas || {});
}
function setAnchor(a) {
  a = validDate(a) ? a : DEFAULT_ANCHOR;
  if (a === S.anchor) return false;
  S.anchor = a;
  S.start = S.navigated ? periodStartOf(S.start, a) : upcomingStart(a);
  return true;
}

async function call(body) {
  let res;
  try {
    res = await fetch(API, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ k: teamKey, ...body }) });
  } catch { throw { code: "network" }; }
  if (!res.ok) throw { code: "network" };
  let out;
  try { out = await res.json(); } catch { throw { code: "server" }; }
  if (!out || !out.ok) throw { code: (out && out.error) || "server" };
  return out;
}

function chain(path, fn) {
  chains[path] = (chains[path] || Promise.resolve()).then(fn, fn);
  return chains[path];
}
function onWriteError(e) {
  const code = e && e.code;
  if (code === "bad_key") return badKey();
  S.notice = { kind: "warn", text: code === "network"
    ? "That change didn’t save because the rota couldn’t reach the Google Sheet. Check your connection and try again."
    : "That change didn’t save. Try again in a moment." };
  render();
}
function badKey() {
  stopShared();
  teamKey = null; lsSet("rota-key", "");
  S.mode = "join";
  S.joinError = "That team link isn’t valid any more. Ask whoever runs the rota for the current link.";
  render();
}

// Send one record to the sheet. `extra` carries the readable tab for rotas.
function write(path, data, extra) {
  const entry = { data };
  pending[path] = entry; writeSeq++;
  return chain(path, () => call({ action: data ? "set" : "delete", path, data, ...(extra || {}) }))
    .then(() => { if (pending[path] === entry) delete pending[path]; writeSeq++; S.offline = false; })
    .catch(e => { if (pending[path] === entry) delete pending[path]; writeSeq++; onWriteError(e); });
}

// The readable "Rota …" tab in the Google Sheet for one fortnight.
function rotaSheet(start, rota) {
  const rows = [["Date", "Day", `${halfName(0)} (${halfTime(0)})`, `${halfName(1)} (${halfTime(1)})`, "Notes"]];
  periodDates(start).forEach(dt => {
    const notes = [];
    const cell = h => {
      const s = slotInfo(rota, dt, h);
      if (!s.id) { notes.push(`${halfName(h)} half uncovered`); return ""; }
      if (s.status === "ask") notes.push(`Check ${halfName(h).toLowerCase()} half with ${nameOf(s.id)}`);
      if (s.status === "agreed") notes.push(`${halfName(h)} half agreed with ${nameOf(s.id)}`);
      return nameOf(s.id);
    };
    const am = cell(0), pm = cell(1);
    rows.push([dt, WD[dowOf(dt)], am, pm, notes.join("; ")]);
  });
  return { name: "Rota " + periodLabel(start), rows };
}

const Store = {
  saveTeam(data) {
    if (S.mode === "shared") return write("settings/team", data);
    L.team = data.members; L.shift = data.shift; L.opts = data.opts; L.anchor = data.anchor; saveLocal();
    return Promise.resolve();
  },
  saveAvail(mid, month) {
    const path = "availability/" + month + "_" + mid, days = { ...((S.availBy[month] || {})[mid] || {}) };
    if (S.mode !== "shared") { (L.avail[month] ||= {})[mid] = days; saveLocal(); return; }
    const body = { month, memberId: mid, days, updatedAt: Date.now() };
    pending[path] = { data: body }; writeSeq++;
    clearTimeout(timers[path]);
    timers[path] = setTimeout(() => write(path, body), 700);
  },
  saveRota(start, rota) {
    if (S.mode !== "shared") { if (rota) L.rotas[start] = clone(rota); else delete L.rotas[start]; saveLocal(); return Promise.resolve(); }
    return write("rotas/" + start, rota ? clone(rota) : null, { sheet: rota ? rotaSheet(start, rota) : { name: "Rota " + periodLabel(start) } });
  },
};

function applyRecord(path, d) {
  if (path === "settings/team") {
    S.team = d && Array.isArray(d.members) ? clone(d.members) : [];
    S.shift = { ...DEFAULT_SHIFT, ...((d && d.shift) || {}) };
    S.opts = { ...DEFAULT_OPTS, ...((d && d.opts) || {}) };
    if (setAnchor(d && d.anchor)) reloadAfter = true;
  } else if (path.startsWith("availability/")) {
    if (d && d.month && d.memberId) (S.availBy[d.month] ||= {})[d.memberId] = { ...(d.days || {}) };
  } else if (path.startsWith("rotas/")) {
    const start = path.slice(6);
    if (d && d.assign) S.rotas[start] = clone(d); else delete S.rotas[start];
  }
}

// Fetch everything this fortnight needs. A poll that overlaps a save is thrown away and re-run,
// and saves not yet confirmed are laid back on top, so a slow poll never undoes a tap.
async function loadShared() {
  if (S.mode !== "shared") return;
  if (loading) { reloadAfter = true; return; }
  loading = true;
  const seq = writeSeq, start = S.start, months = monthsOf(periodDates(start));
  try {
    const out = await call({ action: "load", months: months.join(",") });
    const sig = start + JSON.stringify(out);
    if (S.mode === "shared" && (seq !== writeSeq || S.start !== start)) reloadAfter = true;
    else if (S.mode === "shared" && sig === lastSig && !S.offline && !Object.keys(pending).length) { loading = false; return; }
    else if (S.mode === "shared") {
      lastSig = sig;
      sheetUrl = out.sheetUrl || "";
      S.availBy = {}; S.rotas = {};
      applyRecord("settings/team", out.team);
      (out.availability || []).forEach(d => applyRecord("availability/" + d.month + "_" + d.memberId, d));
      (out.rotas || []).forEach(d => d && d.start && applyRecord("rotas/" + d.start, d));
      for (const path in pending) applyRecord(path, pending[path].data);
      S.offline = false;
    }
  } catch (e) {
    if (e && e.code === "bad_key") { loading = false; return badKey(); }
    if (e && e.code === "not_set_up") S.notice = { kind: "gap", text: "The Google Sheet isn’t set up yet. Run “setup” in its Apps Script editor (see the setup guide)." };
    S.offline = true;
  } finally {
    loading = false;
  }
  if (S.mode !== "shared") return;
  softRender();
  if (reloadAfter) { reloadAfter = false; setTimeout(loadShared, 50); }
}

// Polls shouldn't redraw under someone mid-typing; catch up when they leave the field.
let renderOwed = false;
function softRender() {
  const a = document.activeElement;
  if (a && (a.tagName === "TEXTAREA" || (a.tagName === "INPUT" && /^(text|date|search|)$/.test(a.type)))) { renderOwed = true; return; }
  render();
}
document.addEventListener("focusout", () => { if (renderOwed) { renderOwed = false; setTimeout(render, 0); } });

function startShared() {
  S.mode = "shared"; S.team = null; S.joinError = null;
  loadShared();
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (!document.hidden) loadShared(); }, POLL_MS);
  render();
}
function stopShared() { clearInterval(pollTimer); pollTimer = null; }
document.addEventListener("visibilitychange", () => { if (!document.hidden && S.mode === "shared") loadShared(); });

function joinWith(key) {
  key = String(key || "").trim().replace(/^.*#k=/, "");
  if (!/^[A-Za-z0-9_-]{8,}$/.test(key)) { S.joinError = "That doesn’t look like a team key. Paste the whole team link or the key from the Setup tab."; render(); return; }
  teamKey = key; lsSet("rota-key", key);
  startShared();
}
function teamLink() { return location.origin + location.pathname + "#k=" + (teamKey || ""); }

function setStart(start) {
  S.start = start; S.navigated = true; S.sheet = null;
  if (S.mode === "shared") loadShared();
  render();
}

/* ---------- example data ---------- */
function startDemo() {
  stopShared();
  S.mode = "demo"; S.readOnly = false; S.notice = null; S.navigated = false; S.anchor = null;
  const names = ["Alex", "Priya", "Sam", "Jordan", "Chen"];
  const team = names.map((n, i) => ({ id: "ex" + i, name: n }));
  const rand = mulberry32(2026);
  const anchor = DEFAULT_ANCHOR, start = upcomingStart(anchor);
  const avail = {};
  // Six weeks of example availability: the two fortnights before the upcoming one, plus the upcoming one.
  periodDates(addDays(start, -PERIOD * 2)).concat(periodDates(addDays(start, -PERIOD)), periodDates(start)).forEach(dt => {
    team.forEach((m, i) => {
      const r = rand(), p = isWeekend(dt) ? 0.35 : 0.55;
      let v = null;
      if (r < p * 0.55) v = "full";
      else if (r < p * 0.75) v = "half";
      else if (r < p * 0.88) v = i % 2 ? "pm" : "am";
      else if (r < p) v = i % 2 ? "am" : "pm";
      if (v) ((avail[dt.slice(0, 7)] ||= {})[m.id] ||= {})[dt] = v;
    });
  });
  L = { team, shift: { ...DEFAULT_SHIFT }, opts: { ...DEFAULT_OPTS }, anchor, avail, rotas: {} };
  applyLocal();
  // Build the two earlier fortnights so the upcoming one has history to balance against.
  [addDays(start, -PERIOD * 2), addDays(start, -PERIOD)].forEach(s => { S.start = s; buildInto(s, 1); });
  S.start = start;
  S.me = "ex0"; S.tab = "avail";
  render();
}
function exitDemo() {
  S.me = lsGet("rota-me"); S.notice = null; S.navigated = false; S.anchor = null; S.rotas = {}; S.availBy = {};
  setAnchor(DEFAULT_ANCHOR);
  if (API && teamKey) startShared();
  else if (API) { S.mode = "join"; render(); }
  else { S.mode = "local"; loadLocal(); render(); }
}

/* ---------- derived ---------- */
const memberIndex = id => (S.team || []).findIndex(m => m.id === id);
const colorOf = id => { const i = memberIndex(id); return i < 0 ? "var(--muted)" : `var(--p${i % 8})`; };
const nameOf = id => { const m = (S.team || []).find(m => m.id === id); return m ? m.name || "Unnamed" : "Former member"; };
const stateOf = (mid, dt) => ((S.availBy[dt.slice(0, 7)] || {})[mid] || {})[dt] || null;
const halfName = h => h ? S.shift.pmName || "Night" : S.shift.amName || "Day";
const halfTime = h => h ? S.shift.pmTime : S.shift.amTime;
const slotKey = (dt, h) => dt + ":" + (h ? "pm" : "am");

function stateLabel(st) {
  return st === "full" ? "Full shift" : st === "half" ? "Half shift (either)" : st === "am" ? halfName(0) + " half only" : st === "pm" ? halfName(1) + " half only" : "Not available";
}

function coverageOf(dt) {
  const amSet = [], pmSet = [];
  (S.team || []).forEach(m => { const st = stateOf(m.id, dt); if (canCover(st, 0)) amSet.push(m.id); if (canCover(st, 1)) pmSet.push(m.id); });
  if (!amSet.length && !pmSet.length) return "none";
  if (!amSet.length || !pmSet.length) return "part";
  if (amSet.length === 1 && pmSet.length === 1 && amSet[0] === pmSet[0] && stateOf(amSet[0], dt) === "half") return "part";
  return "ok";
}

// Earlier fortnights (up to three, most recent weighted most) that the planner balances against.
function historyFor(start) {
  const ids = (S.team || []).map(m => m.id);
  const load = {}, wk = {}, nt = {}, raw = {}, rawWk = {}, last = {};
  ids.forEach(id => { load[id] = 0; wk[id] = 0; nt[id] = 0; raw[id] = 0; rawWk[id] = 0; last[id] = null; });
  Object.values(S.rotas)
    .filter(r => r && r.start && r.start < start && daysBetween(r.start, start) <= PERIOD * 3)
    .forEach(r => {
      const w = Math.pow(0.6, Math.round(daysBetween(r.start, start) / PERIOD) - 1);
      Object.entries(r.assign || {}).forEach(([dt, a]) => {
        if (dt >= start) return;
        ["am", "pm"].forEach(h => {
          const id = a && a[h];
          if (!id || !(id in load)) return;
          load[id] += w; raw[id]++;
          if (isWeekend(dt)) { wk[id] += w; rawWk[id]++; }
          if (h === "pm") nt[id] += w;
          const idx = -daysBetween(dt, start);
          if (last[id] === null || idx > last[id]) last[id] = idx;
        });
      });
    });
  const mean = o => ids.length ? ids.reduce((s, id) => s + o[id], 0) / ids.length : 0;
  const ml = mean(load), mw = mean(wk), mn = mean(nt), loadDev = {}, wkDev = {}, nightDev = {};
  ids.forEach(id => { loadDev[id] = load[id] - ml; wkDev[id] = wk[id] - mw; nightDev[id] = nt[id] - mn; });
  const prev = addDays(start, -1), pr = Object.values(S.rotas).find(r => r && r.assign && r.assign[prev]);
  const prevDay = pr ? [pr.assign[prev].am, pr.assign[prev].pm].filter(Boolean) : [];
  return { loadDev, wkDev, nightDev, last, prevDay, raw, rawWk };
}

function slotInfo(rota, dt, h) {
  const a = (rota && rota.assign && rota.assign[dt]) || {};
  const id = a[h ? "pm" : "am"], key = slotKey(dt, h);
  if (!id) return { id: null, status: "empty" };
  const st = stateOf(id, dt);
  const offered = canCover(st, h) && !(st === "half" && a.am === a.pm);
  if (offered) return { id, status: "ok" };
  if (rota.agreed && rota.agreed[key] === id) return { id, status: "agreed" };
  return { id, status: "ask" };
}

function rotaIssues(rota) {
  const gaps = [], ask = [];
  if (!rota) return { gaps, ask };
  periodDates(S.start).forEach(dt => [0, 1].forEach(h => {
    const s = slotInfo(rota, dt, h);
    if (s.status === "empty") gaps.push([dt, h]);
    else if (s.status === "ask") ask.push([dt, h, s.id]);
  }));
  return { gaps, ask };
}

function rotaStats(rota) {
  const st = {};
  (S.team || []).forEach(m => st[m.id] = { full: 0, half: 0, halves: 0, weekend: 0, nights: 0, ask: 0, offered: 0 });
  periodDates(S.start).forEach(dt => {
    (S.team || []).forEach(m => { if (stateOf(m.id, dt)) st[m.id].offered++; });
    const a = rota && rota.assign && rota.assign[dt];
    if (!a) return;
    const we = isWeekend(dt);
    if (a.am && a.am === a.pm) { if (st[a.am]) { st[a.am].full++; st[a.am].halves += 2; if (we) st[a.am].weekend += 2; } }
    else ["am", "pm"].forEach(h => { const id = a[h]; if (id && st[id]) { st[id].half++; st[id].halves++; if (we) st[id].weekend++; } });
    if (a.pm && st[a.pm]) st[a.pm].nights++;
    [0, 1].forEach(h => { const s = slotInfo(rota, dt, h); if (s.status === "ask" && st[s.id]) st[s.id].ask++; });
  });
  return st;
}

/* ---------- actions ---------- */
function paint(dt) {
  if (S.readOnly || !S.me || memberIndex(S.me) < 0) return;
  const month = dt.slice(0, 7);
  const days = ((S.availBy[month] ||= {})[S.me] ||= {});
  const cur = days[dt] || null;
  const next = S.brush === "none" || cur === S.brush ? null : S.brush;
  if (next) days[dt] = next; else delete days[dt];
  Store.saveAvail(S.me, month);
  render();
}
function fillDays(which) {
  if (S.readOnly || !S.me) return;
  const touched = new Set();
  periodDates(S.start).forEach(dt => {
    const we = isWeekend(dt), month = dt.slice(0, 7);
    const match = which === "all" || which === "clear" || (which === "weekdays" && !we) || (which === "weekends" && we);
    if (!match) return;
    const days = ((S.availBy[month] ||= {})[S.me] ||= {});
    if (which === "clear" || S.brush === "none") delete days[dt]; else days[dt] = S.brush;
    touched.add(month);
  });
  touched.forEach(m => Store.saveAvail(S.me, m));
  render();
}

function availForPeriod(start) {
  const out = {};
  (S.team || []).forEach(m => { out[m.id] = {}; periodDates(start).forEach(dt => { const v = stateOf(m.id, dt); if (v) out[m.id][dt] = v; }); });
  return out;
}

// Build (or rebuild) the rota for one fortnight, keeping hand-set and agreed shifts.
function buildInto(start, seed) {
  const dates = periodDates(start);
  const prevRota = S.rotas[start];
  const locked = { ...((prevRota && prevRota.locked) || {}) };
  const agreed = { ...((prevRota && prevRota.agreed) || {}) };
  for (const key in locked) if (memberIndex(locked[key]) < 0) delete locked[key];
  const res = solveRota({
    dates, weekend: dates.map(isWeekend), members: S.team, avail: availForPeriod(start),
    locked, opts: S.opts, seed, history: historyFor(start),
  });
  for (const key in agreed) { const [dt, h] = key.split(":"); if (res.assign[dt][h] !== agreed[key]) delete agreed[key]; }
  const rota = { start, assign: res.assign, locked, agreed, seed, generatedAt: Date.now() };
  S.rotas[start] = rota;
  Store.saveRota(start, rota);
  return rota;
}

function generate(fresh) {
  if (S.readOnly || !(S.team || []).length) return;
  S.busy = true; render();
  setTimeout(() => {
    buildInto(S.start, fresh ? (Math.random() * 4294967296) >>> 0 : 1);
    S.busy = false;
    S.tab = "rota"; lsSet("rota-tab", "rota");
    toast(fresh ? "Here’s another option" : "Rota built");
    render();
  }, 30);
}
function editRota(fn) {
  const rota = curRota();
  if (!rota || S.readOnly) return;
  rota.locked = rota.locked || {}; rota.agreed = rota.agreed || {};
  fn(rota);
  Store.saveRota(S.start, rota);
  render();
}
function setSlot(dt, h, id) {
  editRota(r => {
    const key = slotKey(dt, h);
    (r.assign[dt] ||= { am: null, pm: null })[h ? "pm" : "am"] = id;
    if (id) r.locked[key] = id; else delete r.locked[key];
    delete r.agreed[key];
    S.sheet = null;
  });
}
function setAgreed(dt, h, yes) {
  editRota(r => {
    const key = slotKey(dt, h), id = r.assign[dt] && r.assign[dt][h ? "pm" : "am"];
    if (yes && id) { r.agreed[key] = id; r.locked[key] = id; }
    else { delete r.agreed[key]; delete r.locked[key]; }
  });
}
function unlockSlot(dt, h) {
  const r = curRota(); if (!r) return;
  delete (r.locked || {})[slotKey(dt, h)];
  delete (r.agreed || {})[slotKey(dt, h)];
  S.sheet = null;
  generate(false);
}

let toastTimer;
function toast(text) {
  clearTimeout(toastTimer);
  S.toast = text;
  toastTimer = setTimeout(() => { S.toast = null; renderLayer(); }, 2200);
}

async function copyRota() {
  const rota = curRota();
  const lines = [["Date", "Day", `${halfName(0)} (${halfTime(0)})`, `${halfName(1)} (${halfTime(1)})`].join("\t")];
  periodDates(S.start).forEach(dt => {
    const cell = h => { const s = slotInfo(rota, dt, h); return !s.id ? "UNCOVERED" : nameOf(s.id) + (s.status === "ask" ? " (to confirm)" : ""); };
    lines.push([dt, WD[dowOf(dt)], cell(0), cell(1)].join("\t"));
  });
  copyText(lines.join("\n"), "Copied. Paste it into a spreadsheet or email");
}
async function copyText(text, done) {
  try { await navigator.clipboard.writeText(text); toast(done); renderLayer(); }
  catch {
    S.sheet = { kind: "copy", text }; renderLayer();
    setTimeout(() => { const t = document.getElementById("copytext"); if (t) { t.focus(); t.select(); } }, 30);
  }
}

/* ---------- render ---------- */
const ICON = {
  pager: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2.5"/><path d="M7 10h7M7 14h4"/><circle cx="17.5" cy="13.5" r="1.2" fill="currentColor"/></svg>',
  prev: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
  next: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
};

function bandClasses(st) {
  return [st === "full" || st === "am" ? "on" : st === "half" ? "either" : "", st === "full" || st === "pm" ? "on" : st === "half" ? "either" : ""];
}
function glyph(st, color) {
  const [a, b] = bandClasses(st);
  return `<span class="glyph" style="--gc:${color || "var(--ink)"}"><i class="${a}"></i><i class="${b}"></i></span>`;
}
function dayLabel(dt, i) { return i === 0 || dayNum(dt) === 1 ? `${dayNum(dt)} ${monShort(dt)}` : String(dayNum(dt)); }
function calHead(dates) { return dates.slice(0, 7).map(dt => `<div class="dow">${WD[dowOf(dt)]}</div>`).join(""); }

function render() {
  const app = document.getElementById("app");
  const active = document.activeElement && document.activeElement.id;
  app.innerHTML = header() + notices() + body();
  if (active) { const el = document.getElementById(active); if (el && el.focus) el.focus(); }
  renderLayer();
}

function header() {
  const status = S.mode === "shared" && S.offline ? `<span class="status demo"><span class="dot"></span>Can’t reach the Google Sheet · retrying</span>`
    : S.mode === "shared" ? `<span class="status shared"><span class="dot"></span>Shared with your team · saves to Google Sheets</span>`
    : S.mode === "join" ? `<span class="status"><span class="dot"></span>Not joined yet</span>`
    : S.mode === "demo" ? `<span class="status demo"><span class="dot"></span>Example data · not saved</span>`
    : S.mode === "local" ? `<span class="status"><span class="dot"></span>Saved in this browser only</span>`
    : `<span class="status"><span class="spin"></span>Connecting…</span>`;
  return `<header class="top">
    <div class="brand"><div class="mark">${ICON.pager}</div><div><h1>On-call rota</h1><div class="sub">${status}</div></div></div>
    <div class="monthbar">
      <button class="iconbtn" data-act="period" data-d="-1" aria-label="Previous fortnight">${ICON.prev}</button>
      <div class="name" aria-live="polite">${periodLabel(S.start)}</div>
      <button class="iconbtn" data-act="period" data-d="1" aria-label="Next fortnight">${ICON.next}</button>
    </div>
  </header>`;
}

function notices() {
  let h = "";
  if (S.mode === "demo") h += `<div class="banner warn"><span>You’re looking at an example team with made-up availability and two earlier example rotas. Nothing here is saved.</span><button class="btn small" data-act="exit-demo">Leave example</button></div>`;
  if (S.notice) h += `<div class="banner ${S.notice.kind}"><span>${esc(S.notice.text)}</span><button class="btn small" data-act="dismiss">Dismiss</button></div>`;
  return h;
}

function tabs() {
  const t = [["avail", "1", "Availability"], ["rota", "2", "Rota"], ["team", "", "Team & shifts"]];
  return `<nav class="tabs" role="tablist">${t.map(([id, n, label]) =>
    `<button class="tab" role="tab" id="tab-${id}" aria-selected="${S.tab === id}" data-act="tab" data-tab="${id}">${n ? `<span class="n">${n}</span>` : ""}${label}</button>`).join("")}</nav>`;
}

function body() {
  if (S.mode === "join") {
    return `<section class="panel"><div class="empty-state"><span class="eyebrow">Join</span><h2>Open your team’s rota</h2>
      <p class="muted">Open the team link you were sent and you’ll go straight in. If you only have the team key, paste it here. You only need to do this once on each phone or computer.</p>
      <label class="field" style="max-width:520px">Team link or key<input class="input mono" id="join-key" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://…#k=…"></label>
      ${S.joinError ? `<p style="color:var(--gap);font-weight:600">${esc(S.joinError)}</p>` : ""}
      <div class="row"><button class="btn primary" data-act="join">Open the rota</button><button class="btn" data-act="demo">Try it with an example team</button></div></div></section>`;
  }
  if (S.mode === "shared" && S.team === null && S.offline) {
    return `<section class="panel"><div class="empty-state"><span class="eyebrow">Can’t connect</span><h2>The rota couldn’t reach its Google Sheet</h2>
      <p class="muted">Check your connection and try again. If it keeps happening, ask whoever runs the rota to check the sheet’s web app is still deployed.</p>
      <div class="row"><button class="btn primary" data-act="retry">Try again</button></div></div></section>`;
  }
  if (S.mode === "loading" || S.team === null) {
    return `<section class="panel"><div class="empty-state"><span class="eyebrow">Loading</span><h2>Opening the rota…</h2><p class="muted">Fetching your team and this fortnight’s availability.</p>
      <div class="row"><button class="btn" data-act="demo">Try it with an example team</button></div></div></section>`;
  }
  if (!S.team.length) return teamView(true);
  return tabs() + (S.tab === "rota" ? rotaView() : S.tab === "team" ? teamView(false) : availView());
}

/* Availability */
function availView() {
  const me = S.team.find(m => m.id === S.me);
  const dates = periodDates(S.start);
  const meColor = me ? colorOf(me.id) : "var(--muted)";
  const counts = id => dates.filter(dt => stateOf(id, dt)).length;

  const people = `<div class="stack"><span class="eyebrow">Whose availability?</span><div class="row">${S.team.map((m, i) =>
    `<button class="chip" style="--pc:var(--p${i % 8})" aria-pressed="${m.id === S.me}" data-act="me" data-id="${m.id}"><span class="sw"></span>${esc(m.name || "Unnamed")}<span class="cnt">${counts(m.id)}/${PERIOD}</span></button>`).join("")}</div></div>`;

  if (!me) return `<section class="panel">${people}<div class="empty-state"><h2>Pick your name to start</h2><p class="muted">Choose who you are above, then tap the days you can be on call between ${periodLabel(S.start)}. Each day has a ${esc(halfName(0).toLowerCase())} half (${esc(halfTime(0))}) and a ${esc(halfName(1).toLowerCase())} half (${esc(halfTime(1))}).</p></div></section>${coverageView()}`;

  const brushes = [["full", "Full shift"], ["half", "Half (either)"], ["am", halfName(0) + " half"], ["pm", halfName(1) + " half"], ["none", "Not available"]];
  const brushBar = `<div class="stack"><span class="eyebrow">Tap days to mark them as</span><div class="brushes">${brushes.map(([id, label]) =>
    `<button class="brush" aria-pressed="${S.brush === id}" data-act="brush" data-b="${id}">${glyph(id === "none" ? null : id, meColor)}${esc(label)}</button>`).join("")}</div></div>`;

  let cells = calHead(dates);
  dates.forEach((dt, i) => {
    const st = stateOf(me.id, dt);
    const [a, b] = bandClasses(st);
    const cov = coverageOf(dt);
    const others = S.team.filter(m => m.id !== me.id && stateOf(m.id, dt)).map(m => `<b style="--pc:${colorOf(m.id)}" title="${esc(m.name)}: ${esc(stateLabel(stateOf(m.id, dt)))}"></b>`).join("");
    cells += `<button class="day ${isWeekend(dt) ? "we" : ""}" style="--pc:${meColor}" data-act="paint" data-dt="${dt}" ${S.readOnly ? "disabled" : ""}
      aria-label="${shortDate(dt)}: ${esc(stateLabel(st))}">
      ${cov !== "ok" ? `<span class="flag ${cov === "part" ? "part" : ""}" title="${cov === "none" ? "Nobody available yet" : "Only one half can be covered so far"}"></span>` : ""}
      <span class="num"><span>${dayLabel(dt, i)}</span></span>
      <span class="bands"><i class="${a}"></i><i class="${b}"></i></span>
      <span class="dots">${others}</span>
    </button>`;
  });

  return `<section class="panel">
    ${people}
    ${brushBar}
    <div class="row">
      <span class="muted" style="font-size:.85rem">Fill with “${esc(brushes.find(b => b[0] === S.brush)[1])}”:</span>
      <button class="btn small" data-act="fill" data-w="weekdays">Weekdays</button>
      <button class="btn small" data-act="fill" data-w="weekends">Weekends</button>
      <button class="btn small" data-act="fill" data-w="all">Every day</button>
      <button class="btn small ghost" data-act="fill" data-w="clear">Clear ${esc(me.name)}’s fortnight</button>
    </div>
    <div class="cal" role="group" aria-label="${esc(me.name)}’s availability for ${periodLabel(S.start)}">${cells}</div>
    <div class="legend">
      <span>${glyph("full", meColor)} top = ${esc(halfName(0).toLowerCase())} ${esc(halfTime(0))}, bottom = ${esc(halfName(1).toLowerCase())} ${esc(halfTime(1))}</span>
      <span>${glyph("half", meColor)} striped = one half, either one</span>
      <span>dots = others available</span>
      <span><span class="flag" style="position:static;border-radius:0"></span> not covered yet</span>
    </div>
  </section>
  ${coverageView()}`;
}

function coverageView() {
  const dates = periodDates(S.start);
  const covs = dates.map(coverageOf);
  const none = dates.filter((_, i) => covs[i] === "none"), part = dates.filter((_, i) => covs[i] === "part");
  const head = `<tr><th></th>${dates.map(dt => `<th class="${isWeekend(dt) ? "we" : ""}" title="${shortDate(dt)}">${dayNum(dt)}</th>`).join("")}</tr>`;
  const rows = S.team.map((m, i) => `<tr><th><span class="chip" style="--pc:var(--p${i % 8});border:0;padding:0;background:none"><span class="sw"></span>${esc(m.name || "Unnamed")}</span></th>${dates.map(dt => {
    const st = stateOf(m.id, dt);
    const [a, b] = bandClasses(st);
    return `<td title="${esc(m.name)} · ${shortDate(dt)}: ${esc(stateLabel(st))}"><span class="mcell" style="--pc:var(--p${i % 8})"><i class="${a}"></i><i class="${b}"></i></span></td>`;
  }).join("")}</tr>`).join("");
  const covRow = `<tr><th class="muted" style="font-weight:600">Covered</th>${covs.map(c => `<td><span class="cov ${c === "ok" ? "" : c}"></span></td>`).join("")}</tr>`;
  const okCount = covs.filter(c => c === "ok").length;
  const list = arr => arr.map(shortDate).join(", ");
  return `<section class="panel">
    <div class="row between"><div class="stack" style="gap:2px"><span class="eyebrow">Team coverage</span><h2>${okCount} of ${dates.length} days covered by availability</h2></div>
      <button class="btn primary" data-act="generate" ${S.readOnly ? "disabled" : ""}>Build the rota</button></div>
    ${none.length ? `<p><strong style="color:var(--gap)">Nobody available:</strong> ${list(none)}</p>` : ""}
    ${part.length ? `<p><strong style="color:var(--warn)">Only one half covered:</strong> ${list(part)}</p>` : ""}
    ${none.length || part.length ? `<p class="muted" style="font-size:.88rem">The planner still fills these, choosing whoever has done the least on-call and had the longest break. They’re marked “Check” on the rota so you know who to ask.</p>` : ""}
    <div class="scroll"><table class="matrix"><thead>${head}</thead><tbody>${rows}${covRow}</tbody></table></div>
    <div class="legend"><span><span class="cov"></span> both halves coverable</span><span><span class="cov part"></span> one half only</span><span><span class="cov none"></span> nobody</span></div>
  </section>`;
}

/* Rota */
function rotaView() {
  const dates = periodDates(S.start);
  const rota = curRota();
  const opts = `<div class="row" style="gap:6px 18px">
      <fieldset class="stack" style="border:0;padding:0;margin:0;gap:4px;flex-basis:100%">
        <legend style="font-weight:600;font-size:.9rem;padding:0;margin-bottom:4px">When two or more people offered the same day</legend>
        ${[["split", `Share it: one does the ${esc(halfName(0).toLowerCase())} half, the other the ${esc(halfName(1).toLowerCase())} half`], ["whole", "Give the whole day to one person (fewer handovers)"], ["fairest", "No preference: whatever evens out the totals best"]].map(([v, label]) =>
          `<label class="check"><input type="radio" name="dayMode" id="opt-day-${v}" data-act="daymode" value="${v}" ${S.opts.dayMode === v ? "checked" : ""} ${S.readOnly ? "disabled" : ""}><span>${label}</span></label>`).join("")}
      </fieldset>
      <label class="check"><input type="checkbox" id="opt-b2b" data-act="opt" data-k="avoidBackToBack" ${S.opts.avoidBackToBack ? "checked" : ""} ${S.readOnly ? "disabled" : ""}><span>Avoid back-to-back days for the same person</span></label>
    </div>`;
  const busy = S.busy ? `<span class="spin"></span>` : "";
  if (!rota) {
    return `<section class="panel"><div class="empty-state"><span class="eyebrow">${periodLabel(S.start)}</span><h2>No rota yet for this fortnight</h2>
      <p class="muted">Once everyone has marked their availability, build the rota. Every ${esc(halfName(0).toLowerCase())} and ${esc(halfName(1).toLowerCase())} half gets someone. People who offered a shift are always used first, and shifts and weekends are shared as evenly as possible, counting the previous rotas too. If nobody offered a shift, it goes to whoever has done the least and had the longest break, and it’s flagged so you can check with them.</p>
      ${opts}
      <div class="row"><button class="btn primary" data-act="generate" ${S.readOnly ? "disabled" : ""}>${busy}Build the rota</button></div></div></section>`;
  }
  const { gaps, ask } = rotaIssues(rota);
  const locked = rota.locked || {};
  let cells = calHead(dates);
  dates.forEach((dt, i) => {
    const a = rota.assign[dt] || {};
    const mark = s => s.status === "ask" ? `<span class="q">Check</span>` : s.status === "agreed" ? `<span class="agreed" title="Agreed">✓</span>` : "";
    const slot = h => {
      const s = slotInfo(rota, dt, h), key = slotKey(dt, h);
      const pin = locked[key] && s.status !== "agreed" ? `<span class="pin" title="Set by hand">●</span>` : "";
      if (!s.id) return `<button class="slot empty" data-act="slot" data-dt="${dt}" data-h="${h}"><span class="h">${esc(halfName(h).slice(0, 1))}</span><span class="nm">Uncovered</span></button>`;
      return `<button class="slot ${s.status === "ask" ? "ask" : ""}" style="--pc:${colorOf(s.id)}" data-act="slot" data-dt="${dt}" data-h="${h}" title="${esc(halfName(h))} ${esc(halfTime(h))}: ${esc(nameOf(s.id))}${s.status === "ask" ? " (didn’t mark available)" : ""}"><span class="h">${esc(halfName(h).slice(0, 1))}</span><span class="nm">${esc(nameOf(s.id))}</span>${mark(s) || pin}</button>`;
    };
    let inner;
    if (a.am && a.am === a.pm) {
      const s0 = slotInfo(rota, dt, 0), s1 = slotInfo(rota, dt, 1);
      const worst = s0.status === "ask" || s1.status === "ask" ? s0.status === "ask" ? s0 : s1 : s0.status === "agreed" ? s0 : s1;
      const pin = (locked[slotKey(dt, 0)] || locked[slotKey(dt, 1)]) && worst.status === "ok" ? `<span class="pin">●</span>` : "";
      inner = `<button class="slot full ${worst.status === "ask" ? "ask" : ""}" style="--pc:${colorOf(a.am)}" data-act="slot" data-dt="${dt}" data-h="0" title="Full shift: ${esc(nameOf(a.am))}"><span class="nm">${esc(nameOf(a.am))}</span><span class="h">Full shift ${pin}</span>${mark(worst)}</button>`;
    } else inner = slot(0) + slot(1);
    cells += `<div class="day rday ${isWeekend(dt) ? "we" : ""}"><span class="num"><span>${dayLabel(dt, i)}</span><span class="wd">${WD[dowOf(dt)]}</span></span><div class="slots">${inner}</div></div>`;
  });

  // Group the "check with" shifts by person, so it reads as a list of conversations to have.
  const byPerson = {};
  ask.forEach(([dt, h, id]) => (byPerson[id] ||= []).push([dt, h]));
  const askList = Object.entries(byPerson).map(([id, list]) => {
    const days = [];
    list.forEach(([dt, h]) => { const prev = days[days.length - 1]; if (prev && prev.dt === dt) prev.h = "full"; else days.push({ dt, h }); });
    return `<li><strong style="color:${colorOf(id)}">${esc(nameOf(id))}</strong><span>${days.map(d => `${shortDate(d.dt)} (${d.h === "full" ? "full shift" : esc(halfName(d.h).toLowerCase())})`).join(", ")}</span></li>`;
  }).join("");

  const stats = rotaStats(rota), hist = historyFor(S.start);
  const maxH = Math.max(1, ...Object.values(stats).map(s => s.halves));
  const days = n => (n / 2) % 1 ? (n / 2).toFixed(1) : String(n / 2);
  const statRows = S.team.map((m, i) => {
    const s = stats[m.id];
    return `<tr style="--pc:var(--p${i % 8})"><td><span class="chip" style="--pc:var(--p${i % 8});border:0;padding:0;background:none"><span class="sw"></span>${esc(m.name || "Unnamed")}</span></td>
      <td>${s.full}</td><td>${s.half}</td><td class="mono">${days(s.halves)}</td><td class="mono">${days(s.weekend)}</td><td>${s.nights}</td>
      <td>${s.ask ? `<span style="color:var(--warn);font-weight:600">${s.ask}</span>` : `<span class="muted">0</span>`}</td>
      <td class="mono muted">${days(hist.raw[m.id] || 0)} · ${days(hist.rawWk[m.id] || 0)} wknd</td>
      <td style="width:22%"><div class="bar"><i style="width:${(s.halves / maxH) * 100}%"></i></div></td></tr>`;
  }).join("");
  const when = rota.generatedAt ? new Date(rota.generatedAt).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
  const handCount = Object.keys(locked).length;

  return `<section class="panel">
    <div class="row between">
      <div class="stack" style="gap:2px"><span class="eyebrow">${periodLabel(S.start)} · ${esc(halfName(0))} ${esc(halfTime(0))} · ${esc(halfName(1))} ${esc(halfTime(1))}</span>
        <h2>${gaps.length ? `${gaps.length} half-shift${gaps.length > 1 ? "s" : ""} uncovered` : ask.length ? `All covered · ${ask.length} half-shift${ask.length > 1 ? "s" : ""} to check` : "Every shift is covered"}</h2></div>
      <div class="row">
        <button class="btn" data-act="copy">Copy as table</button>
        <button class="btn" data-act="regen" ${S.readOnly ? "disabled" : ""}>Try another option</button>
        <button class="btn primary" data-act="generate" ${S.readOnly ? "disabled" : ""}>${busy}Rebuild</button>
      </div>
    </div>
    ${ask.length ? `<div class="banner warn"><div class="stack" style="gap:6px"><strong>Check with these people</strong><span style="font-size:.88rem">Nobody offered these shifts, so the planner picked whoever had done the least and had the longest break. Tap a shift to mark it agreed or swap the person.</span><ul class="asklist">${askList}</ul></div></div>` : ""}
    ${gaps.length ? `<div class="banner gap"><span>Left uncovered by hand: ${gaps.map(([dt, h]) => `${shortDate(dt)} (${esc(halfName(h).toLowerCase())})`).join(", ")}. Rebuild to fill them.</span></div>` : ""}
    <div class="cal rota">${cells}</div>
    <div class="legend"><span>Tap a shift to change who’s on call.</span><span><span class="q" style="font-size:.64rem;font-weight:700;color:var(--warn);background:var(--warn-soft);border-radius:4px;padding:0 4px">CHECK</span> didn’t mark available</span><span style="color:var(--ok)">✓ agreed</span>${handCount ? `<span>● set by hand · kept when rebuilding · <button class="linkbtn" data-act="clear-locks">Clear hand changes</button></span>` : ""}${when ? `<span>Built ${esc(when)}</span>` : ""}</div>
  </section>
  <section class="panel">
    <div class="stack" style="gap:2px"><span class="eyebrow">Fairness</span><h2>How the shifts are shared</h2><p class="muted" style="font-size:.88rem">The planner evens out on-call and weekend days across this fortnight and the previous three, with recent fortnights counting most.</p></div>
    <div class="scroll"><table class="tbl"><thead><tr><th>Person</th><th>Full shifts</th><th>Half shifts</th><th>Days on call</th><th>Weekend days</th><th>${esc(halfName(1))} halves</th><th>To check</th><th>Previous 6 weeks</th><th></th></tr></thead><tbody>${statRows}</tbody></table></div>
    ${opts}
  </section>`;
}

/* Team */
function teamView(first) {
  if (!S.teamDraft) S.teamDraft = {
    members: clone(S.team && S.team.length ? S.team : Array.from({ length: 5 }, () => ({ id: uid(), name: "" }))),
    shift: { ...S.shift }, anchor: S.anchor || DEFAULT_ANCHOR,
  };
  const d = S.teamDraft;
  const rows = d.members.map((m, i) => `<div class="teamrow" style="--pc:var(--p${i % 8})"><span class="sw"></span>
      <input class="input" id="tm-${m.id}" data-act="tm-name" data-id="${m.id}" value="${esc(m.name)}" placeholder="Person ${i + 1}" maxlength="40" aria-label="Name of person ${i + 1}" ${S.readOnly ? "disabled" : ""}>
      <button class="btn small ghost" data-act="tm-remove" data-id="${m.id}" ${d.members.length <= 1 || S.readOnly ? "disabled" : ""} aria-label="Remove ${esc(m.name || "person " + (i + 1))}">Remove</button></div>`).join("");
  const anchorDay = validDate(d.anchor) ? WD[dowOf(d.anchor)] : "";
  return `<section class="panel">
    <div class="stack" style="gap:4px">${first ? `<span class="eyebrow">Set up</span><h2>Who’s on the on-call rota?</h2><p class="muted">Add the people who share on-call. Each of them marks the days they’re free, and the planner builds the rota a fortnight at a time.</p>` : `<span class="eyebrow">Team</span><h2>People on the rota</h2>`}</div>
    <div class="stack" style="gap:8px;max-width:520px">${rows}
      <div><button class="btn small" data-act="tm-add" ${d.members.length >= 8 || S.readOnly ? "disabled" : ""}>Add a person</button></div></div>
    <div class="stack" style="gap:4px"><h3>Fortnights</h3><p class="muted" style="font-size:.88rem">Each rota covers two weeks. Pick the date any rota starts on; the rest follow every 14 days from it.</p></div>
    <div class="grid2">
      <label class="field">A rota starts on<input class="input" type="date" id="tm-anchor" data-act="anchor" value="${esc(d.anchor)}" ${S.readOnly ? "disabled" : ""}></label>
      <div class="field" style="justify-content:flex-end;font-weight:400"><span class="muted">Every rota runs ${anchorDay ? `${anchorDay} to ${WD[(dowOf(d.anchor) + 6) % 7]}` : "for 14 days"}.</span></div>
    </div>
    <div class="stack" style="gap:4px"><h3>Shift halves</h3><p class="muted" style="font-size:.88rem">Each day is one on-call shift split into two halves. A day is covered by one person doing both halves, or two people doing one each.</p></div>
    <div class="grid2">
      <label class="field">First half name<input class="input" id="sh-amName" data-act="sh" data-k="amName" value="${esc(d.shift.amName)}" maxlength="16"></label>
      <label class="field">First half hours<input class="input" id="sh-amTime" data-act="sh" data-k="amTime" value="${esc(d.shift.amTime)}" maxlength="24"></label>
      <label class="field">Second half name<input class="input" id="sh-pmName" data-act="sh" data-k="pmName" value="${esc(d.shift.pmName)}" maxlength="16"></label>
      <label class="field">Second half hours<input class="input" id="sh-pmTime" data-act="sh" data-k="pmTime" value="${esc(d.shift.pmTime)}" maxlength="24"></label>
    </div>
    <div class="row">
      <button class="btn primary" data-act="tm-save" ${S.readOnly ? "disabled" : ""}>${first ? "Save team" : "Save changes"}</button>
      ${first ? `<span class="muted">or</span><button class="btn" data-act="demo">Try it with an example team</button>` : ""}
    </div>
    ${S.mode === "local" ? `<p class="muted" style="font-size:.85rem">This copy isn’t connected to a Google Sheet yet, so everything is saved in this browser only. Follow the setup guide to connect it.</p>` : ""}
  </section>
  ${S.mode === "shared" ? `<section class="panel">
    <div class="stack" style="gap:4px"><span class="eyebrow">Sharing</span><h2>Team link</h2>
      <p class="muted" style="font-size:.88rem">Send this link to everyone on the rota. Opening it on a phone or computer is all they need to do; no account or app. Anyone with the link can view and edit, so keep it within the team.</p></div>
    <div class="row" style="flex-wrap:nowrap"><input class="input mono" id="team-link" readonly value="${esc(teamLink())}" style="font-size:.78rem"><button class="btn" data-act="copy-link">Copy</button></div>
    ${sheetUrl ? `<p style="font-size:.88rem"><a href="${esc(sheetUrl)}" target="_blank" rel="noopener" style="color:var(--accent);font-weight:600">Open the Google Sheet</a> <span class="muted">to see availability and each fortnight’s rota as tables.</span></p>` : ""}
  </section>` : ""}`;
}

function renderLayer() {
  const layer = document.getElementById("layer");
  let h = "";
  const rota = curRota();
  if (S.sheet && S.sheet.kind === "slot" && rota) {
    const { dt, h: half } = S.sheet;
    const a = rota.assign[dt] || {};
    const cur = a[half ? "pm" : "am"], other = a[half ? "am" : "pm"];
    const info = slotInfo(rota, dt, half);
    const stats = rotaStats(rota);
    const opts = S.team.map((m, i) => {
      const st = stateOf(m.id, dt);
      const offered = canCover(st, half) && !(st === "half" && other === m.id);
      const meta = offered ? `${esc(stateLabel(st))} · ${(stats[m.id].halves / 2).toFixed(1)} days`
        : st === "half" && other === m.id ? "Offered one half only · check first"
        : `Didn’t mark available · ${(stats[m.id].halves / 2).toFixed(1)} days`;
      return `<button class="opt" style="--pc:var(--p${i % 8})" data-act="pick" data-id="${m.id}" aria-current="${cur === m.id}">
        <span class="sw"></span><strong>${esc(m.name || "Unnamed")}</strong><span class="meta" style="${offered ? "" : "color:var(--warn)"}">${meta}</span></button>`;
    }).join("");
    const key = slotKey(dt, half);
    h += `<div class="scrim" data-act="close-sheet"><div class="sheet" role="dialog" aria-modal="true" aria-label="Choose who is on call" data-stop="1">
      <div class="stack" style="gap:2px"><span class="eyebrow">${shortDate(dt)} · ${esc(halfName(half))} ${esc(halfTime(half))}</span><h2>Who’s on call?</h2></div>
      ${a.am && a.am === a.pm ? `<p class="muted" style="font-size:.88rem">${esc(nameOf(a.am))} has the full shift. Picking someone here changes the ${esc(halfName(half).toLowerCase())} half only.</p>
        <div class="row"><button class="btn small" data-act="sheet-half" data-h="0" aria-pressed="${half === 0}">${esc(halfName(0))} half</button><button class="btn small" data-act="sheet-half" data-h="1" aria-pressed="${half === 1}">${esc(halfName(1))} half</button></div>` : ""}
      ${info.status === "ask" ? `<div class="banner warn"><span>${esc(nameOf(cur))} didn’t mark this shift as available.</span><button class="btn small" data-act="agree" data-v="1">Mark as agreed</button></div>` : ""}
      ${info.status === "agreed" ? `<div class="banner info"><span>Agreed with ${esc(nameOf(cur))}.</span><button class="btn small" data-act="agree" data-v="0">Undo</button></div>` : ""}
      <div class="stack">${opts}</div>
      <div class="row between">
        <button class="btn small ghost" data-act="pick" data-id="">Leave uncovered</button>
        ${(rota.locked || {})[key] ? `<button class="btn small" data-act="unlock">Let the planner choose</button>` : ""}
        <button class="btn small" data-act="close-sheet">Close</button>
      </div>
    </div></div>`;
  }
  if (S.sheet && S.sheet.kind === "copy") {
    h += `<div class="scrim" data-act="close-sheet"><div class="sheet" role="dialog" aria-modal="true" aria-label="Copy rota" data-stop="1">
      <h2>Copy the rota</h2><p class="muted">Select all and copy, then paste into a spreadsheet or email.</p>
      <textarea id="copytext" class="input mono" rows="10" readonly style="font-size:.75rem">${esc(S.sheet.text)}</textarea>
      <div class="row"><button class="btn" data-act="close-sheet">Done</button></div></div></div>`;
  }
  if (S.toast) h += `<div class="toast" role="status">${esc(S.toast)}</div>`;
  layer.innerHTML = h;
}

/* ---------- events ---------- */
function handle(e) {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  // A click inside the sheet that isn't on a control bubbles up to the scrim; ignore it.
  if (el.classList.contains("scrim") && e.target.closest("[data-stop]")) return;
  switch (el.dataset.act) {
    case "period": setStart(addDays(S.start, PERIOD * Number(el.dataset.d))); break;
    case "tab": S.tab = el.dataset.tab; lsSet("rota-tab", S.tab); S.teamDraft = null; render(); break;
    case "me": S.me = el.dataset.id; if (S.mode !== "demo") lsSet("rota-me", S.me); render(); break;
    case "brush": S.brush = el.dataset.b; render(); break;
    case "paint": paint(el.dataset.dt); break;
    case "fill": fillDays(el.dataset.w); break;
    case "generate": generate(false); break;
    case "regen": generate(true); break;
    case "copy": copyRota(); break;
    case "slot": S.sheet = { kind: "slot", dt: el.dataset.dt, h: Number(el.dataset.h) }; renderLayer(); break;
    case "sheet-half": S.sheet.h = Number(el.dataset.h); renderLayer(); break;
    case "pick": setSlot(S.sheet.dt, S.sheet.h, el.dataset.id || null); break;
    case "agree": setAgreed(S.sheet.dt, S.sheet.h, el.dataset.v === "1"); break;
    case "unlock": unlockSlot(S.sheet.dt, S.sheet.h); break;
    case "close-sheet": S.sheet = null; renderLayer(); break;
    case "clear-locks": { const r = curRota(); if (r) { r.locked = {}; r.agreed = {}; generate(false); } break; }
    case "demo": startDemo(); break;
    case "exit-demo": exitDemo(); break;
    case "dismiss": S.notice = null; render(); break;
    case "join": joinWith((document.getElementById("join-key") || {}).value); break;
    case "copy-link": copyText(teamLink(), "Team link copied"); break;
    case "retry": loadShared(); break;
    case "tm-add": S.teamDraft.members.push({ id: uid(), name: "" }); render(); break;
    case "tm-remove": S.teamDraft.members = S.teamDraft.members.filter(m => m.id !== el.dataset.id); render(); break;
    case "tm-save": {
      const members = S.teamDraft.members.map(m => ({ id: m.id, name: m.name.trim() })).filter(m => m.name);
      if (!members.length) { S.notice = { kind: "warn", text: "Add at least one name before saving." }; render(); break; }
      const shift = { ...DEFAULT_SHIFT, ...Object.fromEntries(Object.entries(S.teamDraft.shift).map(([k, v]) => [k, String(v).trim() || DEFAULT_SHIFT[k]])) };
      const anchor = validDate(S.teamDraft.anchor) ? S.teamDraft.anchor : S.anchor;
      const wasFirst = !S.team.length;
      S.team = members; S.shift = shift; S.teamDraft = null; S.notice = null;
      const moved = setAnchor(anchor);
      Store.saveTeam({ members, shift, opts: S.opts, anchor: S.anchor });
      if (moved && S.mode === "shared") loadShared();
      if (wasFirst) S.tab = "avail";
      toast("Team saved");
      render();
      break;
    }
  }
}
document.addEventListener("click", handle);
document.addEventListener("input", e => {
  const el = e.target;
  if (el.dataset.act === "tm-name") { const m = S.teamDraft.members.find(m => m.id === el.dataset.id); if (m) m.name = el.value; }
  if (el.dataset.act === "sh") S.teamDraft.shift[el.dataset.k] = el.value;
});
document.addEventListener("change", e => {
  const el = e.target;
  if (el.dataset.act === "anchor") { S.teamDraft.anchor = el.value; render(); }
  if (el.dataset.act === "daymode" && el.checked) {
    S.opts.dayMode = el.value;
    Store.saveTeam({ members: S.team, shift: S.shift, opts: S.opts, anchor: S.anchor });
    render();
  }
  if (el.dataset.act === "opt") {
    S.opts[el.dataset.k] = el.checked;
    Store.saveTeam({ members: S.team, shift: S.shift, opts: S.opts, anchor: S.anchor });
    render();
  }
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && S.sheet) { S.sheet = null; renderLayer(); }
  if (e.key === "Enter" && e.target.id === "join-key") joinWith(e.target.value);
});

/* ---------- boot ---------- */
(() => {
  // The team link carries the key after #k=; keep it on this device and tidy it out of the address bar.
  const m = /[#&]k=([A-Za-z0-9_-]+)/.exec(location.hash);
  if (m) { lsSet("rota-key", m[1]); try { history.replaceState(null, "", location.pathname + location.search); } catch {} }
  teamKey = (m && m[1]) || lsGet("rota-key") || null;
  if (!API) { S.mode = "local"; loadLocal(); render(); }
  else if (!teamKey) { S.mode = "join"; render(); }
  else startShared();
})();
// Someone pastes a team link into the address bar of an already-open page.
window.addEventListener("hashchange", () => {
  const m = /[#&]k=([A-Za-z0-9_-]+)/.exec(location.hash);
  if (!m || !API) return;
  try { history.replaceState(null, "", location.pathname + location.search); } catch {}
  if (m[1] !== teamKey) joinWith(m[1]);
});
