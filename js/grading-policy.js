// ==========================================================
// grading-policy.js — Grading policy page (administrators; settings/classRecord)
// The college's assessment categories and weights, approved transmutation table,
// passing grade, rounding, how the four periods combine, and approval.
// Class record (class-record.js) computes period grades with it.
// ==========================================================

import { db, doc, getDoc, setDoc, serverTimestamp } from "./firebase-config.js";
import { initLayout, toast, confirmDialog, escapeHtml, setBusy, errorMessage, formatDateTime } from "./app.js";
import {
  PERIODS, ROUNDING, COMBINE, policyOf, policyProblems, tableProblems, tableGaps, parseTable, transmuteGrade, roundGrade, remarksOf,
} from "./class-record-core.js";

const $ = (id) => document.getElementById(id);
const els = {
  status: $("polStatus"), comps: $("polComps"), compTotal: $("polCompTotal"), btnAddComp: $("btnPolAddComp"),
  rows: $("polRows"), rowCount: $("polTableCount"), btnAddRow: $("btnPolAddRow"), btnSort: $("btnPolSort"), btnClear: $("btnPolClear"),
  pasteText: $("polPasteText"), pasteError: $("polPasteError"), btnPaste: $("btnPolPaste"), problems: $("polTableProblems"),
  tryIn: $("polTry"), tryOut: $("polTryOut"),
  passing: $("polPassing"), better: $("polBetter"), decimals: $("polDecimals"), rounding: $("polRounding"),
  combine: $("polCombine"), combineMore: $("polCombineMore"), basis: $("polBasis"), periodWeights: $("polPeriodWeights"), periodTotal: $("polPeriodTotal"),
  approval: $("polApproval"), saved: $("polSaved"), btnSave: $("btnPolSave"),
};

let me = null;
let policy = policyOf(null);
let dirty = false;

const num = (v) => (String(v).trim() === "" ? NaN : Number(v));
const slug = (name) => String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "category";

// ---------- Draw ----------
function renderComps() {
  els.comps.innerHTML = policy.components.map((c, i) => `
    <tr>
      <td><input type="text" class="form-control form-control-sm" data-comp-name="${i}" value="${escapeHtml(c.name)}" maxlength="40" aria-label="Category ${i + 1} name"></td>
      <td><input type="number" step="any" min="0" max="100" class="form-control form-control-sm" data-comp-weight="${i}" value="${Number.isFinite(c.weight) ? c.weight : ""}" aria-label="${escapeHtml(c.name)} weight in percent"></td>
      <td class="text-end"><button type="button" class="btn btn-sm btn-outline-danger" data-comp-del="${i}" aria-label="Remove ${escapeHtml(c.name)}"><i class="bi bi-x-lg"></i></button></td>
    </tr>`).join("") || `<tr><td colspan="3" class="text-secondary small">No categories yet.</td></tr>`;
  renderCompTotal();
}
function renderCompTotal() {
  const total = policy.components.reduce((s, c) => s + (Number(c.weight) || 0), 0);
  const ok = Math.abs(total - 100) < 0.0001;
  els.compTotal.textContent = `${roundGrade(total, 4)}%`;
  els.compTotal.className = `badge rounded-pill ${ok ? "badge-pass" : "badge-fail"}`;
}

function renderRows() {
  els.rows.innerHTML = policy.transmutation.map((r, i) => `
    <tr>
      <td><input type="number" step="any" class="form-control form-control-sm" data-row="${i}" data-f="min" value="${Number.isFinite(r.min) ? r.min : ""}" aria-label="Row ${i + 1} lower limit"></td>
      <td><input type="number" step="any" class="form-control form-control-sm" data-row="${i}" data-f="max" value="${Number.isFinite(r.max) ? r.max : ""}" aria-label="Row ${i + 1} upper limit"></td>
      <td><input type="number" step="any" class="form-control form-control-sm" data-row="${i}" data-f="grade" value="${Number.isFinite(r.grade) ? r.grade : ""}" aria-label="Row ${i + 1} transmuted grade"></td>
      <td class="text-end"><button type="button" class="btn btn-sm btn-outline-danger" data-row-del="${i}" aria-label="Remove row ${i + 1}"><i class="bi bi-x-lg"></i></button></td>
    </tr>`).join("") || `<tr><td colspan="4" class="text-secondary small">No rows. Add the college's approved ranges, or paste them.</td></tr>`;
  renderTableChecks();
}
function renderTableChecks() {
  const n = policy.transmutation.length;
  els.rowCount.textContent = `${n} row${n === 1 ? "" : "s"}`;
  const problems = tableProblems(policy.transmutation);
  const gaps = problems.length ? [] : tableGaps(policy.transmutation, policy.decimals);
  els.problems.innerHTML = problems.length
    ? `<div class="text-danger"><i class="bi bi-exclamation-circle me-1"></i>${problems.map(escapeHtml).join("<br>")}</div>`
    : gaps.length
      ? `<div class="text-warning-emphasis"><i class="bi bi-exclamation-triangle me-1"></i>No row holds ${gaps.map(([a, b]) => `${a}${a === b ? "" : `–${b}`}`).join(", ")}. A student with that initial grade gets no transmuted grade.</div>`
      : `<div class="text-success"><i class="bi bi-check-circle me-1"></i>The ranges don't overlap and leave no gaps.</div>`;
  renderTry();
}
function renderTry() {
  const v = num(els.tryIn.value);
  if (!Number.isFinite(v)) { els.tryOut.textContent = ""; return; }
  const ig = roundGrade(v, policy.decimals, policy.rounding);
  const g = transmuteGrade(ig, policy.transmutation);
  els.tryOut.innerHTML = g === null
    ? `<span class="text-danger">${ig}: no row holds it</span>`
    : `${ig} → <strong>${escapeHtml(String(g))}</strong> (${remarksOf(g, policy)})`;
}

function renderPeriodWeights() {
  const show = policy.combine !== "none";
  els.combineMore.classList.toggle("d-none", !show);
  els.periodWeights.classList.toggle("d-none", policy.combine !== "weighted");
  els.periodTotal.classList.toggle("d-none", policy.combine !== "weighted");
  els.periodWeights.innerHTML = PERIODS.map((p) => `
    <div class="col-6 col-md-3">
      <label class="form-label small mb-1" for="pw-${p.key}">${p.label} (%)</label>
      <input type="number" step="any" min="0" class="form-control form-control-sm" id="pw-${p.key}" data-pw="${p.key}" value="${policy.periodWeights[p.key] ?? ""}">
    </div>`).join("");
  renderPeriodTotal();
}
function renderPeriodTotal() {
  const t = PERIODS.reduce((s, p) => s + (Number(policy.periodWeights[p.key]) || 0), 0);
  const ok = Math.abs(t - 100) < 0.0001;
  els.periodTotal.innerHTML = `<span class="${ok ? "text-success" : "text-danger"}">Total ${roundGrade(t, 4)}%${ok ? "" : " (must be 100%)"}</span>`;
}

function renderAll() {
  renderComps();
  renderRows();
  els.passing.value = Number.isFinite(policy.passingGrade) ? policy.passingGrade : "";
  els.better.value = policy.higherIsBetter ? "higher" : "lower";
  els.decimals.value = String(policy.decimals);
  els.rounding.value = policy.rounding;
  els.combine.value = policy.combine;
  els.basis.value = policy.combineBasis;
  els.approval.checked = policy.requireApproval;
  renderPeriodWeights();
  renderStatus();
}

function renderStatus() {
  const problems = policyProblems(policy);
  els.status.innerHTML = problems.length
    ? `<div class="alert alert-danger small mb-0"><strong>Not ready yet.</strong> Teachers can type scores but no period grade is computed until this is fixed:<ul class="mb-0 mt-1">${problems.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul></div>`
    : `<div class="alert alert-success small mb-0"><i class="bi bi-check-circle me-1"></i>The policy is complete. ${dirty ? "<strong>Save it</strong> so teachers use it." : "Teachers' class records use it."}</div>`;
}

function changed() {
  dirty = true;
  els.saved.textContent = "Unsaved changes.";
  renderStatus();
}

// ---------- Edit ----------
function wire() {
  els.comps.addEventListener("input", (e) => {
    const t = e.target;
    if (t.dataset.compName !== undefined) policy.components[Number(t.dataset.compName)].name = t.value;
    if (t.dataset.compWeight !== undefined) policy.components[Number(t.dataset.compWeight)].weight = num(t.value);
    renderCompTotal();
    changed();
  });
  els.comps.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-comp-del]");
    if (!b) return;
    const c = policy.components[Number(b.dataset.compDel)];
    const ok = await confirmDialog({ title: "Remove category?", message: `Remove "${c.name}"? Scores already typed for it stay saved in class records, but no longer count in new calculations.`, confirmText: "Remove" });
    if (!ok) return;
    policy.components.splice(Number(b.dataset.compDel), 1);
    renderComps();
    changed();
  });
  els.btnAddComp.addEventListener("click", () => {
    // The key never changes after this, so renaming a category keeps its scores
    const used = new Set(policy.components.map((c) => c.key));
    let key = slug("category");
    for (let n = 2; used.has(key); n++) key = `category-${n}`;
    policy.components.push({ key, name: "", weight: 0 });
    renderComps();
    els.comps.querySelector(`[data-comp-name="${policy.components.length - 1}"]`)?.focus();
    changed();
  });

  els.rows.addEventListener("input", (e) => {
    const t = e.target;
    if (t.dataset.row === undefined) return;
    policy.transmutation[Number(t.dataset.row)][t.dataset.f] = num(t.value);
    renderTableChecks();
    changed();
  });
  els.rows.addEventListener("click", (e) => {
    const b = e.target.closest("[data-row-del]");
    if (!b) return;
    policy.transmutation.splice(Number(b.dataset.rowDel), 1);
    renderRows();
    changed();
  });
  els.btnAddRow.addEventListener("click", () => {
    policy.transmutation.push({ min: NaN, max: NaN, grade: NaN });
    renderRows();
    els.rows.querySelector(`[data-row="${policy.transmutation.length - 1}"]`)?.focus();
    changed();
  });
  els.btnSort.addEventListener("click", () => {
    policy.transmutation.sort((a, b) => (b.min || 0) - (a.min || 0));
    renderRows();
    changed();
  });
  els.btnClear.addEventListener("click", async () => {
    if (!policy.transmutation.length) return;
    const ok = await confirmDialog({ title: "Clear the table?", message: "Remove every row of the transmutation table? Nothing is saved until you click Save grading policy.", confirmText: "Clear" });
    if (!ok) return;
    policy.transmutation = [];
    renderRows();
    changed();
  });
  els.btnPaste.addEventListener("click", () => {
    const { rows, errors } = parseTable(els.pasteText.value);
    els.pasteError.innerHTML = errors.map(escapeHtml).join("<br>");
    if (errors.length) return;
    if (!rows.length) { els.pasteError.textContent = "Nothing to read. Paste one row per line."; return; }
    policy.transmutation = rows.sort((a, b) => b.min - a.min);
    renderRows();
    changed();
    toast(`${rows.length} row${rows.length === 1 ? "" : "s"} loaded. Check them, then save.`, "info");
  });
  els.tryIn.addEventListener("input", renderTry);

  const onSetting = () => {
    policy.passingGrade = num(els.passing.value);
    policy.higherIsBetter = els.better.value !== "lower";
    policy.decimals = Number(els.decimals.value);
    policy.rounding = els.rounding.value;
    policy.combine = els.combine.value;
    policy.combineBasis = els.basis.value;
    policy.requireApproval = els.approval.checked;
    renderPeriodWeights();
    renderTableChecks();
    changed();
  };
  [els.passing, els.better, els.decimals, els.rounding, els.combine, els.basis, els.approval].forEach((el) => el.addEventListener("change", onSetting));
  els.passing.addEventListener("input", onSetting);
  els.periodWeights.addEventListener("input", (e) => {
    const k = e.target.dataset.pw;
    if (!k) return;
    policy.periodWeights[k] = num(e.target.value);
    renderPeriodTotal();
    changed();
  });

  els.btnSave.addEventListener("click", save);
  window.addEventListener("beforeunload", (e) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });
}

// ---------- Save ----------
async function save() {
  const blankName = policy.components.some((c) => !String(c.name || "").trim());
  if (blankName) { toast("Every category needs a name.", "warning"); return; }
  const problems = policyProblems(policy);
  if (problems.length) {
    const ok = await confirmDialog({
      title: "Save an incomplete policy?",
      message: `${problems.join("\n")}\n\nTeachers can type scores, but no period grade is computed until this is fixed.`,
      confirmText: "Save anyway", variant: "warning",
    });
    if (!ok) return;
  }
  const clean = (n) => (Number.isFinite(n) ? n : null);
  const data = {
    components: policy.components.map((c) => ({ key: c.key, name: String(c.name).trim(), weight: clean(c.weight) ?? 0 })),
    transmutation: policy.transmutation
      .filter((r) => [r.min, r.max, r.grade].some(Number.isFinite))
      .map((r) => ({ min: clean(r.min), max: clean(r.max), grade: clean(r.grade) })),
    passingGrade: clean(policy.passingGrade),
    higherIsBetter: policy.higherIsBetter,
    decimals: policy.decimals,
    rounding: policy.rounding,
    combine: policy.combine,
    combineBasis: policy.combineBasis,
    periodWeights: Object.fromEntries(PERIODS.map((p) => [p.key, clean(Number(policy.periodWeights[p.key])) ?? 0])),
    requireApproval: policy.requireApproval,
    version: (Number(policy.version) || 0) + 1,
    updatedAt: serverTimestamp(),
    updatedByName: me.displayName || me.username,
  };
  setBusy(els.btnSave, true);
  try {
    await setDoc(doc(db, "settings", "classRecord"), data);
    policy = policyOf({ ...data, updatedAt: null });
    dirty = false;
    renderAll();
    els.saved.textContent = `Saved just now by ${data.updatedByName} (version ${data.version}).`;
    toast("Grading policy saved.");
  } catch (err) {
    toast(errorMessage(err), "danger");
  } finally {
    setBusy(els.btnSave, false);
  }
}

// ---------- Start ----------
(async function start() {
  me = await initLayout("grading-policy");
  if (!me) return;
  els.rounding.innerHTML = Object.entries(ROUNDING).map(([k, v]) => `<option value="${k}">${escapeHtml(v)}</option>`).join("");
  els.combine.innerHTML = Object.entries(COMBINE).map(([k, v]) => `<option value="${k}">${escapeHtml(v)}</option>`).join("");
  try {
    const snap = await getDoc(doc(db, "settings", "classRecord"));
    const data = snap.exists() ? snap.data() : null;
    policy = policyOf(data ? JSON.parse(JSON.stringify({ ...data, updatedAt: null })) : null);
    if (data) els.saved.textContent = `Last saved${data.updatedByName ? ` by ${data.updatedByName}` : ""}${data.updatedAt ? `, ${formatDateTime(data.updatedAt)}` : ""} (version ${data.version || 1}).`;
    else els.saved.textContent = "Not saved yet: the categories shown are only examples.";
  } catch (err) {
    toast(errorMessage(err), "danger");
  }
  renderAll();
  wire();
})();
