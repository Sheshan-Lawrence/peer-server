import { useEffect, useRef, type AudioHTMLAttributes } from 'react';

interface AudioProps extends Omit<AudioHTMLAttributes<HTMLAudioElement>, 'ref'> {
  stream: MediaStream | null;
}

export function Audio({ stream, ...props }: AudioProps) {
  const ref = useRef<HTMLAudioElement>(null);

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

  return <audio ref={ref} autoPlay {...props} />;
}
