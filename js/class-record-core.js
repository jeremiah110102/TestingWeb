// ==========================================================
// class-record-core.js — Class record calculations (no page code, no database)
//
// Teachers type raw scores; the system turns them into period grades with the
// college's approved grading policy (Grading policy page, settings/classRecord):
//
//   1. Raw percentage of each component   (points earned / total points) × 100
//      (every quiz of the period counts together: 45/50 + 20/25 → 65/75)
//   2. Initial grade                      Σ component percentage × weight / 100
//   3. Transmuted grade                   the row of the approved table whose
//                                         lower–upper limits hold the initial grade
//   4. Saved for the period               Prelim, Midterm, Semi-final or Final
//
// Nothing here invents a transmutation table: with no approved rows, nothing is
// transmuted. The four periods are combined into a subject grade only when the
// policy says how (combine: "none" | "average" | "weighted").
// ==========================================================

export const PERIODS = [
  { key: "prelim", label: "Prelim" },
  { key: "midterm", label: "Midterm" },
  { key: "semifinal", label: "Semi-final" },
  { key: "final", label: "Final" },
];
export const periodLabel = (key) => PERIODS.find((p) => p.key === key)?.label || key;

export const ROUNDING = {
  round: "Round to the nearest (82.605 → 82.61)",
  floor: "Round down / truncate (82.609 → 82.60)",
  ceil: "Round up (82.601 → 82.61)",
};

export const COMBINE = {
  none: "Don't combine: the subject grade is entered in Enter grades",
  average: "Average of the four period grades",
  weighted: "Weighted: each period has its own percentage",
};

// Example categories only: the administrator sets the college's own (Grading policy page).
// transmutation is empty on purpose: it must be the college's approved table.
export const DEFAULT_POLICY = {
  components: [
    { key: "quiz", name: "Quizzes", weight: 20 },
    { key: "activity", name: "Activities", weight: 20 },
    { key: "project", name: "Projects", weight: 20 },
    { key: "exam", name: "Examination", weight: 40 },
  ],
  transmutation: [], // [{ min, max, grade }]: initial grade from min to max (inclusive) → grade
  passingGrade: 75,
  higherIsBetter: true, // false for 1.00-is-highest scales (3.00 passes, 5.00 fails)
  decimals: 2,
  rounding: "round",
  combine: "none",
  combineBasis: "transmuted", // "transmuted": combine the period grades; "initial": combine the initial grades, then transmute
  periodWeights: { prelim: 25, midterm: 25, semifinal: 25, final: 25 },
  requireApproval: true,
};

const EPS = 1e-9;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const toNum = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));

/** The saved policy with every missing setting filled in. */
export function policyOf(saved) {
  const p = { ...DEFAULT_POLICY, ...(saved || {}) };
  // Copies, so editing the policy never changes the defaults or the saved record
  p.components = (Array.isArray(p.components) ? p.components : DEFAULT_POLICY.components).map((c) => ({ ...c, weight: Number(c.weight) }));
  p.transmutation = (Array.isArray(p.transmutation) ? p.transmutation : []).map((r) => ({ min: toNum(r.min), max: toNum(r.max), grade: toNum(r.grade) }));
  p.periodWeights = { ...DEFAULT_POLICY.periodWeights, ...(p.periodWeights || {}) };
  p.decimals = Number.isInteger(Number(p.decimals)) ? Math.min(4, Math.max(0, Number(p.decimals))) : 2;
  if (!ROUNDING[p.rounding]) p.rounding = "round";
  if (!COMBINE[p.combine]) p.combine = "none";
  if (p.combineBasis !== "initial") p.combineBasis = "transmuted";
  p.higherIsBetter = p.higherIsBetter !== false;
  p.requireApproval = p.requireApproval !== false;
  p.passingGrade = toNum(p.passingGrade);
  return p;
}

/** Rounds with the policy's rule (decimals and round / floor / ceil). */
export function roundGrade(value, decimals = 2, rounding = "round") {
  const f = 10 ** decimals;
  // The small nudge keeps 82.6 * 100 = 8259.999… from rounding down
  const scaled = value * f;
  const fix = scaled + (scaled >= 0 ? 1e-7 : -1e-7);
  const n = rounding === "floor" ? Math.floor(fix) : rounding === "ceil" ? Math.ceil(scaled - 1e-7) : Math.round(fix);
  return n / f;
}

/** Problems with a policy (empty list = ready to use). */
export function policyProblems(policy) {
  const p = policyOf(policy);
  const out = [];
  if (!p.components.length) out.push("Add at least one assessment category.");
  const keys = new Set();
  p.components.forEach((c) => {
    if (!String(c.name || "").trim()) out.push("Every assessment category needs a name.");
    if (!isNum(c.weight) || c.weight < 0) out.push(`The weight of ${c.name || "a category"} must be 0 or more.`);
    if (keys.has(c.key)) out.push(`Two categories share the key "${c.key}".`);
    keys.add(c.key);
  });
  const total = p.components.reduce((s, c) => s + (Number(c.weight) || 0), 0);
  if (Math.abs(total - 100) > 0.0001) out.push(`Assessment weights must total 100% (now ${roundGrade(total, 4)}%).`);
  out.push(...tableProblems(p.transmutation));
  if (!isNum(p.passingGrade)) out.push("Set the passing grade.");
  if (p.combine === "weighted") {
    const pt = PERIODS.reduce((s, x) => s + (Number(p.periodWeights[x.key]) || 0), 0);
    if (Math.abs(pt - 100) > 0.0001) out.push(`Period weights must total 100% (now ${roundGrade(pt, 4)}%).`);
  }
  return out;
}

/** Problems with a transmutation table: missing, reversed or overlapping ranges. */
export function tableProblems(table) {
  const out = [];
  if (!Array.isArray(table) || !table.length) {
    out.push("Enter the college's approved transmutation table (no rows yet).");
    return out;
  }
  table.forEach((r, i) => {
    if (!isNum(r.min) || !isNum(r.max) || !isNum(r.grade)) out.push(`Row ${i + 1}: lower limit, upper limit and grade must be numbers.`);
    else if (r.min > r.max) out.push(`Row ${i + 1}: the lower limit (${r.min}) is above the upper limit (${r.max}).`);
  });
  if (out.length) return out;
  const sorted = [...table].sort((a, b) => a.min - b.min);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].min <= sorted[i - 1].max + EPS) out.push(`The ranges ${sorted[i - 1].min}–${sorted[i - 1].max} and ${sorted[i].min}–${sorted[i].max} overlap.`);
  }
  return out;
}

/** Gaps between ranges that a grade with the policy's decimals could fall into (warnings only). */
export function tableGaps(table, decimals = 2) {
  const step = 1 / 10 ** decimals;
  const sorted = [...(table || [])].filter((r) => isNum(r.min) && isNum(r.max)).sort((a, b) => a.min - b.min);
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].min - sorted[i - 1].max > step + EPS) gaps.push([roundGrade(sorted[i - 1].max + step, decimals), roundGrade(sorted[i].min - step, decimals)]);
  }
  return gaps;
}

/**
 * Reads a pasted table: one row per line, "lower, upper, grade" (commas, tabs or spaces).
 * Returns { rows, errors }.
 */
export function parseTable(text) {
  const rows = [];
  const errors = [];
  String(text || "").split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (!t) return;
    const parts = t.split(/[\t,;]+|\s+/).filter(Boolean);
    if (parts.length !== 3 || parts.some((x) => !/^-?\d+(\.\d+)?$/.test(x))) {
      if (i === 0 && /[a-z]/i.test(t)) return; // a heading row
      errors.push(`Line ${i + 1}: "${t}" isn't "lower, upper, grade".`);
      return;
    }
    const [min, max, grade] = parts.map(Number);
    rows.push({ min, max, grade });
  });
  return { rows, errors };
}

/** The transmuted grade for an initial grade, or null when no approved range holds it. */
export function transmuteGrade(initialGrade, table) {
  const row = (table || []).find((r) => initialGrade >= r.min - EPS && initialGrade <= r.max + EPS);
  return row ? row.grade : null;
}

/** "Passed" / "Failed" for a grade under the policy. */
export function remarksOf(grade, policy) {
  const p = policyOf(policy);
  if (!isNum(grade)) return "";
  return (p.higherIsBetter ? grade >= p.passingGrade - EPS : grade <= p.passingGrade + EPS) ? "Passed" : "Failed";
}

/** A typed score: { state: "empty" | "invalid" | "valid", value }. */
export function parseScore(raw, maxScore) {
  const text = String(raw ?? "").trim();
  if (!text) return { state: "empty", value: null };
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return { state: "invalid", value: null, why: "Type a number (up to 2 decimals)." };
  const value = Number(text);
  if (value > maxScore + EPS) return { state: "invalid", value: null, why: `Above the total of ${maxScore}.` };
  return { state: "valid", value };
}

/**
 * One student's period grade.
 *   assessments  [{ id, component, title, maxScore }]
 *   scores       [score | null, …] in the same order as assessments
 * Returns { state: "complete", components, initialGrade, transmutedGrade, remarks }
 *      or { state: "incomplete" | "error", reason, components }.
 */
export function studentPeriodGrade(assessments, scores, policy) {
  const p = policyOf(policy);
  const components = p.components.map((c) => ({ key: c.key, name: c.name, weight: Number(c.weight) || 0, earned: 0, possible: 0, missing: 0, count: 0 }));
  const byKey = new Map(components.map((c) => [c.key, c]));
  (assessments || []).forEach((a, i) => {
    const c = byKey.get(a.component);
    if (!c) return; // a category the administrator removed: not counted
    c.count++;
    const s = scores ? scores[i] : null;
    if (!isNum(s)) { c.missing++; return; }
    if (!(a.maxScore > 0) || s < 0 || s > a.maxScore + EPS) throw new Error(`Invalid score ${s} for ${a.title} (out of ${a.maxScore}).`);
    c.earned += s;
    c.possible += a.maxScore;
  });
  components.forEach((c) => { c.percentage = c.possible > 0 ? (c.earned / c.possible) * 100 : null; });

  const weightTotal = components.reduce((s, c) => s + c.weight, 0);
  if (Math.abs(weightTotal - 100) > 0.0001) return { state: "error", reason: "Assessment weights must total 100%.", components };
  const noItems = components.filter((c) => c.weight > 0 && !c.count);
  if (noItems.length) return { state: "incomplete", reason: `No ${noItems.map((c) => c.name).join(", ")} yet.`, components };
  const missing = components.reduce((s, c) => s + (c.weight > 0 ? c.missing : 0), 0);
  if (missing) return { state: "incomplete", reason: `${missing} score${missing === 1 ? "" : "s"} not entered.`, components };

  const raw = components.reduce((t, c) => t + (c.weight > 0 ? c.percentage * (c.weight / 100) : 0), 0);
  const initialGrade = roundGrade(raw, p.decimals, p.rounding);
  const transmutedGrade = transmuteGrade(initialGrade, p.transmutation);
  if (transmutedGrade === null) return { state: "error", reason: `No transmutation range holds ${initialGrade}.`, components, initialGrade };
  return { state: "complete", components, initialGrade, transmutedGrade, remarks: remarksOf(transmutedGrade, p) };
}

/**
 * The official subject grade from the four saved period results.
 *   periods  { prelim: { initialGrade, transmutedGrade }, … } (only official ones)
 * Returns { state: "off" } when the policy doesn't combine periods,
 *         { state: "incomplete", reason } while a period is missing,
 *         { state: "complete", grade, remarks, basis } otherwise.
 */
export function combinePeriods(periods, policy) {
  const p = policyOf(policy);
  if (p.combine === "none") return { state: "off" };
  const field = p.combineBasis === "initial" ? "initialGrade" : "transmutedGrade";
  const missing = PERIODS.filter((x) => !(periods && periods[x.key] && isNum(periods[x.key][field])));
  const used = p.combine === "weighted" ? missing.filter((x) => (Number(p.periodWeights[x.key]) || 0) > 0) : missing;
  if (used.length) return { state: "incomplete", reason: `Waiting for ${used.map((x) => x.label).join(", ")}.` };
  let value;
  if (p.combine === "average") {
    value = PERIODS.reduce((s, x) => s + periods[x.key][field], 0) / PERIODS.length;
  } else {
    const total = PERIODS.reduce((s, x) => s + (Number(p.periodWeights[x.key]) || 0), 0);
    if (Math.abs(total - 100) > 0.0001) return { state: "incomplete", reason: "Period weights must total 100%." };
    value = PERIODS.reduce((s, x) => s + ((Number(p.periodWeights[x.key]) || 0) ? periods[x.key][field] * (p.periodWeights[x.key] / 100) : 0), 0);
  }
  const combined = roundGrade(value, p.decimals, p.rounding);
  const grade = p.combineBasis === "initial" ? transmuteGrade(combined, p.transmutation) : combined;
  if (grade === null) return { state: "incomplete", reason: `No transmutation range holds ${combined}.` };
  return { state: "complete", grade, combined, remarks: remarksOf(grade, p), basis: p.combineBasis };
}

/** True when a saved period record counts as official under the policy. */
export function isOfficial(record, policy) {
  if (!record) return false;
  if (record.status === "approved") return true;
  return record.status === "submitted" && !policyOf(policy).requireApproval;
}

/** The id of one class's record for a period. */
export const recordId = (assignmentId, period) => `${assignmentId}_${period}`;
