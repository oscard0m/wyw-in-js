export const cx = (...values: string[]): string =>
  values.filter(Boolean).join(' ');
