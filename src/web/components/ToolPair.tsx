import { pairColor, shortToolId } from '../format';

/** Colour swatch + short id shared by a tool call and its result. */
export function PairChip({ toolUseId, name }: { toolUseId: string; name?: string }) {
  return (
    <span className="pair-chip" title={`${name ? `${name} · ` : ''}tool_use id ${toolUseId}`}>
      <span className="pair-swatch" style={{ background: pairColor(toolUseId) }} />
      {name && <span className="pair-name">{name}</span>}
      <span className="pair-id">#{shortToolId(toolUseId)}</span>
    </span>
  );
}
