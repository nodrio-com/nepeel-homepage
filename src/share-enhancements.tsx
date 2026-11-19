import { createRoot } from "react-dom/client";
import { isTapePosition } from "../shared/capture-context";

const images = document.querySelectorAll<HTMLImageElement>("img[data-share-tape]");
if (images.length) {
  void import("./components/TapedPhoto").then(({ TapeOverlay }) => {
    for (const image of images) {
      const position = image.dataset.shareTape;
      const figure = image.closest("figure");
      if (!figure || !isTapePosition(position)) continue;
      const mount = () => {
        if (!image.naturalWidth || !image.naturalHeight) return;
        const overlay = document.createElement("span");
        overlay.className = "taped-photo";
        overlay.dataset.fit = "contain";
        figure.classList.add("share-taped-figure");
        image.after(overlay);
        createRoot(overlay).render(<TapeOverlay position={position} ratio={image.naturalWidth / image.naturalHeight}
          focusTarget={() => image} />);
      };
      if (image.complete) mount();
      else image.addEventListener("load", mount, { once: true });
    }
  }).catch(() => { /* The server-rendered photo is already visible. */ });
}

const captions = document.querySelectorAll<HTMLElement>("figcaption[data-share-caption]");
if (captions.length) {
  void import("./components/TranslatedText").then(({ TranslatedText }) => {
    for (const caption of captions) {
      const text = caption.textContent;
      if (text) createRoot(caption).render(<TranslatedText text={text} />);
    }
  }).catch(() => { /* Keep the original caption when the optional module cannot load. */ });
}
