import type { Transfer } from './useFileTransfer';

interface TransferProgressProps {
  transfer: Transfer;
  onAccept?: () => void;
  onReject?: () => void;
  onCancel?: () => void;
  className?: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function TransferProgress({ transfer, onAccept, onReject, onCancel, className }: TransferProgressProps) {
  const { filename, size, progress, bytesPerSecond, status, direction } = transfer;

  return (
    <div className={className} data-status={status} data-direction={direction}>
      <div data-part="info">
        <span data-part="filename">{filename}</span>
        <span data-part="size">{formatBytes(size)}</span>
      </div>
      {status === 'active' && (
        <div data-part="progress">
          <div data-part="bar" style={{ width: `${progress}%` }} />
          <span data-part="percent">{Math.round(progress)}%</span>
          <span data-part="speed">{formatSpeed(bytesPerSecond)}</span>
        </div>
      )}
      {status === 'pending' && direction === 'receive' && (
        <div data-part="actions">
          {onAccept && <button onClick={onAccept} data-action="accept">Accept</button>}
          {onReject && <button onClick={onReject} data-action="reject">Reject</button>}
        </div>
      )}
      {status === 'active' && onCancel && (
        <button onClick={onCancel} data-action="cancel">Cancel</button>
      )}
      {status === 'complete' && <span data-part="status">Complete</span>}
      {status === 'cancelled' && <span data-part="status">Cancelled</span>}
      {status === 'error' && <span data-part="status">Error</span>}
    </div>
  );
}
