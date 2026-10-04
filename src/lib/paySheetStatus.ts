import { canOfferPay, paymentLinkPhase, type PayLinkPhase } from "./payRequest";

/** UI availability. Not a stored payment state. */
export type PayStatusAvailability = "unknown" | "failed" | "ready";

export type PaySheetOffer =
  | { availability: "unknown"; offersPay: false; showsReceipt: false }
  | { availability: "failed"; offersPay: false; showsReceipt: false }
  | { availability: "ready"; phase: PayLinkPhase; offersPay: boolean; showsReceipt: boolean };

/**
 * Pay is offered only after a successful status response says the request is open.
 * Unknown and failed are not open.
 */
export function paySheetOffer(input: {
  availability: PayStatusAvailability;
  paid: boolean;
  cancelled: boolean;
  expiresAt: number | null;
  nowSeconds: number;
}): PaySheetOffer {
  if (input.availability === "unknown") {
    return { availability: "unknown", offersPay: false, showsReceipt: false };
  }
  if (input.availability === "failed") {
    return { availability: "failed", offersPay: false, showsReceipt: false };
  }
  const phase = paymentLinkPhase({
    paid: input.paid,
    cancelled: input.cancelled,
    expiresAt: input.expiresAt,
    nowSeconds: input.nowSeconds,
  });
  return {
    availability: "ready",
    phase,
    offersPay: canOfferPay(phase),
    showsReceipt: phase === "PAID",
  };
}
