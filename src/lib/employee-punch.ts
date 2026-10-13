export function createPunchSubmissionGuard() {
  let active = false;
  const rejectedTokens = new Set<string>();
  return {
    begin(token: string): 'accepted' | 'busy' | 'stale' | 'empty' {
      if (active) return 'busy';
      if (!token.trim()) return 'empty';
      if (rejectedTokens.has(token)) return 'stale';
      active = true;
      return 'accepted';
    },
    reject(token: string) { rejectedTokens.add(token); },
    finish() { active = false; },
  };
}
