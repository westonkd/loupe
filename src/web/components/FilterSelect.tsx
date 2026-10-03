import { Select } from '@westonkd/sprint';

const ALL = '\u0000all';

/**
 * Sprint Select for a toolbar filter, with an explicit "All …" option.
 * Sprint's placeholder can't be chosen again once something is picked,
 * so "no filter" is a real option here, mapped to `value === ''`.
 */
export function FilterSelect({
  label,
  allLabel,
  value,
  onChange,
  options,
}: {
  label: string;
  allLabel: string;
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<{ value: string; label: string; count?: number }>;
}) {
  return (
    <Select
      label={label}
      value={value === '' ? ALL : value}
      onChange={(v) => onChange(v === ALL ? '' : v)}
      options={[{ value: ALL, label: allLabel }, ...options]}
    />
  );
}
