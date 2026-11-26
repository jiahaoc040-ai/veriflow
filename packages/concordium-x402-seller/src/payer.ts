/**
 * The payer account of an x402 Concordium payment (CCD or PLT).
 * payload = { signedTransaction: { header: { sender }, … } }: the sender is signed by the buyer's key and the facilitator checks
 * the signature, so a payment cannot claim another account.
 */
export function payerOf(payload: unknown): string | undefined {
  const p = payload as { signedTransaction?: { header?: { sender?: unknown } } } | undefined;
  const s = p?.signedTransaction?.header?.sender;
  return typeof s === "string" ? s : undefined;
}
