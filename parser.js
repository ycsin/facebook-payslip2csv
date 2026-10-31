// Payslip parsing shared by the browser page and the Node test harness.
// Works on pdf.js text items (position-aware), rebuilds the payslip's text
// layout line by line, then reads the three side-by-side tables
// (Payments | Deductions | Year to Date) and the summary block.
//
// Money is handled in integer pence so totals can be checked exactly.
(function (root) {
  "use strict";

  const AMOUNT = "-?\\d{1,3}(?:,\\d{3})*\\.\\d{2}|-?\\d+\\.\\d{2}";
  // "Label [:] [units] [rate] [*] amount" - label starts with a letter and has
  // no digits; numeric or marker columns before the amount are skipped.
  const ITEM = new RegExp(
    "([A-Za-z][A-Za-z &/.'()-]*?)\\s*:?\\s+(?:[\\d,.*-]+\\s+)*(" + AMOUNT + ")(?=\\s|$)",
    "g"
  );
  const TOTALS = new RegExp(
    "Total Payment\\s*:\\s*(" + AMOUNT + ")\\s+Total Deduction\\s*:\\s*(" + AMOUNT + ")\\s+Net Pay\\s*:\\s*(" + AMOUNT + ")"
  );
  const TABLE_HEADER = /^\s*Payments\b.*\bDeductions\b.*\bYear to Date\b/i;
  const SUMMARY_HEADER = /\bThis Period\b.*\bYear To Date\b.*\bGross Benefits\b/i;
  const EMPLOYER_SECTION = /ER Pension This Period/i;
  const COLUMN_TOLERANCE = 2;

  // Default category guesses. First match wins, so specific rules come before /tax/.
  const CATEGORY_RULES = [
    [/national insurance|\bnic\b|\bni\b/i, "Taxes:National Insurance"],
    [/pension|\bpen\b/i, "Savings & Investments:Pension Contributions"],
    [/bonus|sign-on|sign on/i, "Income:Bonus"],
    [/\brsu|stock|share/i, "Income:Stock Compensation"],
    [/dividend/i, "Income:Dividend Equivalents"],
    [/transport|commut/i, "Income:Benefit Reimbursements"],
    [/elder care|child ?care|wellness|gym/i, "Income:Benefit Reimbursements"],
    [/salary|wage/i, "Income:Salary"],
    [/tax/i, "Taxes:Income Tax"],
  ];
  const FALLBACK_INFLOW = "Income";
  const FALLBACK_OUTFLOW = "Payroll Deductions";

  function pence(text) {
    const negative = text.trim().startsWith("-");
    const digits = text.replace(/[^\d]/g, "");
    const value = parseInt(digits, 10);
    return negative ? -value : value;
  }

  function formatPence(value, currency) {
    const abs = Math.abs(value);
    const major = Math.floor(abs / 100);
    const minor = String(abs % 100).padStart(2, "0");
    const grouped = major.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (value < 0 ? "-" : "") + (currency ? currency + " " : "") + grouped + "." + minor;
  }

  function decimalString(value) {
    const abs = Math.abs(value);
    return (value < 0 ? "-" : "") + Math.floor(abs / 100) + "." + String(abs % 100).padStart(2, "0");
  }

  // pdf.js text items -> array of layout strings, top to bottom. Each item is
  // placed at a character column derived from its x position, so columns line
  // up the way they do on the printed payslip.
  function linesFromTextContent(items) {
    const placed = items
      .filter((item) => item.str && item.str.trim().length > 0)
      .map((item) => ({
        str: item.str,
        x: item.transform[4],
        y: item.transform[5],
        width: item.width,
      }));
    if (placed.length === 0) return [];

    const widths = placed
      .filter((item) => item.str.trim().length > 2 && item.width > 0)
      .map((item) => item.width / item.str.length)
      .sort((a, b) => a - b);
    const charWidth = widths.length ? widths[Math.floor(widths.length / 2)] : 5;

    // Cluster rows by y (pdf y grows upward).
    const rows = [];
    placed
      .sort((a, b) => b.y - a.y || a.x - b.x)
      .forEach((item) => {
        const row = rows.find((r) => Math.abs(r.y - item.y) <= 2.5);
        if (row) row.items.push(item);
        else rows.push({ y: item.y, items: [item] });
      });

    return rows.map((row) => {
      let line = "";
      row.items
        .sort((a, b) => a.x - b.x)
        .forEach((item) => {
          const col = Math.round(item.x / charWidth);
          if (col > line.length) line += " ".repeat(col - line.length);
          else if (line.length > 0 && !line.endsWith(" ") && !item.str.startsWith(" ")) line += " ";
          line += item.str;
        });
      return line.replace(/\s+$/, "");
    });
  }

  function field(lines, label) {
    const pattern = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*:\\s*(\\S.*?)(?:\\s{2,}|$)");
    for (const line of lines) {
      const match = line.match(pattern);
      if (match) return match[1].trim();
    }
    throw new Error('Could not find "' + label + '" on the payslip');
  }

  function itemsByColumn(line, columns) {
    const found = [];
    ITEM.lastIndex = 0;
    let match;
    while ((match = ITEM.exec(line)) !== null) {
      const start = match.index + match[0].search(/[A-Za-z]/);
      let column = 0;
      columns.forEach((col, index) => {
        if (col !== null && col !== -1 && start >= col - COLUMN_TOLERANCE) column = index;
      });
      found.push({ column, label: match[1].trim(), amount: pence(match[2]) });
    }
    return found;
  }

  function parseTables(lines) {
    const headerIndex = lines.findIndex((line) => TABLE_HEADER.test(line));
    if (headerIndex === -1) throw new Error("Could not find the Payments / Deductions / Year to Date table");
    const header = lines[headerIndex];
    const columns = [0, header.search(/Deductions/i), header.search(/Year to Date/i)];

    const payments = [], deductions = [], yearToDate = [], employerContributions = [];
    let ytdTarget = yearToDate;

    for (const line of lines.slice(headerIndex + 1)) {
      if (/^\s*Total Payment/.test(line)) break;
      if (EMPLOYER_SECTION.test(line)) ytdTarget = employerContributions;
      for (const item of itemsByColumn(line, columns)) {
        const entry = { label: item.label, amount: item.amount };
        if (item.column === 0) payments.push(entry);
        else if (item.column === 1) deductions.push(entry);
        else ytdTarget.push(entry);
      }
    }
    return { payments, deductions, yearToDate, employerContributions };
  }

  function parseTotals(lines) {
    for (const line of lines) {
      const match = line.match(TOTALS);
      if (match) return { totalPayment: pence(match[1]), totalDeduction: pence(match[2]), netPay: pence(match[3]) };
    }
    throw new Error("Could not find the Total Payment / Total Deduction / Net Pay line");
  }

  function summaryKey(label) {
    return label.toLowerCase().replace(/\s+/g, "_");
  }

  function parseSummary(lines) {
    const headerIndex = lines.findIndex((line) => SUMMARY_HEADER.test(line));
    const summary = {}, summaryYtd = {}, benefits = [];
    if (headerIndex === -1) return { summary, summaryYtd, benefits };
    const header = lines[headerIndex];
    const columns = [0, header.search(/Year To Date/i), header.search(/Gross Benefits/i)];

    for (const line of lines.slice(headerIndex + 1)) {
      if (/^\s*-{3,}\s*$/.test(line)) continue;
      if (line.trim() === "" && Object.keys(summary).length > 0) break;
      for (const item of itemsByColumn(line, columns)) {
        if (item.column === 0) summary[summaryKey(item.label)] = item.amount;
        else if (item.column === 1) summaryYtd[summaryKey(item.label)] = item.amount;
        else benefits.push({ label: item.label, amount: item.amount });
      }
    }
    return { summary, summaryYtd, benefits };
  }

  function parseDate(value) {
    const match = value.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (!match) throw new Error("Unrecognised pay date " + JSON.stringify(value) + ", expected DD.MM.YYYY");
    return match[3] + "-" + match[2] + "-" + match[1];
  }

  function slug(text) {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }

  function sum(items) {
    return items.reduce((total, item) => total + item.amount, 0);
  }

  function parsePayslipLines(lines) {
    const tables = parseTables(lines);
    const totals = parseTotals(lines);
    const summaryParts = parseSummary(lines);
    const employer = field(lines, "Company Name");
    const payPeriod = field(lines, "Pay Period");

    const payslip = Object.assign(
      {
        employer,
        employeeNumber: field(lines, "Employee Number"),
        payDate: parseDate(field(lines, "Pay Date")),
        payPeriod,
        taxPeriod: field(lines, "Tax Period"),
        taxCode: field(lines, "Tax Code"),
        reference: slug(employer) + "-" + payPeriod.replace("/", "-"),
      },
      tables,
      totals,
      summaryParts
    );

    const problems = [];
    if (sum(payslip.payments) !== payslip.totalPayment)
      problems.push("payments sum to " + decimalString(sum(payslip.payments)) + " but total payment is " + decimalString(payslip.totalPayment));
    if (sum(payslip.deductions) !== payslip.totalDeduction)
      problems.push("deductions sum to " + decimalString(sum(payslip.deductions)) + " but total deduction is " + decimalString(payslip.totalDeduction));
    if (payslip.totalPayment - payslip.totalDeduction !== payslip.netPay)
      problems.push("total payment minus deductions is not the net pay");
    if (problems.length) throw new Error("Payslip " + payslip.reference + " does not add up: " + problems.join("; "));

    return payslip;
  }

  function defaultCategoryFor(label, inflow) {
    for (const [pattern, category] of CATEGORY_RULES) {
      if (pattern.test(label)) return category;
    }
    return inflow ? FALLBACK_INFLOW : FALLBACK_OUTFLOW;
  }

  function summaryNotes(payslip, currency) {
    const parts = [
      "Payslip " + payslip.payPeriod + " (tax period " + payslip.taxPeriod + "), " + payslip.employer + ", paid " + payslip.payDate + ".",
    ];
    if (payslip.taxCode) parts.push("Tax code " + payslip.taxCode + ".");
    if (payslip.summary.ers_ni !== undefined) parts.push("Employer NI " + formatPence(payslip.summary.ers_ni, currency) + ".");
    payslip.employerContributions.forEach((item) => parts.push("Employer " + item.label + " " + formatPence(item.amount, currency) + "."));
    if (payslip.benefits.length)
      parts.push("Benefits in kind: " + payslip.benefits.map((item) => item.label + " " + formatPence(item.amount, currency)).join(", ") + ".");
    return parts.join(" ");
  }

  // Turns a payslip into transaction lines. Internally inflows are negative and
  // outflows positive (the sign flips on CSV output). categoryFor(label, inflow)
  // returns "Parent:Child" or "Parent".
  function planLines(payslip, options) {
    const categoryFor = options.categoryFor || defaultCategoryFor;
    const currency = options.currency || "GBP";
    const lines = [];
    const used = {};
    const key = (label) => {
      const base = slug(label);
      used[base] = (used[base] || 0) + 1;
      return used[base] === 1 ? base : base + "-" + used[base];
    };

    payslip.payments.forEach((item) => {
      const inflow = item.amount > 0;
      lines.push({
        key: key(item.label),
        label: item.label,
        name: item.label,
        inflow,
        amount: inflow ? -item.amount : Math.abs(item.amount),
        category: categoryFor(item.label, inflow),
        notes: "",
      });
    });
    payslip.deductions.forEach((item) => {
      lines.push({
        key: key(item.label),
        label: item.label,
        name: item.label,
        inflow: false,
        amount: item.amount,
        category: categoryFor(item.label, false),
        notes: "",
      });
    });
    lines.push({
      key: "net-pay",
      label: "Net pay",
      name: options.bankAccountName ? "Net pay to " + options.bankAccountName : "Net pay",
      inflow: false,
      amount: payslip.netPay,
      category: "",
      notes: "",
    });

    let salaryIndex = 0;
    lines.forEach((line, index) => { if (line.amount < lines[salaryIndex].amount) salaryIndex = index; });
    lines[salaryIndex].notes = summaryNotes(payslip, currency);
    return lines;
  }

  function csvEscape(value) {
    const text = String(value == null ? "" : value);
    return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }

  // CSV columns: date,amount,name,currency,category,tags,account,notes with
  // inflows positive and outflows negative, the convention most importers expect.
  function toCsv(plans, options) {
    const rows = [["date", "amount", "name", "currency", "category", "tags", "account", "notes"]];
    plans.forEach(({ payslip, lines }) => {
      lines.forEach((line) => {
        rows.push([
          payslip.payDate,
          decimalString(-line.amount),
          line.name,
          options.currency || "",
          line.category || "",
          "",
          options.accountName || "",
          line.notes || "",
        ]);
      });
    });
    return rows.map((row) => row.map(csvEscape).join(",")).join("\n") + "\n";
  }

  root.PayslipParser = {
    linesFromTextContent,
    parsePayslipLines,
    planLines,
    defaultCategoryFor,
    toCsv,
    formatPence,
    decimalString,
    CATEGORY_RULES,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
