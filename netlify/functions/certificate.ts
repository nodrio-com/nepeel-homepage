import { publicCertificate } from "../../server/public-certificate.js";

export default function certificate(request: Request): Promise<Response> {
  return publicCertificate(request);
}
