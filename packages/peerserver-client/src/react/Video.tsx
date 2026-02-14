import { useEffect, useRef, type VideoHTMLAttributes } from 'react';

interface VideoProps extends Omit<VideoHTMLAttributes<HTMLVideoElement>, 'ref'> {
  stream: MediaStream | null;
  muted?: boolean;
}

export function Video({ stream, muted = false, ...props }: VideoProps) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    ref.current.srcObject = stream;
    if (stream) {
      ref.current.play().catch(() => {});
    }
    return () => {
      if (ref.current) ref.current.srcObject = null;
    };
  }, [stream]);

  return <video ref={ref} autoPlay playsInline muted={muted} {...props} />;
}
