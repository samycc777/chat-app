import { useEffect, useRef, useState, useCallback } from 'react';
import { Phone, PhoneOff, Mic, MicOff, Video, VideoOff } from 'lucide-react';
import { getSocket } from '../socket';
import type { User } from '../types';
import Avatar from './Avatar';

export interface CallState {
  active: boolean;
  type: 'audio' | 'video';
  direction: 'outgoing' | 'incoming';
  remoteUser: User;
  conversationId: string;
  offer?: RTCSessionDescriptionInit;
}

interface Props {
  call: CallState;
  currentUser: User;
  onEnd: () => void;
}

const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

export default function CallView({ call, currentUser, onEnd }: Props) {
  const [status, setStatus] = useState<'ringing' | 'connecting' | 'connected' | 'ended'>(
    call.direction === 'outgoing' ? 'ringing' : 'connecting'
  );
  const [muted, setMuted] = useState(false);
  const [videoOff, setVideoOff] = useState(call.type === 'audio');
  const [elapsed, setElapsed] = useState(0);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const connectedAtRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const cleanup = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
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
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: call.type === 'video',
      });
      if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
      localStreamRef.current = stream;

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }

      const pc = new RTCPeerConnection(ICE_SERVERS);
      pcRef.current = pc;

      stream.getTracks().forEach(track => pc.addTrack(track, stream));

      pc.ontrack = (e) => {
        if (remoteVideoRef.current && e.streams[0]) {
          remoteVideoRef.current.srcObject = e.streams[0];
        }
      };

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          socket.emit('ice_candidate', { targetUserId: call.remoteUser.id, candidate: e.candidate.toJSON() });
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          setStatus('connected');
          connectedAtRef.current = Date.now();
          timerRef.current = setInterval(() => {
            setElapsed(Math.floor((Date.now() - connectedAtRef.current!) / 1000));
          }, 1000);
        }
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
          setStatus('ended');
          cleanup();
          setTimeout(onEnd, 1000);
        }
      };

      if (call.direction === 'outgoing') {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('call_user', {
          targetUserId: call.remoteUser.id,
          conversationId: call.conversationId,
          offer: pc.localDescription,
          callType: call.type,
        });
      } else if (call.offer) {
        await pc.setRemoteDescription(new RTCSessionDescription(call.offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('call_answer', { targetUserId: call.remoteUser.id, answer: pc.localDescription });
      }
    }

    start().catch(() => {
      setStatus('ended');
      cleanup();
      setTimeout(onEnd, 1000);
    });

    function handleAnswered(data: { from: string; answer: RTCSessionDescriptionInit }) {
      if (data.from !== call.remoteUser.id) return;
      setStatus('connecting');
      pcRef.current?.setRemoteDescription(new RTCSessionDescription(data.answer));
    }

    function handleIceCandidate(data: { from: string; candidate: RTCIceCandidateInit }) {
      if (data.from !== call.remoteUser.id) return;
      pcRef.current?.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
    }

    function handleEnded(data: { from: string }) {
      if (data.from !== call.remoteUser.id) return;
      setStatus('ended');
      cleanup();
      setTimeout(onEnd, 1000);
    }

    function handleRejected(data: { from: string }) {
      if (data.from !== call.remoteUser.id) return;
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
  }, [call, cleanup, onEnd]);

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
            {status === 'ringing' && 'Ringing...'}
            {status === 'connecting' && 'Connecting...'}
            {status === 'connected' && formatTime(elapsed)}
            {status === 'ended' && 'Call ended'}
          </div>
          <audio ref={remoteVideoRef} autoPlay />
        </div>
      )}

      {isVideo && (
        <div className="call-video-info">
          <div className="call-user-name">{call.remoteUser.displayName}</div>
          <div className="call-status-text">
            {status === 'ringing' && 'Ringing...'}
            {status === 'connecting' && 'Connecting...'}
            {status === 'connected' && formatTime(elapsed)}
            {status === 'ended' && 'Call ended'}
          </div>
        </div>
      )}

      <div className="call-controls">
        <button
          className={`call-control-btn ${muted ? 'active' : ''}`}
          onClick={toggleMute}
          title={muted ? 'Unmute' : 'Mute'}
        >
          {muted ? <MicOff size={24} /> : <Mic size={24} />}
        </button>

        {isVideo && (
          <button
            className={`call-control-btn ${videoOff ? 'active' : ''}`}
            onClick={toggleVideo}
            title={videoOff ? 'Turn on camera' : 'Turn off camera'}
          >
            {videoOff ? <VideoOff size={24} /> : <Video size={24} />}
          </button>
        )}

        <button className="call-control-btn end" onClick={endCall} title="End call">
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
  return (
    <div className="incoming-call-banner">
      <Avatar name={caller.displayName} color={caller.avatarColor} size="small" />
      <div className="incoming-call-info">
        <div className="incoming-call-name">{caller.displayName}</div>
        <div className="incoming-call-type">
          Incoming {callType} call...
        </div>
      </div>
      <div className="incoming-call-actions">
        <button className="call-action-btn accept" onClick={onAccept} title="Accept">
          <Phone size={20} />
        </button>
        <button className="call-action-btn reject" onClick={onReject} title="Reject">
          <PhoneOff size={20} />
        </button>
      </div>
    </div>
  );
}
