import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CertificateReader, PublicCertificateRow } from "./public-certificate.js";
import { verifyMint } from "./nft-ledger.js";

// These two opt-in synthetic fixtures share a historical test issuer. It is
// trusted only for the two exact, immutable receipts below, never for live shares.
const issuer = "rGkkKM2PPJMWTaMuuaPQQnkAcyXkVzU2HF";
const receipts = {
  "example-photo": {
    id: "55d9390d-32a2-476f-a169-092a6996bba5",
    media_kind: "photo",
    source_hash: "4465e6247241d3887863502048274a08d832d042d5866052f4cddcf09b2637f2",
    display_hash: "86f09beb2dcd14fc2d5a1f7110ec773139dee65c2c61353017a04f2fd11013ca",
    salt: "6383e45c29d9675203be97d92aa82b759175093e5f9c10b88a172397f3a6db5b",
    commitment: "2f5e7900dbe3ebf4268faa6bc48cd0ce1fbc9d5359bf3251c05f598f5e4fc56f",
    tx_hash: "38DF96131F81DC0D38BD21D2E87D264A9C000C914353E887318526FC78DE9BD1",
    token_id: "00000000ACCFEE8F53DDB9B5851788E2E069D67F896D220F0616426401561FC9",
  },
  "example-video": {
    id: "c6eed9c5-b79a-4603-b45c-fb3127381b35",
    media_kind: "video",
    source_hash: "18bffc7486c9d473ecfa351cc759f5766002671171687bd1834956559221dd96",
    display_hash: "50b71fb4825bf62bc7978bd401db28cc3724d510d1a9d5b28ad9baa8d0ec5f8c",
    salt: "669bf7c816d0048cfb523fa299c3e682217f4e835c1a9cfd2760dff7a5df2a01",
    commitment: "0bff7cb2d25c94ff1dbc48e7c595831a69028de38bb527561be772289b74557a",
    tx_hash: "DF6DE3D3CBA6035AD85B40132EB784C1DF6A2404237FA3C04B6AB7206FAD9F50",
    token_id: "00000000ACCFEE8F53DDB9B5851788E2E069D67F896D220F1CFC136501561FCA",
  },
} as const;

export function exampleReader(token: keyof typeof receipts): CertificateReader {
  const receipt = receipts[token];
  const extension = receipt.media_kind === "photo" ? "jpg" : "mp4";
  const row: PublicCertificateRow = {
    ...receipt, issuer, platform: "example", state: "minted", object_path: `${receipt.id}/media.${extension}`,
  };
  return {
    find: async () => row,
    async download() {
      const bytes = await readFile(join(process.cwd(), "server", "certificate-examples", `${receipt.media_kind}.${extension}`));
      return new Blob([new Uint8Array(bytes)]);
    },
    stillShared: async () => true,
    verifyMint: proof => verifyMint(proof, [issuer]),
  };
}
