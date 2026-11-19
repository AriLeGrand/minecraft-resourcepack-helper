// The drawing area: one HTML canvas. It converts mouse positions to texture
// pixels, pans and zooms, and hands everything else to the controller.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../store";
import {
  cancelPending, commitPending, isBusy, pointerDown, pointerMove, pointerUp, sessionKind, setPreviewScheduler, sprayTick, updateText,
} from "./controller";
import { fileName, useEditor, viewOf, withPreview, type Tab } from "./editorStore";
import { drawScene, rasterText } from "./render";
import { focusInfo, isTypingTarget, keyBelongsToControl } from "./shortcuts";
import { cursorPoints } from "./tools";
import { panBy, pixelToScreen, screenToPixel, stepZoom, zoomAbout, zoomLabel, type View } from "./view";

export function Canvas({ tab }: { tab: Tab }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tool = useEditor((s) => s.tool);
  const options = useEditor((s) => s.options);
  const cursor = useEditor((s) => s.cursor);
  const viewport = useEditor((s) => s.viewport);
  const text = useEditor((s) => s.text);
  const setView = useEditor((s) => s.setView);
  const zoomStep = useEditor((s) => s.zoomStep);

  const [space, setSpace] = useState(false);
  const [panning, setPanning] = useState(false);
  const pan = useRef<{ x: number; y: number; view: View } | null>(null);
  const spray = useRef<number | null>(null);

  // only the document and the preview decide what is drawn: panning and zooming
  // (which replace the tab too) keep the same document, so nothing is composited again
  const doc = useMemo(() => withPreview(tab.doc, tab.preview), [tab.doc, tab.preview]);
  const view = useMemo(() => viewOf(tab, viewport), [tab, viewport]);
  const viewRef = useRef(view);
  viewRef.current = view;

  // keep the canvas as large as its area
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => useEditor.getState().setViewport(el.clientWidth, el.clientHeight);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  const panTool = tool === "hand" || space;
  const brush = useMemo(
    () => (cursor && !panTool && tool !== "zoom" && !panning ? cursorPoints(tool, options, cursor) : null),
    [cursor, tool, options, panTool, panning],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(viewport.w * dpr));
    const h = Math.max(1, Math.round(viewport.h * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    drawScene(canvas, {
      doc, view, width: viewport.w, height: viewport.h, dpr, tiled: options.tiled, symmetry: options.symmetry,
      onion: options.onionSkin, cursor: brush, region: tab.region?.rects ?? null,
    });
  }, [doc, view, viewport, options.tiled, options.symmetry, options.onionSkin, brush, tab.region]);

  // While a tool is dragged the preview is worked out once per screen refresh,
  // however many pointer events arrive in between.
  useEffect(() => {
    let frame = 0;
    let pending: (() => void) | null = null;
    setPreviewScheduler((run) => {
      pending = run;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const job = pending;
        pending = null;
        job?.();
      });
    });
    return () => {
      setPreviewScheduler(null);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  // wheel zooms about the pointer (needs a non-passive listener to stop page scrolling)
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const v = viewRef.current;
      setView(zoomAbout(v, stepZoom(v.zoom, e.deltaY < 0 ? 1 : -1), e.clientX - r.left, e.clientY - r.top));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [setView]);

  // Holding Space pans with any tool. Not while a question or the search is
  // open, not while typing, and not when Space belongs to a button or checkbox
  // that was reached with the keyboard (there it presses the control).
  useEffect(() => {
    let taken = false;
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      const app = useApp.getState();
      const target = e.target as HTMLElement | null;
      if (app.modal || app.palette || isTypingTarget(target) || keyBelongsToControl(focusInfo(target), " ")) return;
      e.preventDefault();
      taken = true;
      if (!e.repeat) setSpace(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      // only swallow the release of a press that was used for panning
      if (taken) e.preventDefault();
      taken = false;
      setSpace(false);
    };
    const blur = () => {
      taken = false;
      setSpace(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  const stopSpray = () => {
    if (spray.current !== null) window.clearInterval(spray.current);
    spray.current = null;
  };
  useEffect(() => stopSpray, []);

  const info = (e: { clientX: number; clientY: number; button: number; shiftKey: boolean; altKey: boolean }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return {
      p: screenToPixel(viewRef.current, e.clientX - r.left, e.clientY - r.top),
      button: e.button, shift: e.shiftKey, alt: e.altKey,
    };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    // leave any field that still has the focus, so shortcuts work again
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused !== document.body && !focused.classList.contains("ed-textinput")) focused.blur();
    const r = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    if (e.button === 1 || (e.button === 0 && panTool)) {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      pan.current = { x: e.clientX, y: e.clientY, view: viewRef.current };
      setPanning(true);
      return;
    }
    if (tool === "zoom" && !isBusy()) {
      const out = e.button === 2 || e.altKey;
      setView(zoomAbout(viewRef.current, stepZoom(viewRef.current.zoom, out ? -1 : 1), sx, sy));
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    pointerDown(info(e));
    if (tool === "spray" && sessionKind() === "stroke") {
      stopSpray();
      spray.current = window.setInterval(sprayTick, 60);
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (pan.current) {
      setView(panBy(pan.current.view, e.clientX - pan.current.x, e.clientY - pan.current.y));
      return;
    }
    useEditor.getState().setCursor(info(e).p);
    // the browser hands over one event per screen refresh; the positions the
    // pointer went through in between come with it, so a fast stroke loses none
    const native = e.nativeEvent;
    const parts = typeof native.getCoalescedEvents === "function" ? native.getCoalescedEvents() : [];
    if (parts.length > 1) for (const part of parts) pointerMove(info(part));
    else pointerMove(info(e));
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    stopSpray();
    if (pan.current) {
      pan.current = null;
      setPanning(false);
      return;
    }
    pointerUp(info(e));
  };

  const cursorStyle = panning ? "grabbing" : panTool ? "grab" : tool === "zoom" ? "zoom-in" : tool === "move" ? "move" : tool === "text" ? "text" : "crosshair";
  const textAt = text ? pixelToScreen(view, text.at[0], text.at[1]) : null;

  return (
    <div className="ed-canvas" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`Texture canvas: ${fileName(tab.doc.path)}, ${tab.doc.width} by ${tab.doc.height} pixels`}
        style={{ cursor: cursorStyle }}
        onPointerDown={onPointerDown}
        // a click on the canvas must not take the focus away from the text being typed
        onMouseDown={(e) => e.preventDefault()}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => { if (!pan.current) useEditor.getState().setCursor(null); }}
        onDoubleClick={() => { if (sessionKind() === "poly") commitPending(); }}
        onContextMenu={(e) => e.preventDefault()}
      />
      {text && textAt && (
        <input
          className="ed-textinput"
          autoFocus
          spellCheck={false}
          placeholder="Type, then Enter"
          value={text.value}
          style={{
            left: Math.max(4, Math.min(viewport.w - 190, textAt[0])),
            top: Math.max(4, Math.min(viewport.h - 34, textAt[1] + Math.ceil(options.textSize * 1.3) * view.zoom + 6)),
          }}
          onChange={(e) => updateText(e.target.value, rasterText(e.target.value, options.textSize))}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitPending();
            else if (e.key === "Escape") cancelPending();
            // everything typed here is text, except Ctrl+S: it goes on to the
            // editor, which finishes the text and saves
            if (!((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s")) e.stopPropagation();
          }}
          onBlur={() => commitPending()}
        />
      )}
      <div className="ed-zoom" role="group" aria-label="Zoom">
        <button aria-label="Zoom out" title="Zoom out (-)" onClick={() => zoomStep(-1)}>−</button>
        <span className="val" title="Zoom">{zoomLabel(view.zoom)}</span>
        <button aria-label="Zoom in" title="Zoom in (+)" onClick={() => zoomStep(1)}>+</button>
        <button className="fit" title="Fit the texture in the window (Ctrl+0)" onClick={() => setView(null)}>Fit</button>
      </div>
    </div>
  );
}
