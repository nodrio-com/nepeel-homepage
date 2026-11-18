export type LinkDelivery = "shared" | "copied" | "cancelled" | "manual";

function prefersMobileShare() {
  const agent = navigator.userAgent;
  if (/Windows NT/i.test(agent)) return false;
  return /Android|iPhone|iPad|iPod/i.test(agent)
    || (/Macintosh/i.test(agent) && navigator.maxTouchPoints > 1)
    || window.matchMedia?.("(pointer: coarse) and (hover: none)").matches === true;
}

export async function copyMediaLink(url: string): Promise<"copied" | "manual"> {
  try {
    await navigator.clipboard.writeText(url);
    return "copied";
  } catch {
    return "manual";
  }
}

export async function deliverMediaLink(url: string, title = "nepeel"): Promise<LinkDelivery> {
  if (typeof navigator.share === "function" && prefersMobileShare()) {
    try {
      const data = { url, title };
      if (!navigator.canShare || navigator.canShare(data)) {
        await navigator.share(data);
        return "shared";
      }
    } catch (error) {
      if (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError")
        return "cancelled";
    }
  }
  return copyMediaLink(url);
}
