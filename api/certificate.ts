import { publicCertificate } from "../server/public-certificate.js";

interface CertificateResponse {
  setHeader(name: string, value: string): unknown;
  status(code: number): CertificateResponse;
  end(bytes?: Buffer): unknown;
}

export default async function handler(req: { method?: string; url?: string }, res: CertificateResponse) {
  const response = await publicCertificate({
    method: req.method ?? "GET",
    url: new URL(req.url ?? "/", "https://localhost").href,
  });
  response.headers.forEach((value, key) => res.setHeader(key, value));
  return res.status(response.status).end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
}
