// The example's two pages: your own payment page, and the page the buyer returns to.

const html = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

const STYLE = `
  :root { color-scheme: light; --ink: #222; --muted: #6b6b6b; --line: #e4e0d8; --paper: #fbf9f5; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.5 system-ui, sans-serif; color: var(--ink); background: var(--paper); }
  main { max-width: 520px; margin: 0 auto; padding: 32px 16px; display: flex; flex-direction: column; gap: 16px; }
  h1 { font-size: 28px; margin: 0; }
  .muted { color: var(--muted); }
  .card { background: #fff; border: 1px solid var(--line); border-radius: 16px; padding: 20px; display: flex; flex-direction: column; gap: 12px; }
  label { display: flex; flex-direction: column; gap: 4px; font-size: 14px; }
  input, select { font: inherit; padding: 10px 12px; border: 1px solid #b9b4aa; border-radius: 12px; background: #fff; }
  .method { flex-direction: row; align-items: center; gap: 10px; font-size: 16px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 12px; }
  .method span:last-child { margin-left: auto; font-variant-numeric: tabular-nums; }
  button { font: inherit; padding: 12px 18px; border-radius: 999px; border: 0; background: var(--ink); color: #fff; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  #error:empty { display: none; }
  #error { color: #b42318; margin: 0; }
  #fields:empty { display: none; }
`;

const shipbillScript = (scripts) => `<script src="${html(scripts.shipbillJs)}"></script>`;

/** Inline because it's an example; in your app, part of your frontend. */
export function payPage({ scripts }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Atlas Maps · Pay</title><style>${STYLE}</style></head>
<body>
<main>
  <h1>Pay</h1>
  <form id="buyer" class="card">
    <label>Email <input name="email" type="email" required autocomplete="email"></label>
    <label>Country
      <select name="country">
        <option value="">Choose…</option>
        <option value="DE">Germany</option><option value="ID">Indonesia</option>
        <option value="GB">United Kingdom</option><option value="US">United States</option>
      </select>
    </label>
    <button>Continue</button>
  </form>
  <form id="methods" class="card" hidden>
    <p id="items" class="muted"></p>
    <div id="list"></div>
    <button id="pay">Pay</button>
  </form>
  <div id="fields" class="card"></div>
  <button id="confirm" hidden>Pay now</button>
  <p id="error" role="alert"></p>
</main>
${shipbillScript(scripts)}
<script>
  const $ = (id) => document.getElementById(id);
  const say = (text) => ($("error").textContent = text || "");
  // Amounts are integers in the currency's ISO 4217 minor units: two decimals for most (rupiah too), none for
  // yen, three for the dinars. Not from Intl, which shows rupiah without decimals.
  const ZERO = "BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX VND VUV XAF XOF XPF".split(" ");
  const THREE = "BHD IQD JOD KWD LYD OMR TND".split(" ");
  const exponent = (currency) => (ZERO.includes(currency) ? 0 : THREE.includes(currency) ? 3 : 2);
  const money = (amount, currency) =>
    new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount / 10 ** exponent(currency));
  const post = async (path, body) => {
    const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    return data;
  };

  // 1. The buyer says who they are; the server opens the order and lists the methods with their amounts.
  //    Changing the email or country later opens a new one: an intent is never updated.
  $("buyer").addEventListener("submit", async (event) => {
    event.preventDefault();
    say();
    const form = new FormData(event.target);
    try {
      const order = await post("/api/order", { email: form.get("email"), country: form.get("country") });
      $("items").textContent = order.items.map((item) => item.quantity + " × " + item.title).join(", ");
      $("list").replaceChildren(...order.methods.map((method, index) => {
        const row = document.createElement("label");
        row.className = "method";
        const radio = Object.assign(document.createElement("input"), { type: "radio", name: "method", value: method.type, checked: index === 0 });
        const name = Object.assign(document.createElement("span"), { textContent: method.label });
        const price = Object.assign(document.createElement("span"), { textContent: money(method.amount, method.currency) });
        row.append(radio, name, price);
        return row;
      }));
      $("methods").hidden = !order.methods.length;
      if (!order.methods.length) say("Nothing can take this payment right now.");
    } catch (error) {
      say(error.message);
    }
  });

  // 2. Pay: the server confirms with the method, and ShipBill.mount does what next_action says.
  $("methods").addEventListener("submit", async (event) => {
    event.preventDefault();
    say();
    $("pay").disabled = true;
    try {
      const { next_action } = await post("/api/pay", { method: new FormData(event.target).get("method") });
      const action = await ShipBill.mount(next_action, "#fields");
      if (action.type === "fields") {
        // The provider's card fields are in #fields: pay when the buyer has filled them in.
        $("methods").hidden = true;
        $("confirm").hidden = false;
        $("confirm").onclick = async () => {
          $("confirm").disabled = true;
          const { error } = await action.confirm(); // returns only if the buyer stays on this page
          say(error.message);
          $("confirm").disabled = false;
        };
      }
    } catch (error) {
      say(error.message);
      $("pay").disabled = false;
    }
  });
</script>
</body></html>`;
}

const OUTCOMES = {
  succeeded: ["Paid", "Thank you. Your receipt is on its way to your email."],
  processing: [
    "Almost there",
    "Your provider is still confirming the payment. You'll get an email when it's done.",
  ],
  requires_action: ["Not finished", "The payment wasn't completed at the provider. You can try again."],
  requires_payment_method: ["Not paid", null],
  expired: ["This order has closed", "Start again to pay."],
  cancelled: ["This order has closed", "Start again to pay."],
};

/** Back from the provider: what ShipBill says about this buyer's own order. */
export function returnPage(result) {
  const [title, text] = result.intent
    ? OUTCOMES[result.intent.status]
    : [result.title, "Start again from the payment page."];
  const detail =
    result.intent?.status === "requires_payment_method"
      ? `${result.intent.last_payment_error?.message ?? "The payment didn't go through."} You can try again.`
      : text;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Atlas Maps · ${html(title)}</title><style>${STYLE}</style></head>
<body><main>
  <h1>${html(title)}</h1>
  <p class="muted">${html(detail)}</p>
  ${result.intent?.status === "succeeded" ? "" : '<p><a href="/">Back to the payment page</a></p>'}
</main></body></html>`;
}
