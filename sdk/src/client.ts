import { AgentPaymentIntents } from "./agent";
import { Analytics } from "./analytics";
import { Policies } from "./policies";
import { Escrows } from "./escrows";
import { createHttpClient, resolveClientConfig } from "./http";
import { PaymentRequests } from "./paymentRequests";
import type { FinalClientOptions } from "./types";
import { TransactionVerificationClient } from "./verify";
import { Webhooks } from "./webhooks";

export class Final {
  readonly paymentRequests: PaymentRequests;
  readonly verify: TransactionVerificationClient;
  readonly webhooks: Webhooks;
  readonly escrows: Escrows;
  readonly agent: { paymentIntents: AgentPaymentIntents };
  readonly policies: Policies;
  /** Read-only analytics. Requires analytics:read. */
  readonly analytics: Analytics;

  constructor(options: FinalClientOptions) {
    const config = resolveClientConfig(options);
    const http = createHttpClient(config);
    this.paymentRequests = new PaymentRequests(http);
    this.verify = new TransactionVerificationClient(http);
    this.webhooks = new Webhooks();
    this.escrows = new Escrows(http);
    this.agent = { paymentIntents: new AgentPaymentIntents(http) };
    this.policies = new Policies(http);
    this.analytics = new Analytics(http);
  }
}
