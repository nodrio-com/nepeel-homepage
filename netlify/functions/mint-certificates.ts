import { runCertificateMint } from "../../server/certificate-mint.js";
import { certificateService } from "../../server/certificate-service.js";

export const config = { schedule: "*/10 * * * *" };
export default async function mintCertificates() {
  const state = await runCertificateMint(certificateService());
  return Response.json({ state });
}
