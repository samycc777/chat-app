import { useEffect, useRef, useState, useCallback } from 'react';
import {
  X, ChevronLeft, ChevronRight, Pencil, Eraser, Trash2, Upload, Mic, MicOff, Users, Monitor,
} from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { getSocket } from '../socket';
import { useI18n } from '../i18n';
import type { User } from '../types';
import { api, API_URL } from '../api';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

interface WbStroke {
  id: string;
  page: number;
  points: { x: number; y: number }[];
  color: string;
  width: number;
  tool: 'pen' | 'eraser';
}

interface VoiceParticipant {
  userId: string;
  displayName: string;
  avatarColor: string;
  muted: boolean;
}

interface Props {
  conversationId: string;
  pdfUrl: string | null;
  presenterId: string;
  currentUser: User;
  onEnd: () => void;
}

const COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#000000', '#ffffff', '#eab308'];
const WIDTHS = [2, 4, 8];
const SEND_INTERVAL = 50;

const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

export default function WhiteboardView({ conversationId, pdfUrl, presenterId, currentUser, onEnd }: Props) {
  const { t } = useI18n();
  const isPresenter = currentUser.id === presenterId;

  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [activePdfUrl, setActivePdfUrl] = useState(pdfUrl);
  const [loadError, setLoadError] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [tool, setTool] = useState<'pen' | 'eraser'>('pen');
  const [color, setColor] = useState('#ef4444');
  const [lineWidth, setLineWidth] = useState(4);

  const containerRef = useRef<HTMLDivElement>(null);
  const pdfCanvasRef = useRef<HTMLCanvasElement>(null);
  const drawCanvasRef = useRef<HTMLCanvasElement>(null);
  const pdfDocRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  const strokesRef = useRef<Map<number, WbStroke[]>>(new Map());
  const remoteStrokesRef = useRef<Map<string, WbStroke>>(new Map());
  const activeStrokeRef = useRef<WbStroke | null>(null);
  const canvasSizeRef = useRef({ width: 0, height: 0 });
  const isDrawingRef = useRef(false);
  const currentPageRef = useRef(1);
  const sendBufferRef = useRef<{ x: number; y: number }[]>([]);
  const sendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toolRef = useRef(tool);
  const colorRef = useRef(color);
  const lineWidthRef = useRef(lineWidth);

  const [voiceActive, setVoiceActive] = useState(false);
  const [muted, setMuted] = useState(false);
  const voiceStreamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const remoteAudioRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const [voiceParticipants, setVoiceParticipants] = useState<VoiceParticipant[]>([]);

  const [screenSharing, setScreenSharing] = useState(false);
  const [remoteScreenActive, setRemoteScreenActive] = useState(false);
  const screenVideoRef = useRef<HTMLVideoElement>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const screenPeersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const screenActiveRef = useRef(false);

  useEffect(() => { toolRef.current = tool; }, [tool]);
  useEffect(() => { colorRef.current = color; }, [color]);
  useEffect(() => { lineWidthRef.current = lineWidth; }, [lineWidth]);

  const screenActive = screenSharing || remoteScreenActive;
  useEffect(() => { screenActiveRef.current = screenActive; }, [screenActive]);

  function drawStrokeOnCanvas(ctx: CanvasRenderingContext2D, stroke: WbStroke, w: number, h: number) {
    if (stroke.points.length < 1) return;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = stroke.width;

    if (stroke.tool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = stroke.color;
    }

    ctx.beginPath();
    ctx.moveTo(stroke.points[0].x * w, stroke.points[0].y * h);
    for (let i = 1; i < stroke.points.length; i++) {
      ctx.lineTo(stroke.points[i].x * w, stroke.points[i].y * h);
    }
    if (stroke.points.length === 1) {
      ctx.arc(stroke.points[0].x * w, stroke.points[0].y * h, stroke.width / 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.stroke();
    ctx.restore();
  }

  const renderStrokes = useCallback(() => {
    const canvas = drawCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = canvasSizeRef.current;
    if (!width || !height) return;
    const page = currentPageRef.current;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.scale(dpr, dpr);

    const pageStrokes = strokesRef.current.get(page) || [];
    for (const s of pageStrokes) drawStrokeOnCanvas(ctx, s, width, height);

    for (const s of remoteStrokesRef.current.values()) {
      if (s.page === page) drawStrokeOnCanvas(ctx, s, width, height);
    }

    if (activeStrokeRef.current?.page === page) {
      drawStrokeOnCanvas(ctx, activeStrokeRef.current, width, height);
    }

    ctx.restore();
  }, []);

  const renderPdfPage = useCallback(async (pageNum: number) => {
    const container = containerRef.current;
    const pdfCanvas = pdfCanvasRef.current;
    const drawCanvas = drawCanvasRef.current;
    if (!container || !pdfCanvas || !drawCanvas) return;

    const dpr = window.devicePixelRatio || 1;
    const containerW = container.clientWidth;
    const containerH = container.clientHeight;

    let w: number, h: number;
    const pdf = pdfDocRef.current;

    if (pdf && pageNum >= 1 && pageNum <= pdf.numPages) {
      const page = await pdf.getPage(pageNum);
      const uv = page.getViewport({ scale: 1 });
      const scale = Math.min((containerW - 32) / uv.width, (containerH - 32) / uv.height);
      const viewport = page.getViewport({ scale });
      w = Math.floor(viewport.width);
      h = Math.floor(viewport.height);

      pdfCanvas.width = Math.floor(w * dpr);
      pdfCanvas.height = Math.floor(h * dpr);
      pdfCanvas.style.width = w + 'px';
      pdfCanvas.style.height = h + 'px';

      const ctx = pdfCanvas.getContext('2d')!;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const transform: [number, number, number, number, number, number] = [dpr, 0, 0, dpr, 0, 0];
      await page.render({ canvas: pdfCanvas, canvasContext: ctx, viewport, transform }).promise;
    } else {
      const aspect = 1 / 1.414;
      if (containerW / containerH > aspect) {
        h = Math.min(containerH - 32, 800);
        w = Math.floor(h * aspect);
      } else {
        w = Math.min(containerW - 32, 600);
        h = Math.floor(w / aspect);
      }

      pdfCanvas.width = w * dpr;
      pdfCanvas.height = h * dpr;
      pdfCanvas.style.width = w + 'px';
      pdfCanvas.style.height = h + 'px';

      const ctx = pdfCanvas.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
    }

    drawCanvas.width = w * dpr;
    drawCanvas.height = h * dpr;
    drawCanvas.style.width = w + 'px';
    drawCanvas.style.height = h + 'px';

    canvasSizeRef.current = { width: w, height: h };
    renderStrokes();
  }, [renderStrokes]);

  // Load PDF
  useEffect(() => {
    if (!activePdfUrl) {
      pdfDocRef.current = null;
      setNumPages(0);
      setLoadError(false);
      renderPdfPage(currentPageRef.current);
      return;
    }
    setLoadError(false);
    let live = true;
    let objectUrl: string | null = null;
    api.getAttachmentBlob(activePdfUrl).then(blob => {
      objectUrl = URL.createObjectURL(blob);
      return pdfjsLib.getDocument({ url: objectUrl }).promise;
    }).then(pdf => {
      if (!live) return;
      pdfDocRef.current = pdf;
      setNumPages(pdf.numPages);
      renderPdfPage(currentPageRef.current);
    }).catch(err => {
      console.error('PDF load failed:', err);
      if (live) setLoadError(true);
    });
    return () => { live = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [activePdfUrl, renderPdfPage]);

  // Resize handler
  function resizeForScreenShare() {
    const container = containerRef.current;
    const video = screenVideoRef.current;
    const drawCanvas = drawCanvasRef.current;
    if (!container || !video || !drawCanvas || !video.videoWidth) return;

    const dpr = window.devicePixelRatio || 1;
    const containerW = container.clientWidth;
    const containerH = container.clientHeight;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const scale = Math.min((containerW - 32) / vw, (containerH - 32) / vh);
    const w = Math.floor(vw * scale);
    const h = Math.floor(vh * scale);

    video.style.width = w + 'px';
    video.style.height = h + 'px';

    drawCanvas.width = w * dpr;
    drawCanvas.height = h * dpr;
    drawCanvas.style.width = w + 'px';
    drawCanvas.style.height = h + 'px';

    canvasSizeRef.current = { width: w, height: h };
    renderStrokes();
  }

  useEffect(() => {
    function onResize() {
      if (screenActiveRef.current) {
        resizeForScreenShare();
      } else {
        renderPdfPage(currentPageRef.current);
      }
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [renderPdfPage]);

  function goToPage(page: number) {
    if (page < 1 || page > numPages) return;
    currentPageRef.current = page;
    setCurrentPage(page);
    renderPdfPage(page);
    if (isPresenter) {
      getSocket()?.emit('wb_page', { conversationId, page });
    }
  }

  // Pointer handlers
  function getCanvasPoint(e: React.PointerEvent): { x: number; y: number } {
    const rect = drawCanvasRef.current!.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top) / rect.height,
    };
  }

  function flushSendBuffer(done = false) {
    const socket = getSocket();
    const stroke = activeStrokeRef.current;
    if (!socket || !stroke || sendBufferRef.current.length === 0) {
      if (done && socket && stroke) {
        socket.emit('wb_draw', {
          conversationId, strokeId: stroke.id, page: stroke.page,
          points: [], color: stroke.color, width: stroke.width, tool: stroke.tool, done: true,
        });
      }
      return;
    }
    socket.emit('wb_draw', {
      conversationId, strokeId: stroke.id, page: stroke.page,
      points: sendBufferRef.current, color: stroke.color, width: stroke.width, tool: stroke.tool, done,
    });
    sendBufferRef.current = [];
  }

  function handlePointerDown(e: React.PointerEvent) {
    if (!isPresenter) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);

    isDrawingRef.current = true;
    const point = getCanvasPoint(e);
    const strokeId = crypto.randomUUID();

    activeStrokeRef.current = {
      id: strokeId, page: currentPageRef.current, points: [point],
      color: colorRef.current, width: lineWidthRef.current, tool: toolRef.current,
    };
    sendBufferRef.current = [point];
    flushSendBuffer();
    renderStrokes();
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (!isPresenter || !isDrawingRef.current || !activeStrokeRef.current) return;
    e.preventDefault();
    const point = getCanvasPoint(e);
    activeStrokeRef.current.points.push(point);
    sendBufferRef.current.push(point);
    renderStrokes();

    if (!sendTimerRef.current) {
      sendTimerRef.current = setTimeout(() => {
        flushSendBuffer();
        sendTimerRef.current = null;
      }, SEND_INTERVAL);
    }
  }

  function handlePointerUp(e: React.PointerEvent) {
    if (!isPresenter || !isDrawingRef.current || !activeStrokeRef.current) return;
    e.preventDefault();
    isDrawingRef.current = false;

    if (sendTimerRef.current) {
      clearTimeout(sendTimerRef.current);
      sendTimerRef.current = null;
    }
    flushSendBuffer(true);

    const stroke = activeStrokeRef.current;
    const page = stroke.page;
    if (!strokesRef.current.has(page)) strokesRef.current.set(page, []);
    strokesRef.current.get(page)!.push(stroke);
    activeStrokeRef.current = null;
    renderStrokes();
  }

  function handleClear() {
    if (!isPresenter) return;
    strokesRef.current.set(currentPageRef.current, []);
    renderStrokes();
    getSocket()?.emit('wb_clear', { conversationId, page: currentPageRef.current });
  }

  function handleUploadPdf(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setLoadError(false);
    setUploadProgress(0);

    const formData = new FormData();
    formData.append('conversationId', conversationId);
    formData.append('file', file);
    const token = localStorage.getItem('token');

    const xhr = new XMLHttpRequest();
    xhr.upload.addEventListener('progress', (ev) => {
      if (ev.lengthComputable) {
        setUploadProgress(Math.round((ev.loaded / ev.total) * 100));
      }
    });
    xhr.addEventListener('load', () => {
      setUploadProgress(null);
      if (xhr.status < 200 || xhr.status >= 300) {
        console.error('Upload failed:', xhr.status, xhr.responseText);
        setLoadError(true);
        e.target.value = '';
        return;
      }
      try {
        const data = JSON.parse(xhr.responseText);
        if (!data.attachmentId) {
          console.error('Upload response missing url:', data);
          setLoadError(true);
          e.target.value = '';
          return;
        }
        setActivePdfUrl(data.attachmentId);
        strokesRef.current.clear();
        currentPageRef.current = 1;
        setCurrentPage(1);
        getSocket()?.emit('wb_pdf', { conversationId, attachmentId: data.attachmentId });
      } catch (err) {
        console.error('Upload response parse error:', err);
        setLoadError(true);
      }
      e.target.value = '';
    });
    xhr.addEventListener('error', () => {
      setUploadProgress(null);
      console.error('Upload network error');
      setLoadError(true);
      e.target.value = '';
    });
    xhr.addEventListener('abort', () => {
      setUploadProgress(null);
      e.target.value = '';
    });

    xhr.open('POST', `${API_URL}/api/upload`);
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.send(formData);
  }

  async function startScreenShare() {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      screenStreamRef.current = stream;
      setScreenSharing(true);
      if (screenVideoRef.current) {
        screenVideoRef.current.srcObject = stream;
      }
      strokesRef.current.clear();
      currentPageRef.current = 1;
      setCurrentPage(1);
      renderStrokes();
      getSocket()?.emit('wb_screen_start', { conversationId });
      stream.getVideoTracks()[0].addEventListener('ended', () => {
        stopScreenShare();
      });
    } catch (err) {
      console.error('Screen share failed:', err);
    }
  }

  function stopScreenShare() {
    screenStreamRef.current?.getTracks().forEach(t => t.stop());
    screenStreamRef.current = null;
    for (const pc of screenPeersRef.current.values()) pc.close();
    screenPeersRef.current.clear();
    if (screenVideoRef.current) screenVideoRef.current.srcObject = null;
    setScreenSharing(false);
    getSocket()?.emit('wb_screen_stop', { conversationId });
    renderPdfPage(currentPageRef.current);
  }

  function toggleScreenShare() {
    if (screenSharing) stopScreenShare();
    else startScreenShare();
  }

  function handleEnd() {
    leaveVoice();
    if (screenSharing) stopScreenShare();
    getSocket()?.emit('wb_end', { conversationId });
    onEnd();
  }

  function createPeerConnection(peerId: string, stream: MediaStream): RTCPeerConnection {
    const pc = new RTCPeerConnection(ICE_SERVERS);
    peersRef.current.set(peerId, pc);

    stream.getTracks().forEach(track => pc.addTrack(track, stream));

    pc.ontrack = (e) => {
      if (e.streams[0]) {
        let audio = remoteAudioRef.current.get(peerId);
        if (!audio) {
          audio = new Audio();
          audio.autoplay = true;
          remoteAudioRef.current.set(peerId, audio);
        }
        audio.srcObject = e.streams[0];
      }
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        getSocket()?.emit('wb_voice_ice', {
          conversationId,
          targetUserId: peerId,
          candidate: e.candidate.toJSON(),
        });
      }
    };

    return pc;
  }

  function cleanupPeer(peerId: string) {
    const pc = peersRef.current.get(peerId);
    if (pc) {
      pc.close();
      peersRef.current.delete(peerId);
    }
    const audio = remoteAudioRef.current.get(peerId);
    if (audio) {
      audio.srcObject = null;
      remoteAudioRef.current.delete(peerId);
    }
  }

  function leaveVoice() {
    getSocket()?.emit('wb_voice_leave', { conversationId });
    voiceStreamRef.current?.getTracks().forEach(t => t.stop());
    voiceStreamRef.current = null;
    for (const peerId of peersRef.current.keys()) {
      cleanupPeer(peerId);
    }
    setVoiceActive(false);
    setMuted(false);
    setVoiceParticipants(prev => prev.filter(p => p.userId !== currentUser.id));
  }

  async function toggleVoice() {
    if (voiceActive) {
      leaveVoice();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      voiceStreamRef.current = stream;
      setVoiceActive(true);
      getSocket()?.emit('wb_voice_join', { conversationId });
    } catch {
      console.error('Microphone access denied');
    }
  }

  function toggleMute() {
    const track = voiceStreamRef.current?.getAudioTracks()[0];
    if (track) {
      track.enabled = !track.enabled;
      const newMuted = !track.enabled;
      setMuted(newMuted);
      getSocket()?.emit('wb_voice_mute', { conversationId, muted: newMuted });
      setVoiceParticipants(prev => prev.map(p =>
        p.userId === currentUser.id ? { ...p, muted: newMuted } : p
      ));
    }
  }

  // Voice signaling
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    async function handleVoicePeers(data: { conversationId: string; peers: string[]; participants?: VoiceParticipant[] }) {
      if (data.conversationId !== conversationId) return;
      if (data.participants) setVoiceParticipants(data.participants);
      const stream = voiceStreamRef.current;
      if (!stream) return;
      for (const peerId of data.peers) {
        const pc = createPeerConnection(peerId, stream);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket!.emit('wb_voice_offer', {
          conversationId,
          targetUserId: peerId,
          offer: pc.localDescription,
        });
      }
    }

    async function handleVoiceJoined(data: { conversationId: string; userId: string }) {
      if (data.conversationId !== conversationId) return;
      if (data.userId === currentUser.id) return;
    }

    async function handleVoiceOffer(data: { conversationId: string; from: string; offer: RTCSessionDescriptionInit }) {
      if (data.conversationId !== conversationId) return;
      const stream = voiceStreamRef.current;
      if (!stream) return;
      const pc = createPeerConnection(data.from, stream);
      await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket!.emit('wb_voice_answer', {
        conversationId,
        targetUserId: data.from,
        answer: pc.localDescription,
      });
    }

    async function handleVoiceAnswer(data: { conversationId: string; from: string; answer: RTCSessionDescriptionInit }) {
      if (data.conversationId !== conversationId) return;
      const pc = peersRef.current.get(data.from);
      if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
      }
    }

    function handleVoiceIce(data: { conversationId: string; from: string; candidate: RTCIceCandidateInit }) {
      if (data.conversationId !== conversationId) return;
      const pc = peersRef.current.get(data.from);
      if (pc) {
        pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
      }
    }

    function handleVoiceLeft(data: { conversationId: string; userId: string }) {
      if (data.conversationId !== conversationId) return;
      cleanupPeer(data.userId);
    }

    socket.on('wb_voice_peers', handleVoicePeers);
    socket.on('wb_voice_joined', handleVoiceJoined);
    socket.on('wb_voice_offer', handleVoiceOffer);
    socket.on('wb_voice_answer', handleVoiceAnswer);
    socket.on('wb_voice_ice', handleVoiceIce);
    socket.on('wb_voice_left', handleVoiceLeft);

    return () => {
      socket.off('wb_voice_peers', handleVoicePeers);
      socket.off('wb_voice_joined', handleVoiceJoined);
      socket.off('wb_voice_offer', handleVoiceOffer);
      socket.off('wb_voice_answer', handleVoiceAnswer);
      socket.off('wb_voice_ice', handleVoiceIce);
      socket.off('wb_voice_left', handleVoiceLeft);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, voiceActive]);

  // Cleanup voice on unmount
  useEffect(() => {
    return () => {
      voiceStreamRef.current?.getTracks().forEach(t => t.stop());
      for (const pc of peersRef.current.values()) pc.close();
      for (const audio of remoteAudioRef.current.values()) audio.srcObject = null;
      screenStreamRef.current?.getTracks().forEach(t => t.stop());
      for (const pc of screenPeersRef.current.values()) pc.close();
    };
  }, []);

  // Socket listeners
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    socket.emit('wb_get_state', { conversationId });

    function handleDraw(data: any) {
      if (data.conversationId !== conversationId) return;
      const existing = remoteStrokesRef.current.get(data.strokeId);
      if (existing) {
        existing.points.push(...data.points);
      } else {
        remoteStrokesRef.current.set(data.strokeId, {
          id: data.strokeId, page: data.page,
          points: [...data.points], color: data.color, width: data.width, tool: data.tool,
        });
      }
      if (data.done) {
        const stroke = remoteStrokesRef.current.get(data.strokeId)!;
        remoteStrokesRef.current.delete(data.strokeId);
        if (!strokesRef.current.has(stroke.page)) strokesRef.current.set(stroke.page, []);
        strokesRef.current.get(stroke.page)!.push(stroke);
      }
      renderStrokes();
    }

    function handlePageChanged(data: any) {
      if (data.conversationId !== conversationId) return;
      currentPageRef.current = data.page;
      setCurrentPage(data.page);
      renderPdfPage(data.page);
    }

    function handleCleared(data: any) {
      if (data.conversationId !== conversationId) return;
      strokesRef.current.set(data.page, []);
      renderStrokes();
    }

    function handlePdfChanged(data: any) {
      if (data.conversationId !== conversationId) return;
      setActivePdfUrl(data.pdfUrl);
      strokesRef.current.clear();
      remoteStrokesRef.current.clear();
      currentPageRef.current = 1;
      setCurrentPage(1);
    }

    function handleEnded(data: any) {
      if (data.conversationId !== conversationId) return;
      onEnd();
    }

    function handleState(data: any) {
      if (data.conversationId !== conversationId) return;
      if (data.voiceParticipants) setVoiceParticipants(data.voiceParticipants);
      if (data.pdfUrl && data.pdfUrl !== activePdfUrl) setActivePdfUrl(data.pdfUrl);
      if (data.currentPage) {
        currentPageRef.current = data.currentPage;
        setCurrentPage(data.currentPage);
      }
      if (data.strokes) {
        const map = new Map<number, WbStroke[]>();
        for (const [k, v] of Object.entries(data.strokes)) {
          map.set(Number(k), v as WbStroke[]);
        }
        strokesRef.current = map;
      }
      if (data.screenShareActive) {
        setRemoteScreenActive(true);
        socket!.emit('wb_screen_watch', { conversationId });
      }
      renderPdfPage(data.currentPage || 1);
    }

    function handleScreenStarted(data: any) {
      if (data.conversationId !== conversationId) return;
      setRemoteScreenActive(true);
      strokesRef.current.clear();
      renderStrokes();
      socket!.emit('wb_screen_watch', { conversationId });
    }

    function handleScreenStopped(data: any) {
      if (data.conversationId !== conversationId) return;
      for (const pc of screenPeersRef.current.values()) pc.close();
      screenPeersRef.current.clear();
      if (screenVideoRef.current) screenVideoRef.current.srcObject = null;
      setRemoteScreenActive(false);
      renderPdfPage(currentPageRef.current);
    }

    async function handleScreenWatcher(data: any) {
      if (data.conversationId !== conversationId) return;
      const stream = screenStreamRef.current;
      if (!stream) return;
      const pc = new RTCPeerConnection(ICE_SERVERS);
      screenPeersRef.current.set(data.viewerId, pc);
      stream.getTracks().forEach(track => pc.addTrack(track, stream));
      pc.onicecandidate = (e) => {
        if (e.candidate) {
          socket!.emit('wb_screen_ice', {
            conversationId,
            targetUserId: data.viewerId,
            candidate: e.candidate.toJSON(),
          });
        }
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket!.emit('wb_screen_offer', {
        conversationId,
        targetUserId: data.viewerId,
        offer: pc.localDescription,
      });
    }

    async function handleScreenOffer(data: any) {
      if (data.conversationId !== conversationId) return;
      const pc = new RTCPeerConnection(ICE_SERVERS);
      screenPeersRef.current.set(data.from, pc);
      pc.ontrack = (e) => {
        if (e.streams[0] && screenVideoRef.current) {
          screenVideoRef.current.srcObject = e.streams[0];
        }
      };
      pc.onicecandidate = (e) => {
        if (e.candidate) {
          socket!.emit('wb_screen_ice', {
            conversationId,
            targetUserId: data.from,
            candidate: e.candidate.toJSON(),
          });
        }
      };
      await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket!.emit('wb_screen_answer', {
        conversationId,
        targetUserId: data.from,
        answer: pc.localDescription,
      });
    }

    async function handleScreenAnswer(data: any) {
      if (data.conversationId !== conversationId) return;
      const pc = screenPeersRef.current.get(data.from);
      if (pc) await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
    }

    function handleScreenIce(data: any) {
      if (data.conversationId !== conversationId) return;
      const pc = screenPeersRef.current.get(data.from);
      if (pc) pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
    }

    function handleVoiceJoinedTrack(data: any) {
      if (data.conversationId !== conversationId) return;
      setVoiceParticipants(prev => {
        if (prev.some(p => p.userId === data.userId)) return prev;
        return [...prev, {
          userId: data.userId,
          displayName: data.displayName,
          avatarColor: data.avatarColor,
          muted: data.muted ?? false,
        }];
      });
    }

    function handleVoiceLeftTrack(data: any) {
      if (data.conversationId !== conversationId) return;
      setVoiceParticipants(prev => prev.filter(p => p.userId !== data.userId));
    }

    function handleVoiceMuted(data: any) {
      if (data.conversationId !== conversationId) return;
      setVoiceParticipants(prev => prev.map(p =>
        p.userId === data.userId ? { ...p, muted: data.muted } : p
      ));
    }

    socket.on('wb_draw', handleDraw);
    socket.on('wb_page_changed', handlePageChanged);
    socket.on('wb_cleared', handleCleared);
    socket.on('wb_pdf_loaded', handlePdfChanged);
    socket.on('wb_ended', handleEnded);
    socket.on('wb_state', handleState);
    socket.on('wb_voice_joined', handleVoiceJoinedTrack);
    socket.on('wb_voice_left', handleVoiceLeftTrack);
    socket.on('wb_voice_muted', handleVoiceMuted);
    socket.on('wb_screen_started', handleScreenStarted);
    socket.on('wb_screen_stopped', handleScreenStopped);
    socket.on('wb_screen_watcher', handleScreenWatcher);
    socket.on('wb_screen_offer', handleScreenOffer);
    socket.on('wb_screen_answer', handleScreenAnswer);
    socket.on('wb_screen_ice', handleScreenIce);

    return () => {
      socket.off('wb_draw', handleDraw);
      socket.off('wb_page_changed', handlePageChanged);
      socket.off('wb_cleared', handleCleared);
      socket.off('wb_pdf_loaded', handlePdfChanged);
      socket.off('wb_ended', handleEnded);
      socket.off('wb_state', handleState);
      socket.off('wb_voice_joined', handleVoiceJoinedTrack);
      socket.off('wb_voice_left', handleVoiceLeftTrack);
      socket.off('wb_voice_muted', handleVoiceMuted);
      socket.off('wb_screen_started', handleScreenStarted);
      socket.off('wb_screen_stopped', handleScreenStopped);
      socket.off('wb_screen_watcher', handleScreenWatcher);
      socket.off('wb_screen_offer', handleScreenOffer);
      socket.off('wb_screen_answer', handleScreenAnswer);
      socket.off('wb_screen_ice', handleScreenIce);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  return (
    <div className="whiteboard-overlay">
      <div className="whiteboard-header">
        <div className="whiteboard-title">{t('whiteboard')}</div>
        {numPages > 0 && (
          <div className="whiteboard-page-nav">
            <button className="icon-btn" onClick={() => goToPage(currentPage - 1)} disabled={currentPage <= 1 || !isPresenter}>
              <ChevronLeft size={20} />
            </button>
            <span className="whiteboard-page-num">{currentPage} / {numPages}</span>
            <button className="icon-btn" onClick={() => goToPage(currentPage + 1)} disabled={currentPage >= numPages || !isPresenter}>
              <ChevronRight size={20} />
            </button>
          </div>
        )}
        <button
          className={`wb-voice-btn ${voiceActive ? (muted ? 'muted' : 'active') : ''}`}
          onClick={voiceActive ? toggleMute : toggleVoice}
          title={voiceActive ? (muted ? t('unmute') : t('mute')) : t('joinVoice')}
        >
          {voiceActive && !muted ? <Mic size={18} /> : <MicOff size={18} />}
          <span>{voiceActive ? (muted ? t('muted') : t('voiceOn')) : t('joinVoice')}</span>
        </button>
        {voiceActive && (
          <button className="wb-voice-leave-btn" onClick={leaveVoice} title={t('leaveVoice')}>
            <MicOff size={18} />
          </button>
        )}
        <button className="whiteboard-end-btn" onClick={isPresenter ? handleEnd : () => { leaveVoice(); onEnd(); }}>
          <X size={18} />
          <span>{isPresenter ? t('end') : t('leave')}</span>
        </button>
      </div>

      {voiceParticipants.length > 0 && (
        <div className="wb-participants-bar">
          <div className="wb-participants-label">
            <Users size={14} />
            <span>{t('inCall', { count: voiceParticipants.length })}</span>
          </div>
          <div className="wb-participants-list">
            {voiceParticipants.map(p => (
              <div key={p.userId} className={`wb-participant ${p.userId === currentUser.id ? 'self' : ''}`}>
                <div className="wb-participant-avatar" style={{ background: p.avatarColor }}>
                  {p.displayName.charAt(0).toUpperCase()}
                </div>
                <span className="wb-participant-name">
                  {p.userId === currentUser.id ? t('you') : p.displayName}
                </span>
                <span className={`wb-participant-mic ${p.muted ? 'muted' : ''}`}>
                  {p.muted ? <MicOff size={14} /> : <Mic size={14} />}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="whiteboard-canvas-area" ref={containerRef}>
        <div className="whiteboard-canvas-wrap">
          <canvas ref={pdfCanvasRef} className="whiteboard-pdf-canvas" style={{ display: screenActive ? 'none' : undefined }} />
          <video
            ref={screenVideoRef}
            className="whiteboard-screen-video"
            autoPlay
            playsInline
            muted
            onLoadedMetadata={() => resizeForScreenShare()}
            style={{ display: screenActive ? 'block' : 'none' }}
          />
          <canvas
            ref={drawCanvasRef}
            className="whiteboard-draw-canvas"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            style={{ cursor: isPresenter ? 'crosshair' : 'default' }}
          />
        </div>
        {uploadProgress !== null && (
          <div className="whiteboard-upload-overlay">
            <div className="whiteboard-upload-progress">
              <div className="whiteboard-upload-bar">
                <div className="whiteboard-upload-fill" style={{ width: `${uploadProgress}%` }} />
              </div>
              <span className="whiteboard-upload-text">
                {uploadProgress < 100 ? `${t('uploading')}… ${uploadProgress}%` : t('processing')}
              </span>
            </div>
          </div>
        )}
        {!activePdfUrl && !loadError && uploadProgress === null && !screenActive && (
          <div className="whiteboard-placeholder">
            {isPresenter ? t('uploadPdfPrompt') : t('waitingForPresenter')}
          </div>
        )}
        {loadError && (
          <div className="whiteboard-placeholder whiteboard-error">
            {t('pdfLoadError')}
          </div>
        )}
      </div>

      {isPresenter && (
        <div className="whiteboard-toolbar">
          <div className="whiteboard-tool-group">
            <button className={`wb-tool-btn ${tool === 'pen' ? 'active' : ''}`} onClick={() => setTool('pen')} title={t('pen')}>
              <Pencil size={18} />
            </button>
            <button className={`wb-tool-btn ${tool === 'eraser' ? 'active' : ''}`} onClick={() => setTool('eraser')} title={t('eraser')}>
              <Eraser size={18} />
            </button>
            <button className="wb-tool-btn" onClick={handleClear} title={t('clearPage')}>
              <Trash2 size={18} />
            </button>
          </div>

          <div className="whiteboard-tool-group wb-colors">
            {COLORS.map(c => (
              <button
                key={c}
                className={`wb-color-btn ${color === c ? 'active' : ''}`}
                style={{ background: c, border: c === '#ffffff' ? '2px solid #666' : '2px solid transparent' }}
                onClick={() => setColor(c)}
              />
            ))}
          </div>

          <div className="whiteboard-tool-group wb-widths">
            {WIDTHS.map(w => (
              <button key={w} className={`wb-width-btn ${lineWidth === w ? 'active' : ''}`} onClick={() => setLineWidth(w)}>
                <span className="wb-width-dot" style={{ width: w + 4, height: w + 4 }} />
              </button>
            ))}
          </div>

          <label className="wb-tool-btn wb-upload-btn" title={t('uploadPdf')}>
            <Upload size={18} />
            <input type="file" accept=".pdf,application/pdf" style={{ display: 'none' }} onChange={handleUploadPdf} />
          </label>
          <button
            className={`wb-tool-btn ${screenSharing ? 'active' : ''}`}
            onClick={toggleScreenShare}
            title={screenSharing ? t('stopSharing') : t('shareScreen')}
          >
            <Monitor size={18} />
          </button>
        </div>
      )}
    </div>
  );
}
