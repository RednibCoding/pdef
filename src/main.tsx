import "./pdfjs-compat";
import React, { ChangeEvent, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Download, FileText, Loader2, RotateCcw, Upload } from "lucide-react";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import * as pdfjs from "pdfjs-dist";
import pdfWorkerUrl from "./pdf.worker.ts?url";
import "./styles.css";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const RENDER_SCALE = 1.6;
const DEFAULT_SIDEBAR_WIDTH = 320;
const MIN_SIDEBAR_WIDTH = 260;
const MAX_SIDEBAR_WIDTH = 560;

type TextBox = {
  id: string;
  pageIndex: number;
  original: string;
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
  fontSize: number;
  pdfX: number;
  pdfY: number;
  pdfWidth: number;
  pdfHeight: number;
  pdfFontSize: number;
};

type TextFragment = Omit<TextBox, "id" | "pageIndex" | "original" | "text"> & {
  text: string;
  hasEOL: boolean;
};

type RenderedPage = {
  pageIndex: number;
  imageUrl: string;
  width: number;
  height: number;
  boxes: TextBox[];
};

function App() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(() => getStoredSidebarWidth());
  const [fileName, setFileName] = useState("");
  const [fileBytes, setFileBytes] = useState<Uint8Array | null>(null);
  const [pages, setPages] = useState<RenderedPage[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDraggingPdf, setIsDraggingPdf] = useState(false);
  const [status, setStatus] = useState("");

  const boxesByPage = useMemo(
    () => pages.map((page) => page.boxes.filter((box) => box.text !== box.original)),
    [pages],
  );
  const editedCount = boxesByPage.reduce((total, pageBoxes) => total + pageBoxes.length, 0);
  const selectedBox = pages.flatMap((page) => page.boxes).find((box) => box.id === selectedId);

  function startSidebarResize(event: React.PointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    let nextStoredWidth = sidebarWidth;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const nextWidth = clampSidebarWidth(startWidth + moveEvent.clientX - startX);
      nextStoredWidth = nextWidth;
      setSidebarWidth(nextWidth);
    };

    const handlePointerUp = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      localStorage.setItem("pdef.sidebarWidth", String(nextStoredWidth));
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
  }

  async function loadPdf(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) {
      await loadPdfFile(file);
    }
    event.target.value = "";
  }

  async function loadPdfFile(file: File) {
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setStatus("Drop a PDF file");
      return;
    }

    setIsLoading(true);
    setStatus("Reading PDF");
    setSelectedId(null);

    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const loadingTask = pdfjs.getDocument({ data: bytes.slice() });
      const pdf = await loadingTask.promise;
      const renderedPages: RenderedPage[] = [];

      for (let pageIndex = 0; pageIndex < pdf.numPages; pageIndex += 1) {
        const page = await pdf.getPage(pageIndex + 1);
        const viewport = page.getViewport({ scale: RENDER_SCALE });
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas is unavailable in this browser.");

        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({ canvas, canvasContext: context, viewport }).promise;

        const textContent = await page.getTextContent();
        const boxes = makeTextBoxes(textContent.items, pageIndex, viewport);

        renderedPages.push({
          pageIndex,
          imageUrl: canvas.toDataURL("image/png"),
          width: viewport.width,
          height: viewport.height,
          boxes,
        });
      }

      setFileName(file.name);
      setFileBytes(bytes);
      setPages(renderedPages);
      setStatus(`${pdf.numPages} page${pdf.numPages === 1 ? "" : "s"}`);
    } catch (error) {
      setFileBytes(null);
      setPages([]);
      setStatus(error instanceof Error ? error.message : "Could not read the PDF");
    } finally {
      setIsLoading(false);
    }
  }

  function handleDragOver(event: React.DragEvent<HTMLElement>) {
    if (hasPdfFile(event.dataTransfer)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setIsDraggingPdf(true);
    }
  }

  function handleDragLeave(event: React.DragEvent<HTMLElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setIsDraggingPdf(false);
    }
  }

  async function handleDrop(event: React.DragEvent<HTMLElement>) {
    event.preventDefault();
    setIsDraggingPdf(false);

    const file = Array.from(event.dataTransfer.files).find(
      (droppedFile) => droppedFile.type === "application/pdf" || droppedFile.name.toLowerCase().endsWith(".pdf"),
    );

    if (file) {
      await loadPdfFile(file);
    } else {
      setStatus("Drop a PDF file");
    }
  }

  function updateBoxText(id: string, text: string) {
    setPages((currentPages) =>
      currentPages.map((page) => ({
        ...page,
        boxes: page.boxes.map((box) => (box.id === id ? { ...box, text } : box)),
      })),
    );
  }

  function resetBox(id: string) {
    setPages((currentPages) =>
      currentPages.map((page) => ({
        ...page,
        boxes: page.boxes.map((box) => (box.id === id ? { ...box, text: box.original } : box)),
      })),
    );
  }

  async function downloadPdf() {
    if (!fileBytes) return;
    setIsSaving(true);
    setStatus("Writing PDF");

    try {
      const pdfDoc = await PDFDocument.load(fileBytes.slice());
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

      boxesByPage.forEach((pageBoxes, pageIndex) => {
        if (pageBoxes.length === 0) return;
        const page = pdfDoc.getPage(pageIndex);

        pageBoxes.forEach((box) => {
          page.drawRectangle({
            x: box.pdfX - 0.8,
            y: box.pdfY - box.pdfHeight * 0.28,
            width: Math.max(box.pdfWidth + 1.6, font.widthOfTextAtSize(box.text, box.pdfFontSize) + 1.6),
            height: box.pdfHeight,
            color: rgb(1, 1, 1),
          });

          page.drawText(box.text, {
            x: box.pdfX,
            y: box.pdfY,
            size: box.pdfFontSize,
            font,
            color: rgb(0, 0, 0),
          });
        });
      });

      const editedBytes = await pdfDoc.save();
      const blob = new Blob([new Uint8Array(editedBytes)], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName.replace(/\.pdf$/i, "") + "-edited.pdf";
      link.click();
      URL.revokeObjectURL(url);
      setStatus("Download ready");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not write the PDF");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <main className="appShell" style={{ "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}>
      <aside className="sidePanel">
        <div>
          <p className="eyebrow">Pdef</p>
          <h1>PDF text editor</h1>
        </div>

        <input ref={fileInputRef} className="hiddenInput" type="file" accept="application/pdf" onChange={loadPdf} />

        <div className="actions">
          <button type="button" className="primaryButton" onClick={() => fileInputRef.current?.click()} disabled={isLoading}>
            {isLoading ? <Loader2 className="spin" size={18} /> : <Upload size={18} />}
            <span>{isLoading ? "Loading" : "Open PDF"}</span>
          </button>
          <button type="button" onClick={downloadPdf} disabled={!fileBytes || isSaving || editedCount === 0}>
            {isSaving ? <Loader2 className="spin" size={18} /> : <Download size={18} />}
            <span>{isSaving ? "Saving" : "Download"}</span>
          </button>
        </div>

        <div className="meta">
          <FileText size={18} />
          <div>
            <strong>{fileName || "No file open"}</strong>
            <span>{status || "Open a PDF to start"}</span>
          </div>
        </div>

        <section className="editorPanel" aria-label="Selected text">
          <div className="panelHeader">
            <span>Selected text</span>
            <button type="button" className="iconButton" onClick={() => selectedBox && resetBox(selectedBox.id)} disabled={!selectedBox}>
              <RotateCcw size={16} />
            </button>
          </div>
          <textarea
            value={selectedBox?.text ?? ""}
            onChange={(event) => selectedBox && updateBoxText(selectedBox.id, event.target.value)}
            disabled={!selectedBox}
            placeholder="Click text on the page"
          />
        </section>

        <div className="stats">
          <span>{pages.length} pages</span>
          <span>{editedCount} edits</span>
        </div>

        <button
          type="button"
          className="resizeHandle"
          aria-label="Resize side panel"
          title="Resize side panel"
          onPointerDown={startSidebarResize}
        />
      </aside>

      <section
        className={`documentStage ${isDraggingPdf ? "dragging" : ""}`}
        aria-label="PDF pages"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {pages.length === 0 ? (
          <div className="emptyState">
            {isLoading ? <Loader2 className="spin" size={42} /> : <FileText size={42} />}
            <span>{isDraggingPdf ? "Drop PDF" : "Open or drop a PDF"}</span>
          </div>
        ) : (
          pages.map((page) => (
            <article className="pageFrame" key={page.pageIndex} style={{ width: page.width, height: page.height }}>
              <img src={page.imageUrl} alt={`Page ${page.pageIndex + 1}`} draggable={false} />
              {page.boxes.map((box) => (
                <button
                  key={box.id}
                  type="button"
                  className={`textHitbox ${box.id === selectedId ? "selected" : ""} ${box.text !== box.original ? "edited" : ""}`}
                  style={{
                    left: box.left,
                    top: box.top,
                    width: Math.max(box.width, estimateTextWidth(box.text, box.fontSize), 12),
                    height: Math.max(box.height, 10),
                    fontSize: Math.max(box.fontSize, 8),
                  }}
                  title={box.text}
                  onClick={() => setSelectedId(box.id)}
                >
                  {box.text}
                </button>
              ))}
            </article>
          ))
        )}
      </section>
    </main>
  );
}

function hasPdfFile(dataTransfer: DataTransfer) {
  return Array.from(dataTransfer.items).some((item) => item.kind === "file" && (item.type === "application/pdf" || !item.type));
}

function getStoredSidebarWidth() {
  const stored = Number.parseInt(localStorage.getItem("pdef.sidebarWidth") ?? "", 10);
  return clampSidebarWidth(Number.isFinite(stored) ? stored : DEFAULT_SIDEBAR_WIDTH);
}

function clampSidebarWidth(width: number) {
  return Math.min(Math.max(width, MIN_SIDEBAR_WIDTH), MAX_SIDEBAR_WIDTH);
}

function estimateTextWidth(text: string, fontSize: number) {
  return Math.max(text.length * fontSize * 0.56, fontSize);
}

function makeTextBoxes(items: unknown[], pageIndex: number, viewport: pdfjs.PageViewport) {
  const boxes: TextBox[] = [];
  let current: TextBox | null = null;
  let textBoxIndex = 0;

  const flushCurrent = () => {
    if (!current) return;
    if (current.original.trim()) {
      boxes.push(current);
      textBoxIndex += 1;
    }
    current = null;
  };

  items.forEach((item) => {
    const fragment = makeTextFragment(item, viewport);

    if (!fragment) {
      flushCurrent();
      return;
    }

    if (!current && !fragment.text.trim()) {
      return;
    }

    if (current && shouldMergeFragment(current, fragment)) {
      current = mergeTextFragment(current, fragment);
    } else {
      flushCurrent();
      if (fragment.text.trim()) {
        current = {
          id: `${pageIndex}-${textBoxIndex}`,
          pageIndex,
          original: fragment.text,
          text: fragment.text,
          left: fragment.left,
          top: fragment.top,
          width: fragment.width,
          height: fragment.height,
          fontSize: fragment.fontSize,
          pdfX: fragment.pdfX,
          pdfY: fragment.pdfY,
          pdfWidth: fragment.pdfWidth,
          pdfHeight: fragment.pdfHeight,
          pdfFontSize: fragment.pdfFontSize,
        };
      }
    }

    if (fragment.hasEOL) {
      flushCurrent();
    }
  });

  flushCurrent();
  return boxes;
}

function makeTextFragment(item: unknown, viewport: pdfjs.PageViewport): TextFragment | null {
  const textItem = item as {
    str?: string;
    hasEOL?: boolean;
    width?: number;
    height?: number;
    transform?: number[];
  };

  const text = textItem.str ?? "";
  if (!textItem.transform) return null;
  if (!text && textItem.hasEOL) return null;

  const viewportTransform = pdfjs.Util.transform(viewport.transform, textItem.transform);
  const fontSize = Math.hypot(viewportTransform[2], viewportTransform[3]);
  const pdfFontSize = Math.max(Math.hypot(textItem.transform[0], textItem.transform[1]), 4);
  const width = Math.max((textItem.width ?? 0) * RENDER_SCALE, fontSize * 0.6);
  const height = Math.max(fontSize * 1.15, 9);

  return {
    text,
    hasEOL: Boolean(textItem.hasEOL),
    left: viewportTransform[4],
    top: viewportTransform[5] - height * 0.82,
    width,
    height,
    fontSize,
    pdfX: textItem.transform[4],
    pdfY: textItem.transform[5],
    pdfWidth: Math.max(textItem.width ?? width / RENDER_SCALE, 1),
    pdfHeight: Math.max((textItem.height ?? pdfFontSize) * 1.2, pdfFontSize * 1.2),
    pdfFontSize,
  };
}

function shouldMergeFragment(box: TextBox, fragment: TextFragment) {
  const baselineDelta = Math.abs(box.pdfY - fragment.pdfY);
  const fontDelta = Math.abs(box.pdfFontSize - fragment.pdfFontSize);
  const horizontalGap = fragment.pdfX - (box.pdfX + box.pdfWidth);
  const baselineTolerance = Math.max(1.5, box.pdfFontSize * 0.25);
  const fontTolerance = Math.max(1, box.pdfFontSize * 0.25);
  const gapTolerance = Math.max(18, box.pdfFontSize * 4);

  return (
    baselineDelta <= baselineTolerance &&
    fontDelta <= fontTolerance &&
    horizontalGap <= gapTolerance &&
    fragment.pdfX >= box.pdfX - gapTolerance
  );
}

function mergeTextFragment(box: TextBox, fragment: TextFragment): TextBox {
  const left = Math.min(box.left, fragment.left);
  const top = Math.min(box.top, fragment.top);
  const right = Math.max(box.left + box.width, fragment.left + fragment.width);
  const bottom = Math.max(box.top + box.height, fragment.top + fragment.height);
  const pdfLeft = Math.min(box.pdfX, fragment.pdfX);
  const pdfRight = Math.max(box.pdfX + box.pdfWidth, fragment.pdfX + fragment.pdfWidth);

  return {
    ...box,
    original: box.original + fragment.text,
    text: box.text + fragment.text,
    left,
    top,
    width: right - left,
    height: bottom - top,
    fontSize: Math.max(box.fontSize, fragment.fontSize),
    pdfX: pdfLeft,
    pdfWidth: pdfRight - pdfLeft,
    pdfHeight: Math.max(box.pdfHeight, fragment.pdfHeight),
    pdfFontSize: Math.max(box.pdfFontSize, fragment.pdfFontSize),
  };
}

createRoot(document.getElementById("root")!).render(<App />);
