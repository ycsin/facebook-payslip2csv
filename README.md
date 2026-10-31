# Facebook payslip to CSV

A single-page browser tool that turns Facebook UK payslip PDFs into transaction rows
for a payroll account in any personal finance app that imports CSV.

**Use it here: <https://ycsin.github.io/facebook-payslip2csv/>**

- PDFs are parsed in the browser with pdf.js. Nothing is uploaded anywhere.
- Each payslip becomes: gross pay lines as income, tax / National Insurance / pension
  sacrifice as outflows, and the net pay as an outflow. The payroll account nets to zero
  per payslip, and the "Net pay" outflow is matched to the real bank deposit as a transfer
  in your finance app.
- Every total on the payslip is checked against its line items; a payslip that does not
  add up is refused rather than exported.
- Labels map to categories written as `Parent:Child`; suggested mappings cover salary,
  bonus, stock compensation, tax, National Insurance and pension, and your edits are
  remembered in the browser.

## Files

| File | Purpose |
| --- | --- |
| `parser.js` | Layout reconstruction from pdf.js text items, payslip parsing, transaction planning, CSV output. Runs in the browser and in Node. |
| `page.template.html` | The page, with a `/*__PARSER__*/` placeholder where `parser.js` is inlined. |
| `index.html` | The built, self-contained page, served by GitHub Pages. Also works opened from disk. |
| `build.py` | Inlines the parser into the template. |

## Use

1. In your finance app, create a manual checking account in the payslip currency with a
   zero balance (for example "Salary (Facebook UK)").
2. Open <https://ycsin.github.io/facebook-payslip2csv/> (or `index.html` from disk), drop
   the PDFs, and check the category mapping.
3. Enter the payroll account name and currency, then download the CSV (or copy it and
   save it as a `.csv` file) and import it against the payroll account. The file is named
   after the pay dates it covers, for example `facebook-payslips-2025-09-30_2026-10-30.csv`.
   Inside the Claude artifact viewer the save goes through its download confirmation;
   elsewhere the browser's save dialog or a plain download is used.
4. Match each "Net pay" outflow with the corresponding bank deposit as a transfer.

## CSV format

```
date,amount,name,currency,category,tags,account,notes
```

Inflows are positive and outflows negative. The largest income line of each payslip
carries a note with the tax code, employer National Insurance, employer pension and
benefits in kind. `tags` is left empty.

## Payslip format

Written against single-page UK payslips with three side-by-side tables
(Payments | Deductions | Year to Date), a `Total Payment / Total Deduction / Net Pay`
line, and a `This Period / Year To Date / Gross Benefits` summary block. Column
boundaries are taken from the header row with a small tolerance, so other payroll
providers with the same shape should parse; a payslip that does not add up is refused.

## Develop

```sh
python3 build.py
```

GitHub Pages serves `index.html` from the `main` branch root, so a pushed build is live
within a minute or two.

To test the parser against real PDFs in Node, install `pdfjs-dist@3.11.174` in a
scratch directory, load the PDF with `getDocument`, call `getTextContent()` on page 1,
and pass `items` to `PayslipParser.linesFromTextContent` then
`PayslipParser.parsePayslipLines`.
