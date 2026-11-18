import {
  Wallet, convertStringToHex, decode, deriveAddress, getNFTokenID, hashes, isValidClassicAddress,
  parseNFTokenID, verifySignature, type TransactionMetadata,
} from "xrpl";

// Fixed TLS origins and disabled redirects keep the signing path on XRPL Testnet.
const TESTNET = "https://s.altnet.rippletest.net:51234/";
const CLIO = "https://clio.altnet.rippletest.net:51234/";
const WINDOW = 20;
const MAX_FEE_DROPS = 1000;
const HASH = /^[A-F0-9]{64}$/;
const COMMITMENT = /^[a-f0-9]{64}$/;
const SIGNED_FIELDS = new Set([
  "TransactionType", "Account", "NFTokenTaxon", "Flags", "URI", "Fee", "Sequence",
  "LastLedgerSequence", "SigningPubKey", "TxnSignature",
]);

export type PreparedMint = { blob: string; hash: string; lastLedger: number };
export type MintProof = { txHash: string; tokenId: string; issuer: string; commitment: string };
export type MintResult =
  | { state: "pending" }
  | { state: "expired" }
  | ({ state: "minted" } & Omit<MintProof, "commitment">);

class LedgerError extends Error {
  constructor(readonly code: string, readonly searchedAll: boolean) {
    super(`XRPL Testnet request failed (${code})`);
  }
}

async function rpc<T>(origin: typeof TESTNET | typeof CLIO, method: string, fields = {}): Promise<T> {
  const response = await fetch(origin, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(8000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, params: [{ api_version: 2, ...fields }] }),
  });
  if (!response.ok) throw new Error(`XRPL Testnet returned HTTP ${response.status}`);
  const { result } = await response.json();
  if (result?.status !== "success") {
    throw new LedgerError(result?.error || "invalidResponse", result?.searched_all === true);
  }
  return result as T;
}

function configuredIssuer(): string {
  const issuer = process.env.XRPL_TESTNET_ISSUER;
  if (!issuer || !isValidClassicAddress(issuer)) throw new Error("XRPL Testnet issuer is not configured");
  return issuer;
}

function mintUri(commitment: string) {
  if (!COMMITMENT.test(commitment)) throw new Error("Invalid certificate commitment");
  return convertStringToHex(`urn:sha256:${commitment}`);
}

async function validatedTip() {
  const { info } = await rpc<{ info: { network_id: number; validated_ledger: { seq: number } } }>(
    TESTNET, "server_info",
  );
  if (info?.network_id !== 1 || !Number.isSafeInteger(info.validated_ledger?.seq))
    throw new Error("XRPL Testnet validated ledger unavailable");
  return info.validated_ledger.seq;
}

export async function prepareMint(commitment: string): Promise<PreparedMint> {
  const URI = mintUri(commitment);
  const issuer = configuredIssuer();
  const seed = process.env.XRPL_TESTNET_ISSUER_SEED;
  if (!seed) throw new Error("XRPL Testnet signing key is not configured");
  const wallet = Wallet.fromSeed(seed);
  if (wallet.classicAddress !== issuer) throw new Error("XRPL Testnet signing key does not match issuer");
  const [tip, account, fees] = await Promise.all([
    validatedTip(),
    rpc<{ validated: boolean; account_data: { Account: string; Sequence: number } }>(
      TESTNET, "account_info", { account: issuer, ledger_index: "validated" },
    ),
    rpc<{ drops: { open_ledger_fee: string } }>(TESTNET, "fee"),
  ]);
  if (!account.validated || account.account_data.Account !== issuer || !Number.isSafeInteger(account.account_data.Sequence))
    throw new Error("XRPL Testnet issuer account unavailable");
  const fee = Number(fees.drops.open_ledger_fee);
  if (!Number.isSafeInteger(fee) || fee < 1 || fee > MAX_FEE_DROPS) throw new Error("XRPL Testnet fee unavailable");
  const lastLedger = tip + WINDOW;
  const signed = wallet.sign({
    TransactionType: "NFTokenMint", Account: issuer, NFTokenTaxon: 0, Flags: 0, URI,
    Fee: String(fee), Sequence: account.account_data.Sequence, LastLedgerSequence: lastLedger,
  });
  return { blob: signed.tx_blob, hash: signed.hash, lastLedger };
}

type TransactionResult = {
  hash: string; validated: boolean; tx_json: Record<string, unknown>;
  meta?: TransactionMetadata & { nftoken_id?: string };
};

function matchesMint(tx: Record<string, unknown>, issuer: string, uri: string) {
  return tx.TransactionType === "NFTokenMint" && tx.Account === issuer && tx.Issuer === undefined
    && tx.URI === uri && tx.NFTokenTaxon === 0 && (tx.Flags ?? 0) === 0
    && tx.Memos === undefined && tx.Amount === undefined && tx.Destination === undefined
    && tx.TransferFee === undefined;
}

function mintedToken(tx: TransactionResult, hash: string, issuer: string, uri: string): string | undefined {
  if (tx.validated !== true || tx.hash !== hash || tx.meta?.TransactionResult !== "tesSUCCESS"
    || !matchesMint(tx.tx_json, issuer, uri)) return;
  const id = tx.meta.nftoken_id ?? getNFTokenID(tx.meta);
  if (!id || !HASH.test(id)) return;
  const token = parseNFTokenID(id);
  if (token.Issuer === issuer && token.Flags === 0 && token.Taxon === 0 && token.TransferFee === 0) return id;
}

/** Only call after atomically saving the signed transaction. A retry always submits the same bytes. */
export async function submitOrCheckMint(prepared: PreparedMint, commitment: string): Promise<MintResult> {
  const issuer = configuredIssuer();
  const uri = mintUri(commitment);
  const { blob, hash, lastLedger } = prepared;
  const tx = decode(blob);
  if (hashes.hashSignedTx(blob) !== hash || tx.LastLedgerSequence !== lastLedger || !Number.isSafeInteger(lastLedger)
    || !matchesMint(tx, issuer, uri) || !Object.keys(tx).every((field) => SIGNED_FIELDS.has(field))
    || Number(tx.Fee) < 1 || Number(tx.Fee) > MAX_FEE_DROPS || !Number.isSafeInteger(Number(tx.Fee))
    || typeof tx.SigningPubKey !== "string" || deriveAddress(tx.SigningPubKey) !== issuer || !verifySignature(blob))
    throw new Error("Stored XRPL Testnet mint does not match certificate");
  const tip = await validatedTip();
  try {
    const result = await rpc<TransactionResult>(CLIO, "tx", {
      transaction: hash, min_ledger: lastLedger - WINDOW + 1, max_ledger: lastLedger,
    });
    if (!result.validated) return { state: "pending" };
    // A validated failure consumed the sequence or fee but never minted a token.
    if (result.hash === hash && result.meta?.TransactionResult?.startsWith("tec")) return { state: "expired" };
    const tokenId = mintedToken(result, hash, issuer, uri);
    if (!tokenId) throw new Error("Validated mint does not match certificate");
    return { state: "minted", issuer, tokenId, txHash: hash };
  } catch (error) {
    if (!(error instanceof LedgerError) || error.code !== "txnNotFound") throw error;
    // Only replace after the entire validity window has been searched in validated history.
    if (tip >= lastLedger) return { state: error.searchedAll ? "expired" : "pending" };
  }
  await rpc(TESTNET, "submit", { tx_blob: blob });
  return { state: "pending" };
}

/** Public verification uses a fresh validated transaction and the NFT on the separate Clio read node. */
export async function verifyMint(proof: MintProof, trustedIssuers?: readonly string[]): Promise<boolean> {
  const { issuer, txHash, tokenId, commitment } = proof;
  const trusted = trustedIssuers ?? [process.env.XRPL_TESTNET_ISSUER, ...(process.env.XRPL_TESTNET_TRUSTED_ISSUERS ?? "").split(",")]
    .map(value => value?.trim()).filter((value): value is string => Boolean(value));
  if (!trusted.length || !trusted.every(address => isValidClassicAddress(address)))
    throw new Error("XRPL Testnet verification issuer is not configured");
  if (!trusted.includes(issuer) || !HASH.test(txHash) || !HASH.test(tokenId) || !COMMITMENT.test(commitment)) return false;
  const uri = mintUri(commitment);
  try {
    const tx = await rpc<TransactionResult>(CLIO, "tx", { transaction: txHash });
    if (mintedToken(tx, txHash, issuer, uri) !== tokenId) return false;
    const nft = await rpc<{
      validated: boolean; nft_id: string; issuer: string; owner: string; uri: string;
      flags: number; nft_taxon: number; is_burned: boolean; transfer_fee: number;
    }>(CLIO, "nft_info", { nft_id: tokenId, ledger_index: "validated" });
    return nft.validated === true && nft.nft_id === tokenId && nft.issuer === issuer && nft.owner === issuer
      && nft.uri === uri && nft.is_burned === false && nft.flags === 0 && nft.transfer_fee === 0 && nft.nft_taxon === 0;
  } catch (error) {
    if (error instanceof LedgerError && ["txnNotFound", "objectNotFound"].includes(error.code)) return false;
    throw error;
  }
}
