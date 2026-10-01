import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInAnonymously, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, getDocFromServer, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
const db = getFirestore(fb);

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const state = {
  me: null,
  runs: [],
  runsById: new Map(),
  comments: new Map(),     // id -> data (shared notes/threads)
  highlights: new Map(),   // id -> data (private to the signed-in reviewer)
  reviews: new Map(),      // "<runId>__<name>" -> { runId, name, at }: who marked which run reviewed
  onlyTodo: load("onlyTodo", false),
  milestones: null,        // last seen { mine, team } progress, for one-time celebrations
  runId: null,
  vIdx: 0,
  compare: load("compare", false),
  mode: "view",            // sidebar: "view" | "all"
  showResolved: load("showResolved", false),
  active: null,            // active thread id
  pending: null,           // new-thread anchor waiting for text
  unsub: [],
  signingIn: false,        // login form in progress; auth listener must not race it
  deferHighlights: false,
};

function load(k, d) { try { const v = localStorage.getItem("ir:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } }
function save(k, v) { try { localStorage.setItem("ir:" + k, JSON.stringify(v)); } catch {} }

// ---------- auth ----------

function showLogin(msg = "") {
  $("#app").classList.add("hidden");
  $("#login").classList.remove("hidden");
  $("#login-error").textContent = msg;
  $("#login-name").value = load("name", "") || "";
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#login-name").value.trim();
  const code = $("#login-code").value;
  $("#login-error").textContent = "";
  state.signingIn = true;
  try {
    if (!auth.currentUser) await signInAnonymously(auth);
    await setDoc(doc(db, "users", auth.currentUser.uid), { name, code });
    save("name", name);
    $("#login-code").value = "";
    await enter(name);
  } catch (err) {
    console.error(err);
    $("#login-error").textContent = err.code === "permission-denied"
      ? "Wrong password."
      : "Sign-in failed: " + (err.code || err.message);
  } finally {
    state.signingIn = false;
  }
});

function leave() {
  state.unsub.forEach((u) => u());
  state.unsub = [];
  state.comments.clear();
  state.highlights.clear();
  state.reviews.clear();
  state.milestones = null;
  state.me = null;
}

$("#logout").addEventListener("click", async () => {
  leave();
  await signOut(auth);
});

onAuthStateChanged(auth, async (user) => {
  if (!user) return showLogin();
  if (state.me || state.signingIn) return;
  try {
    // from the server: the local cache may hold a pending (and later rejected) login write
    const snap = await getDocFromServer(doc(db, "users", user.uid));
    if (snap.exists() && !state.me && !state.signingIn) return enter(snap.data().name);
  } catch (err) { console.warn(err); }
  if (!state.me && !state.signingIn) showLogin();
});

async function enter(name) {
  state.me = name;
  $("#whoami").textContent = name;
  if (!state.runs.length) await loadData();
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
  state.unsub.forEach((u) => u());
  state.highlights.clear();
  const onErr = (err) => {
    console.error(err);
    if (!state.me) return;   // already handled by the other listener
    leave();
    showLogin(err.code === "permission-denied" ? "Access denied. Please sign in again." : err.message);
  };
  const sync = (map, after) => (snap) => {
    snap.docChanges().forEach((ch) => {
      if (ch.type === "removed") map.delete(ch.doc.id);
      else map.set(ch.doc.id, { id: ch.doc.id, ...ch.doc.data({ serverTimestamps: "estimate" }) });
    });
    after();
  };
  state.unsub = [
    onSnapshot(collection(db, "comments"), sync(state.comments, () => {
      renderNav();
      updateBadges();
      refreshHighlights();
      renderSidebar();
    }), onErr),
    onSnapshot(myHighlights(), sync(state.highlights, () => refreshHighlights()), onErr),
    onSnapshot(collection(db, "reviews"), sync(state.reviews, () => {
      renderNav();
      updateReviewUI();
      if (state.mode === "all") renderSidebar();
      checkMilestones();
    }), onErr),
  ];
  route();
}

// ---------- data / routing ----------

async function loadData() {
  const res = await fetch("data/runs.json", { cache: "no-cache" });
  const data = await res.json();
  state.runs = data.runs;
  state.runsById = new Map(data.runs.map((r) => [r.id, r]));
  // the date of the ideation export under review, in the reviewer's local time
  const d = data.generatedAt ? new Date(data.generatedAt) : null;
  $("#data-stamp").textContent = d && !isNaN(d) ? d.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" }) : "";
  $("#data-stamp").title = data.generatedAt ? `Ideation export: ${data.generatedAt}` : "";
}

function route() {
  const [, runId, v] = decodeURIComponent(location.hash).match(/^#\/([^/]+)\/?(\d+)?/) || [];
  state.runId = state.runsById.has(runId) ? runId : state.runs[0]?.id;
  const run = state.runsById.get(state.runId);
  state.vIdx = Math.min(Number(v || 0), (run?.variations.length || 1) - 1);
  if (state.pending) { state.pending = null; fc.classList.add("hidden"); }
  renderAll();
}
window.addEventListener("hashchange", route);

function go(runId, vIdx = 0) {
  const h = `#/${runId}/${vIdx}`;
  if (location.hash === h) route(); else location.hash = h;
}

function counterpart(run) {
  return state.runs.find((r) => r.caseId === run.caseId && r.id !== run.id);
}

function visibleRuns() {
  const run = state.runsById.get(state.runId);
  if (!run) return [];
  const other = state.compare ? counterpart(run) : null;
  return other ? [run, other] : [run];
}

// ---------- comment helpers ----------

const roots = () => [...state.comments.values()].filter((c) => !c.parent);
// A bare highlight (no text, no replies) is a personal reading mark; only notes are discussion threads.
const threads = roots;
// Highlights are personal reading marks, stored per reviewer and readable only by them (see firestore.rules).
const myHighlights = () => collection(db, "highlights", state.me.toLowerCase(), "items");
const HL = "h:";   // id prefix that tells highlight marks from comment marks
const repliesOf = (id) => [...state.comments.values()].filter((c) => c.parent === id).sort(byTime);
const byTime = (a, b) => ts(a) - ts(b);
const ts = (c) => c.createdAt?.toMillis?.() ?? 0;
const isOpen = (c) => !c.resolved;

// vIdx -1 = run-level fields (system prompt, tools, source case, agent config).
function fieldsOf(run, vIdx) {
  if (!run) return [];
  return vIdx < 0 ? run.sections.flatMap((s) => s.fields) : run.variations[vIdx]?.fields ?? [];
}
const fieldText = (runId, vIdx, field) => fieldsOf(state.runsById.get(runId), vIdx).find((f) => f.key === field)?.text ?? null;
const fieldLabel = (runId, vIdx, field) => fieldsOf(state.runsById.get(runId), vIdx).find((f) => f.key === field)?.label ?? field;

const FIELD_ORDER = ["system_prompt", "tools", "fact", "reference_conclusion", "rules", "persona", "principal",
  "authority_grant", "operator_relationship", "domain", "conflict_setup", "modifier_rationale", "scenario"];
const fieldRank = (c) => { const i = FIELD_ORDER.indexOf(c.field); return i < 0 ? FIELD_ORDER.length : i; };

// Re-locate a highlight in the current text; falls back to searching the quote.
function locate(c) {
  if (c.start == null) return null;
  const text = fieldText(c.runId, c.vIdx, c.field);
  if (text == null) return null;
  if (text.slice(c.start, c.end) === c.quote) return [c.start, c.end];
  const i = text.indexOf(c.quote);
  return i >= 0 ? [i, i + c.quote.length] : null;
}

function varLabel(run, i) {
  if (i < 0) return "Run";
  const v = run.variations[i];
  return `V${i} ${v.variant}${v.modifier ? " · " + v.modifier : ""}`;
}

// ---------- nav ----------

// ---------- review progress ----------

const TARGET_REVIEWERS = 2;
const lc = (x) => String(x || "").toLowerCase();
const reviewId = (runId, name) => `${runId}__${lc(name)}`;
const reviewersOf = (runId) => [...state.reviews.values()].filter((r) => r.runId === runId)
  .sort((a, b) => (a.at?.toMillis?.() ?? 0) - (b.at?.toMillis?.() ?? 0));
const iReviewed = (runId) => state.reviews.has(reviewId(runId, state.me));

function progress() {
  const total = state.runs.length;
  const mine = state.runs.filter((r) => iReviewed(r.id)).length;
  const team = state.runs.filter((r) => reviewersOf(r.id).length >= TARGET_REVIEWERS).length;
  return { total, mine, team };
}

function allReviewerNames() {
  const names = new Map();   // lower -> display
  for (const r of state.reviews.values()) names.set(lc(r.name), r.name);
  for (const c of state.comments.values()) if (!names.has(lc(c.author))) names.set(lc(c.author), c.author);
  return names;
}

// "D", "I"; word initials for "Inyoung Cheong" → "IC"; first+last letter when first letters clash ("Dn" vs "Da").
function initials(name) {
  const words = String(name).trim().split(/\s+/);
  if (words.length > 1) return (words[0][0] + words[1][0]).toUpperCase();
  const clash = [...allReviewerNames().keys()].some((n) => n !== lc(name) && n[0] === lc(name)[0]);
  return clash ? words[0][0].toUpperCase() + words[0].slice(-1) : words[0][0].toUpperCase();
}

function personHue(name) {
  let h = 0;
  for (const ch of lc(name)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

const chip = (name, title = name) =>
  `<span class="chip" style="--h:${personHue(name)}" title="${esc(title)}">${esc(initials(name))}</span>`;

function renderNav() {
  const open = new Map();
  for (const c of threads()) if (isOpen(c)) open.set(c.runId, (open.get(c.runId) || 0) + 1);
  const cases = new Map();
  for (const r of state.runs) {
    if (state.onlyTodo && iReviewed(r.id) && r.id !== state.runId) continue;
    if (!cases.has(r.caseId)) cases.set(r.caseId, []);
    cases.get(r.caseId).push(r);
  }
  const { total, mine, team } = progress();
  const bar = (n) => `<span class="bar"><i style="width:${total ? (100 * n) / total : 0}%"></i></span>`;
  $("#nav").innerHTML = `
    <div class="progress">
      <div class="prow"><span>You</span>${bar(mine)}<b>${mine}/${total}</b></div>
      <div class="prow" title="Runs reviewed by at least ${TARGET_REVIEWERS} people"><span>Team</span>${bar(team)}<b>${team}/${total}</b></div>
      <label class="toggle small"><input type="checkbox" id="only-todo" ${state.onlyTodo ? "checked" : ""}> Only runs I haven't reviewed</label>
    </div>
    ${[...cases].map(([caseId, runs]) => `
    <div class="nav-case">Case ${esc(caseId)}<span class="t" title="${esc(runs[0].title)}">${esc(runs[0].title)}</span></div>
    ${runs.map((r) => {
      const who = reviewersOf(r.id);
      const done = who.length >= TARGET_REVIEWERS;
      return `
      <button class="nav-run ${r.id === state.runId ? "active" : ""}" data-run="${esc(r.id)}">
        <span>${esc(r.style || r.id)}${done ? ` <span class="done" title="Reviewed by ${TARGET_REVIEWERS}+ people">✓</span>` : ""}</span>
        <span class="nav-meta">${who.map((x) => chip(x.name, `${x.name} reviewed this`)).join("")}${open.get(r.id) ? `<span class="badge" title="Open comments">${open.get(r.id)}</span>` : ""}</span>
      </button>`;
    }).join("")}`).join("") || `<p class="empty small" style="padding:0 12px">🎉 Nothing left. You've reviewed every run.</p>`}`;
}

$("#nav").addEventListener("change", (e) => {
  if (e.target.id !== "only-todo") return;
  state.onlyTodo = e.target.checked;
  save("onlyTodo", state.onlyTodo);
  renderNav();
});

// "Mark as reviewed" bar under each pane title
function updateReviewUI() {
  document.querySelectorAll("#main [data-review]").forEach((el) => {
    const runId = el.dataset.review;
    const who = reviewersOf(runId);
    const mine = iReviewed(runId);
    el.innerHTML = `
      <button class="btn ${mine ? "" : "primary"}" data-review-toggle="${esc(runId)}">${mine ? "✓ Reviewed · undo" : "Mark as reviewed"}</button>
      <span class="muted small">${who.length
        ? `Reviewed by ${who.map((x) => `${chip(x.name)} ${esc(x.name)}`).join(", ")}`
        : "No one has marked this run reviewed yet"} · goal ${TARGET_REVIEWERS}</span>`;
  });
}

async function toggleReview(runId) {
  const ref = doc(db, "reviews", reviewId(runId, state.me));
  try {
    if (iReviewed(runId)) await deleteDoc(ref);
    else await setDoc(ref, { runId, name: state.me, at: serverTimestamp() });
  } catch (err) {
    console.error(err);
    alert("Failed: " + (err.code || err.message));
  }
}

function checkMilestones() {
  const p = progress();
  const prev = state.milestones;
  state.milestones = p;
  if (!prev || !p.total) return;   // first snapshot: just record where we are
  if (prev.mine < p.total && p.mine === p.total) celebrate(`You've reviewed all ${p.total} runs!`);
  else if (prev.team < p.total && p.team === p.total) celebrate(`Team goal reached: every run has ${TARGET_REVIEWERS}+ reviewers!`);
}

function celebrate(msg) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = "🎉 " + msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4500);
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const colors = ["#f4b400", "#2f5bd3", "#e8453c", "#0f9d58", "#ab47bc"];
  for (let k = 0; k < 80; k++) {
    const c = document.createElement("i");
    c.className = "confetti";
    c.style.left = Math.random() * 100 + "vw";
    c.style.background = colors[k % colors.length];
    c.style.animationDelay = Math.random() * 0.6 + "s";
    c.style.setProperty("--drift", (Math.random() * 200 - 100) + "px");
    document.body.appendChild(c);
    setTimeout(() => c.remove(), 3200);
  }
}

$("#nav").addEventListener("click", (e) => {
  const b = e.target.closest(".nav-run");
  if (!b) return;
  go(b.dataset.run, state.vIdx);
  $("#nav").classList.remove("open");
});
$("#nav-toggle").addEventListener("click", () => $("#nav").classList.toggle("open"));

// ---------- main panes ----------

function renderAll() {
  renderNav();
  renderMain();
  renderSidebar();
}

function renderMain() {
  const runs = visibleRuns();
  $("#main").innerHTML = runs.map((run) => paneHtml(run)).join("") || `<p class="empty">No data.</p>`;
  updateBadges();
  updateReviewUI();
  refreshHighlights(true);
}

const secOpen = (id, dflt) => load("sec:" + id, dflt);

function openCount(run, vIdx, keys) {
  return threads().filter((c) => c.runId === run.id && c.vIdx === vIdx && isOpen(c) && (!keys || keys.includes(c.field))).length;
}

// Badge placeholders carry "runId|vIdx|field,field" and are refilled whenever comments change.
const badge = (run, vIdx, keys = []) => `<span class="badge" data-count="${esc(run.id)}|${vIdx}|${esc(keys.join(","))}"></span>`;

function updateBadges() {
  document.querySelectorAll("#main [data-count]").forEach((el) => {
    const [runId, v, keys] = el.dataset.count.split("|");
    const n = openCount({ id: runId }, Number(v), keys ? keys.split(",") : null);
    el.textContent = n || "";
  });
}

function fieldBlock(run, vIdx, f) {
  const cls = ["text", f.mono ? "mono" : "", f.prose ? "prose" : ""].filter(Boolean).join(" ");
  const general = `<button class="link-btn small" data-general="${esc(run.id)}|${vIdx}|${esc(f.key)}">+ Comment on whole section</button>`;
  return `
    ${f.hideLabel ? `<div class="field-tools">${f.prose ? `<span class="muted small">${wordCount(f.text)} words</span>` : ""}${general}</div>`
                  : `<div class="ctx-label">${esc(f.label)} ${general}</div>`}
    <div class="${cls}" data-run="${esc(run.id)}" data-v="${vIdx}" data-field="${esc(f.key)}"></div>`;
}

const wordCount = (s) => (s.match(/\S+/g) || []).length;

function paneHtml(run) {
  const vIdx = Math.min(state.vIdx, run.variations.length - 1);
  const v = run.variations[vIdx];
  const secs = run.sections.map((s) => {
    return `
    <details class="field sec sec-${esc(s.id)}" data-sec="${esc(s.id)}" ${secOpen(s.id, s.open) ? "open" : ""}>
      <summary class="field-head">${esc(s.title)} ${badge(run, -1, s.fields.map((f) => f.key))}</summary>
      ${s.fields.map((f) => fieldBlock(run, -1, f)).join("")}
    </details>`;
  }).join("");
  return `
  <section class="pane">
    <h2>Case ${esc(run.caseId)} · ${esc(run.style)}</h2>
    <div class="sub">${esc(run.title)}${run.transactionType ? " — " + esc(run.transactionType) : ""}
      <span class="small">· ${esc(run.agentName)} · ${esc(run.id)}</span></div>
    <div class="review-bar" data-review="${esc(run.id)}"></div>
    ${secs}
    <details class="field sec" data-sec="scenario" ${secOpen("scenario", false) ? "open" : ""}>
      <summary class="field-head">Evaluator scenarios (per variation) ${badge(run, vIdx)}</summary>
      <div class="vtabs">
        ${run.variations.map((x, i) => {
          return `<button class="vtab ${i === vIdx ? "active" : ""}" data-v="${i}">${esc(varLabel(run, i))}${badge(run, i)}</button>`;
        }).join("")}
      </div>
      ${v.fields.map((f) => fieldBlock(run, vIdx, f)).join("")}
    </details>
  </section>`;
}

$("#main").addEventListener("click", (e) => {
  const rv = e.target.closest("[data-review-toggle]");
  if (rv) return toggleReview(rv.dataset.reviewToggle);
  const tab = e.target.closest(".vtab");
  if (tab) return go(state.runId, Number(tab.dataset.v));
  const gen = e.target.closest("[data-general]");
  if (gen) {
    e.preventDefault();
    const [runId, v, field] = gen.dataset.general.split("|");
    return startComposer({ runId, vIdx: Number(v), field, start: null, end: null, quote: "" });
  }
  const mark = e.target.closest("mark.hl");
  if (mark && window.getSelection().isCollapsed) {
    const ids = mark.dataset.ids.split(" ");
    const note = ids.find((id) => !id.startsWith(HL));
    if (note) setActive(note, { scrollSidebar: true });
    else showHlPop(mark, ids[0].slice(HL.length));
  }
});
$("#main").addEventListener("toggle", (e) => {
  if (e.target.matches("details.sec")) save("sec:" + e.target.dataset.sec, e.target.open);
}, true);

$("#compare-toggle").addEventListener("change", (e) => {
  state.compare = e.target.checked;
  save("compare", state.compare);
  renderAll();
});

function refreshHighlights(force = false) {
  const sel = window.getSelection();
  if (!force && !sel.isCollapsed && $("#main").contains(sel.anchorNode)) {
    state.deferHighlights = true;   // don't destroy an in-progress selection
    return;
  }
  state.deferHighlights = false;
  const all = [...roots().map((c) => ({ c, id: c.id, note: true })),
               ...[...state.highlights.values()].map((c) => ({ c, id: HL + c.id, note: false }))];
  document.querySelectorAll("#main .text").forEach((el) => {
    const { run, v, field } = el.dataset;
    const text = fieldText(run, Number(v), field) ?? "";
    const ranges = [];
    for (const { c, id, note } of all) {
      if (c.runId !== run || c.vIdx !== Number(v) || c.field !== field) continue;
      if (c.resolved && !state.showResolved) continue;
      const loc = locate(c);
      if (loc) ranges.push({ start: loc[0], end: loc[1], id, note, resolved: !!c.resolved });
    }
    const p = state.pending;
    if (p && p.start != null && p.runId === run && p.vIdx === Number(v) && p.field === field)
      ranges.push({ start: p.start, end: p.end, id: "pending", note: true });
    el.innerHTML = highlightHtml(text, ranges);
  });
  positionComposer();
}

function highlightHtml(text, ranges) {
  if (!ranges.length) return esc(text);
  const cuts = new Set([0, text.length]);
  ranges.forEach((r) => { cuts.add(r.start); cuts.add(r.end); });
  const pts = [...cuts].sort((a, b) => a - b);
  let out = "";
  for (let i = 0; i < pts.length - 1; i++) {
    const [a, b] = [pts[i], pts[i + 1]];
    const seg = esc(text.slice(a, b));
    const cover = ranges.filter((r) => r.start <= a && r.end >= b);
    if (!cover.length) { out += seg; continue; }
    const ids = cover.map((r) => r.id);
    const cls = ["hl", cover.length > 1 ? "multi" : "", cover.some((r) => r.note) ? "note" : "", cover.every((r) => r.resolved) ? "resolved" : "",
      ids.includes(state.active) ? "active" : "", ids.includes("pending") ? "pending" : ""].filter(Boolean).join(" ");
    out += `<mark class="${cls}" data-ids="${ids.join(" ")}">${seg}</mark>`;
  }
  return out;
}

// ---------- selection → new comment ----------

const selBar = $("#sel-bar");

function currentSelectionAnchor() {
  const sel = window.getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const host = (n) => (n.nodeType === 1 ? n : n.parentElement)?.closest("#main .text");
  const el = host(range.startContainer);
  if (!el || el !== host(range.endContainer)) return null;
  const offsetOf = (node, off) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    r.setEnd(node, off);
    return r.toString().length;
  };
  let start = offsetOf(range.startContainer, range.startOffset);
  let end = offsetOf(range.endContainer, range.endOffset);
  const text = fieldText(el.dataset.run, Number(el.dataset.v), el.dataset.field) ?? "";
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  if (start >= end) return null;
  return { runId: el.dataset.run, vIdx: Number(el.dataset.v), field: el.dataset.field, start, end,
           quote: text.slice(start, end), rect: range.getClientRects()[0] || range.getBoundingClientRect() };
}

document.addEventListener("mouseup", (e) => {
  if (selBar.contains(e.target)) return;
  setTimeout(() => {
    const a = currentSelectionAnchor();
    if (!a) { selBar.classList.add("hidden"); return; }
    selBar._anchor = a;
    selBar.classList.remove("hidden");
    const above = a.rect.top - selBar.offsetHeight - 8;   // sit above the first selected line
    selBar.style.top = `${above > 56 ? above : a.rect.bottom + 8}px`;
    selBar.style.left = `${Math.max(8, Math.min(a.rect.left, window.innerWidth - selBar.offsetWidth - 8))}px`;
  });
});
document.addEventListener("selectionchange", () => {
  if (window.getSelection().isCollapsed) {
    selBar.classList.add("hidden");
    if (state.deferHighlights) refreshHighlights();
  }
});
$("#main").addEventListener("scroll", () => selBar.classList.add("hidden"));
selBar.addEventListener("mousedown", (e) => e.preventDefault());
selBar.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-sel]");
  if (!b || !selBar._anchor) return;
  const { rect, ...anchor } = selBar._anchor;
  selBar.classList.add("hidden");
  window.getSelection().removeAllRanges();
  if (b.dataset.sel === "comment") return startComposer(anchor);
  try {
    await addDoc(myHighlights(), { ...anchor, createdAt: serverTimestamp() });
  } catch (err) {
    console.error(err);
    alert("Failed: " + (err.code || err.message));
  }
});

const hlPop = $("#hl-pop");

function showHlPop(mark, id) {
  if (!state.highlights.has(id)) return;
  setActive(HL + id);
  hlPop.innerHTML = `<span class="who" title="Highlights are never shared with other reviewers">🖍 Your highlight · only you can see it</span>
    <button data-hl="note">💬 Add comment (shared)</button>
    <button data-hl="delete">Remove</button>`;
  hlPop._id = id;
  hlPop.classList.remove("hidden");
  const r = mark.getClientRects()[0] || mark.getBoundingClientRect();
  const above = r.top - hlPop.offsetHeight - 8;
  hlPop.style.top = `${above > 56 ? above : r.bottom + 8}px`;
  hlPop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - hlPop.offsetWidth - 8))}px`;
}
const hideHlPop = () => hlPop.classList.add("hidden");

hlPop.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-hl]");
  const c = state.highlights.get(hlPop._id);
  if (!b || !c) return;
  hideHlPop();
  if (b.dataset.hl === "note") {
    startComposer({ runId: c.runId, vIdx: c.vIdx, field: c.field, start: c.start, end: c.end, quote: c.quote, convertId: c.id });
  } else if (b.dataset.hl === "delete") {
    try { await deleteDoc(doc(myHighlights(), c.id)); } catch (err) { alert("Failed: " + (err.code || err.message)); }
  }
});
document.addEventListener("mousedown", (e) => {
  if (!hlPop.contains(e.target) && !e.target.closest?.("mark.hl")) hideHlPop();
});
$("#main").addEventListener("scroll", hideHlPop);

// ---------- floating composer (opens next to the selected text) ----------

const fc = $("#float-composer");

function startComposer(anchor) {
  state.pending = anchor;
  state.mode = "view";
  fc.innerHTML = `
    ${anchor.quote ? "" : `<div class="muted small">Comment on the whole “${esc(fieldLabel(anchor.runId, anchor.vIdx, anchor.field))}” section</div>`}
    <textarea placeholder="Write a comment…" rows="3"></textarea>
    <div class="row">
      <span class="muted small">Visible to all reviewers · Ctrl+Enter</span>
      <span class="spacer"></span>
      <button class="btn" data-act="cancel">Cancel</button>
      <button class="btn primary" data-act="create">Post</button>
    </div>`;
  fc.classList.remove("hidden");
  renderSidebar();
  refreshHighlights(true);   // draws the pending mark and positions the composer
  fc.querySelector("textarea").focus({ preventScroll: true });
}

function closeComposer() {
  state.pending = null;
  fc.classList.add("hidden");
  fc.innerHTML = "";
  refreshHighlights(true);
}

function positionComposer() {
  if (!state.pending || fc.classList.contains("hidden")) return;
  const p = state.pending;
  const host = document.querySelector(`#main .text[data-run="${CSS.escape(p.runId)}"][data-v="${p.vIdx}"][data-field="${CSS.escape(p.field)}"]`);
  const marks = [...document.querySelectorAll("#main mark.pending")];
  let below, above;
  if (marks.length) {
    const rects = marks.flatMap((m) => [...m.getClientRects()]);
    below = rects[rects.length - 1];
    above = rects[0];
  } else {
    // whole-section comment: hang under the button that opened it, right-aligned
    const btn = document.querySelector(`#main [data-general="${CSS.escape(`${p.runId}|${p.vIdx}|${p.field}`)}"]`);
    const r = (btn || host)?.getBoundingClientRect();
    if (!r) return;
    below = above = { left: r.right - fc.offsetWidth, bottom: r.bottom, top: r.top };
  }
  const main = $("#main").getBoundingClientRect();
  const w = fc.offsetWidth, h = fc.offsetHeight;
  let top = below.bottom + 8;
  if (top + h > window.innerHeight - 8 && above.top - h - 8 > main.top) top = above.top - h - 8;
  fc.style.top = `${Math.max(main.top + 4, Math.min(top, window.innerHeight - h - 8))}px`;
  fc.style.left = `${Math.max(main.left + 8, Math.min(below.left, main.right - w - 16))}px`;
}

$("#main").addEventListener("scroll", positionComposer);
window.addEventListener("resize", positionComposer);
fc.addEventListener("click", (e) => {
  const b = e.target.closest("[data-act]");
  if (b) act(b.dataset.act);
});
fc.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); act("create"); }
  else if (e.key === "Escape") { e.preventDefault(); act("cancel"); }
});

// ---------- sidebar ----------

document.querySelectorAll(".seg button").forEach((b) => b.addEventListener("click", () => {
  state.mode = b.dataset.mode;
  renderSidebar();
}));
$("#show-resolved").checked = state.showResolved;
$("#show-resolved").addEventListener("change", (e) => {
  state.showResolved = e.target.checked;
  save("showResolved", state.showResolved);
  refreshHighlights(true);
  renderSidebar();
});

function renderSidebar() {
  document.querySelectorAll(".seg button").forEach((b) => b.classList.toggle("active", b.dataset.mode === state.mode));

  // keep drafts & focus across re-renders
  const drafts = {};
  document.querySelectorAll("#sidebar textarea[data-draft]").forEach((t) => { drafts[t.dataset.draft] = t.value; });
  const focused = document.activeElement?.dataset?.draft;


  const all = threads().filter((c) => state.showResolved || isOpen(c));
  const runs = visibleRuns();
  const order = new Map(runs.map((r, i) => [r.id, i]));
  const here = all.filter((c) => order.has(c.runId) && (c.vIdx === -1 || c.vIdx === Math.min(state.vIdx, state.runsById.get(c.runId).variations.length - 1)));
  const [viewBtn, allBtn] = document.querySelectorAll(".seg button");
  viewBtn.textContent = `${runs.length > 1 ? `These ${runs.length} runs` : "This run"} (${here.length})`;
  allBtn.textContent = `All runs (${all.length})`;
  let list = state.mode === "view" ? here : all;
  let html;
  if (state.mode === "view") {
    list.sort((a, b) => order.get(a.runId) - order.get(b.runId) || fieldRank(a) - fieldRank(b)
      || (a.start ?? -1) - (b.start ?? -1) || byTime(a, b));
    html = list.map((c) => threadHtml(c, runs.length > 1)).join("");
  } else {
    list.sort((a, b) => byTime(b, a));
    html = reviewerSummary() + list.map((c) => threadHtml(c, true)).join("");
  }
  $("#threads").innerHTML = html || `<p class="empty">${state.mode === "view" ? "No comments on this run yet. Select text to add one." : "No comments yet."}</p>`;

  document.querySelectorAll("#sidebar textarea[data-draft]").forEach((t) => {
    if (drafts[t.dataset.draft]) t.value = drafts[t.dataset.draft];
    if (t.dataset.draft === focused) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); }
  });
}

function reviewerSummary() {
  const rows = [...allReviewerNames()].map(([key, name]) => {
    const runs = [...state.reviews.values()].filter((r) => lc(r.name) === key).length;
    const comments = [...state.comments.values()].filter((c) => lc(c.author) === key).length;
    return { name, runs, comments };
  }).sort((a, b) => b.runs - a.runs || b.comments - a.comments);
  if (!rows.length) return "";
  return `<div class="summary">${rows.map((r) => `
    <div class="srow">${chip(r.name)} <b>${esc(r.name)}</b>
      <span class="muted small">${r.runs} run${r.runs === 1 ? "" : "s"} · ${r.comments} comment${r.comments === 1 ? "" : "s"}</span></div>`).join("")}</div>`;
}

function fmtTime(c) {
  const ms = ts(c);
  return ms ? new Date(ms).toLocaleString("en-US", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
}

function commentHtml(c, isRoot, replyCount) {
  const mine = c.author === state.me;
  return `
  <div class="cmt" data-cid="${c.id}">
    <div class="cmt-meta"><b>${esc(c.author)}</b><span>${fmtTime(c)}${c.editedAt ? " (edited)" : ""}</span>
      ${mine ? `<button class="link-btn" data-act="edit" data-id="${c.id}">Edit</button>` : ""}
      ${mine && !(isRoot && replyCount) ? `<button class="link-btn" data-act="delete" data-id="${c.id}">Delete</button>` : ""}
    </div>
    <div class="cmt-body">${esc(c.text)}</div>
  </div>`;
}

function threadHtml(c, showLoc) {
  const run = state.runsById.get(c.runId);
  const replies = repliesOf(c.id);
  const orphan = c.start != null && !locate(c);
  return `
  <div class="thread ${c.id === state.active ? "active" : ""} ${c.resolved ? "resolved" : ""}" data-thread="${c.id}">
    ${showLoc ? `<div class="loc">${esc(run ? `Case ${run.caseId} · ${run.style}` : c.runId)} · ${esc(run ? varLabel(run, c.vIdx) : "")} · ${esc(fieldLabel(c.runId, c.vIdx, c.field))}</div>` : ""}
    ${orphan ? `<div class="quote orphan" title="The source text changed; this passage can no longer be located">${esc(c.quote)}</div>`
      : c.quote ? (state.mode === "all" ? `<div class="quote note one-line" title="${esc(c.quote)}">${esc(c.quote)}</div>` : "")
      : `<div class="loc">Whole section${showLoc ? "" : ` · ${esc(fieldLabel(c.runId, c.vIdx, c.field))}`}</div>`}
    ${commentHtml(c, true, replies.length)}
    ${replies.map((r) => commentHtml(r, false)).join("")}
    <textarea data-draft="reply-${c.id}" placeholder="Reply…" rows="1"></textarea>
    <div class="row">
      <button class="btn" data-act="reply" data-id="${c.id}">Reply</button>
      <button class="btn" data-act="resolve" data-id="${c.id}">${c.resolved ? "Reopen" : "Resolve"}</button>
      ${c.resolved && c.resolvedBy ? `<span class="muted small">resolved by ${esc(c.resolvedBy)}</span>` : ""}
    </div>
  </div>`;
}

$("#sidebar").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && e.target.matches("textarea[data-draft]")) {
    e.preventDefault();
    const d = e.target.dataset.draft;
    if (d === "new") act("create");
    else if (d.startsWith("reply-")) act("reply", d.slice(6));
    else if (d.startsWith("edit-")) act("save-edit", d.slice(5));
  }
});

$("#sidebar").addEventListener("click", (e) => {
  const b = e.target.closest("[data-act]");
  if (b) return act(b.dataset.act, b.dataset.id);
  const t = e.target.closest(".thread");
  // clicking the card body (not its inputs) jumps to the passage, like Google Docs
  if (t && !e.target.closest("textarea, button, a")) jumpTo(t.dataset.thread);
});

async function act(kind, id) {
  try {
    if (kind === "create") {
      const ta = fc.querySelector("textarea");
      const text = ta.value.trim();
      if (!text) return;
      const p = state.pending;
      const ref = await addDoc(collection(db, "comments"), {
        parent: null, runId: p.runId, vIdx: p.vIdx, field: p.field,
        start: p.start, end: p.end, quote: p.quote,
        author: state.me, text, createdAt: serverTimestamp(), resolved: false,
      });
      // a memo on a private highlight turns it into a shared comment
      if (p.convertId) await deleteDoc(doc(myHighlights(), p.convertId)).catch(console.error);
      state.active = ref.id;
      closeComposer();
      renderSidebar();
      setActive(ref.id, { scrollSidebar: true });
    } else if (kind === "cancel") {
      closeComposer();
    } else if (kind === "reply") {
      const ta = document.querySelector(`textarea[data-draft="reply-${id}"]`);
      const text = ta.value.trim();
      if (!text) { setActive(id); ta.focus(); return; }   // reply box is only shown on the active card
      const root = state.comments.get(id);
      ta.value = "";
      await addDoc(collection(db, "comments"), {
        parent: id, runId: root.runId, vIdx: root.vIdx, field: root.field,
        author: state.me, text, createdAt: serverTimestamp(),
      });
    } else if (kind === "resolve") {
      const c = state.comments.get(id);
      await updateDoc(doc(db, "comments", id), { resolved: !c.resolved, resolvedBy: c.resolved ? null : state.me });
    } else if (kind === "delete") {
      if (confirm("Delete this comment?")) await deleteDoc(doc(db, "comments", id));
    } else if (kind === "edit") {
      const body = document.querySelector(`.cmt[data-cid="${id}"] .cmt-body`);
      body.outerHTML = `<textarea data-draft="edit-${id}">${esc(state.comments.get(id).text)}</textarea>
        <div class="row"><button class="btn primary" data-act="save-edit" data-id="${id}">Save</button>
        <button class="btn" data-act="cancel-edit">Cancel</button></div>`;
      document.querySelector(`textarea[data-draft="edit-${id}"]`).focus();
    } else if (kind === "save-edit") {
      const text = document.querySelector(`textarea[data-draft="edit-${id}"]`).value.trim();
      if (text) await updateDoc(doc(db, "comments", id), { text, editedAt: serverTimestamp() });
      renderSidebar();
    } else if (kind === "cancel-edit") {
      renderSidebar();
    } else if (kind === "jump") {
      jumpTo(id);
    }
  } catch (err) {
    console.error(err);
    alert("Failed: " + (err.code || err.message));
  }
}

function setActive(id, { scrollSidebar = false } = {}) {
  state.active = id;
  document.querySelectorAll("#main mark.hl").forEach((m) => m.classList.toggle("active", m.dataset.ids.split(" ").includes(id)));
  document.querySelectorAll(".thread").forEach((t) => t.classList.toggle("active", t.dataset.thread === id));
  if (scrollSidebar) document.querySelector(`.thread[data-thread="${id}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function jumpTo(id) {
  const c = state.comments.get(id);
  if (!c) return;
  const shown = visibleRuns().some((r) => r.id === c.runId);
  if (!shown || (c.vIdx >= 0 && c.vIdx !== state.vIdx)) {
    state.active = id;
    go(c.runId, c.vIdx >= 0 ? c.vIdx : state.vIdx);
    setTimeout(() => jumpTo(id), 50);
    return;
  }
  if (c.resolved && !state.showResolved) return setActive(id);
  setActive(id);
  const mark = [...document.querySelectorAll("#main mark.hl")].find((m) => m.dataset.ids.split(" ").includes(id));
  const host = document.querySelector(`#main .text[data-run="${CSS.escape(c.runId)}"][data-v="${c.vIdx}"][data-field="${CSS.escape(c.field)}"]`);
  const sec = host?.closest("details");
  if (sec && !sec.open) sec.open = true;
  if (!mark) host?.scrollIntoView({ block: "center", behavior: "smooth" });
  if (mark) {
    mark.scrollIntoView({ block: "center", behavior: "smooth" });
    mark.classList.remove("flash");
    void mark.offsetWidth;
    mark.classList.add("flash");
  }
}

$("#compare-toggle").checked = state.compare;
