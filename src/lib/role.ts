export function isAgent(role: string | null | undefined): boolean {
  return role === 'agent' || role === 'admin';
}
