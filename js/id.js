// ============================================================
// id.js — ID# auto-generation
// Telecom Coordinator Tracking App
// ============================================================
//
// Responsibilities (this file only):
//   - Generate a unique ID# from job_code + timestamp + row index
//   - Expose ID.tryGenerate(sourceRow, hotRowIdx) for grid.js to call
//
// Rules (from CLAUDE.md):
//   - Only fires if the ID column is empty AND Job Code is filled
//   - Never overwrites an existing ID
//   - Format: {2-char prefix}-{YYMMDDHHmmss}-{rowIndex}
//     e.g. job_code "MW213" → "MW-260404143022-1"
//
// Called by: js/grid.js afterChange when job_code column changes
// ============================================================

var ID = (function () {

  // ── Core generator (exact formula from CLAUDE.md) ─────────

  function generateID(jobCode, rowIndex) {
    var prefix = jobCode.trim().substring(0, 2).toUpperCase();
    var now    = new Date();
    var yy     = String(now.getFullYear()).slice(-2);
    var mm     = String(now.getMonth() + 1).padStart(2, '0');
    var dd     = String(now.getDate()).padStart(2, '0');
    var hh     = String(now.getHours()).padStart(2, '0');
    var min    = String(now.getMinutes()).padStart(2, '0');
    var ss     = String(now.getSeconds()).padStart(2, '0');
    return prefix + '-' + yy + mm + dd + hh + min + ss + '-' + rowIndex;
  }

  // ── Public: attempt to generate an ID for a grid row ──────
  //
  // sourceRow  — live data object from _hot.getSourceDataAtRow(rowIdx)
  // hotRowIdx  — 0-based HOT row index; converted to 1-based for the ID suffix
  //
  // Returns the generated ID string, or null if conditions are not met:
  //   • job_code must be non-empty
  //   • id must be empty (never overwrite)

  function tryGenerate(sourceRow, hotRowIdx) {
    var jobCode    = String(sourceRow.job_code || '').trim();
    var existingId = String(sourceRow.id       || '').trim();

    if (!jobCode)   return null; // no job code — nothing to prefix
    if (existingId) return null; // ID already set — never overwrite

    return generateID(jobCode, hotRowIdx + 1); // 1-based suffix
  }

  // ── Expose ────────────────────────────────────────────────

  return {
    tryGenerate: tryGenerate
  };

}());
