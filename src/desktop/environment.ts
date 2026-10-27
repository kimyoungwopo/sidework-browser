import { delimiter, join } from 'node:path';

// Finder often supplies no package-manager path; use only explicit installed locations, never cwd.
export function cliPath(home: string, inherited: string | undefined): string {
  return [...new Set([join(home,'.local','bin'),'/opt/homebrew/bin','/usr/local/bin',...(inherited??'/usr/bin:/bin:/usr/sbin:/sbin').split(delimiter)].filter(Boolean))].join(delimiter);
}
