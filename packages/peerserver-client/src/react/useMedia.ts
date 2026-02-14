import { useEffect, useState, useCallback, useRef } from 'react';
import { usePeerContext } from './PeerProvider';
import { DirectMedia, GroupMedia } from '../media';

export function useMedia(
  roomId: string,
  type: 'direct' | 'group' = 'direct',
  create = false,
  audio = true,
  video = true,
) {
  const { client } = usePeerContext();
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());
  const [audioMuted, setAudioMuted] = useState(false);
  const [videoMuted, setVideoMuted] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const mediaRef = useRef<DirectMedia | GroupMedia | null>(null);

  useEffect(() => {
    if (!client || !roomId) return;

    const media = type === 'group'
      ? new GroupMedia(client, roomId)
      : new DirectMedia(client, roomId);
    mediaRef.current = media;

    media.on('local_stream', (stream: MediaStream) => setLocalStream(stream));

    media.on('remote_stream', (stream: MediaStream, fp: string) => {
      setRemoteStreams((prev) => new Map(prev).set(fp, stream));
    });

    media.on('remote_stream_removed', (fp: string) => {
      setRemoteStreams((prev) => {
        const next = new Map(prev);
        next.delete(fp);
        return next;
      });
    });

    media.on('error', (e: any) => {
      setError(e instanceof Error ? e : new Error(String(e)));
    });

    const init = async () => {
      try {
        if (create) {
          await media.createAndJoin({ audio, video });
        } else {
          await media.joinAndStart({ audio, video });
        }
      } catch (e) {
        setError(e instanceof Error ? e : new Error(String(e)));
      }
    };
    init();

    return () => {
      media.close();
      mediaRef.current = null;
      setLocalStream(null);
      setRemoteStreams(new Map());
    };
  }, [client, roomId, type, create, audio, video]);

  const muteAudio = useCallback(() => {
    mediaRef.current?.muteAudio();
    setAudioMuted(true);
  }, []);

  const unmuteAudio = useCallback(() => {
    mediaRef.current?.unmuteAudio();
    setAudioMuted(false);
  }, []);

  const muteVideo = useCallback(() => {
    mediaRef.current?.muteVideo();
    setVideoMuted(true);
  }, []);

  const unmuteVideo = useCallback(() => {
    mediaRef.current?.unmuteVideo();
    setVideoMuted(false);
  }, []);

  const toggleAudio = useCallback(() => {
    audioMuted ? unmuteAudio() : muteAudio();
  }, [audioMuted, muteAudio, unmuteAudio]);

  const toggleVideo = useCallback(() => {
    videoMuted ? unmuteVideo() : muteVideo();
  }, [videoMuted, muteVideo, unmuteVideo]);

  return {
    localStream,
    remoteStreams,
    audioMuted,
    videoMuted,
    muteAudio,
    unmuteAudio,
    muteVideo,
    unmuteVideo,
    toggleAudio,
    toggleVideo,
    error,
  };
}
