// ==========================================================
// class-record.js — Class record page (teachers, registrar, administrators)
//
// For each class and grading period (Prelim, Midterm, Semi-final, Final) the teacher
// adds assessments (quiz, activity, project, exam… with their total points) and types
// each student's raw score. With the Grading policy (settings/classRecord) the page shows:
//   raw percentage per category → weighted initial grade → transmuted grade → remarks
// Collection classRecords, id {assignmentId}_{period}: the assessments, raw scores, the
// computed results and the policy used (so every grade can be traced back).
// Status: draft → submitted → approved (or returned to the teacher). With "approval not
// needed" in the policy, a submitted period is already official.
// The All periods tab combines the four period grades only if the policy says how.
// ==========================================================

import { db, collection, doc, getDoc, getDocs, query, where, documentId, serverTimestamp, setDoc } from "./firebase-config.js";
import {
  initLayout, toast, confirmDialog, escapeHtml, setBusy, compareText, errorMessage, formatUnits, formatDateTime,
  getOptions, getDowntime, downtimeActive, downtimeText,
} from "./app.js";
import {
  PERIODS, periodLabel, policyOf, policyProblems, parseScore, studentPeriodGrade, combinePeriods, isOfficial, recordId, roundGrade,
} from "./class-record-core.js";
import { termOf, yearTermText, termClosed } from "./terms.js";
import { hasLeft, statusBadge } from "./student-status.js";

const $ = (id) => document.getElementById(id);
const els = {
  policyAlert: $("crPolicyAlert"), cls: $("crClass"), periods: $("crPeriods"), empty: $("crEmpty"), sheet: $("crSheet"),
  title: $("crTitle"), sub: $("crSub"), meta: $("crMeta"), notice: $("crNotice"),
  periodView: $("crPeriodView"), addForm: $("crAddForm"), addComp: $("crAddComp"), addTitle: $("crAddTitle"), addMax: $("crAddMax"),
  btnAdd: $("btnCrAdd"), weights: $("crWeights"), head: $("crHead"), body: $("crBody"), dirty: $("crDirty"),
  btnSave: $("btnCrSave"), btnSubmit: $("btnCrSubmit"), btnApprove: $("btnCrApprove"), btnReturn: $("btnCrReturn"),
  summaryView: $("crSummaryView"), sumHead: $("crSumHead"), sumBody: $("crSumBody"), sumNote: $("crSumNote"), btnToGrades: $("btnCrToGrades"),
  calcEarned: $("calcEarned"), calcMax: $("calcMax"), calcWeight: $("calcWeight"), calcOut: $("calcOut"),
};

let me = null;
let policy = policyOf(null);
let policyReady = false;
let assignments = [];
let current = null; // the open grading assignment
let period = "prelim"; // a PERIODS key, or "summary"
let records = {}; // period -> saved class record (this class)
let students = []; // [{ sid, number, name, student }]
let assessments = []; // working copy: [{ id, component, title, maxScore }]
let raw = {}; // sid -> [typed text per assessment]
let dirty = false;
let locked = false; // teachers: submitted / approved period, downtime or term closed
let lockText = "";
let openSeq = 0;

const isStaff = () => me.role === "admin" || me.role === "registrar";
const STATUS = {
  none: ["badge-none", "Not started"],
  draft: ["badge-none", "Draft"],
  returned: ["badge-fail", "Returned to teacher"],
  submitted: ["badge-count", "Submitted"],
  approved: ["badge-pass", "Approved"],
};
const statusBadgeHtml = (st) => { const [c, t] = STATUS[st] || STATUS.none; return `<span class="badge ${c}">${t}</span>`; };
const fmt = (n) => (Number.isFinite(n) ? String(roundGrade(n, policy.decimals, policy.rounding)) : "");
const compName = (key) => policy.components.find((c) => c.key === key)?.name || `${key} (removed category)`;

// ---------- Policy ----------
async function loadPolicy() {
  try {
    const snap = await getDoc(doc(db, "settings", "classRecord"));
    policy = policyOf(snap.exists() ? snap.data() : null);
    const problems = snap.exists() ? policyProblems(policy) : ["The administrator hasn't saved the college's grading policy yet."];
    policyReady = !problems.length;
    els.policyAlert.innerHTML = policyReady ? "" : `
      <div class="alert alert-warning small">
        <strong>Period grades can't be computed yet.</strong> You can add assessments and type raw scores; grades appear once the grading policy is complete.
        <ul class="mb-0 mt-1">${problems.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul>
        ${me.role === "admin" ? `<a href="grading-policy.html" class="alert-link">Open Grading policy</a>` : "Ask the administrator to finish the Grading policy."}
      </div>`;
  } catch (err) {
    policyReady = false;
    els.policyAlert.innerHTML = `<div class="alert alert-danger small">Couldn't load the grading policy: ${escapeHtml(errorMessage(err))}</div>`;
  }
  els.addComp.innerHTML = policy.components.map((c) => `<option value="${escapeHtml(c.key)}">${escapeHtml(c.name)} (${c.weight}%)</option>`).join("");
  els.weights.textContent = policy.components.map((c) => `${c.name} ${c.weight}%`).join(" · ");
}

// ---------- Classes ----------
async function loadClasses() {
  if (me.role === "teacher" && !me.teacherDocId) {
    els.cls.innerHTML = `<option value="">Your account isn't linked to a teacher</option>`;
    els.cls.disabled = true;
    els.empty.innerHTML = `<div class="empty-state">Your account isn't linked to a teacher record yet. Ask an administrator to link it on the Users and roles page.</div>`;
    return;
  }
  try {
    const src = me.role === "teacher"
      ? query(collection(db, "gradingAssignments"), where("teacherDocId", "==", me.teacherDocId))
      : collection(db, "gradingAssignments");
    assignments = (await getDocs(src)).docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (err) {
    els.cls.innerHTML = `<option value="">Couldn't load classes</option>`;
    toast(errorMessage(err), "danger");
    return;
  }
  if (!assignments.length) {
    els.cls.innerHTML = `<option value="">No classes yet</option>`;
    els.cls.disabled = true;
    els.empty.innerHTML = `<div class="empty-state">${me.role === "teacher" ? "No classes are assigned to you yet." : 'No grading assignments yet. <a href="assignments.html">Create one</a> first.'}</div>`;
    return;
  }
  const byTeacher = {};
  assignments.forEach((a) => (byTeacher[a.teacherName] = byTeacher[a.teacherName] || []).push(a));
  els.cls.innerHTML = `<option value="">Select a class</option>` + Object.keys(byTeacher).sort(compareText).map((t) =>
    `<optgroup label="${escapeHtml(t)}">${byTeacher[t]
      .sort((a, b) => compareText(b.schoolYear, a.schoolYear) || compareText(a.subjectCode, b.subjectCode))
      .map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.subjectCode)} ${escapeHtml(a.subjectName)}, ${escapeHtml(a.sectionName)}, ${escapeHtml(yearTermText(a.schoolYear, termOf(a)))}</option>`)
      .join("")}</optgroup>`).join("");

  const params = new URLSearchParams(location.search);
  const id = params.get("assignment");
  const p = params.get("period");
  if (p && (p === "summary" || PERIODS.some((x) => x.key === p))) period = p;
  renderPeriodButtons();
  if (id && assignments.some((a) => a.id === id)) {
    els.cls.value = id;
    openClass(id);
  }
}

function renderPeriodButtons() {
  els.periods.innerHTML = [...PERIODS, { key: "summary", label: "All periods" }].map((p) => {
    const st = p.key === "summary" ? "" : records[p.key]?.status;
    const mark = st === "approved" || (st === "submitted" && !policy.requireApproval) ? ' <i class="bi bi-check-circle-fill" aria-label="official"></i>'
      : st === "submitted" ? ' <i class="bi bi-hourglass-split" aria-label="submitted"></i>'
      : st === "returned" ? ' <i class="bi bi-arrow-counterclockwise" aria-label="returned"></i>' : "";
    return `<button type="button" class="btn btn-sm ${p.key === period ? "btn-primary" : "btn-outline-primary"}" data-period="${p.key}" aria-pressed="${p.key === period}">${p.label}${current ? mark : ""}</button>`;
  }).join("");
}

async function fetchStudents(ids) {
  const found = {};
  for (let i = 0; i < ids.length; i += 30) {
    const snap = await getDocs(query(collection(db, "students"), where(documentId(), "in", ids.slice(i, i + 30))));
    snap.forEach((d) => (found[d.id] = d.data()));
  }
  return found;
}

/** Reads this class's four period records (teachers may only read their own). */
async function readRecords(a) {
  const q = me.role === "teacher"
    ? query(collection(db, "classRecords"), where("assignmentId", "==", a.id), where("teacherDocId", "==", me.teacherDocId))
    : query(collection(db, "classRecords"), where("assignmentId", "==", a.id));
  const out = {};
  (await getDocs(q)).forEach((d) => { const r = d.data(); out[r.period] = { id: d.id, ...r }; });
  return out;
}

async function openClass(id) {
  const seq = ++openSeq;
  current = assignments.find((a) => a.id === id) || null;
  history.replaceState(null, "", current ? `?assignment=${encodeURIComponent(id)}&period=${period}` : location.pathname);
  if (!current) {
    els.sheet.classList.add("d-none");
    els.empty.classList.remove("d-none");
    renderPeriodButtons();
    return;
  }
  els.empty.classList.add("d-none");
  els.sheet.classList.remove("d-none");
  renderHeader();
  els.body.innerHTML = `<tr><td class="empty-state">Loading…</td></tr>`;
  try {
    const ids = current.studentIds || [];
    const [found, recs] = await Promise.all([fetchStudents(ids), readRecords(current)]);
    if (seq !== openSeq) return;
    records = recs;
    students = ids.map((sid) => ({
      sid, number: found[sid]?.studentId ?? "—", name: found[sid]?.studentName ?? "(student record not found)", student: found[sid] || null,
    })).sort((a, b) => compareText(a.name, b.name));
    await openPeriod(period, { force: true });
  } catch (err) {
    if (seq !== openSeq) return;
    els.body.innerHTML = `<tr><td class="empty-state text-danger">${escapeHtml(errorMessage(err))}</td></tr>`;
  }
}

function renderHeader() {
  const a = current;
  els.title.textContent = `${a.subjectCode ? `${a.subjectCode} - ` : ""}${a.subjectName}`;
  els.sub.textContent = `Class record for ${a.sectionName}, ${yearTermText(a.schoolYear, termOf(a))}`;
  els.meta.innerHTML = [
    ["Teacher", a.teacherName], ["Units", formatUnits(a.units)], ["School Year", a.schoolYear],
    ...(termOf(a) ? [["Term", termOf(a)]] : []), ["Section", a.sectionName], ["Students", String((a.studentIds || []).length)],
  ].map(([k, v]) => `<div><dt>${k}</dt><dd>${escapeHtml(v)}</dd></div>`).join("");
}

// ---------- One period ----------
async function openPeriod(p, { force = false } = {}) {
  if (!force && dirty && !(await confirmDialog({ title: "Leave without saving?", message: "Your changes to this period aren't saved.", confirmText: "Leave", variant: "warning" }))) return;
  period = p;
  dirty = false;
  if (current) history.replaceState(null, "", `?assignment=${encodeURIComponent(current.id)}&period=${period}`);
  renderPeriodButtons();
  els.notice.innerHTML = "";
  const summary = period === "summary";
  els.periodView.classList.toggle("d-none", summary);
  els.summaryView.classList.toggle("d-none", !summary);
  if (summary) { renderSummary(); return; }

  const rec = records[period] || null;
  assessments = (rec?.assessments || []).map((a) => ({ ...a }));
  raw = {};
  students.forEach((s) => {
    const saved = rec?.scores?.[s.sid] || [];
    raw[s.sid] = assessments.map((_, i) => (Number.isFinite(saved[i]) ? String(saved[i]) : ""));
  });
  await checkLock(rec);
  renderGrid();
  renderStatus();
}

async function checkLock(rec) {
  locked = false;
  lockText = "";
  if (isStaff()) return;
  const st = rec?.status || "none";
  if (st === "submitted" || st === "approved") {
    locked = true;
    lockText = st === "approved" ? "Approved: this period's grades are official." : "Submitted: waiting for approval. Ask the registrar to return it if something must change.";
    return;
  }
  try {
    const d = await getDowntime();
    if (downtimeActive(d)) { locked = true; lockText = downtimeText(d); return; }
    const o = await getOptions(true);
    if (termClosed(o, termOf(current))) { locked = true; lockText = "Grade entry for this term is closed. Ask the registrar to enter late grades."; }
  } catch { /* the database rules still check it */ }
}

/** One student's result with the typed scores (and current policy). */
function resultOf(sid) {
  const scores = (raw[sid] || []).map((t, i) => parseScore(t, assessments[i].maxScore));
  if (scores.some((x) => x.state === "invalid")) return { state: "invalid", reason: "Fix the red scores." };
  try {
    return studentPeriodGrade(assessments, scores.map((x) => x.value), policy);
  } catch (err) {
    return { state: "error", reason: err.message };
  }
}

function renderGrid() {
  const editable = !locked;
  els.addForm.classList.toggle("d-none", !editable);
  const comps = policy.components.filter((c) => c.weight > 0);
  els.head.innerHTML = `<tr>
    <th class="num" style="width:2.5rem">#</th>
    <th style="min-width:12rem">Student</th>
    ${assessments.map((a, i) => `<th class="text-center" style="min-width:6.5rem">
        <div class="small text-secondary text-truncate">${escapeHtml(compName(a.component))}</div>
        <div>${escapeHtml(a.title)}</div>
        <div class="small text-secondary">/ ${escapeHtml(String(a.maxScore))}${editable ? ` <button type="button" class="btn btn-link btn-sm p-0 text-danger" data-del-a="${i}" aria-label="Remove ${escapeHtml(a.title)}" title="Remove this assessment"><i class="bi bi-x-circle"></i></button>` : ""}</div>
      </th>`).join("")}
    ${comps.map((c) => `<th class="text-center small" title="Raw percentage × ${c.weight}%">${escapeHtml(c.name)}<div class="text-secondary">${c.weight}%</div></th>`).join("")}
    <th class="text-center">Initial grade</th>
    <th class="text-center">Transmuted</th>
    <th>Remarks</th>
  </tr>`;
  if (!students.length) {
    els.body.innerHTML = `<tr><td colspan="${5 + assessments.length + comps.length}" class="empty-state">This class has no students.</td></tr>`;
    return;
  }
  els.body.innerHTML = students.map((s, si) => `
    <tr data-sid="${escapeHtml(s.sid)}">
      <td class="num text-secondary">${si + 1}</td>
      <td><div>${escapeHtml(s.name)}${statusBadge(s.student, escapeHtml)}</div><div class="small text-secondary">${escapeHtml(s.number)}</div></td>
      ${assessments.map((a, ai) => `<td class="text-center">
        <input type="text" inputmode="decimal" class="form-control form-control-sm text-center mx-auto" style="max-width:5.5rem" data-s="${si}" data-a="${ai}"
          value="${escapeHtml(raw[s.sid][ai])}" maxlength="7" autocomplete="off" ${editable ? "" : "readonly tabindex=\"-1\""}
          aria-label="${escapeHtml(a.title)} score for ${escapeHtml(s.name)}, out of ${escapeHtml(String(a.maxScore))}">
      </td>`).join("")}
      ${comps.map((c) => `<td class="text-center small" data-comp="${escapeHtml(c.key)}"></td>`).join("")}
      <td class="text-center" data-ig></td>
      <td class="text-center fw-semibold" data-tg></td>
      <td data-rm></td>
    </tr>`).join("");
  students.forEach((s, si) => renderRowResult(si));
}

function renderRowResult(si) {
  const s = students[si];
  const tr = els.body.querySelector(`tr[data-sid="${CSS.escape(s.sid)}"]`);
  if (!tr) return;
  (raw[s.sid] || []).forEach((t, ai) => {
    const input = tr.querySelector(`input[data-a="${ai}"]`);
    const p = parseScore(t, assessments[ai].maxScore);
    input.classList.toggle("is-invalid", p.state === "invalid");
    input.title = p.state === "invalid" ? p.why : "";
  });
  const r = resultOf(s.sid);
  (r.components || []).forEach((c) => {
    const td = tr.querySelector(`[data-comp="${CSS.escape(c.key)}"]`);
    if (td) td.textContent = c.percentage === null ? "" : `${fmt(c.percentage)}%`;
  });
  const ig = tr.querySelector("[data-ig]");
  const tg = tr.querySelector("[data-tg]");
  const rm = tr.querySelector("[data-rm]");
  if (r.state === "complete" && policyReady) {
    ig.textContent = fmt(r.initialGrade);
    tg.textContent = String(r.transmutedGrade);
    rm.innerHTML = `<span class="badge ${r.remarks === "Passed" ? "badge-pass" : "badge-fail"}">${r.remarks}</span>`;
  } else {
    ig.textContent = Number.isFinite(r.initialGrade) ? fmt(r.initialGrade) : "";
    tg.textContent = "";
    const why = !policyReady && r.state === "complete" ? "Grading policy not ready." : r.reason || "";
    rm.innerHTML = hasLeft(s.student) ? `<span class="small text-secondary">Left the class</span>` : `<span class="small ${r.state === "error" || r.state === "invalid" ? "text-danger" : "text-secondary"}">${escapeHtml(why)}</span>`;
  }
}

function renderStatus() {
  const rec = records[period];
  const st = rec?.status || "none";
  const staff = isStaff();
  const bits = [statusBadgeHtml(st)];
  if (rec?.submittedByName && (st === "submitted" || st === "approved")) bits.push(`Submitted by ${escapeHtml(rec.submittedByName)}${rec.submittedAt ? `, ${escapeHtml(formatDateTime(rec.submittedAt))}` : ""}.`);
  if (st === "approved" && rec.approvedByName) bits.push(`Approved by ${escapeHtml(rec.approvedByName)}${rec.approvedAt ? `, ${escapeHtml(formatDateTime(rec.approvedAt))}` : ""}.`);
  if (st === "returned" && rec.returnedByName) bits.push(`Returned by ${escapeHtml(rec.returnedByName)}: fix and submit again.`);
  if (st === "submitted" && !policy.requireApproval) bits.push("Official (approval isn't required).");
  if (locked && lockText) bits.push(`<i class="bi bi-lock-fill"></i> ${escapeHtml(lockText)}`);
  if (rec && rec.policyVersion && rec.policyVersion !== policy.version && (st === "submitted" || st === "approved")) {
    bits.push(`<span class="text-warning-emphasis">Saved with grading policy version ${escapeHtml(String(rec.policyVersion))} (now ${escapeHtml(String(policy.version || "?"))}).</span>`);
  }
  els.notice.innerHTML = `<div class="small d-flex flex-wrap gap-2 align-items-center">${bits.join(" ")}</div>`;

  els.btnSave.classList.toggle("d-none", locked);
  els.btnSubmit.classList.toggle("d-none", locked || (staff && st !== "none" && st !== "draft" && st !== "returned"));
  els.btnSubmit.innerHTML = staff
    ? `<i class="bi bi-send me-1"></i>${policy.requireApproval ? "Save as approved" : "Save as submitted"}`
    : `<i class="bi bi-send me-1"></i>Submit period grades`;
  els.btnApprove.classList.toggle("d-none", !(staff && st === "submitted" && policy.requireApproval));
  els.btnReturn.classList.toggle("d-none", !(staff && (st === "submitted" || st === "approved")));
  els.btnSave.innerHTML = staff && (st === "submitted" || st === "approved") ? `<i class="bi bi-save me-1"></i>Save changes` : `<i class="bi bi-save me-1"></i>Save draft`;
  renderDirty();
}

function renderDirty() {
  els.dirty.textContent = dirty ? "Unsaved changes." : records[period] ? "All changes saved." : "";
}

// ---------- Editing ----------
function addAssessment() {
  const component = els.addComp.value;
  const title = els.addTitle.value.trim();
  const maxScore = Number(els.addMax.value);
  if (!component) { toast("Choose the assessment type.", "warning"); return; }
  if (!title) { toast("Type a title, like Quiz 1.", "warning"); els.addTitle.focus(); return; }
  if (!(maxScore > 0)) { toast("Total possible points must be more than 0.", "warning"); els.addMax.focus(); return; }
  if (assessments.length >= 100) { toast("A period can have up to 100 assessments.", "warning"); return; }
  const a = { id: `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, component, title, maxScore };
  // Keep each category's assessments together, in the policy's order
  const order = (k) => { const i = policy.components.findIndex((c) => c.key === k); return i < 0 ? 999 : i; };
  let at = assessments.length;
  for (let i = 0; i < assessments.length; i++) { if (order(assessments[i].component) > order(component)) { at = i; break; } }
  assessments.splice(at, 0, a);
  students.forEach((s) => raw[s.sid].splice(at, 0, ""));
  els.addTitle.value = "";
  markDirty();
  renderGrid();
  els.body.querySelector(`input[data-s="0"][data-a="${at}"]`)?.focus();
}

async function removeAssessment(i) {
  const a = assessments[i];
  const typed = students.filter((s) => raw[s.sid][i] !== "").length;
  const ok = await confirmDialog({
    title: "Remove assessment?",
    message: `Remove ${a.title} (${compName(a.component)}, ${a.maxScore} points)${typed ? ` and the ${typed} score${typed === 1 ? "" : "s"} typed for it` : ""}? It's gone once you save.`,
    confirmText: "Remove",
  });
  if (!ok) return;
  assessments.splice(i, 1);
  students.forEach((s) => raw[s.sid].splice(i, 1));
  markDirty();
  renderGrid();
}

function markDirty() {
  dirty = true;
  renderDirty();
}

// ---------- Save / submit / approve ----------
function buildRecord(status, extra = {}) {
  const a = current;
  const scores = {};
  const results = {};
  students.forEach((s) => {
    scores[s.sid] = raw[s.sid].map((t, i) => { const p = parseScore(t, assessments[i].maxScore); return p.state === "valid" ? p.value : null; });
    const r = resultOf(s.sid);
    if (policyReady && r.state === "complete") results[s.sid] = { initialGrade: r.initialGrade, transmutedGrade: r.transmutedGrade, remarks: r.remarks };
  });
  return {
    assignmentId: a.id, teacherDocId: a.teacherDocId, teacherName: a.teacherName,
    subjectId: a.subjectId, subjectCode: a.subjectCode, subjectName: a.subjectName, units: Number(a.units),
    sectionId: a.sectionId, sectionName: a.sectionName, schoolYear: a.schoolYear, term: termOf(a), yearLevel: a.yearLevel,
    period, periodLabel: periodLabel(period),
    assessments: assessments.map((x) => ({ id: x.id, component: x.component, title: x.title, maxScore: x.maxScore })),
    scores, results,
    // The policy used, so each grade can be traced back
    policyVersion: policy.version || 0,
    policyUsed: {
      components: policy.components.map((c) => ({ key: c.key, name: c.name, weight: c.weight })),
      transmutation: policy.transmutation, passingGrade: policy.passingGrade, higherIsBetter: policy.higherIsBetter,
      decimals: policy.decimals, rounding: policy.rounding,
    },
    status,
    updatedAt: serverTimestamp(), updatedByName: me.displayName || me.username,
    ...extra,
  };
}

function invalidCount() {
  let n = 0;
  students.forEach((s) => raw[s.sid].forEach((t, i) => { if (parseScore(t, assessments[i].maxScore).state === "invalid") n++; }));
  return n;
}

async function write(status, extra, button, message) {
  if (navigator.onLine === false) { toast("You're offline. Nothing was saved.", "warning"); return false; }
  setBusy(button, true);
  try {
    const keep = records[period] || {};
    const data = buildRecord(status, {
      createdAt: keep.createdAt || serverTimestamp(),
      ...(keep.submittedByName ? { submittedByName: keep.submittedByName, submittedAt: keep.submittedAt } : {}),
      ...(keep.approvedByName && status === "approved" ? { approvedByName: keep.approvedByName, approvedAt: keep.approvedAt } : {}),
      ...extra,
    });
    const id = recordId(current.id, period);
    await setDoc(doc(db, "classRecords", id), data);
    records = await readRecords(current);
    dirty = false;
    toast(message);
    await openPeriod(period, { force: true });
    return true;
  } catch (err) {
    toast(errorMessage(err), "danger");
    return false;
  } finally {
    setBusy(button, false);
  }
}

async function saveDraft() {
  const bad = invalidCount();
  if (bad) { toast(`${bad} score${bad === 1 ? " needs" : "s need"} fixing (red boxes).`, "warning"); return; }
  const st = records[period]?.status;
  // Staff keep the period's status; a teacher's save is always a draft
  const status = isStaff() && st ? st : "draft";
  await write(status, {}, els.btnSave, "Class record saved.");
}

async function submit() {
  const bad = invalidCount();
  if (bad) { toast(`${bad} score${bad === 1 ? " needs" : "s need"} fixing (red boxes).`, "warning"); return; }
  if (!policyReady) { toast("The grading policy isn't complete, so period grades can't be submitted yet.", "warning"); return; }
  const missing = students.filter((s) => !hasLeft(s.student) && resultOf(s.sid).state !== "complete");
  if (missing.length) {
    toast(`${missing.length} student${missing.length === 1 ? " has" : "s have"} no period grade yet (${missing.slice(0, 3).map((s) => s.name).join(", ")}${missing.length > 3 ? "…" : ""}). Type every score first (0 for a missed one).`, "warning");
    return;
  }
  const staff = isStaff();
  const status = staff && policy.requireApproval ? "approved" : "submitted";
  const ok = await confirmDialog({
    title: `Submit ${periodLabel(period)} grades?`,
    message: staff
      ? `Save the ${periodLabel(period)} grades of ${current.subjectCode} · ${current.sectionName} as ${status}?`
      : `Submit the ${periodLabel(period)} grades of ${current.subjectCode} · ${current.sectionName}? You can't change them after this${policy.requireApproval ? "; the registrar approves them" : ""}.`,
    confirmText: "Submit", variant: "primary",
  });
  if (!ok) return;
  const who = { submittedByName: me.displayName || me.username, submittedAt: serverTimestamp() };
  const appr = status === "approved" ? { approvedByName: me.displayName || me.username, approvedAt: serverTimestamp() } : {};
  await write(status, { ...who, ...appr }, els.btnSubmit, `${periodLabel(period)} grades ${status}.`);
}

async function approve() {
  if (dirty) { toast("Save your changes first.", "warning"); return; }
  const ok = await confirmDialog({ title: `Approve ${periodLabel(period)} grades?`, message: `The ${periodLabel(period)} grades of ${current.subjectCode} · ${current.sectionName} become official.`, confirmText: "Approve", variant: "success" });
  if (!ok) return;
  await write("approved", { approvedByName: me.displayName || me.username, approvedAt: serverTimestamp() }, els.btnApprove, "Approved.");
}

async function returnToTeacher() {
  if (dirty) { toast("Save your changes first.", "warning"); return; }
  const ok = await confirmDialog({ title: "Return to the teacher?", message: `${current.teacherName} can change the ${periodLabel(period)} scores again and submit them anew. The grades stop being official until then.`, confirmText: "Return", variant: "warning" });
  if (!ok) return;
  await write("returned", { returnedByName: me.displayName || me.username, returnedAt: serverTimestamp() }, els.btnReturn, "Returned to the teacher.");
}

// ---------- All periods ----------
function renderSummary() {
  const combineOn = policy.combine !== "none";
  els.sumHead.innerHTML = `<tr><th class="num" style="width:2.5rem">#</th><th>Student</th>
    ${PERIODS.map((p) => `<th class="text-center">${p.label}<div class="small fw-normal">${statusBadgeHtml(records[p.key]?.status || "none")}</div></th>`).join("")}
    ${combineOn ? `<th class="text-center">Subject grade</th><th>Remarks</th>` : ""}</tr>`;
  let ready = 0;
  els.sumBody.innerHTML = students.map((s, i) => {
    const official = {};
    const cells = PERIODS.map((p) => {
      const rec = records[p.key];
      const r = rec?.results?.[s.sid];
      if (!r) return `<td class="text-center text-secondary">—</td>`;
      const off = isOfficial(rec, policy);
      if (off) official[p.key] = r;
      return `<td class="text-center${off ? " fw-semibold" : " text-secondary fst-italic"}" title="Initial grade ${escapeHtml(String(r.initialGrade))}${off ? "" : " (not official yet)"}">${escapeHtml(String(r.transmutedGrade))}</td>`;
    }).join("");
    let tail = "";
    if (combineOn) {
      const c = combinePeriods(official, policy);
      if (c.state === "complete") ready++;
      tail = c.state === "complete"
        ? `<td class="text-center fw-bold">${escapeHtml(String(c.grade))}</td><td><span class="badge ${c.remarks === "Passed" ? "badge-pass" : "badge-fail"}">${c.remarks}</span></td>`
        : `<td class="text-center text-secondary">—</td><td class="small text-secondary">${escapeHtml(c.reason || "")}</td>`;
    }
    return `<tr><td class="num text-secondary">${i + 1}</td><td>${escapeHtml(s.name)}<div class="small text-secondary">${escapeHtml(s.number)}</div></td>${cells}${tail}</tr>`;
  }).join("") || `<tr><td colspan="7" class="empty-state">This class has no students.</td></tr>`;

  const how = policy.combine === "average" ? "the average" : policy.combine === "weighted"
    ? `weighted ${PERIODS.map((p) => `${p.label} ${policy.periodWeights[p.key]}%`).join(", ")}` : "";
  els.sumNote.innerHTML = combineOn
    ? `Subject grade = ${escapeHtml(how)} of the official ${policy.combineBasis === "initial" ? "initial grades, then transmuted" : "period grades"}. Grey grades aren't official yet and don't count.`
    : "The college's policy doesn't combine the four periods: type the subject grade in Enter grades.";
  els.btnToGrades.classList.toggle("d-none", !(combineOn && ready));
  els.btnToGrades.href = `grading.html?assignment=${encodeURIComponent(current.id)}&fromRecord=1`;
}

// ---------- Quick calculator ----------
function renderCalc() {
  const e = Number(els.calcEarned.value);
  const m = Number(els.calcMax.value);
  const w = Number(els.calcWeight.value);
  if (els.calcEarned.value === "" || els.calcMax.value === "") { els.calcOut.textContent = ""; return; }
  if (!(m > 0) || e < 0 || e > m) { els.calcOut.innerHTML = `<span class="text-danger">Points earned must be from 0 to the total.</span>`; return; }
  const pct = (e / m) * 100;
  els.calcOut.innerHTML = `${e}/${m} × 100 = <strong>${fmt(pct)}%</strong>` +
    (els.calcWeight.value !== "" && w >= 0 ? `<br>× ${w}% = <strong>${fmt(pct * (w / 100))}</strong> points of the initial grade` : "");
}

// ---------- Start ----------
function wire() {
  els.cls.addEventListener("change", async () => {
    if (dirty && !(await confirmDialog({ title: "Leave without saving?", message: "Your changes to this period aren't saved.", confirmText: "Leave", variant: "warning" }))) {
      els.cls.value = current ? current.id : "";
      return;
    }
    dirty = false;
    openClass(els.cls.value);
  });
  els.periods.addEventListener("click", (e) => {
    const b = e.target.closest("[data-period]");
    if (b && current && b.dataset.period !== period) openPeriod(b.dataset.period);
    else if (b && !current) { period = b.dataset.period; renderPeriodButtons(); }
  });
  els.btnAdd.addEventListener("click", addAssessment);
  [els.addTitle, els.addMax].forEach((el) => el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addAssessment(); } }));
  els.head.addEventListener("click", (e) => { const b = e.target.closest("[data-del-a]"); if (b) removeAssessment(Number(b.dataset.delA)); });
  els.body.addEventListener("input", (e) => {
    const t = e.target;
    if (t.dataset.s === undefined || locked) return;
    const si = Number(t.dataset.s);
    raw[students[si].sid][Number(t.dataset.a)] = t.value.trim();
    markDirty();
    renderRowResult(si);
  });
  // Enter moves down the column, like a spreadsheet
  els.body.addEventListener("keydown", (e) => {
    const t = e.target;
    if (e.key !== "Enter" || t.dataset.s === undefined) return;
    e.preventDefault();
    els.body.querySelector(`input[data-s="${Number(t.dataset.s) + (e.shiftKey ? -1 : 1)}"][data-a="${t.dataset.a}"]`)?.focus();
  });
  els.btnSave.addEventListener("click", saveDraft);
  els.btnSubmit.addEventListener("click", submit);
  els.btnApprove.addEventListener("click", approve);
  els.btnReturn.addEventListener("click", returnToTeacher);
  [els.calcEarned, els.calcMax, els.calcWeight].forEach((el) => el.addEventListener("input", renderCalc));
  window.addEventListener("beforeunload", (e) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });
}

(async function start() {
  me = await initLayout("class-record");
  if (!me) return;
  wire();
  await loadPolicy();
  await loadClasses();
})();
