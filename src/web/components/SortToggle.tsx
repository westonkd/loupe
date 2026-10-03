import { SegmentedControl } from '@westonkd/sprint';

export function SortToggle({ desc, onChange, label = 'Order' }: { desc: boolean; onChange: (desc: boolean) => void; label?: string }) {
  return (
    <SegmentedControl
      label={label}
      value={desc ? 'desc' : 'asc'}
      onChange={(v) => onChange(v === 'desc')}
      options={[
        { value: 'desc', label: 'Newest first' },
        { value: 'asc', label: 'Oldest first' },
      ]}
    />
  );
}

/** Remember the sort choice per panel (falls back to newest first). */
export function loadDesc(key: string): boolean {
  try {
    return localStorage.getItem(`sort:${key}`) !== 'asc';
  } catch {
    return true;
  }
}

export function saveDesc(key: string, desc: boolean) {
  try {
    localStorage.setItem(`sort:${key}`, desc ? 'desc' : 'asc');
  } catch {
    /* storage unavailable */
  }
}
