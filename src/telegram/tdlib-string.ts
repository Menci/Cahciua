export const nonEmptyString = (value: string): string | undefined =>
  value === '' ? undefined : value;

export const firstNonEmptyString = (
  ...values: Array<string | undefined>
): string | undefined => values.find(value => value !== undefined && value !== '');
