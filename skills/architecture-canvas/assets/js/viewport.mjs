export const observeViewport = (element, onResize) => {
  const viewport = window.visualViewport;
  const sync = () => {
    const width = viewport?.width ?? window.innerWidth;
    const height = viewport?.height ?? window.innerHeight;
    element.style.zoom = "1";
    element.style.width = `${width}px`;
    element.style.height = `${height}px`;
    const rect = element.getBoundingClientRect();
    const scale = Math.min(width / rect.width, height / rect.height);
    if (Math.abs(scale - 1) > 0.001) element.style.zoom = String(scale);
    onResize();
  };
  viewport?.addEventListener("resize", sync);
  new ResizeObserver(sync).observe(element);
  sync();
};
