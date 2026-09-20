import { useEffect, useRef, useState, useCallback } from 'react';
import { Phone, PhoneOff, Mic, MicOff, Video, VideoOff } from 'lucide-react';
import { getSocket } from '../socket';
import { useI18n } from '../i18n';
import type { User } from '../types';
import Avatar from './Avatar';
import { api } from '../api';

export interface CallState {
  active: boolean;
  type: 'audio' | 'video';
  direction: 'outgoing' | 'incoming';
  remoteUser: User;
  conversationId: string;
  offer?: RTCSessionDescriptionInit;
  pendingCandidates?: RTCIceCandidateInit[];
}

interface Props {
  call: CallState;
  onEnd: () => void;
}

export default function CallView({ call, onEnd }: Props) {
  const { t } = useI18n();
  const [status, setStatus] = useState<'ringing' | 'connecting' | 'connected' | 'ended'>(
    call.direction === 'outgoing' ? 'ringing' : 'connecting'
  );
  const [muted, setMuted] = useState(false);
  const [videoOff, setVideoOff] = useState(call.type === 'audio');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const connectedAtRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>(call.pendingCandidates || []);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cleanup = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    localStreamRef.current?.getTracks().forEach(t => t.stop());
    pcRef.current?.close();
    pcRef.current = null;
    localStreamRef.current = null;
  }, []);

  const endCall = useCallback(() => {
    const socket = getSocket();
    socket?.emit('call_end', { targetUserId: call.remoteUser.id });
    setStatus('ended');
    cleanup();
    setTimeout(onEnd, 1000);
  }, [call.remoteUser.id, cleanup, onEnd]);

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    let cancelled = false;

    async function start() {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error(t('secureMediaRequired'));
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: call.type === 'video',
      });
      if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
      localStreamRef.current = stream;

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }

      const configuration = await api.getIceConfiguration();
      if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
      const pc = new RTCPeerConnection(configuration);
      pcRef.current = pc;

      stream.getTracks().forEach(track => pc.addTrack(track, stream));

      pc.ontrack = (e) => {
        if (remoteVideoRef.current && e.streams[0]) {
          remoteVideoRef.current.srcObject = e.streams[0];
          remoteVideoRef.current.play().catch(() => setError(t('mediaPlaybackBlocked')));
        }
      };

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          socket!.emit('ice_candidate', { targetUserId: call.remoteUser.id, candidate: e.candidate.toJSON() });
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          if (timeoutRef.current) clearTimeout(timeoutRef.current);
          setStatus('connected');
          connectedAtRef.current = Date.now();
          timerRef.current = setInterval(() => {
            setElapsed(Math.floor((Date.now() - connectedAtRef.current!) / 1000));
          }, 1000);
        }
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
          setError(t('networkCallFailed'));
          setStatus('ended');
          cleanup();
          setTimeout(onEnd, 1000);
        }
      };

      if (call.direction === 'outgoing') {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket!.emit('call_user', {
          targetUserId: call.remoteUser.id,
          conversationId: call.conversationId,
          offer: pc.localDescription,
          callType: call.type,
        });
      } else if (call.offer) {
        await pc.setRemoteDescription(new RTCSessionDescription(call.offer));
        for (const candidate of pendingCandidatesRef.current.splice(0)) await pc.addIceCandidate(candidate);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket!.emit('call_answer', { targetUserId: call.remoteUser.id, answer: pc.localDescription });
      }
      timeoutRef.current = setTimeout(() => {
        if (pc.connectionState !== 'connected') {
          setError(t('callTimedOut'));
          cleanup();
          setStatus('ended');
          setTimeout(onEnd, 1500);
        }
      }, 30000);
    }

    start().catch((cause: unknown) => {
      const name = cause instanceof DOMException ? cause.name : '';
      setError(name === 'NotAllowedError' || name === 'PermissionDeniedError' ? t('mediaPermissionDenied')
        : name === 'NotFoundError' || name === 'DevicesNotFoundError' ? t('mediaDeviceMissing')
          : cause instanceof Error ? cause.message : t('mediaSetupFailed'));
      setStatus('ended');
      cleanup();
      setTimeout(onEnd, 1000);
    });

    function handleAnswered(data: { from: string; answer: RTCSessionDescriptionInit }) {
      if (data.from !== call.remoteUser.id) return;
      setStatus('connecting');
      const pc = pcRef.current;
      if (!pc) return;
      pc.setRemoteDescription(new RTCSessionDescription(data.answer)).then(async () => {
        for (const candidate of pendingCandidatesRef.current.splice(0)) await pc.addIceCandidate(candidate);
      }).catch(() => setError(t('networkCallFailed')));
    }

    function handleIceCandidate(data: { from: string; candidate: RTCIceCandidateInit }) {
      if (data.from !== call.remoteUser.id) return;
      const pc = pcRef.current;
      if (!pc || !pc.remoteDescription) pendingCandidatesRef.current.push(data.candidate);
      else pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => setError(t('networkCallFailed')));
    }

    function handleEnded(data: { from: string }) {
      if (data.from !== call.remoteUser.id) return;
      setStatus('ended');
      cleanup();
      setTimeout(onEnd, 1000);
    }

    function handleRejected(data: { from: string }) {
      if (data.from !== call.remoteUser.id) return;
      setError(t('callRejected'));
      setStatus('ended');
      cleanup();
      setTimeout(onEnd, 1000);
    }

    socket.on('call_answered', handleAnswered);
    socket.on('ice_candidate', handleIceCandidate);
    socket.on('call_ended', handleEnded);
    socket.on('call_rejected', handleRejected);

    return () => {
      cancelled = true;
      socket.off('call_answered', handleAnswered);
      socket.off('ice_candidate', handleIceCandidate);
      socket.off('call_ended', handleEnded);
      socket.off('call_rejected', handleRejected);
      cleanup();
    };
  }, [call, cleanup, onEnd, t]);

  function toggleMute() {
    const audio = localStreamRef.current?.getAudioTracks()[0];
    if (audio) {
      audio.enabled = !audio.enabled;
      setMuted(!audio.enabled);
    }
  }

  function toggleVideo() {
    const video = localStreamRef.current?.getVideoTracks()[0];
    if (video) {
      video.enabled = !video.enabled;
      setVideoOff(!video.enabled);
    }
  }

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const isVideo = call.type === 'video';

  return (
    <div className="call-overlay">
      {error && <div className="call-error" role="alert">{error}</div>}
      {isVideo && (
        <>
          <video ref={remoteVideoRef} className="call-remote-video" autoPlay playsInline />
          <video ref={localVideoRef} className="call-local-video" autoPlay playsInline muted />
        </>
      )}

      {!isVideo && (
        <div className="call-audio-view">
          <Avatar name={call.remoteUser.displayName} color={call.remoteUser.avatarColor} size="normal" />
          <div className="call-user-name">{call.remoteUser.displayName}</div>
          <div className="call-status-text">
            {status === 'ringing' && t('ringing')}
            {status === 'connecting' && t('connecting')}
            {status === 'connected' && formatTime(elapsed)}
            {status === 'ended' && t('callEnded')}
          </div>
          <audio ref={remoteVideoRef} autoPlay />
        </div>
      )}

      {isVideo && (
        <div className="call-video-info">
          <div className="call-user-name">{call.remoteUser.displayName}</div>
          <div className="call-status-text">
            {status === 'ringing' && t('ringing')}
            {status === 'connecting' && t('connecting')}
            {status === 'connected' && formatTime(elapsed)}
            {status === 'ended' && t('callEnded')}
          </div>
        </div>
      )}

      <div className="call-controls">
        <button
          className={`call-control-btn ${muted ? 'active' : ''}`}
          onClick={toggleMute}
          title={muted ? t('unmute') : t('mute')}
        >
          {muted ? <MicOff size={24} /> : <Mic size={24} />}
        </button>

        {isVideo && (
          <button
            className={`call-control-btn ${videoOff ? 'active' : ''}`}
            onClick={toggleVideo}
            title={videoOff ? t('turnOnCamera') : t('turnOffCamera')}
          >
            {videoOff ? <VideoOff size={24} /> : <Video size={24} />}
          </button>
        )}

        <button className="call-control-btn end" onClick={endCall} title={t('endCall')}>
          <PhoneOff size={24} />
        </button>
      </div>
    </div>
  );
}

export function IncomingCallBanner({
  caller,
  callType,
  onAccept,
  onReject,
}: {
  caller: User;
  callType: 'audio' | 'video';
  onAccept: () => void;
  onReject: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="incoming-call-banner">
      <Avatar name={caller.displayName} color={caller.avatarColor} size="small" />
      <div className="incoming-call-info">
        <div className="incoming-call-name">{caller.displayName}</div>
        <div className="incoming-call-type">
          {t('incomingCall', { type: t(callType) })}
        </div>
      </div>
      <div className="incoming-call-actions">
        <button className="call-action-btn accept" onClick={onAccept} title={t('accept')}>
          <Phone size={20} />
        </button>
        <button className="call-action-btn reject" onClick={onReject} title={t('reject')}>
          <PhoneOff size={20} />
        </button>
      </div>
    </div>
  );
}
