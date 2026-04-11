// ============================================================
// pricing.js — Price version lookup + calculation engine
// Telecom Coordinator Tracking App — Stage 2
// ============================================================
//
// Responsibilities (this file only):
//   - Store and query price versions loaded from Config tab
//   - Resolve which version applies to a given Task Date
//   - Look up unit price for a Line Item in the applicable version
//   - Calculate New Total Price, LMP Portion, Contractor Portion
//   - Provide per-row visual indicators
//
// Called by: js/grid.js (_applyPricing) and js/app.js (init)
// Data loaded by: js/sheets.js → Sheets.fetchConfig()
//
// ============================================================
// REQUIRED CONFIG TAB SECTIONS
// ============================================================
//
// Add these three sections to your Config tab.
// Each section ends with a blank row in column A.
//
// ── [PRICE_VERSIONS] ─────────────────────────────────────────
// Version  |  Effective_Date  |  Notes (optional)
// 2024     |  01-Apr-2024     |
// 2025     |  01-Apr-2025     |
//
// ── [PRICE_LIST] ─────────────────────────────────────────────
// Version  |  Line_Item  |  Unit_Price
// 2024     |  MW001      |  5000
// 2024     |  RF002      |  3000
// 2025     |  MW001      |  5500
// 2025     |  RF002      |  3300
//
// ── [CONTRACTOR_SPLITS] ──────────────────────────────────────
// Contractor  |  LMP_Pct  |  Contractor_Pct
// In-House    |  100      |  0
// Ericsson    |  70       |  30
// Huawei      |  65       |  35
//
// ============================================================
// Version resolution rules
// ============================================================
//
// 1. Versions are sorted by Effective_Date ascending.
// 2. The applicable version for a Task Date is the latest version
//    whose Effective_Date <= Task Date.
// 3. If Task Date falls before all versions, the earliest version
//    is used (never error — always return something).
// 4. No Task Date → use the version with the latest Effective_Date
//    (i.e. the current active version).
// 5. No versions configured → all lookups return null; auto-calc
//    still works for totals using the manually-entered new_price.
//
// ============================================================

var Pricing = (function () {

  // ── Internal state ────────────────────────────────────────

  var _versions    = [];  // [{ name, effectiveDate: Date }] — sorted asc
  var _priceMap    = {};  // { 'VERSION|line_item_lower': unitPrice }
  var _splits      = [];  // [{ contractor_lower, lmpPct, contractorPct }]
  var _distMults   = [];  // [{ range_lower, multiplier }] — distance range → multiplier
  var _ready       = false;

  // ── Public: Init ──────────────────────────────────────────

  /**
   * Load price data from the Config response.
   * Called by app.js after Sheets.fetchConfig() resolves.
   *
   * configData — { versions, priceList, contractorSplits } from Code.gs
   *              Pass null or {} to mark ready with no data (graceful
   *              degradation: auto-calc still works, lookups return null).
   */
  function init(configData) {
    _versions  = [];
    _priceMap  = {};
    _splits    = [];
    _distMults = [];

    if (configData) {
      // ── Parse versions ──────────────────────────────────
      (configData.versions || []).forEach(function (v) {
        var d = _parseDate(v.effectiveDate);
        if (d && v.version) {
          _versions.push({ name: String(v.version).trim(), effectiveDate: d });
        }
      });
      _versions.sort(function (a, b) { return a.effectiveDate - b.effectiveDate; });

      // ── Build price lookup map ──────────────────────────
      (configData.priceList || []).forEach(function (p) {
        if (!p.version || !p.lineItem) return;
        var key = String(p.version).trim() + '|' + String(p.lineItem).trim().toLowerCase();
        _priceMap[key] = parseFloat(p.unitPrice) || 0;
      });

      // ── Parse contractor splits ─────────────────────────
      (configData.contractorSplits || []).forEach(function (s) {
        if (!s.contractor) return;
        _splits.push({
          contractor_lower: String(s.contractor).trim().toLowerCase(),
          lmpPct:           parseFloat(s.lmpPct)        || 0,
          contractorPct:    parseFloat(s.contractorPct) || 0
        });
      });

      // ── Parse distance multipliers ──────────────────────
      (configData.distanceMultipliers || []).forEach(function (d) {
        if (!d.range) return;
        _distMults.push({
          range:       String(d.range).trim(),
          range_lower: String(d.range).trim().toLowerCase(),
          multiplier:  parseFloat(d.multiplier) || 1
        });
      });
    }

    // ── Fallback distance multipliers ────────────────────
    // Used when Config tab has no [DISTANCE_MULTIPLIERS] section.
    // Values match the dropdown options and project spec exactly.
    if (!_distMults.length) {
      _distMults = [
        { range: '0Km - 100Km',   range_lower: '0km - 100km',   multiplier: 1    },
        { range: '100Km - 400Km', range_lower: '100km - 400km', multiplier: 1.1  },
        { range: '400Km - 800Km', range_lower: '400km - 800km', multiplier: 1.2  },
        { range: '> 800Km',       range_lower: '> 800km',       multiplier: 1.25 }
      ];
    }

    _ready = true;
    console.log('[pricing.js] init() — versions:', _versions.length,
      '| price entries:', Object.keys(_priceMap).length,
      '| splits:', _splits.length,
      '| distance multipliers:', _distMults.length);

    // ── Diagnostic: show first 5 price map keys and all version names ──
    // Helps verify that version names and line item strings match exactly.
    var mapKeys = Object.keys(_priceMap);
    if (mapKeys.length) {
      console.log('[pricing.js] sample priceMap keys (first 5):', mapKeys.slice(0, 5));
    }
    if (_versions.length) {
      console.log('[pricing.js] version names:', _versions.map(function (v) {
        return '"' + v.name + '" (eff: ' + v.effectiveDate.toDateString() + ')';
      }));
    }
    if (!_splits.length) {
      console.warn('[pricing.js] No contractor splits loaded. ' +
        'Add a [CONTRACTOR_SPLITS] section in the Config tab, or splits default to 100% LMP.');
    }
  }

  function isReady() { return _ready; }

  // ── Public: Version resolution ────────────────────────────

  /**
   * Resolve which version name applies for a given Task Date string.
   *
   * taskDate  — "DD-MMM-YYYY" string, or empty/null for current date
   * Returns version name (string) or null if no versions are configured.
   */
  function resolveVersion(taskDate) {
    if (!_versions.length) return null;

    var refDate = taskDate ? _parseDate(taskDate) : new Date();
    if (!refDate) refDate = new Date();

    // Latest version whose Effective_Date <= refDate
    var matched = null;
    for (var i = 0; i < _versions.length; i++) {
      if (_versions[i].effectiveDate <= refDate) matched = _versions[i];
    }

    // Task Date is before all versions → use earliest
    if (!matched) matched = _versions[0];

    return matched.name;
  }

  // ── Public: Price lookup ──────────────────────────────────

  /**
   * Look up the unit price for a Line Item in the version that applies
   * to the given Task Date.
   *
   * lineItem  — string (must match a key in [PRICE_LIST])
   * taskDate  — "DD-MMM-YYYY" string, or empty/null for current version
   * Returns price (number) or null if the Line Item is not in the price list.
   */
  function lookupPrice(lineItem, taskDate) {
    if (!lineItem) return null;
    var version = resolveVersion(taskDate);
    if (!version) return null;
    var key = version + '|' + String(lineItem).trim().toLowerCase();
    var price = _priceMap[key];
    if (price === undefined) {
      console.warn('[pricing.js] lookupPrice MISS — key:', JSON.stringify(key),
        '| lineItem raw:', JSON.stringify(lineItem),
        '| version:', version);
    }
    return (price !== undefined) ? price : null;
  }

  // ── Public: Contractor splits ─────────────────────────────

  /**
   * Return the LMP % and Contractor % for a given contractor name.
   * In-House is always 100 / 0 regardless of Config data.
   * Unknown contractors default to 100 / 0.
   */
  function getContractorSplit(contractor) {
    if (!contractor) return { lmpPct: 100, contractorPct: 0 };

    var name = String(contractor).trim().toLowerCase();
    if (name === 'in-house' || name === 'inhouse' || name === 'in house') {
      return { lmpPct: 100, contractorPct: 0 };
    }

    for (var i = 0; i < _splits.length; i++) {
      if (_splits[i].contractor_lower === name) {
        return { lmpPct: _splits[i].lmpPct, contractorPct: _splits[i].contractorPct };
      }
    }

    // Contractor not in Config — default to 100 % LMP
    console.warn('[pricing.js] contractor not found in splits:', contractor, '— defaulting to 100% LMP');
    return { lmpPct: 100, contractorPct: 0 };
  }

  // ── Public: Distance multiplier ──────────────────────────

  /**
   * Return the multiplier for a given distance range string.
   * Falls back to 1 if the range is not in the Config data.
   *
   * distanceRange — string matching a row in [DISTANCE_MULTIPLIERS]
   *                 e.g. "0Km - 100Km", "> 800Km"
   */
  function getDistanceMultiplier(distanceRange) {
    if (!distanceRange) return 1;
    var range = String(distanceRange).trim().toLowerCase();
    for (var i = 0; i < _distMults.length; i++) {
      if (_distMults[i].range_lower === range) return _distMults[i].multiplier;
    }
    // Not configured — no adjustment
    return 1;
  }

  // ── Public: Auto-calculation ──────────────────────────────

  /**
   * Calculate the three derived numeric fields from the row values.
   *
   * Formula:
   *   New Total Price    = New Price × Absolute Quantity
   *   LMP Portion        = New Total Price × LMP %
   *   Contractor Portion = New Total Price × Contractor %
   *
   * absoluteQty — already the result of Actual Quantity × Distance Multiplier,
   *               computed by grid.js _applyPricing before calling here.
   *
   * Returns { newTotalPrice, lmpPortion, contractorPortion }.
   */
  function calculateTotals(newPrice, absoluteQty, contractor) {
    var price = parseFloat(newPrice)    || 0;
    var qty   = parseFloat(absoluteQty) || 0;
    var total = price * qty;

    var split      = getContractorSplit(contractor);
    var lmp        = total * (split.lmpPct        / 100);
    var conPortion = total * (split.contractorPct / 100);

    return {
      newTotalPrice:     total,
      lmpPortion:        lmp,
      contractorPortion: conPortion
    };
  }

  // ── Public: Visual indicator ──────────────────────────────

  /**
   * Return a per-row visual indicator object { icon, title } based on
   * whether the Task Date is set and whether the price matches the
   * applicable version.
   *
   * 🔵  No Task Date — using current active version
   * ✅  Task Date set, price matches applicable version (or no price list)
   * ⚠️  Task Date set but price doesn't match applicable version
   */
  function getIndicator(row) {
    var taskDate = String(row.task_date  || '').trim();
    var lineItem = String(row.line_item  || '').trim();
    var newPrice = parseFloat(row.new_price) || 0;

    if (!taskDate) {
      return {
        icon:  '🔵',
        title: 'No Task Date — using current active price version'
      };
    }

    var expected = lookupPrice(lineItem, taskDate);

    if (expected === null) {
      // Line item not in price list — can't verify mismatch
      return {
        icon:  '✅',
        title: 'Task Date set — price version: ' + (resolveVersion(taskDate) || '—')
      };
    }

    if (newPrice !== 0 && Math.abs(newPrice - expected) > 0.001) {
      return {
        icon:  '⚠️',
        title: 'Price version mismatch — expected ' + expected + ' for version ' + resolveVersion(taskDate)
      };
    }

    return {
      icon:  '✅',
      title: 'Task Date set — price matches version ' + (resolveVersion(taskDate) || '—')
    };
  }

  // ── Internal: Date parsing ────────────────────────────────

  function _parseDate(val) {
    if (!val) return null;
    if (val instanceof Date) return isNaN(val.getTime()) ? null : val;

    var s = String(val).trim();

    // DD-MMM-YYYY (canonical app format e.g. "01-Apr-2024")
    var MONTHS = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5,
                   jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
    var m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
    if (m) {
      var mo = MONTHS[m[2].toLowerCase()];
      if (mo !== undefined) {
        return new Date(parseInt(m[3], 10), mo, parseInt(m[1], 10));
      }
    }

    // YYYY-MM-DD
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) {
      return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
    }

    // Fallback
    var d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  // ── Expose ────────────────────────────────────────────────

  /**
   * Return all distance multiplier entries as
   * [{ range, multiplier }] — range is the original display string
   * (e.g. "100Km - 400Km") suitable for writing back to the sheet.
   * Sorted by multiplier ascending so callers can iterate smallest → largest.
   */
  function getAllDistanceMults() {
    return _distMults
      .slice()
      .sort(function (a, b) { return a.multiplier - b.multiplier; })
      .map(function (d) { return { range: d.range, multiplier: d.multiplier }; });
  }

  return {
    init:                   init,
    isReady:                isReady,
    resolveVersion:         resolveVersion,
    lookupPrice:            lookupPrice,
    getContractorSplit:     getContractorSplit,
    getDistanceMultiplier:  getDistanceMultiplier,
    getAllDistanceMults:     getAllDistanceMults,
    calculateTotals:        calculateTotals,
    getIndicator:           getIndicator
  };

}());
