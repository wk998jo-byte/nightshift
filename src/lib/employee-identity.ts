/** Visual + login identity helpers — each badge gets a stable unique look */

const PALETTE = [
  { bg: '#FEF2F2', fg: '#C8102E', ring: '#FECACA', label: 'Crimson' },
  { bg: '#ECFDF5', fg: '#047857', ring: '#A7F3D0', label: 'Emerald' },
  { bg: '#FFF7ED', fg: '#C2410C', ring: '#FED7AA', label: 'Amber' },
  { bg: '#F0F9FF', fg: '#0369A1', ring: '#BAE6FD', label: 'Sky' },
  { bg: '#F5F3FF', fg: '#6D28D9', ring: '#DDD6FE', label: 'Violet' },
  { bg: '#FFF1F2', fg: '#BE123C', ring: '#FECDD3', label: 'Rose' },
  { bg: '#F0FDFA', fg: '#0F766E', ring: '#99F6E4', label: 'Teal' },
  { bg: '#FFFBEB', fg: '#B45309', ring: '#FDE68A', label: 'Gold' },
] as const;

function hashId(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) >>> 0;
  }
  return h;
}

export function employeeColor(badgeOrCode: string) {
  return PALETTE[hashId(badgeOrCode) % PALETTE.length];
}

/** Initials: first letter of first + last name parts */
export function employeeInitials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

export function shortName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 2) return fullName;
  // First + Father initial + Family
  return `${parts[0]} ${parts[1][0]}. ${parts[parts.length - 1]}`;
}
