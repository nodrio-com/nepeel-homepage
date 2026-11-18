import {
  emptyCaptureContext,
  type CaptureContext,
  type PlaceAudience,
} from "./capture-context";

// A reference guides composition only. Nearby discovery is never publication consent.
export function newPhotoCaptureContext(
  referencePostId: string | null = null,
): CaptureContext {
  return { ...emptyCaptureContext(), referencePostId };
}

export interface PhotoLocationRequest {
  readonly photoId: string;
  readonly audience: PlaceAudience;
}

// Consent belongs to one photographed draft and one explicit location action.
export class CaptureLocationConsent {
  private photoId: string | null = null;
  private currentRequest: PhotoLocationRequest | null = null;

  startPhoto(photoId: string | null) {
    this.photoId = photoId;
    this.cancel();
  }

  request(
    photoId: string,
    audience: PlaceAudience = "followers",
  ): PhotoLocationRequest | null {
    if (this.photoId !== photoId) return null;
    this.currentRequest = { photoId, audience };
    return this.currentRequest;
  }

  accepts(request: PhotoLocationRequest | null) {
    return (
      request !== null &&
      request === this.currentRequest &&
      request.photoId === this.photoId &&
      this.photoId !== null
    );
  }

  cancel() {
    this.currentRequest = null;
  }
}
