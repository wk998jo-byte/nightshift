export const OFFICIAL_ROSTER_START = '2026-09-26';
export const OFFICIAL_ROSTER_END = '2026-12-31';
export const OFFICIAL_ROSTER_DATES = 97;
export const OFFICIAL_ROSTER_ROWS = 291;
export const OFFICIAL_PROJECT_CODE = 'HQ-01';
export const OFFICIAL_EMPLOYEE_CODES = ['71326', '71343', '71378'] as const;
export const OFFICIAL_ROSTER_FILE = 'data/nightshift-roster-2026-09-26-to-2026-12-31.csv';

export const OFFICIAL_CHOICE_TOTALS: Record<string, { SHIFT_1: number; SHIFT_2: number; OFF: number }> = {
  '71343': { SHIFT_1: 34, SHIFT_2: 35, OFF: 28 },
  '71326': { SHIFT_1: 35, SHIFT_2: 34, OFF: 28 },
  '71378': { SHIFT_1: 35, SHIFT_2: 35, OFF: 27 },
};

export type OfficialChoice = 'SHIFT_1' | 'SHIFT_2' | 'OFF';

export type RosterCsvRow = {
  workDate: string;
  employeeCode: string;
  employeeName: string;
  choice: OfficialChoice;
  shiftStart: string;
  shiftEnd: string;
  projectCode: string;
};
