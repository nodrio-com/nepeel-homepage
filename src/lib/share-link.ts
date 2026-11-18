export type LinkDelivery = "shared" | "copied" | "cancelled" | "manual";

export async function deliverMediaLink(url: string, title = "nepeel"): Promise<LinkDelivery> {
  if (typeof navigator.share === "function") {
    try {
      await navigator.share({ url, title });
      return "shared";
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return "cancelled";
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    return "copied";
  } catch {
    return "manual";
  }
}
