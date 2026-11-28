/**
 * The buyer-proof requirement as a top-level x402 extension
 * ---------------------------------------------------------
 * x402 issue #4182 first put the buyer requirement in each entry's extra (extra.buyerProof). The discussion there
 * (24 Nov 2026) moved it to one top-level `extensions` entry that covers every entry in `accepts`, with the facts and the
 * accepted assurance stated apart from how a proof is bound, and the account-bound proof as one way to meet them.
 * The 402 carries both shapes until the restructured proposal settles the names: extra.buyerProof for buyers written
 * against the first draft, and this entry for the new one.
 */
export const BUYER_PROOF_EXTENSION = "buyer-proof";

export type BuyerProofPolicy = { id: string; minAge?: number; restrictedCountries?: string[]; [k: string]: unknown };

export function buyerProofExtension(o: { facts: string[]; policy: BuyerProofPolicy; verifyUrl: string; network: string }) {
  return {
    [BUYER_PROOF_EXTENSION]: {
      info: {
        // Applies to every entry in accepts, whichever network or asset the buyer picks
        appliesTo: "all-accepts",
        // What must be true of the buyer
        facts: o.facts,
        // What assurance the seller accepts for those facts
        assurance: o.policy,
        // Ways to meet it. The one offered here: a zero-knowledge proof bound to the Concordium account that pays
        methods: [
          {
            type: "concordium-account-proof",
            network: o.network,
            binding: "payer: the account that signs the payment (signedTransaction.header.sender) must be the proven account",
            verifyUrl: o.verifyUrl,
          },
        ],
        // A payment from a buyer that does not meet it is refused before it is broadcast, with this reason
        refusal: "buyer_proof_required",
      },
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        required: ["appliesTo", "facts", "assurance", "methods"],
        properties: {
          appliesTo: { const: "all-accepts" },
          facts: { type: "array", items: { type: "string" }, minItems: 1 },
          assurance: { type: "object", required: ["id"] },
          methods: {
            type: "array",
            minItems: 1,
            items: { type: "object", required: ["type", "binding"], properties: { type: { type: "string" }, binding: { type: "string" }, verifyUrl: { type: "string" } } },
          },
          refusal: { type: "string" },
        },
      },
    },
  };
}
