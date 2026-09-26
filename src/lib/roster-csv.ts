import {
  OFFICIAL_CHOICE_TOTALS,
  OFFICIAL_EMPLOYEE_CODES,
  OFFICIAL_PROJECT_CODE,
  OFFICIAL_ROSTER_DATES,
  OFFICIAL_ROSTER_END,
  OFFICIAL_ROSTER_ROWS,
  OFFICIAL_ROSTER_START,
  type OfficialChoice,
  type RosterCsvRow,
} from './roster-official';

const HEADER =
  'Work Date,Employee Code,Employee Name,Choice,Shift Start,Shift End,Project Code';

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

function asChoice(value: string): OfficialChoice | null {
  if (value === 'SHIFT_1' || value === 'SHIFT_2' || value === 'OFF') return value;
  return null;
}

export function parseRosterCsv(text: string): { rows: RosterCsvRow[]; errors: string[] } {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const errors: string[] = [];
  if (lines.length === 0) return { rows: [], errors: ['CSV is empty'] };
  if (lines[0] !== HEADER) errors.push('Unexpected CSV header');

  const rows: RosterCsvRow[] = [];
  const seen = new Set<string>();
  for (const line of lines.slice(1)) {
    const cols = parseCsvLine(line);
    if (cols.length < 7) {
      errors.push(`Invalid row: ${line}`);
      continue;
    }
    const [workDate, employeeCode, employeeName, choiceRaw, shiftStart, shiftEnd, projectCode] = cols;
    const choice = asChoice(choiceRaw);
    if (!choice) {
      errors.push(`Unknown choice ${choiceRaw} on ${workDate} ${employeeCode}`);
      continue;
    }
    if (!OFFICIAL_EMPLOYEE_CODES.includes(employeeCode as (typeof OFFICIAL_EMPLOYEE_CODES)[number])) {
      errors.push(`Unknown employee ${employeeCode} on ${workDate}`);
      continue;
    }
    if (workDate < OFFICIAL_ROSTER_START || workDate > OFFICIAL_ROSTER_END) {
      errors.push(`Date outside official range: ${workDate}`);
      continue;
    }
    if (projectCode !== OFFICIAL_PROJECT_CODE) {
      errors.push(`Unexpected project ${projectCode} on ${workDate} ${employeeCode}`);
      continue;
    }
    const key = `${employeeCode}:${workDate}`;
    if (seen.has(key)) {
      errors.push(`Duplicate employee/date ${key}`);
      continue;
    }
    seen.add(key);
    rows.push({
      workDate,
      employeeCode,
      employeeName,
      choice,
      shiftStart,
      shiftEnd,
      projectCode,
    });
  }
  return { rows, errors };
}

export function validateOfficialRoster(rows: RosterCsvRow[]): string[] {
  const errors: string[] = [];
  const dates = new Set(rows.map((r) => r.workDate));
  if (rows.length !== OFFICIAL_ROSTER_ROWS) {
    errors.push(`Expected ${OFFICIAL_ROSTER_ROWS} rows, got ${rows.length}`);
  }
  if (dates.size !== OFFICIAL_ROSTER_DATES) {
    errors.push(`Expected ${OFFICIAL_ROSTER_DATES} unique dates, got ${dates.size}`);
  }
  for (const code of OFFICIAL_EMPLOYEE_CODES) {
    if (!rows.some((r) => r.employeeCode === code)) errors.push(`Missing employee ${code}`);
  }
  const totals: Record<string, { SHIFT_1: number; SHIFT_2: number; OFF: number }> = {};
  for (const code of OFFICIAL_EMPLOYEE_CODES) {
    totals[code] = { SHIFT_1: 0, SHIFT_2: 0, OFF: 0 };
  }
  for (const row of rows) {
    totals[row.employeeCode][row.choice] += 1;
    if (row.choice === 'SHIFT_1' && (row.shiftStart !== '15:30' || row.shiftEnd !== '03:30')) {
      errors.push(`SHIFT_1 times must be 15:30→03:30 on ${row.workDate} ${row.employeeCode}`);
    }
    if (row.choice === 'SHIFT_2' && (row.shiftStart !== '19:30' || row.shiftEnd !== '07:30')) {
      errors.push(`SHIFT_2 times must be 19:30→07:30 on ${row.workDate} ${row.employeeCode}`);
    }
    if (row.choice === 'OFF' && row.shiftStart !== '—' && row.shiftStart !== '') {
      errors.push(`OFF must not carry shift times on ${row.workDate} ${row.employeeCode}`);
    }
  }
  for (const code of OFFICIAL_EMPLOYEE_CODES) {
    const expected = OFFICIAL_CHOICE_TOTALS[code];
    const got = totals[code];
    if (got.SHIFT_1 !== expected.SHIFT_1 || got.SHIFT_2 !== expected.SHIFT_2 || got.OFF !== expected.OFF) {
      errors.push(
        `${code} totals expected SHIFT_1=${expected.SHIFT_1} SHIFT_2=${expected.SHIFT_2} OFF=${expected.OFF}, got SHIFT_1=${got.SHIFT_1} SHIFT_2=${got.SHIFT_2} OFF=${got.OFF}`
      );
    }
  }
  return errors;
}

export function choiceTotals(rows: RosterCsvRow[]) {
  const totals: Record<string, { SHIFT_1: number; SHIFT_2: number; OFF: number }> = {};
  for (const row of rows) {
    if (!totals[row.employeeCode]) totals[row.employeeCode] = { SHIFT_1: 0, SHIFT_2: 0, OFF: 0 };
    totals[row.employeeCode][row.choice] += 1;
  }
  return totals;
}
