interface PeerStatusProps {
  state: string;
  label?: string;
  className?: string;
}

const STATE_COLORS: Record<string, string> = {
  connected: '#22c55e',
  connecting: '#eab308',
  disconnected: '#ef4444',
  failed: '#ef4444',
  closed: '#6b7280',
  new: '#6b7280',
};

export function PeerStatus({ state, label, className }: PeerStatusProps) {
  const color = STATE_COLORS[state] ?? '#6b7280';

  return (
    <span className={className} data-state={state}>
      <span
        data-part="dot"
        style={{
          display: 'inline-block',
          width: 8,
          height: 8,
          borderRadius: '50%',
          backgroundColor: color,
          marginRight: 6,
        }}
      />
      <span data-part="label">{label ?? state}</span>
    </span>
  );
}
