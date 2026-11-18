import type { Connection } from "../../shared/connect";

// The app shell owns one store per signed-in account. Nothing is written to disk.
export class HiMessageDrafts {
  private drafts = new Map<string, { body: string; clientId?: string }>();
  private listeners = new Set<() => void>();
  private revision = 0;

  snapshot = () => this.revision;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  body(id: string | null) {
    return (id && this.drafts.get(id)?.body) || "";
  }

  edit(id: string, body: string) {
    const previous = this.drafts.get(id);
    if ((previous?.body ?? "") === body) return;
    if (body) {
      const clientId = previous?.body.trim() === body.trim() ? previous?.clientId : undefined;
      this.drafts.set(id, { body, clientId });
    } else {
      this.drafts.delete(id);
    }
    this.revision++;
    this.listeners.forEach(listener => listener());
  }

  prepareSend(id: string) {
    const draft = this.drafts.get(id);
    const body = draft?.body.trim();
    if (!draft || !body) return;
    draft.clientId ??= crypto.randomUUID();
    return { body, clientId: draft.clientId };
  }

  sent(id: string, clientId: string) {
    // A late acknowledgement belongs to the original submission, even after navigation.
    if (this.drafts.get(id)?.clientId === clientId) this.edit(id, "");
  }

  reconcile(items: Connection[]) {
    // A missing row can be on an older, unloaded inbox page.
    for (const item of items) {
      if (item.status !== "accepted") this.edit(item.id, "");
    }
  }
}
