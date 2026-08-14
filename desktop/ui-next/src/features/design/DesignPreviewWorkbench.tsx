import {
  IconArrowBackUp, IconBrowser, IconCamera, IconCode, IconDeviceDesktop, IconDeviceMobile,
  IconDeviceTablet, IconDownload, IconMessage, IconPencil, IconPointer, IconRefresh,
  IconSend, IconSquare, IconTrash, IconX, IconFolder,
} from "@tabler/icons-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import type { ComposerCtl } from "@/features/chat/composer/useComposer";
import { CodeView } from "@/features/files/CodeView";
import { useI18n, type MessageKey } from "@/lib/i18n";
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
  | { kind: "text"; x: number; y: number; text: string };
type Tool = Annotation["kind"];
type DrawingAnnotation = Exclude<Annotation, { kind: "text" }>;

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
    ctx.strokeStyle = "#ff2d2d";
    ctx.fillStyle = ctx.strokeStyle;
    if (a.kind === "rect") ctx.strokeRect(x(a.x), y(a.y), x(a.width), y(a.height));
    else if (a.kind === "pen") {
      ctx.beginPath();
      a.points.forEach((p, i) => i ? ctx.lineTo(x(p.x), y(p.y)) : ctx.moveTo(x(p.x), y(p.y)));
      ctx.stroke();
    } else ctx.fillText(a.text, x(a.x), y(a.y));
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

function feedbackOf(url: string, annotations: Annotation[], message: string) {
  return [
    message.trim(),
    `Design preview feedback for ${url}`,
    `Annotations: ${annotations.length}.`,
  ].filter(Boolean).join("\n\n");
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
  const { t } = useI18n();
  const initialUrl = initialTarget.kind === "localhost" ? initialTarget.url : "";
  const paneRef = useRef<HTMLElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef(0);
  const createdRef = useRef(false);
  const artifactCreateQueueRef = useRef(Promise.resolve());
  const [paneWidth, setPaneWidth] = useState<number | string>("65%");
  const [target, setTarget] = useState<DesignPreviewTarget>(initialTarget);
  const targetKey = target.kind === "localhost" ? `localhost:${normalizePreviewUrl(target.url) ?? target.url}` : target.kind === "artifact" ? `artifact:${target.path}` : "none";
  const latestRef = useRef({ sessionId, targetKey, targetKind: target.kind });
  latestRef.current = { sessionId, targetKey, targetKind: target.kind };
  const elementSelectionRef = useRef(0);
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
  const [pickerPurpose, setPickerPurpose] = useState<"edit" | "comment" | null>(null);
  const pickerRef = useRef(false);
  pickerRef.current = picker;
  const pickerCommandRef = useRef<Promise<void>>(Promise.resolve());
  const overlayRef = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState<ElementSnapshot | null>(null);
  const pickedRef = useRef<ElementSnapshot | null>(null);
  pickedRef.current = picked;
  const commentRequestRef = useRef(0);
  const [pickedPreview, setPickedPreview] = useState<string | null>(null);
  const [commentText, setCommentText] = useState("");
  const [property, setProperty] = useState("text");
  const [value, setValue] = useState("");
  const [capture, setCapture] = useState<string | null>(null);
  const resultImageRef = useRef<string | null>(null);
  const resultAnnotationsRef = useRef<Annotation[]>([]);
  const resultFeedbackRef = useRef("");
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [tool, setTool] = useState<Tool>("rect");
  const [textDraft, setTextDraft] = useState<{ x: number; y: number; text: string } | null>(null);
  const [feedbackText, setFeedbackText] = useState("");
  const drawing = useRef<DrawingAnnotation | null>(null);
  const [drawingAnnotation, setDrawingAnnotation] = useState<DrawingAnnotation | null>(null);
  const feedbackSendingRef = useRef(false);
  const [feedbackSending, setFeedbackSending] = useState(false);

  useEffect(() => {
    setTarget(initialTarget);
    if (initialTarget.kind === "localhost") setAddress(initialTarget.url);
    setFilesOpen(false);
  }, [initialTarget]);

  useEffect(() => {
    elementSelectionRef.current += 1;
  }, [sessionId, targetKey]);

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
  const submitFeedback = useCallback(async (image: string, feedbackAnnotations: Annotation[], message: string): Promise<boolean> => {
    if (feedbackSendingRef.current) return false;
    feedbackSendingRef.current = true;
    setFeedbackSending(true);
    setStatus("Preparing annotated preview…");
    const forSid = sessionId;
    try {
      const annotated = await annotatedDataUrl(image, feedbackAnnotations);
      if (latestRef.current.sessionId !== forSid) return false;
      const accepted = await composer.sendWithFiles(
        feedbackOf(address, feedbackAnnotations, message),
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
        if (pickerRef.current) void previewPickerToggle(true).catch((error) => { setPicker(false); report(error); });
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
      const selection = ++elementSelectionRef.current;
      const selectedTarget = latestRef.current.targetKey;
      const showPicked = (preview: string | null) => {
        if (liveRef.current !== generation || elementSelectionRef.current !== selection || latestRef.current.targetKey !== selectedTarget) return;
        setPickedPreview(preview);
        setPicked(snapshot); setProperty("text"); setValue(snapshot.text);
      };
      setPicker(false);
      void requestCapture("viewport-no-copy").then((result) => {
        showPicked(result.dataUrl);
      }).catch((error) => {
        showPicked(null);
        if (elementSelectionRef.current === selection && latestRef.current.targetKey === selectedTarget) report(error);
      });
      void previewPickerToggle(false).catch(report);
    });
    const offError = onPreviewPickerError((error) => liveRef.current === generation && report(error));
    const offAction = onPreviewResultAction((action) => {
      if (liveRef.current !== generation || latestRef.current.sessionId !== sessionId) return;
      const image = resultImageRef.current;
      const resultAnnotations = resultAnnotationsRef.current;
      const resultFeedback = resultFeedbackRef.current;
      if (action === "download" && image) void downloadAnnotated(image, resultAnnotations).catch(report);
      if (action === "send" && image) {
        void submitFeedback(image, resultAnnotations, resultFeedback).then((sent) => {
          if (sent) void previewResultHide().catch(report);
        });
      }
      if (action === "close") void previewResultHide().catch(report);
    });
    return () => { offPicked(); offError(); offAction(); };
  }, [sessionId, submitFeedback, report]);

  const togglePicker = (purpose: "edit" | "comment") => {
    if (!createdRef.current) {
      setStatus(t("design.preview.loading"));
      return;
    }
    const next = !pickerRef.current || pickerPurpose !== purpose;
    pickerRef.current = next;
    setPicker(next);
    setPickerPurpose(next ? purpose : null);
    if (next) {
      elementSelectionRef.current += 1;
      setPicked(null); setPickedPreview(null); setCommentText("");
    }
    setStatus(next ? t(purpose === "comment" ? "design.preview.commentHint" : "design.preview.editHint") : "");
    pickerCommandRef.current = pickerCommandRef.current
      .catch(() => undefined)
      .then(() => previewPickerToggle(next))
      .catch((error) => {
        if (pickerRef.current === next) {
          pickerRef.current = false;
          setPicker(false);
          setPickerPurpose(null);
        }
        report(error);
      });
  };
  const navigate = () => {
    const normalized = normalizePreviewUrl(address);
    if (!normalized) { setStatus("Only localhost, 127.0.0.1 and [::1] HTTP(S) URLs are allowed."); return; }
    elementSelectionRef.current += 1;
    setPicked(null); setPickedPreview(null);
    setAddress(normalized); setTarget({ kind: "localhost", url: normalized }); setStatus("");
    if (native) void previewNavigate(normalized).catch(report);
  };
  const serialize = async () => {
    setStatus("Serializing…");
    try {
      const serialized = await requestSerialization();
      await previewHide();
      setHtml(serialized); setTab("code"); setStatus("");
    } catch (error) { report(error); }
  };
  const takeScreenshot = async () => {
    setStatus(t("design.preview.capturing"));
    try {
      const result = await requestCapture("viewport");
      if (latestRef.current.sessionId !== sessionId) return;
      setStatus(result.clipboardError ? t("design.preview.copyFailed", { error: result.clipboardError }) : t("design.preview.copied"));
    } catch (error) { report(error); }
  };
  const startCapture = async () => {
    setStatus(t("design.preview.capturing"));
    try {
      const result = await requestCapture("viewport");
      if (latestRef.current.sessionId !== sessionId) return;
      setCapture(result.dataUrl); setAnnotations([]); setTextDraft(null); setFeedbackText(""); setStatus(result.clipboardError ?? "");
    } catch (error) { report(error); }
  };
  const closeCapture = () => {
    const image = capture;
    if (!image) return;
    resultImageRef.current = image;
    resultAnnotationsRef.current = annotations;
    resultFeedbackRef.current = feedbackText;
    setCapture(null);
    void previewResultShow(image, t("design.preview.annotationReady"), annotations.length).catch(report);
  };
  const sendFeedback = async () => {
    const image = capture;
    if (!image) return;
    if (await submitFeedback(image, annotations, feedbackText)) closeCapture();
  };

  const point = (e: ReactPointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100 };
  };
  const commitTextDraft = (draft = textDraft) => {
    const text = draft?.text.trim();
    if (draft && text) setAnnotations((all) => [...all, { kind: "text", x: draft.x, y: draft.y, text }]);
    setTextDraft(null);
  };
  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    const p = point(e);
    if (tool === "text") {
      setTextDraft({ ...p, text: "" });
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    const next: DrawingAnnotation = tool === "rect" ? { kind: "rect", ...p, width: 0, height: 0 } : { kind: "pen", points: [p] };
    drawing.current = next;
    setDrawingAnnotation(next);
  };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const current = drawing.current;
    if (!current) return;
    const p = point(e);
    const next: DrawingAnnotation = current.kind === "rect"
      ? { ...current, width: p.x - current.x, height: p.y - current.y }
      : { ...current, points: [...current.points, p] };
    drawing.current = next;
    setDrawingAnnotation(next);
  };
  const onPointerCancel = () => {
    drawing.current = null;
    setDrawingAnnotation(null);
  };
  const onPointerUp = () => {
    if (!drawing.current) return;
    const next = drawing.current; drawing.current = null;
    setDrawingAnnotation(null);
    setAnnotations((all) => [...all, next]);
  };

  const previewTarget = target.kind === "artifact" ? target.path : address;
  const submitElementComment = async () => {
    if (!picked || !commentText.trim() || feedbackSendingRef.current) return;
    const request = ++commentRequestRef.current;
    const selected = picked;
    const selectedTarget = latestRef.current.targetKey;
    feedbackSendingRef.current = true;
    setFeedbackSending(true);
    try {
      const text = [
        t("design.preview.commentPrompt"),
        `${target.kind === "artifact" ? t("design.preview.filePath") : "URL"}: ${previewTarget}`,
        `${t("design.preview.elementSelector")}: ${picked.selector}`,
        `${t("design.preview.elementTag")}: ${picked.tag}`,
        `${t("design.preview.commentContent")}: ${commentText.trim()}`,
      ].join("\n");
      const accepted = await composer.sendWithFiles(text, [new File([JSON.stringify({ target: previewTarget, comment: commentText.trim(), element: picked }, null, 2)], "element-comment.json", { type: "application/json" })]);
      if (commentRequestRef.current !== request || pickedRef.current !== selected || latestRef.current.targetKey !== selectedTarget) return;
      if (!accepted) { setStatus(t("design.preview.feedbackFailed")); return; }
      setPicked(null); setCommentText(""); setPickerPurpose(null); setStatus(t("design.preview.commentSent"));
    } catch (error) {
      if (commentRequestRef.current === request && pickedRef.current === selected && latestRef.current.targetKey === selectedTarget) report(error);
    }
    finally { feedbackSendingRef.current = false; setFeedbackSending(false); }
  };
  const applyEdit = async () => {
    if (!picked) return;
    try { await previewElementApply({ selector: picked.selector, property, value: property === "delete" ? "" : value }); setStatus(t("design.preview.applied")); }
    catch (error) { report(error); }
  };
  const selectedPreviewPosition = (() => {
    const hostRect = hostRef.current?.getBoundingClientRect();
    const overlayRect = overlayRef.current?.getBoundingClientRect();
    return {
      left: (hostRect?.left ?? 0) - (overlayRect?.left ?? 0),
      top: (hostRect?.top ?? 0) - (overlayRect?.top ?? 0),
      width: hostRect?.width ?? 0,
      height: hostRect?.height ?? 0,
    };
  })();
  const selectedElementPosition = {
    left: selectedPreviewPosition.left + (picked?.bounds.x ?? 0),
    top: selectedPreviewPosition.top + (picked?.bounds.y ?? 0) + (picked?.bounds.height ?? 0) + 8,
  };
  const overlayWidth = overlayRef.current?.getBoundingClientRect().width ?? 0;
  const selectedElementDialogWidth = Math.min(352, Math.max(0, overlayWidth - 24));
  const selectedElementDialogLeft = Math.max(12, overlayWidth > 0
    ? Math.min(selectedElementPosition.left, overlayWidth - selectedElementDialogWidth - 12)
    : selectedElementPosition.left);

  return (
    <aside ref={paneRef} aria-label={t("design.preview.workbench")} style={{ width: paneWidth }} className="relative flex min-w-80 shrink-0 flex-col border-s border-base-300 bg-base-100">
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("design.preview.resize")}
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
        <button aria-label={t("design.preview.chooseFile")} className="btn btn-ghost btn-square btn-xs" onClick={() => { const open = !filesOpen; setFilesOpen(open); if (open && previewFiles === null) void loadFiles(); }}><IconFolder size={14} /></button>
        {target.kind === "localhost" ? <>
          <IconBrowser size={15} stroke={1.75} className="shrink-0 text-base-content/50" aria-hidden />
          <input aria-label={t("design.preview.address")} className="input input-xs min-w-24 flex-1 font-mono" value={address} onChange={(e) => setAddress(e.target.value)} onKeyDown={(e) => e.key === "Enter" && navigate()} />
          <button className="btn btn-ghost btn-square btn-xs" title={t("design.preview.navigate")} onClick={navigate}>→</button>
          <button className="btn btn-ghost btn-square btn-xs" title={t("design.preview.reload")} onClick={() => void previewReload().catch(report)}><IconRefresh size={14} stroke={1.75} /></button>
        </> : <>
          <span className="min-w-0 flex-1 truncate font-mono text-xs" title={target.kind === "artifact" ? target.path : ""}>{target.kind === "artifact" ? target.path : ""}</span>
          {target.kind === "artifact" && target.artifactKind === "html" && <button className="btn btn-ghost btn-square btn-xs" title={t("design.preview.reload")} onClick={() => void previewReload().catch(report)}><IconRefresh size={14} stroke={1.75} /></button>}
        </>}
        <button className="btn btn-ghost btn-square btn-xs" title={t("design.preview.close")} onClick={onClose}><IconX size={14} stroke={1.75} /></button>
        {filesOpen && <div className="absolute inset-x-2 top-10 z-40 max-h-72 overflow-auto rounded-box border border-base-300 bg-base-100 p-2 shadow-lg">
          <div className="flex gap-1"><input autoFocus aria-label={t("design.preview.searchFiles")} className="input input-xs min-w-0 flex-1" placeholder={t("design.preview.searchPlaceholder")} value={fileQuery} onChange={(e) => setFileQuery(e.target.value)} /><button className="btn btn-ghost btn-xs" disabled={filesLoading} onClick={() => void loadFiles()}><IconRefresh size={13} /> {t("design.preview.refresh")}</button></div>
          {filesTruncated && <p className="py-1 text-xs text-warning">{t("design.preview.truncated")}</p>}
          <div className="mt-1 flex flex-col">{visibleFiles.map((file) => <button key={file.path} className="btn btn-ghost btn-sm h-auto min-h-8 justify-start font-mono text-xs" title={file.path} onClick={() => { elementSelectionRef.current += 1; setPicked(null); setPickedPreview(null); setTarget(targetForFile(file)); setFilesOpen(false); }}>{file.path}</button>)}</div>
          {!filesLoading && visibleFiles.length === 0 && <p className="p-2 text-xs text-base-content/60">{t("design.preview.empty")}</p>}
        </div>}
      </div>
      {native && <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-1 border-b border-base-300 px-2 py-1">
        {Object.entries(PRESETS).map(([name]) => {
          const Icon = name === "desktop" ? IconDeviceDesktop : name === "tablet" ? IconDeviceTablet : IconDeviceMobile;
          const label = t(`design.preview.device.${name}` as MessageKey);
          return <button key={name} className={`btn btn-square btn-xs ${preset === name ? "btn-active" : "btn-ghost"}`} title={label} aria-label={label} onClick={() => setPreset(name as keyof typeof PRESETS)}><Icon size={14} stroke={1.75} /></button>;
        })}
        <div role="tablist" className="tabs tabs-box tabs-xs ms-1">
          <button role="tab" className={`tab ${tab === "preview" ? "tab-active" : ""}`} onClick={() => { setTab("preview"); requestAnimationFrame(() => void previewShow().then(bounds).catch(report)); }}>{t("design.preview.tab.preview")}</button>
          <button role="tab" className={`tab ${tab === "code" ? "tab-active" : ""}`} onClick={() => void serialize()}><IconCode size={12} stroke={1.75} /> {t("design.preview.tab.code")}</button>
        </div>
        <button className="btn btn-ghost btn-xs ms-auto" onClick={() => void takeScreenshot()}><IconCamera size={13} stroke={1.75} /> {t("design.preview.screenshot")}</button>
        <button className={`btn btn-xs ${picker && pickerPurpose === "comment" ? "btn-primary" : "btn-ghost"}`} onClick={() => void togglePicker("comment")}><IconMessage size={13} stroke={1.75} /> {t("design.preview.annotate")}</button>
        <button className="btn btn-ghost btn-xs" onClick={() => void startCapture()}><IconPencil size={13} stroke={1.75} /> {t("design.preview.mark")}</button>
        <button className={`btn btn-xs ${picker && pickerPurpose === "edit" ? "btn-primary" : "btn-ghost"}`} onClick={() => void togglePicker("edit")}><IconPointer size={13} stroke={1.75} /> {t("design.preview.edit")}</button>
        <select aria-label={t("design.preview.zoom")} className="select select-xs w-20" value={zoom} onChange={(e) => { const n = Math.min(500, Math.max(10, Number(e.target.value))); setZoom(n); void previewSetZoom(n / 100).catch(report); }}>
          {[10, 25, 50, 75, 100, 125, 150, 200, 300, 400, 500].map((n) => <option key={n} value={n}>{n}%</option>)}
        </select>
      </div>}
      {status && <div role="status" className="shrink-0 border-b border-base-300 px-3 py-1 text-xs text-base-content/60">{status}</div>}
      <div ref={overlayRef} className="relative min-h-0 flex-1 overflow-hidden bg-base-200">
        {target.kind === "artifact" && target.artifactKind !== "html" ? (
          artifact?.kind === "image" ? <div className="flex size-full items-center justify-center overflow-auto p-2"><img src={artifact.dataUrl} alt={artifact.path} className="max-h-full max-w-full" /></div>
          : artifact?.kind === "text" ? <div className="size-full overflow-auto"><CodeView path={artifact.path} text={artifact.content} /></div>
          : null
        ) : tab === "preview" ? (
          <div className="flex size-full justify-center overflow-auto p-2">
            <div ref={hostRef} data-preview-host="" style={{ width: preset === "desktop" ? "100%" : `min(100%, ${PRESETS[preset]}px)` }} className="h-full min-w-40 bg-base-100" />
          </div>
        ) : (
          <div className="flex size-full flex-col gap-2 p-2">
            <textarea aria-label={t("design.preview.code.html")} wrap="off" className="textarea size-full min-h-0 min-w-0 flex-1 resize-none overflow-auto whitespace-pre font-mono text-xs" value={html} onChange={(e) => setHtml(e.target.value)} />
            <div className="flex gap-2">
              <input aria-label={t("design.preview.code.path")} className="input input-sm min-w-0 flex-1 font-mono" value={savePath} onChange={(e) => setSavePath(e.target.value)} />
              <button className="btn btn-primary btn-sm" onClick={() => void previewSaveHtml(sessionId, savePath, html).then(() => setStatus(t("design.preview.code.saved", { path: savePath })), report)}>{t("design.preview.code.save")}</button>
            </div>
          </div>
        )}
        {picked && (
          <div className="absolute inset-0 z-10 pointer-events-none">
          {pickedPreview && <img src={pickedPreview} alt="" className="absolute object-fill" style={selectedPreviewPosition} />}
          <div
            role="dialog"
            aria-label={t("design.preview.element")}
            className="pointer-events-auto absolute max-h-[calc(100%-1.5rem)] w-[352px] max-w-[calc(100%-1.5rem)] overflow-auto rounded-box border border-primary/25 bg-base-100 p-4 shadow-2xl ring-1 ring-primary/10"
            style={{ left: selectedElementDialogLeft, top: Math.max(12, selectedElementPosition.top) }}
          >
            <div className="flex items-start gap-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-field bg-primary/12 text-primary">
                {pickerPurpose === "comment" ? <IconMessage size={16} stroke={1.8} /> : <IconPointer size={16} stroke={1.8} />}
              </div>
              <div className="min-w-0 flex-1">
                <span className="text-xs font-medium text-base-content/60">{t("design.preview.element")}</span>
                <div className="mt-1 min-w-0">
                  <strong className="block truncate rounded-field bg-primary/10 px-1.5 py-0.5 font-mono text-xs font-medium text-primary" title={picked.selector}>{picked.tag} · {picked.selector}</strong>
                </div>
              </div>
              <button aria-label={t("design.preview.close")} className="btn btn-ghost btn-square btn-xs -me-1 -mt-1 hover:bg-primary/10 hover:text-primary" onClick={() => { setPicked(null); setPickedPreview(null); }}><IconX size={14} /></button>
            </div>
            <dl className="mt-3 grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-2 gap-y-1.5 rounded-box border border-base-300 bg-base-200/60 px-3 py-2.5 text-xs">
              <dt className="text-base-content/50">{t("design.preview.elementSize")}</dt>
              <dd className="font-medium">{Math.round(picked.bounds.width)}×{Math.round(picked.bounds.height)}</dd>
              <dt className="text-base-content/50">{t("design.preview.elementText")}</dt>
              <dd className="truncate font-medium" title={picked.text}>{picked.text || "—"}</dd>
            </dl>
            {pickerPurpose === "comment" ? <>
              <label className="mt-3 block text-xs font-medium text-base-content/70">
                <span>{t("design.preview.commentContent")}</span>
                <textarea autoFocus aria-label={t("design.preview.commentContent")} placeholder={t("design.preview.commentPlaceholder")} className="textarea mt-1.5 min-h-24 w-full resize-none border-base-300 bg-base-100 text-sm leading-5 transition-[border-color,box-shadow] placeholder:text-base-content/35 focus:border-primary focus:outline-none focus:shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-primary)_15%,transparent)]" value={commentText} onChange={(e) => setCommentText(e.target.value)} />
              </label>
              <div className="mt-3 flex justify-end border-t border-base-300 pt-3"><button className="btn btn-primary btn-sm min-w-28" disabled={feedbackSending || !commentText.trim()} onClick={() => void submitElementComment()}><IconSend size={14} /> {t("design.preview.sendComment")}</button></div>
            </> : <>
              <select aria-label={t("design.preview.elementProperty")} className="select select-sm mt-3 w-full" value={property} onChange={(e) => { setProperty(e.target.value); setValue(e.target.value === "text" ? picked.text : ""); }}>
                <option value="text">{t("design.preview.property.text")}</option><option value="color">{t("design.preview.property.color")}</option><option value="backgroundColor">{t("design.preview.property.background")}</option><option value="fontSize">{t("design.preview.property.fontSize")}</option><option value="opacity">{t("design.preview.property.opacity")}</option><option value="borderRadius">{t("design.preview.property.borderRadius")}</option><option value="delete">{t("design.preview.property.delete")}</option>
              </select>
              {property !== "delete" && <textarea aria-label={t("design.preview.elementValue")} className="textarea textarea-sm mt-2 w-full" value={value} onChange={(e) => setValue(e.target.value)} />}
              <div className="mt-2 flex gap-2"><button className="btn btn-primary btn-sm" onClick={() => void applyEdit()}>{t("design.preview.apply")}</button><button className="btn btn-ghost btn-sm" onClick={() => void previewElementUndo().catch(report)}><IconArrowBackUp size={14} /> {t("design.preview.undo")}</button></div>
            </>}
          </div>
          </div>
        )}
        {capture && (
          <div className="absolute inset-0 z-20 flex flex-col bg-base-200 p-2">
            <div className="flex shrink-0 flex-wrap items-center gap-1 pb-2">
              {([['rect', IconSquare], ['pen', IconPencil], ['text', IconCode]] as const).map(([name, Icon]) => <button key={name} className={`btn btn-xs ${tool === name ? "btn-active" : "btn-ghost"}`} onClick={() => { setTool(name); setTextDraft(null); }}><Icon size={13} /> {t(`design.preview.capture.${name}` as MessageKey)}</button>)}
              <button className="btn btn-ghost btn-xs ms-auto" onClick={() => setAnnotations((a) => a.slice(0, -1))}><IconArrowBackUp size={13} /> {t("design.preview.undo")}</button>
              <button className="btn btn-ghost btn-xs" onClick={() => setAnnotations([])}><IconTrash size={13} /> {t("design.preview.capture.clear")}</button>
              <button className="btn btn-ghost btn-xs" onClick={() => void downloadAnnotated(capture, annotations).catch(report)}><IconDownload size={13} /> {t("design.preview.capture.download")}</button>
              <button aria-label={t("design.preview.closeCapture")} className="btn btn-ghost btn-square btn-xs" onClick={closeCapture}><IconX size={13} /></button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto rounded-box bg-base-300/40 p-1">
              <div className="relative w-fit max-w-full">
                <img src={capture} alt={t("design.preview.capture.image")} className="block max-w-full select-none" draggable={false} />
                <svg aria-label={t("design.preview.capture.surface")} className="absolute inset-0 size-full touch-none" viewBox="0 0 100 100" preserveAspectRatio="none" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel}>
                  {[...annotations, ...(drawingAnnotation ? [drawingAnnotation] : [])].map((a, i) => a.kind === "rect" ? <rect key={i} x={Math.min(a.x, a.x + a.width)} y={Math.min(a.y, a.y + a.height)} width={Math.abs(a.width)} height={Math.abs(a.height)} fill="none" stroke="red" strokeWidth="0.5" /> : a.kind === "pen" ? <polyline key={i} points={a.points.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke="red" strokeWidth="0.6" /> : <text key={i} x={a.x} y={a.y} fill="red" fontSize="3">{a.text}</text>)}
                </svg>
                {textDraft && <input
                  autoFocus
                  aria-label={t("design.preview.capture.textInput")}
                  className="input input-sm absolute z-10 min-w-40 border-error bg-base-100/95 text-error shadow-lg focus:outline-none"
                  style={{ left: `${textDraft.x}%`, top: `${textDraft.y}%`, transform: "translateY(-50%)" }}
                  value={textDraft.text}
                  onChange={(e) => setTextDraft((draft) => draft ? { ...draft, text: e.target.value } : null)}
                  onBlur={(e) => { if (e.currentTarget.dataset.cancelled !== "true") commitTextDraft(); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); commitTextDraft(); }
                    if (e.key === "Escape") { e.currentTarget.dataset.cancelled = "true"; setTextDraft(null); }
                  }}
                />}
              </div>
            </div>
            <div className="mt-2 flex shrink-0 items-end gap-2 rounded-box border border-base-300 bg-base-100 p-2 shadow-sm transition-[border-color,box-shadow] focus-within:border-primary focus-within:shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-primary)_12%,transparent)]">
              <textarea
                aria-label={t("design.preview.capture.feedbackInput")}
                placeholder={t("design.preview.capture.feedbackPlaceholder")}
                className="min-h-10 max-h-28 min-w-0 flex-1 resize-none bg-transparent px-1 py-2 text-sm leading-5 outline-none placeholder:text-base-content/35"
                value={feedbackText}
                onChange={(e) => setFeedbackText(e.target.value)}
              />
              <button aria-label={t("design.preview.capture.send")} className="btn btn-primary btn-circle btn-sm shrink-0" disabled={feedbackSending} onClick={() => void sendFeedback()}><IconSend size={15} /></button>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
