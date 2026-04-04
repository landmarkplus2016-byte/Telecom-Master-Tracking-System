// ============================================================
// dropdowns.js — Fallback dropdown option lists
// Telecom Coordinator Tracking App
// ============================================================
//
// These lists are used ONLY when the Config tab is unreachable
// or does not contain a [DROPDOWNS] section.
//
// The canonical source of dropdown options is the Config tab.
// Add a [DROPDOWNS] section there to override any of these:
//
//   [DROPDOWNS]
//   field_key          | option1      | option2      | option3 | ...
//   tx_rf              | TX           | RF           |
//   site_option        | Option A     | Option B     | Option C
//   facing             | N            | NE           | E       | SE | S | SW | W | NW
//   status             | Pending      | In Progress  | Completed | On Hold | Cancelled
//   acceptance_status  | Submitted    | Accepted     | Rejected  | Pending
//   po_status          | Not Raised   | Raised       | Approved  | Paid
//   vendor             | Vendor A     | Vendor B     |
//   region             | Region 1     | Region 2     |
//   sub_region         | Sub 1        | Sub 2        |
//   general_stream     | Stream A     | Stream B     |
//   task_name          | Task A       | Task B       |
//   contractor         | In-House     | Contractor A |
//   line_item          | LI-001       | LI-002       |
//   vf_task_owner      | Owner A      | Owner B      |
//
// Each row in [DROPDOWNS]: col A = field key, col B onward = options.
// A blank cell in col A ends the section.
// Options with empty cells are ignored automatically.
//
// ============================================================

var DROPDOWN_DEFAULTS = {
  tx_rf:             ['TX', 'RF'],
  site_option:       ['Option A', 'Option B', 'Option C'],
  facing:            ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'],
  status:            ['Pending', 'In Progress', 'Completed', 'On Hold', 'Cancelled'],
  acceptance_status: ['Submitted', 'Accepted', 'Rejected', 'Pending'],
  po_status:         ['Not Raised', 'Raised', 'Approved', 'Paid'],
  distance:          ['0Km - 100Km', '100Km - 400Km', '400Km - 800Km', '> 800Km'],

  // Fields below have no universal defaults — populated entirely from Config tab.
  // If Config is unreachable, these fields fall back to free-text entry.
  vendor:            [],
  region:            [],
  sub_region:        [],
  general_stream:    [],
  task_name:         [],
  contractor:        [],
  line_item:         [],
  vf_task_owner:     [],
};
