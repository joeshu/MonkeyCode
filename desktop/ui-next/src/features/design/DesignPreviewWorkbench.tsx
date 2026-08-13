import {
  IconArrowBackUp, IconBrowser, IconCamera, IconCode, IconDeviceDesktop, IconDeviceMobile,
  IconDeviceTablet, IconDownload, IconMessage, IconPencil, IconPointer, IconRefresh,
  IconSend, IconSquare, IconTrash, IconX, IconFolder,
} from "@tabler/icons-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import type { ComposerCtl } from "@/features/chat/composer/useComposer";
import { CodeView } from "@/features/files/CodeView";
import { repoArtifactRead, repoPreviewFiles, type RepoArtifact, type RepoPreviewFile } from "@/lib/ipc/repo";
import { rankPreviewFiles, targetForFile, type DesignPreviewTarget } from "./previewArtifact";
import {
  onPreviewElementPicked, onPreviewPickerError, onPreviewResultAction, previewCreate, previewCreateArtifact,
  previewDestroy, previewElementApply, previewElementUndo, previewHide, previewNavigate, previewPickerToggle,
  previewReload, previewResultHide, previewResultShow, previewSaveHtml, previewSetBounds,
  previewSetZoom, previewShow, requestCapture, requestSerialization, type ElementSnapshot,
} from "./previewIpc";
import { normalizePreviewUrl } from "./previewUrl";

type Annotation =
  | { kind: "rect"; x: number; y: number; width: number; height: number }
  | { kind: "pen"; points: { x: number; y: number }[] }
  | { kind: "text"; x: number; y: number; text: string }
  | { kind: "comment"; x: number; y: number; text: string };
type Tool = Annotation["kind"];

const PRESETS = { desktop: 1280, tablet: 768, mobile: 390 } as const;

function downloadDataUrl(dataUrl: string, name = "design-preview.png") {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = name;
  a.click();
}

async function annotatedDataUrl(dataUrl: string, annotations: Annotation[]): Promise<string> {
  if (!annotations.length) return dataUrl;
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is unavailable");
  ctx.drawImage(image, 0, 0);
  const x = (n: number) => n * canvas.width / 100;
  const y = (n: number) => n * canvas.height / 100;
  ctx.lineWidth = Math.max(2, canvas.width / 500);
  ctx.font = `${Math.max(14, canvas.width / 70)}px sans-serif`;
  for (const a of annotations) {
    ctx.strokeStyle = a.kind === "comment" ? "#ffcc00" : "#ff2d2d";
    ctx.fillStyle = ctx.strokeStyle;
    if (a.kind === "rect") ctx.strokeRect(x(a.x), y(a.y), x(a.width), y(a.height));
    else if (a.kind === "pen") {
      ctx.beginPath();
      a.points.forEach((p, i) => i ? ctx.lineTo(x(p.x), y(p.y)) : ctx.moveTo(x(p.x), y(p.y)));
      ctx.stroke();
    } else ctx.fillText(`${a.kind === "comment" ? "● " : ""}${a.text}`, x(a.x), y(a.y));
  }
  return canvas.toDataURL("image/png");
}

async function downloadAnnotated(dataUrl: string, annotations: Annotation[]) {
  downloadDataUrl(await annotatedDataUrl(dataUrl, annotations));
}

function pngFileOf(dataUrl: string): File {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("Captured preview is not a valid data URL.");
  const header = dataUrl.slice(0, comma);
  const body = dataUrl.slice(comma + 1);
  const binary = /;base64(?:;|$)/i.test(header) ? atob(body) : decodeURIComponent(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], `design-feedback-${Date.now()}.png`, { type: "image/png" });
}

function feedbackOf(url: string, annotations: Annotation[]) {
  const comments = annotations.filter((a): a is Extract<Annotation, { kind: "comment" }> => a.kind === "comment");
  return [
    `Design preview feedback for ${url}`,
    ...comments.map((a, i) => `${i + 1}. ${a.text} (at ${Math.round(a.x)}%, ${Math.round(a.y)}%)`),
    comments.length ? "" : "Please review the attached preview state.",
    `Annotations: ${annotations.length}.`,
  ].join("\n");
}

export function DesignPreviewWorkbench({
  sessionId, initialTarget, composer, obscured, onClose,
}: {
  sessionId: string;
  initialTarget: DesignPreviewTarget;
  composer: ComposerCtl;
  obscured: boolean;
  onClose(): void;
}) {
  const initialUrl = initialTarget.kind === "localhost" ? initialTarget.url : "";
  const paneRef = useRef<HTMLElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef(0);
  const createdRef = useRef(false);
  const artifactCreateQueueRef = useRef(Promise.resolve());
  const [paneWidth, setPaneWidth] = useState<number | string>("65%");
  const [target, setTarget] = useState<DesignPreviewTarget>(initialTarget);
  const latestRef = useRef({ sessionId, initialUrl, targetKind: target.kind });
  latestRef.current = { sessionId, initialUrl, targetKind: target.kind };
  const [address, setAddress] = useState(initialUrl);
  const [filesOpen, setFilesOpen] = useState(false);
  const [previewFiles, setPreviewFiles] = useState<RepoPreviewFile[] | null>(null);
  const [filesTruncated, setFilesTruncated] = useState(false);
  const [fileQuery, setFileQuery] = useState("");
  const [artifact, setArtifact] = useState<RepoArtifact | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [tab, setTab] = useState<"preview" | "code">("preview");
  const [zoom, setZoom] = useState(100);
  const [preset, setPreset] = useState<keyof typeof PRESETS>("desktop");
  const [status, setStatus] = useState("");
  const [html, setHtml] = useState("");
  const [savePath, setSavePath] = useState("index.html");
  const [picker, setPicker] = useState(false);
  const [picked, setPicked] = useState<ElementSnapshot | null>(null);
  const [property, setProperty] = useState("text");
  const [value, setValue] = useState("");
  const [capture, setCapture] = useState<string | null>(null);
  const resultImageRef = useRef<string | null>(null);
  const resultAnnotationsRef = useRef<Annotation[]>([]);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [tool, setTool] = useState<Tool>("rect");
  const drawing = useRef<Annotation | null>(null);
  const feedbackSendingRef = useRef(false);
  const [feedbackSending, setFeedbackSending] = useState(false);

  useEffect(() => {
    setTarget(initialTarget);
    if (initialTarget.kind === "localhost") setAddress(initialTarget.url);
    setFilesOpen(false);
  }, [initialTarget]);

  const native = target.kind === "localhost" || (target.kind === "artifact" && target.artifactKind === "html");
  const previewSourceKey = target.kind === "localhost" ? "localhost" : target.kind === "artifact" && target.artifactKind === "html" ? `artifact:${target.path}` : "none";
  const hidden = !native || obscured || tab === "code" || filesOpen || !!capture || !!picked;
  const visibleFiles = useMemo(() => rankPreviewFiles(previewFiles ?? [], fileQuery), [previewFiles, fileQuery]);
  const loadFiles = useCallback(async () => {
    setFilesLoading(true);
    try {
      const result = await repoPreviewFiles(sessionId);
      setPreviewFiles(result.files); setFilesTruncated(result.truncated);
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    finally { setFilesLoading(false); }
  }, [sessionId]);
  const report = useCallback((error: unknown) => setStatus(error instanceof Error ? error.message : String(error)), []);
  const submitFeedback = useCallback(async (image: string, feedbackAnnotations: Annotation[]): Promise<boolean> => {
    if (feedbackSendingRef.current) return false;
    feedbackSendingRef.current = true;
    setFeedbackSending(true);
    setStatus("Preparing annotated preview…");
    const forSid = sessionId;
    try {
      const annotated = await annotatedDataUrl(image, feedbackAnnotations);
      if (latestRef.current.sessionId !== forSid) return false;
      const accepted = await composer.sendWithFiles(
        feedbackOf(address, feedbackAnnotations),
        [pngFileOf(annotated)],
      );
      if (latestRef.current.sessionId !== forSid) return false;
      if (!accepted) {
        setStatus("Feedback was not sent. Check the composer error and try again.");
        return false;
      }
      setStatus("Feedback sent through the composer.");
      return true;
    } catch (error) {
      if (latestRef.current.sessionId === forSid) report(error);
      return false;
    } finally {
      feedbackSendingRef.current = false;
      if (latestRef.current.sessionId === forSid) setFeedbackSending(false);
    }
  }, [sessionId, composer, address, report]);

  const bounds = useCallback(() => {
    const host = hostRef.current;
    if (!host || !createdRef.current) return;
    const r = host.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    void previewSetBounds({ x: r.left, y: r.top, width: r.width, height: r.height }).catch(report);
  }, [report]);

  useLayoutEffect(() => {
    const generation = ++liveRef.current;
    const artifactPath = target.kind === "artifact" && target.artifactKind === "html" ? target.path : null;
    const url = target.kind === "localhost" ? normalizePreviewUrl(target.url) : null;
    if (!url && !artifactPath) {
      createdRef.current = false;
      void previewDestroy().catch(() => {});
      return;
    }
    let starting = false;
    const sync = () => {
      const host = hostRef.current;
      if (!host || (!url && !artifactPath)) return;
      const r = host.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      if (createdRef.current) { bounds(); return; }
      if (starting) return;
      starting = true;
      const create = artifactPath
        ? artifactCreateQueueRef.current.then(() => previewCreateArtifact(sessionId, artifactPath, { x: r.left, y: r.top, width: r.width, height: r.height }))
        : previewCreate(url!, { x: r.left, y: r.top, width: r.width, height: r.height });
      if (artifactPath) artifactCreateQueueRef.current = create.catch(() => {});
      void create.then(() => {
        starting = false;
        if (liveRef.current !== generation) {
          if (latestRef.current.targetKind !== "localhost") void previewDestroy().catch(() => {});
          return;
        }
        createdRef.current = true;
        bounds();
      }, (error) => { starting = false; report(error); });
    };
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync);
    if (hostRef.current) ro?.observe(hostRef.current);
    window.addEventListener("resize", sync);
    sync();
    return () => {
      liveRef.current += 1;
      createdRef.current = false;
      ro?.disconnect();
      window.removeEventListener("resize", sync);
      void previewDestroy().catch(() => {});
    };
    // URL changes navigate through the dedicated effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, previewSourceKey]);

  useLayoutEffect(() => {
    if (tab !== "preview" || !hostRef.current) return;
    bounds();
    const frame = requestAnimationFrame(bounds);
    if (typeof ResizeObserver === "undefined") return () => cancelAnimationFrame(frame);
    const ro = new ResizeObserver(bounds);
    ro.observe(hostRef.current);
    return () => { cancelAnimationFrame(frame); ro.disconnect(); };
  }, [tab, preset, bounds]);

  useEffect(() => {
    if (target.kind !== "localhost") return;
    const url = normalizePreviewUrl(target.url);
    if (!url) return;
    setAddress(url);
    if (createdRef.current) void previewNavigate(url).catch(report);
  }, [target, report]);

  useEffect(() => {
    if (target.kind !== "artifact" || target.artifactKind === "html") { setArtifact(null); return; }
    let active = true;
    setStatus("Loading artifact…");
    void repoArtifactRead(sessionId, target.path).then((value) => {
      if (!active) return;
      setArtifact(value); setStatus(""); setTab("preview");
    }, (error) => active && report(error));
    return () => { active = false; };
  }, [sessionId, target, report]);

  useEffect(() => {
    if (!createdRef.current) return;
    void (hidden ? previewHide() : previewShow().then(bounds)).catch(report);
  }, [hidden, bounds, report]);

  useEffect(() => {
    const generation = liveRef.current;
    const offPicked = onPreviewElementPicked((snapshot) => {
      if (liveRef.current !== generation) return;
      setPicker(false); setPicked(snapshot); setProperty("text"); setValue(snapshot.text);
      void previewPickerToggle(false).catch(report);
    });
    const offError = onPreviewPickerError((error) => liveRef.current === generation && report(error));
    const offAction = onPreviewResultAction((action) => {
      if (liveRef.current !== generation || latestRef.current.sessionId !== sessionId) return;
      const image = resultImageRef.current;
      const resultAnnotations = resultAnnotationsRef.current;
      if (action === "download" && image) void downloadAnnotated(image, resultAnnotations).catch(report);
      if (action === "send" && image) {
        void submitFeedback(image, resultAnnotations).then((sent) => {
          if (sent) void previewResultHide().catch(report);
        });
      }
      if (action === "close") void previewResultHide().catch(report);
    });
    return () => { offPicked(); offError(); offAction(); };
  }, [sessionId, submitFeedback, report]);

  const navigate = () => {
    const normalized = normalizePreviewUrl(address);
    if (!normalized) { setStatus("Only localhost, 127.0.0.1 and [::1] HTTP(S) URLs are allowed."); return; }
    setAddress(normalized); setTarget({ kind: "localhost", url: normalized }); setStatus("");
    if (native) void previewNavigate(normalized).catch(report);
  };
  const serialize = async () => {
    setTab("code"); setStatus("Serializing…");
    try { setHtml(await requestSerialization()); setStatus(""); } catch (error) { report(error); }
  };
  const startCapture = async (mode: "viewport" | "full") => {
    setStatus("Capturing…");
    try {
      const result = await requestCapture(mode);
      if (latestRef.current.sessionId !== sessionId) return;
      setCapture(result.dataUrl); setAnnotations([]); setStatus(result.clipboardError ?? "");
    } catch (error) { report(error); }
  };
  const closeCapture = () => {
    const image = capture;
    if (!image) return;
    resultImageRef.current = image;
    resultAnnotationsRef.current = annotations;
    setCapture(null);
    void previewResultShow(image, "Annotation ready", annotations.filter((a) => a.kind === "comment").length).catch(report);
  };
  const sendFeedback = async () => {
    const image = capture;
    if (!image) return;
    if (await submitFeedback(image, annotations)) closeCapture();
  };

  const point = (e: ReactPointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100 };
  };
  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    const p = point(e);
    e.currentTarget.setPointerCapture(e.pointerId);
    if (tool === "text" || tool === "comment") {
      const text = window.prompt(tool === "comment" ? "Comment" : "Text")?.trim();
      if (text) setAnnotations((all) => [...all, { kind: tool, ...p, text }]);
      return;
    }
    drawing.current = tool === "rect" ? { kind: "rect", ...p, width: 0, height: 0 } : { kind: "pen", points: [p] };
  };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!drawing.current) return;
    const p = point(e);
    if (drawing.current.kind === "rect") {
      drawing.current.width = p.x - drawing.current.x; drawing.current.height = p.y - drawing.current.y;
    } else if (drawing.current.kind === "pen") drawing.current.points.push(p);
  };
  const onPointerUp = () => {
    if (!drawing.current) return;
    const next = drawing.current; drawing.current = null;
    setAnnotations((all) => [...all, next]);
  };

  const applyEdit = async () => {
    if (!picked) return;
    try { await previewElementApply({ selector: picked.selector, property, value: property === "delete" ? "" : value }); setStatus("Applied in preview."); }
    catch (error) { report(error); }
  };

  return (
    <aside ref={paneRef} aria-label="Design preview workbench" style={{ width: paneWidth }} className="relative flex min-w-80 shrink-0 flex-col border-s border-base-300 bg-base-100">
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize design preview"
        className="absolute inset-y-0 -start-1 z-30 w-2 cursor-col-resize"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          const parent = paneRef.current?.parentElement?.getBoundingClientRect();
          const move = (event: PointerEvent) => parent && setPaneWidth(Math.max(320, Math.min(parent.width - 360, parent.right - event.clientX)));
          const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
          window.addEventListener("pointermove", move); window.addEventListener("pointerup", up, { once: true });
        }}
      />
      <div className="relative flex h-10 shrink-0 items-center gap-1 border-b border-base-300 px-2">
        <button aria-label="Choose workspace preview file" className="btn btn-ghost btn-square btn-xs" onClick={() => { const open = !filesOpen; setFilesOpen(open); if (open && previewFiles === null) void loadFiles(); }}><IconFolder size={14} /></button>
        {target.kind === "localhost" ? <>
          <IconBrowser size={15} stroke={1.75} className="shrink-0 text-base-content/50" aria-hidden />
          <input aria-label="Preview address" className="input input-xs min-w-24 flex-1 font-mono" value={address} onChange={(e) => setAddress(e.target.value)} onKeyDown={(e) => e.key === "Enter" && navigate()} />
          <button className="btn btn-ghost btn-square btn-xs" title="Navigate" onClick={navigate}>→</button>
          <button className="btn btn-ghost btn-square btn-xs" title="Reload" onClick={() => void previewReload().catch(report)}><IconRefresh size={14} stroke={1.75} /></button>
        </> : <>
          <span className="min-w-0 flex-1 truncate font-mono text-xs" title={target.kind === "artifact" ? target.path : ""}>{target.kind === "artifact" ? target.path : ""}</span>
          {target.kind === "artifact" && target.artifactKind === "html" && <button className="btn btn-ghost btn-square btn-xs" title="Reload" onClick={() => void previewReload().catch(report)}><IconRefresh size={14} stroke={1.75} /></button>}
        </>}
        <button className="btn btn-ghost btn-square btn-xs" title="Close preview" onClick={onClose}><IconX size={14} stroke={1.75} /></button>
        {filesOpen && <div className="absolute inset-x-2 top-10 z-40 max-h-72 overflow-auto rounded-box border border-base-300 bg-base-100 p-2 shadow-lg">
          <div className="flex gap-1"><input autoFocus aria-label="Search preview files" className="input input-xs min-w-0 flex-1" placeholder="Search workspace files" value={fileQuery} onChange={(e) => setFileQuery(e.target.value)} /><button className="btn btn-ghost btn-xs" disabled={filesLoading} onClick={() => void loadFiles()}><IconRefresh size={13} /> Refresh</button></div>
          {filesTruncated && <p className="py-1 text-xs text-warning">Results truncated</p>}
          <div className="mt-1 flex flex-col">{visibleFiles.map((file) => <button key={file.path} className="btn btn-ghost btn-sm h-auto min-h-8 justify-start font-mono text-xs" title={file.path} onClick={() => { setTarget(targetForFile(file)); setFilesOpen(false); }}>{file.path}</button>)}</div>
          {!filesLoading && visibleFiles.length === 0 && <p className="p-2 text-xs text-base-content/60">No previewable files</p>}
        </div>}
      </div>
      {native && <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-1 border-b border-base-300 px-2 py-1">
        {Object.entries(PRESETS).map(([name]) => {
          const Icon = name === "desktop" ? IconDeviceDesktop : name === "tablet" ? IconDeviceTablet : IconDeviceMobile;
          return <button key={name} className={`btn btn-square btn-xs ${preset === name ? "btn-active" : "btn-ghost"}`} title={name} onClick={() => setPreset(name as keyof typeof PRESETS)}><Icon size={14} stroke={1.75} /></button>;
        })}
        <div role="tablist" className="tabs tabs-box tabs-xs ms-1">
          <button role="tab" className={`tab ${tab === "preview" ? "tab-active" : ""}`} onClick={() => setTab("preview")}>Preview</button>
          <button role="tab" className={`tab ${tab === "code" ? "tab-active" : ""}`} onClick={() => void serialize()}><IconCode size={12} stroke={1.75} /> Code</button>
        </div>
        <button className={`btn btn-xs ms-auto ${picker ? "btn-primary" : "btn-ghost"}`} onClick={() => { const next = !picker; setPicker(next); void previewPickerToggle(next).catch(report); }}><IconPointer size={13} stroke={1.75} /> Pick</button>
        <button className="btn btn-ghost btn-xs" onClick={() => void startCapture("viewport")}><IconCamera size={13} stroke={1.75} /> Capture</button>
        <button className="btn btn-ghost btn-xs" onClick={() => void startCapture("full")}>Full</button>
        <select aria-label="Zoom" className="select select-xs w-20" value={zoom} onChange={(e) => { const n = Math.min(500, Math.max(10, Number(e.target.value))); setZoom(n); void previewSetZoom(n / 100).catch(report); }}>
          {[10, 25, 50, 75, 100, 125, 150, 200, 300, 400, 500].map((n) => <option key={n} value={n}>{n}%</option>)}
        </select>
      </div>}
      {status && <div role="status" className="shrink-0 border-b border-base-300 px-3 py-1 text-xs text-base-content/60">{status}</div>}
      <div className="relative min-h-0 flex-1 overflow-hidden bg-base-200">
        {target.kind === "artifact" && target.artifactKind !== "html" ? (
          artifact?.kind === "image" ? <div className="flex size-full items-center justify-center overflow-auto p-2"><img src={artifact.dataUrl} alt={artifact.path} className="max-h-full max-w-full" /></div>
          : artifact?.kind === "text" ? <div className="size-full overflow-auto"><CodeView path={artifact.path} text={artifact.content} /></div>
          : null
        ) : tab === "preview" ? (
          <div className="flex size-full justify-center overflow-auto p-2">
            <div ref={hostRef} data-preview-host="" style={{ width: `min(100%, ${PRESETS[preset]}px)` }} className="h-full min-w-40 bg-base-100" />
          </div>
        ) : (
          <div className="flex size-full flex-col gap-2 p-2">
            <textarea aria-label="Serialized HTML" className="textarea min-h-0 flex-1 resize-none font-mono text-xs" value={html} onChange={(e) => setHtml(e.target.value)} />
            <div className="flex gap-2">
              <input aria-label="Project-relative HTML path" className="input input-sm min-w-0 flex-1 font-mono" value={savePath} onChange={(e) => setSavePath(e.target.value)} />
              <button className="btn btn-primary btn-sm" onClick={() => void previewSaveHtml(sessionId, savePath, html).then(() => setStatus(`Saved ${savePath}`), report)}>Save HTML</button>
            </div>
          </div>
        )}
        {picked && (
          <div className="absolute inset-3 z-10 overflow-auto rounded-box bg-base-100 p-3 shadow-sm">
            <div className="flex items-center gap-2"><strong className="min-w-0 flex-1 truncate text-sm">{picked.tag} · {picked.selector}</strong><button className="btn btn-ghost btn-square btn-xs" onClick={() => setPicked(null)}><IconX size={14} /></button></div>
            <p className="mt-1 text-xs text-base-content/60">{picked.text.slice(0, 240)}</p>
            <select aria-label="Element property" className="select select-sm mt-3 w-full" value={property} onChange={(e) => { setProperty(e.target.value); setValue(e.target.value === "text" ? picked.text : ""); }}>
              <option value="text">Text</option><option value="color">Color</option><option value="backgroundColor">Background</option><option value="fontSize">Font size</option><option value="opacity">Opacity</option><option value="borderRadius">Border radius</option><option value="delete">Delete element</option>
            </select>
            {property !== "delete" && <textarea aria-label="Element value" className="textarea textarea-sm mt-2 w-full" value={value} onChange={(e) => setValue(e.target.value)} />}
            <div className="mt-2 flex gap-2"><button className="btn btn-primary btn-sm" onClick={() => void applyEdit()}>Apply</button><button className="btn btn-ghost btn-sm" onClick={() => void previewElementUndo().catch(report)}><IconArrowBackUp size={14} /> Undo</button></div>
          </div>
        )}
        {capture && (
          <div className="absolute inset-0 z-20 flex flex-col bg-base-200 p-2">
            <div className="flex shrink-0 flex-wrap gap-1 pb-2">
              {([['rect', IconSquare], ['pen', IconPencil], ['text', IconCode], ['comment', IconMessage]] as const).map(([name, Icon]) => <button key={name} className={`btn btn-xs ${tool === name ? "btn-active" : "btn-ghost"}`} onClick={() => setTool(name)}><Icon size={13} /> {name}</button>)}
              <button className="btn btn-ghost btn-xs ms-auto" onClick={() => setAnnotations((a) => a.slice(0, -1))}><IconArrowBackUp size={13} /> Undo</button>
              <button className="btn btn-ghost btn-xs" onClick={() => setAnnotations([])}><IconTrash size={13} /> Clear</button>
              <button className="btn btn-ghost btn-xs" onClick={() => void downloadAnnotated(capture, annotations).catch(report)}><IconDownload size={13} /> Download</button>
              <button className="btn btn-primary btn-xs" disabled={feedbackSending} onClick={() => void sendFeedback()}><IconSend size={13} /> Send</button>
              <button className="btn btn-ghost btn-square btn-xs" onClick={closeCapture}><IconX size={13} /></button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              <div className="relative w-fit max-w-full">
              <img src={capture} alt="Captured preview" className="block max-w-full select-none" draggable={false} />
              <svg aria-label="Annotation surface" className="absolute inset-0 size-full touch-none" viewBox="0 0 100 100" preserveAspectRatio="none" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
                {annotations.map((a, i) => a.kind === "rect" ? <rect key={i} x={Math.min(a.x, a.x + a.width)} y={Math.min(a.y, a.y + a.height)} width={Math.abs(a.width)} height={Math.abs(a.height)} fill="none" stroke="red" strokeWidth="0.5" /> : a.kind === "pen" ? <polyline key={i} points={a.points.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke="red" strokeWidth="0.6" /> : <text key={i} x={a.x} y={a.y} fill={a.kind === "comment" ? "#ffcc00" : "red"} fontSize="3">{a.kind === "comment" ? `● ${a.text}` : a.text}</text>)}
              </svg>
              </div>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
