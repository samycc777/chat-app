import { useEffect, useRef, useState, useCallback } from 'react';
import {
  X, ChevronLeft, ChevronRight, Pencil, Eraser, Trash2, Upload,
} from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
import { getSocket } from '../socket';
import type { User } from '../types';
import { API_URL } from '../api';

pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

interface WbStroke {
  id: string;
  page: number;
  points: { x: number; y: number }[];
  color: string;
  width: number;
  tool: 'pen' | 'eraser';
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

export default function WhiteboardView({ conversationId, pdfUrl, presenterId, currentUser, onEnd }: Props) {
  const isPresenter = currentUser.id === presenterId;

  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [activePdfUrl, setActivePdfUrl] = useState(pdfUrl);
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

  useEffect(() => { toolRef.current = tool; }, [tool]);
  useEffect(() => { colorRef.current = color; }, [color]);
  useEffect(() => { lineWidthRef.current = lineWidth; }, [lineWidth]);

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
      renderPdfPage(currentPageRef.current);
      return;
    }
    const url = `${API_URL}${activePdfUrl}`;
    pdfjsLib.getDocument({ url }).promise.then(pdf => {
      pdfDocRef.current = pdf;
      setNumPages(pdf.numPages);
      renderPdfPage(currentPageRef.current);
    }).catch(err => console.error('PDF load failed:', err));
  }, [activePdfUrl, renderPdfPage]);

  // Resize handler
  useEffect(() => {
    function onResize() { renderPdfPage(currentPageRef.current); }
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

  async function handleUploadPdf(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      const data = await res.json();
      setActivePdfUrl(data.url);
      strokesRef.current.clear();
      currentPageRef.current = 1;
      setCurrentPage(1);
      getSocket()?.emit('wb_pdf', { conversationId, pdfUrl: data.url });
    } catch (err) {
      console.error('Upload failed:', err);
    }
    e.target.value = '';
  }

  function handleEnd() {
    getSocket()?.emit('wb_end', { conversationId });
    onEnd();
  }

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
      renderPdfPage(data.currentPage || 1);
    }

    socket.on('wb_draw', handleDraw);
    socket.on('wb_page_changed', handlePageChanged);
    socket.on('wb_cleared', handleCleared);
    socket.on('wb_pdf_loaded', handlePdfChanged);
    socket.on('wb_ended', handleEnded);
    socket.on('wb_state', handleState);

    return () => {
      socket.off('wb_draw', handleDraw);
      socket.off('wb_page_changed', handlePageChanged);
      socket.off('wb_cleared', handleCleared);
      socket.off('wb_pdf_loaded', handlePdfChanged);
      socket.off('wb_ended', handleEnded);
      socket.off('wb_state', handleState);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  return (
    <div className="whiteboard-overlay">
      <div className="whiteboard-header">
        <div className="whiteboard-title">Whiteboard</div>
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
        <button className="whiteboard-end-btn" onClick={isPresenter ? handleEnd : onEnd}>
          <X size={18} />
          <span>{isPresenter ? 'End' : 'Leave'}</span>
        </button>
      </div>

      <div className="whiteboard-canvas-area" ref={containerRef}>
        <div className="whiteboard-canvas-wrap">
          <canvas ref={pdfCanvasRef} className="whiteboard-pdf-canvas" />
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
        {!activePdfUrl && (
          <div className="whiteboard-placeholder">
            {isPresenter ? 'Upload a PDF to get started, or draw on the blank canvas' : 'Waiting for presenter...'}
          </div>
        )}
      </div>

      {isPresenter && (
        <div className="whiteboard-toolbar">
          <div className="whiteboard-tool-group">
            <button className={`wb-tool-btn ${tool === 'pen' ? 'active' : ''}`} onClick={() => setTool('pen')} title="Pen">
              <Pencil size={18} />
            </button>
            <button className={`wb-tool-btn ${tool === 'eraser' ? 'active' : ''}`} onClick={() => setTool('eraser')} title="Eraser">
              <Eraser size={18} />
            </button>
            <button className="wb-tool-btn" onClick={handleClear} title="Clear page">
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

          <label className="wb-tool-btn wb-upload-btn" title="Upload PDF">
            <Upload size={18} />
            <input type="file" accept=".pdf,application/pdf" style={{ display: 'none' }} onChange={handleUploadPdf} />
          </label>
        </div>
      )}
    </div>
  );
}
