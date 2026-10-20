import { createServer } from "node:http";
import { WebhookSignatureError, webhooks } from "@shipbill/node";

// The smallest correct ShipBill webhook receiver:   SHIPBILL_WEBHOOK_SECRET=whsec_… node server.mjs
//
//   1. Read the raw body: the signature is over the exact bytes, so check it before parsing anything.
//   2. Verify it with the endpoint's signing secret. Anything else gets 400 and changes nothing.
//   3. Skip an event ID you've already handled: ShipBill delivers at least once.
//   4. Answer 2xx quickly. Anything else is retried for about three days.

const secret = process.env.SHIPBILL_WEBHOOK_SECRET;
if (!secret) {
  console.error("Set SHIPBILL_WEBHOOK_SECRET: it's on the endpoint's page in Settings → Webhook.");
  process.exit(1);
}

/** In your app: a table of event IDs, written in the same transaction as what the event changes. */
const handled = new Set();

function handle(event) {
  switch (event.type) {
    case "payment.succeeded":
      // A one-time purchase: fulfil it for event.data.object.reference.
      console.log(
        `Paid: ${event.data.object.amount} ${event.data.object.currency} for ${event.data.object.reference}`,
      );
      break;
    case "subscription.created":
    case "subscription.renewed":
    case "subscription.reactivated":
      console.log(
        `${event.data.object.reference} has access until ${new Date(event.data.object.access_until * 1000).toISOString()}`,
      );
      break;
    case "subscription.expired":
      console.log(`${event.data.object.reference}'s subscription ended`);
      break;
    default:
      console.log(`Received ${event.type}`);
  }
}

createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/webhooks/shipbill") {
    response.writeHead(404).end();
    return;
  }
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    let event;
    try {
      event = webhooks.verify(Buffer.concat(chunks), request.headers["shipbill-signature"], secret);
    } catch (error) {
      if (!(error instanceof WebhookSignatureError)) throw error;
      response.writeHead(400, { "Content-Type": "text/plain" }).end(error.message);
      return;
    }
    if (!handled.has(event.id)) {
      handle(event);
      handled.add(event.id);
    }
    response.writeHead(200).end();
  });
}).listen(Number(process.env.PORT ?? 4700), () => console.log("Receiving on POST /webhooks/shipbill"));
