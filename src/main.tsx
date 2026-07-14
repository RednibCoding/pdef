import "./pdfjs-compat";
import React, { ChangeEvent, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Download, FileText, ImagePlus, Loader2, RotateCcw, Trash2, Upload, X } from "lucide-react";
import { degrees, PDFDocument, PDFImage, StandardFonts, rgb } from "pdf-lib";
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
  fontName: string;
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

type ImageKind = "png" | "jpg";

type PlacedImage = {
  id: string;
  pageIndex: number;
  name: string;
  dataUrl: string;
  kind: ImageKind;
  left: number;
  top: number;
  width: number;
  height: number;
};

type PendingImage = Pick<PlacedImage, "name" | "dataUrl" | "kind"> & {
  naturalWidth: number;
  naturalHeight: number;
};

type FormField = {
  id: string;
  pageIndex: number;
  name: string;
  type: "text" | "checkbox";
  value: string | boolean;
  originalValue: string | boolean;
  left: number;
  top: number;
  width: number;
  height: number;
  fontSize: number;
  maxLength?: number;
  multiline?: boolean;
  comb?: boolean;
  textAlignment?: "left" | "center" | "right";
};

type RenderedPage = {
  pageIndex: number;
  imageUrl: string;
  width: number;
  height: number;
  viewportTransform: number[];
  boxes: TextBox[];
  images: PlacedImage[];
  formFields: FormField[];
  formWidgetCount: number;
};

function App() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(() => getStoredSidebarWidth());
  const [fileName, setFileName] = useState("");
  const [fileBytes, setFileBytes] = useState<Uint8Array | null>(null);
  const [pages, setPages] = useState<RenderedPage[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [pendingImage, setPendingImage] = useState<PendingImage | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDraggingPdf, setIsDraggingPdf] = useState(false);
  const [status, setStatus] = useState("");

  const boxesByPage = useMemo(
    () => pages.map((page) => page.boxes.filter((box) => box.text !== box.original)),
    [pages],
  );
  const editedCount = boxesByPage.reduce((total, pageBoxes) => total + pageBoxes.length, 0);
  const imageCount = pages.reduce((total, page) => total + page.images.length, 0);
  const formWidgetCount = pages.reduce((total, page) => total + page.formWidgetCount, 0);
  const formEditsByName = useMemo(() => {
    const edits = new Map<string, FormField>();
    pages.forEach((page) => {
      page.formFields.forEach((field) => {
        if (field.value !== field.originalValue) edits.set(field.name, field);
      });
    });
    return edits;
  }, [pages]);
  const formEditCount = formEditsByName.size;
  const selectedBox = pages.flatMap((page) => page.boxes).find((box) => box.id === selectedId);
  const selectedImage = pages.flatMap((page) => page.images).find((image) => image.id === selectedImageId);

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
    setSelectedImageId(null);
    setPendingImage(null);

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
        const annotations = await page.getAnnotations({ intent: "display" });
        const formFields = makeFormFields(annotations, pageIndex, viewport);

        renderedPages.push({
          pageIndex,
          imageUrl: canvas.toDataURL("image/png"),
          width: viewport.width,
          height: viewport.height,
          viewportTransform: [...viewport.transform],
          boxes,
          images: [],
          formFields,
          formWidgetCount: annotations.filter((annotation) => annotation.subtype === "Widget" && annotation.fieldType).length,
        });
      }

      setFileName(file.name);
      setFileBytes(bytes);
      setPages(renderedPages);
      const fieldCount = renderedPages.reduce((total, page) => total + page.formFields.length, 0);
      setStatus(
        `${pdf.numPages} page${pdf.numPages === 1 ? "" : "s"}${fieldCount ? ` · ${fieldCount} fillable field${fieldCount === 1 ? "" : "s"}` : ""}`,
      );
    } catch (error) {
      setFileBytes(null);
      setPages([]);
      setStatus(error instanceof Error ? error.message : "Could not read the PDF");
    } finally {
      setIsLoading(false);
    }
  }

  async function chooseImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) {
      await prepareImage(file);
    }
    event.target.value = "";
  }

  async function prepareImage(file: File) {
    if (!file.type.startsWith("image/")) {
      setStatus("Choose an image file");
      return;
    }

    setStatus("Reading image");

    try {
      const image = await readLocalImage(file);
      setPendingImage(image);
      setSelectedId(null);
      setSelectedImageId(null);
      setStatus("Click a page to place the image");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not read the image");
    }
  }

  function handleDragOver(event: React.DragEvent<HTMLElement>) {
    if (hasPdfFile(event.dataTransfer) || (fileBytes && hasImageFile(event.dataTransfer))) {
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
      return;
    }

    const imageFile = Array.from(event.dataTransfer.files).find((droppedFile) => droppedFile.type.startsWith("image/"));
    if (imageFile && fileBytes) {
      await prepareImage(imageFile);
    } else {
      setStatus(fileBytes ? "Drop a PDF or image file" : "Drop a PDF file");
    }
  }

  function placePendingImage(event: React.MouseEvent<HTMLElement>, page: RenderedPage) {
    if (!pendingImage) return;

    const pageRect = event.currentTarget.getBoundingClientRect();
    const maxWidth = page.width * 0.4;
    const maxHeight = page.height * 0.4;
    const scale = Math.min(1, maxWidth / pendingImage.naturalWidth, maxHeight / pendingImage.naturalHeight);
    const width = pendingImage.naturalWidth * scale;
    const height = pendingImage.naturalHeight * scale;
    const left = clamp(event.clientX - pageRect.left - width / 2, 0, page.width - width);
    const top = clamp(event.clientY - pageRect.top - height / 2, 0, page.height - height);
    const id = `image-${crypto.randomUUID()}`;
    const placedImage: PlacedImage = {
      id,
      pageIndex: page.pageIndex,
      name: pendingImage.name,
      dataUrl: pendingImage.dataUrl,
      kind: pendingImage.kind,
      left,
      top,
      width,
      height,
    };

    setPages((currentPages) =>
      currentPages.map((currentPage) =>
        currentPage.pageIndex === page.pageIndex
          ? { ...currentPage, images: [...currentPage.images, placedImage] }
          : currentPage,
      ),
    );
    setPendingImage(null);
    setSelectedImageId(id);
    setSelectedId(null);
    setStatus("Image added — drag to move, use the corners to resize");
  }

  function updateImage(id: string, changes: Partial<Pick<PlacedImage, "left" | "top" | "width" | "height">>) {
    setPages((currentPages) =>
      currentPages.map((page) => ({
        ...page,
        images: page.images.map((image) => (image.id === id ? { ...image, ...changes } : image)),
      })),
    );
  }

  function startImageMove(event: React.PointerEvent<HTMLDivElement>, image: PlacedImage, page: RenderedPage) {
    if (pendingImage || (event.target as HTMLElement).classList.contains("imageResizeHandle")) return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedImageId(image.id);
    setSelectedId(null);
    const startX = event.clientX;
    const startY = event.clientY;
    const startLeft = image.left;
    const startTop = image.top;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      updateImage(image.id, {
        left: clamp(startLeft + moveEvent.clientX - startX, 0, page.width - image.width),
        top: clamp(startTop + moveEvent.clientY - startY, 0, page.height - image.height),
      });
    };

    const handlePointerUp = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
  }

  function startImageResize(
    event: React.PointerEvent<HTMLButtonElement>,
    image: PlacedImage,
    page: RenderedPage,
    corner: "nw" | "ne" | "sw" | "se",
  ) {
    event.preventDefault();
    event.stopPropagation();
    setSelectedImageId(image.id);
    setSelectedId(null);
    const pageRect = event.currentTarget.closest(".pageFrame")!.getBoundingClientRect();
    const isEast = corner.endsWith("e");
    const isSouth = corner.startsWith("s");
    const anchorX = isEast ? image.left : image.left + image.width;
    const anchorY = isSouth ? image.top : image.top + image.height;
    const aspectRatio = image.width / image.height;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const pointerX = moveEvent.clientX - pageRect.left;
      const pointerY = moveEvent.clientY - pageRect.top;
      const widthFromX = (isEast ? 1 : -1) * (pointerX - anchorX);
      const widthFromY = (isSouth ? 1 : -1) * (pointerY - anchorY) * aspectRatio;
      const desiredWidth =
        Math.abs(widthFromX - image.width) >= Math.abs(widthFromY - image.width) ? widthFromX : widthFromY;
      const maxWidthFromX = isEast ? page.width - anchorX : anchorX;
      const maxHeightFromY = isSouth ? page.height - anchorY : anchorY;
      const maxWidth = Math.min(maxWidthFromX, maxHeightFromY * aspectRatio);
      const width = clamp(desiredWidth, Math.min(24, maxWidth), maxWidth);
      const height = width / aspectRatio;

      updateImage(image.id, {
        left: isEast ? anchorX : anchorX - width,
        top: isSouth ? anchorY : anchorY - height,
        width,
        height,
      });
    };

    const handlePointerUp = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
  }

  function removeSelectedImage() {
    if (!selectedImageId) return;
    setPages((currentPages) =>
      currentPages.map((page) => ({ ...page, images: page.images.filter((image) => image.id !== selectedImageId) })),
    );
    setSelectedImageId(null);
    setStatus("Image removed");
  }

  function cancelImagePlacement() {
    setPendingImage(null);
    setStatus(`${pages.length} page${pages.length === 1 ? "" : "s"}`);
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

  function updateFormField(name: string, value: string | boolean) {
    setPages((currentPages) =>
      currentPages.map((page) => ({
        ...page,
        formFields: page.formFields.map((field) => (field.name === name ? { ...field, value } : field)),
      })),
    );
  }

  async function downloadPdf() {
    if (!fileBytes) return;
    setIsSaving(true);
    setStatus("Writing PDF");

    try {
      const pdfDoc = await PDFDocument.load(fileBytes.slice());

      const form = formEditCount > 0 || (imageCount > 0 && formWidgetCount > 0) ? pdfDoc.getForm() : null;
      if (form && formEditCount > 0) {
        formEditsByName.forEach((field) => {
          if (field.type === "text") {
            form.getTextField(field.name).setText(String(field.value));
          } else {
            const checkBox = form.getCheckBox(field.name);
            if (field.value) checkBox.check();
            else checkBox.uncheck();
          }
        });
      }

      // Form widgets are annotations, so PDF readers paint them above normal
      // page content. Flatten them first to keep signature-field backgrounds
      // behind images that the user places on the page.
      if (imageCount > 0 && form) {
        if (form.getFields().length > 0) {
          const widgetRefs = form
            .getFields()
            .flatMap((field) =>
              field.acroField.getWidgets().map((widget) => pdfDoc.context.getObjectRef(widget.dict)),
            );
          form.flatten();

          // pdf-lib 1.17 can leave deleted widget refs in a page's /Annots
          // array after flattening. Remove those refs so strict readers do not
          // report a broken cross-reference.
          pdfDoc.getPages().forEach((page) => {
            widgetRefs.forEach((widgetRef) => {
              if (widgetRef) page.node.removeAnnot(widgetRef);
            });
          });
        }
      }

      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const embeddedImages = new Map<string, PDFImage>();

      for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
        const pageBoxes = boxesByPage[pageIndex];
        const renderedPage = pages[pageIndex];
        if (pageBoxes.length === 0 && renderedPage.images.length === 0) continue;
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

        for (const image of renderedPage.images) {
          let embeddedImage = embeddedImages.get(image.dataUrl);
          if (!embeddedImage) {
            embeddedImage =
              image.kind === "jpg" ? await pdfDoc.embedJpg(image.dataUrl) : await pdfDoc.embedPng(image.dataUrl);
            embeddedImages.set(image.dataUrl, embeddedImage);
          }

          const bottomLeft = applyInverseTransform(
            [image.left, image.top + image.height],
            renderedPage.viewportTransform,
          );
          const bottomRight = applyInverseTransform(
            [image.left + image.width, image.top + image.height],
            renderedPage.viewportTransform,
          );
          const topLeft = applyInverseTransform([image.left, image.top], renderedPage.viewportTransform);
          const pdfWidth = Math.hypot(bottomRight[0] - bottomLeft[0], bottomRight[1] - bottomLeft[1]);
          const pdfHeight = Math.hypot(topLeft[0] - bottomLeft[0], topLeft[1] - bottomLeft[1]);
          const angle = Math.atan2(bottomRight[1] - bottomLeft[1], bottomRight[0] - bottomLeft[0]);

          page.drawImage(embeddedImage, {
            x: bottomLeft[0],
            y: bottomLeft[1],
            width: pdfWidth,
            height: pdfHeight,
            rotate: degrees((angle * 180) / Math.PI),
          });
        }
      }

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
          <h1>PDF editor</h1>
        </div>

        <input ref={fileInputRef} className="hiddenInput" type="file" accept="application/pdf" onChange={loadPdf} />
        <input ref={imageInputRef} className="hiddenInput" type="file" accept="image/*" onChange={chooseImage} />

        <div className="actions">
          <button type="button" className="primaryButton" onClick={() => fileInputRef.current?.click()} disabled={isLoading}>
            {isLoading ? <Loader2 className="spin" size={18} /> : <Upload size={18} />}
            <span>{isLoading ? "Loading" : "Open PDF"}</span>
          </button>
          <button
            type="button"
            onClick={() => (pendingImage ? cancelImagePlacement() : imageInputRef.current?.click())}
            disabled={!fileBytes || isLoading}
          >
            {pendingImage ? <X size={18} /> : <ImagePlus size={18} />}
            <span>{pendingImage ? "Cancel" : "Add image"}</span>
          </button>
          <button
            type="button"
            className="downloadButton"
            onClick={downloadPdf}
            disabled={!fileBytes || isSaving || editedCount + imageCount + formEditCount === 0}
          >
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

        <section className="editorPanel" aria-label="Selection inspector">
          <div className="panelHeader">
            <span>{pendingImage ? "Place image" : selectedImage ? "Selected image" : "Selected text"}</span>
            {pendingImage ? (
              <button type="button" className="iconButton" onClick={cancelImagePlacement} aria-label="Cancel image placement">
                <X size={16} />
              </button>
            ) : selectedImage ? (
              <button type="button" className="iconButton dangerButton" onClick={removeSelectedImage} aria-label="Remove image">
                <Trash2 size={16} />
              </button>
            ) : (
              <button
                type="button"
                className="iconButton"
                onClick={() => selectedBox && resetBox(selectedBox.id)}
                disabled={!selectedBox}
                aria-label="Reset selected text"
              >
                <RotateCcw size={16} />
              </button>
            )}
          </div>
          {pendingImage || selectedImage ? (
            <div className="imageInspector">
              <img src={(pendingImage ?? selectedImage)!.dataUrl} alt="" />
              <strong>{(pendingImage ?? selectedImage)!.name}</strong>
              {pendingImage ? (
                <p>Click anywhere on a page to place this image.</p>
              ) : (
                <>
                  <span>
                    {Math.round(selectedImage!.width / RENDER_SCALE)} × {Math.round(selectedImage!.height / RENDER_SCALE)} pt
                  </span>
                  <p>Drag the image to move it. Drag a corner to resize it.</p>
                </>
              )}
            </div>
          ) : (
            <textarea
              value={selectedBox?.text ?? ""}
              onChange={(event) => selectedBox && updateBoxText(selectedBox.id, event.target.value)}
              disabled={!selectedBox}
              placeholder="Click text on the page"
            />
          )}
        </section>

        <div className="stats">
          <span>{pages.length} page{pages.length === 1 ? "" : "s"}</span>
          <span>
            {editedCount + formEditCount} edit{editedCount + formEditCount === 1 ? "" : "s"} · {imageCount} image
            {imageCount === 1 ? "" : "s"}
          </span>
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
        className={`documentStage ${isDraggingPdf ? "dragging" : ""} ${pendingImage ? "placingImage" : ""}`}
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
            <article
              className="pageFrame"
              key={page.pageIndex}
              style={{ width: page.width, height: page.height }}
              onClick={(event) => placePendingImage(event, page)}
            >
              <img className="pageBackground" src={page.imageUrl} alt={`Page ${page.pageIndex + 1}`} draggable={false} />
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
                  onClick={() => {
                    if (pendingImage) return;
                    setSelectedId(box.id);
                    setSelectedImageId(null);
                  }}
                >
                  {box.text}
                </button>
              ))}
              {page.formFields.map((field) =>
                field.type === "checkbox" ? (
                  <input
                    key={field.id}
                    type="checkbox"
                    className="formFieldOverlay formCheckbox"
                    style={{ left: field.left, top: field.top, width: field.width, height: field.height }}
                    checked={Boolean(field.value)}
                    onChange={(event) => updateFormField(field.name, event.target.checked)}
                    aria-label={field.name}
                    title={field.name}
                  />
                ) : field.multiline ? (
                  <textarea
                    key={field.id}
                    className={`formFieldOverlay formTextField ${field.comb ? "comb" : ""}`}
                    style={getFormFieldStyle(field)}
                    value={String(field.value)}
                    maxLength={field.maxLength}
                    onChange={(event) => updateFormField(field.name, event.target.value)}
                    aria-label={field.name}
                    title={field.name}
                  />
                ) : (
                  <input
                    key={field.id}
                    type="text"
                    className={`formFieldOverlay formTextField ${field.comb ? "comb" : ""}`}
                    style={getFormFieldStyle(field)}
                    value={String(field.value)}
                    maxLength={field.maxLength}
                    inputMode={field.comb ? "numeric" : undefined}
                    onChange={(event) => updateFormField(field.name, event.target.value)}
                    aria-label={field.name}
                    title={field.name}
                    spellCheck={false}
                  />
                ),
              )}
              {page.images.map((image) => (
                <div
                  key={image.id}
                  className={`imageOverlay ${image.id === selectedImageId ? "selected" : ""}`}
                  style={{ left: image.left, top: image.top, width: image.width, height: image.height }}
                  onPointerDown={(event) => startImageMove(event, image, page)}
                  onClick={() => {
                    if (pendingImage) return;
                    setSelectedImageId(image.id);
                    setSelectedId(null);
                  }}
                  role="button"
                  tabIndex={0}
                  aria-label={`Placed image: ${image.name}`}
                >
                  <img src={image.dataUrl} alt={image.name} draggable={false} />
                  {(["nw", "ne", "sw", "se"] as const).map((corner) => (
                    <button
                      key={corner}
                      type="button"
                      className={`imageResizeHandle ${corner}`}
                      aria-label={`Resize image from ${corner} corner`}
                      onPointerDown={(event) => startImageResize(event, image, page, corner)}
                    />
                  ))}
                </div>
              ))}
            </article>
          ))
        )}
      </section>
    </main>
  );
}

function makeFormFields(annotations: unknown[], pageIndex: number, viewport: pdfjs.PageViewport) {
  const fields: FormField[] = [];

  annotations.forEach((item) => {
    const annotation = item as {
      id?: string;
      subtype?: string;
      fieldType?: string;
      fieldName?: string;
      fieldValue?: string | null;
      exportValue?: string | null;
      checkBox?: boolean;
      readOnly?: boolean;
      hidden?: boolean;
      rect?: number[];
      maxLen?: number;
      multiLine?: boolean;
      comb?: boolean;
      textAlignment?: number | null;
      defaultAppearanceData?: { fontSize?: number } | null;
    };

    if (
      annotation.subtype !== "Widget" ||
      !annotation.id ||
      !annotation.fieldName ||
      !annotation.rect ||
      annotation.hidden ||
      annotation.readOnly
    ) {
      return;
    }

    const viewportRect = viewport.convertToViewportRectangle(annotation.rect);
    const left = Math.min(viewportRect[0], viewportRect[2]);
    const top = Math.min(viewportRect[1], viewportRect[3]);
    const width = Math.abs(viewportRect[2] - viewportRect[0]);
    const height = Math.abs(viewportRect[3] - viewportRect[1]);
    if (width < 2 || height < 2) return;

    if (annotation.fieldType === "Tx") {
      const value = typeof annotation.fieldValue === "string" ? annotation.fieldValue : "";
      fields.push({
        id: annotation.id,
        pageIndex,
        name: annotation.fieldName,
        type: "text",
        value,
        originalValue: value,
        left,
        top,
        width,
        height,
        fontSize: Math.max((annotation.defaultAppearanceData?.fontSize ?? 0) * RENDER_SCALE, height * 0.58, 8),
        maxLength: annotation.maxLen && annotation.maxLen > 0 ? annotation.maxLen : undefined,
        multiline: Boolean(annotation.multiLine),
        comb: Boolean(annotation.comb),
        textAlignment: annotation.textAlignment === 1 ? "center" : annotation.textAlignment === 2 ? "right" : "left",
      });
      return;
    }

    if (annotation.fieldType === "Btn" && annotation.checkBox) {
      const value = annotation.exportValue
        ? annotation.fieldValue === annotation.exportValue
        : Boolean(annotation.fieldValue && annotation.fieldValue !== "Off");
      fields.push({
        id: annotation.id,
        pageIndex,
        name: annotation.fieldName,
        type: "checkbox",
        value,
        originalValue: value,
        left,
        top,
        width,
        height,
        fontSize: height * 0.75,
      });
    }
  });

  return fields;
}

function getFormFieldStyle(field: FormField): React.CSSProperties {
  const style: React.CSSProperties = {
    left: field.left,
    top: field.top,
    width: field.width,
    height: field.height,
    fontSize: field.fontSize,
    textAlign: field.textAlignment,
  };

  if (field.comb && field.maxLength) {
    const cellWidth = field.width / field.maxLength;
    const glyphWidth = field.fontSize * 0.58;
    style.letterSpacing = Math.max(cellWidth - glyphWidth, 0);
    style.paddingLeft = Math.max((cellWidth - glyphWidth) / 2, 2);
    style.backgroundSize = `${cellWidth}px 100%`;
  }

  return style;
}

function hasPdfFile(dataTransfer: DataTransfer) {
  return Array.from(dataTransfer.items).some((item) => item.kind === "file" && (item.type === "application/pdf" || !item.type));
}

function hasImageFile(dataTransfer: DataTransfer) {
  return Array.from(dataTransfer.items).some((item) => item.kind === "file" && item.type.startsWith("image/"));
}

async function readLocalImage(file: File): Promise<PendingImage> {
  const sourceUrl = await readFileAsDataUrl(file);
  const image = await loadImage(sourceUrl);
  const lowerName = file.name.toLowerCase();
  if (image.naturalWidth < 1 || image.naturalHeight < 1) {
    throw new Error("The selected image has no usable dimensions");
  }

  if (file.type === "image/png" || lowerName.endsWith(".png")) {
    return {
      name: file.name,
      dataUrl: sourceUrl,
      kind: "png",
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
    };
  }

  if (file.type === "image/jpeg" || /\.jpe?g$/i.test(lowerName)) {
    return {
      name: file.name,
      dataUrl: sourceUrl,
      kind: "jpg",
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
    };
  }

  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable in this browser.");
  context.drawImage(image, 0, 0);

  return {
    name: file.name,
    dataUrl: canvas.toDataURL("image/png"),
    kind: "png",
    naturalWidth: image.naturalWidth,
    naturalHeight: image.naturalHeight,
  };
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("This image format is not supported by the browser"));
    image.src = url;
  });
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

function applyInverseTransform(point: [number, number], transform: number[]) {
  pdfjs.Util.applyInverseTransform(point, transform);
  return point;
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
          fontName: fragment.fontName,
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
    fontName?: string;
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
    fontName: textItem.fontName ?? "",
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
  const estimatedBoxWidth = Math.max(box.text.length * box.pdfFontSize * 0.7, box.pdfFontSize);
  const effectiveBoxWidth = Math.min(box.pdfWidth, estimatedBoxWidth * 2.5);
  const horizontalGap = fragment.pdfX - (box.pdfX + effectiveBoxWidth);
  const baselineTolerance = Math.max(1.5, box.pdfFontSize * 0.25);
  const fontTolerance = Math.max(1, box.pdfFontSize * 0.25);
  const gapTolerance = Math.max(8, box.pdfFontSize * 1.5);
  const sameFont = !box.fontName || !fragment.fontName || box.fontName === fragment.fontName;
  const whitespaceBridgeIsTooWide =
    !fragment.text.trim() && fragment.pdfWidth > Math.max(8, box.pdfFontSize * 1.5);

  return (
    sameFont &&
    !whitespaceBridgeIsTooWide &&
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
