// The sample site's two pages: the pricing page, and the page a buyer returns to after paying.

const html = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

const STYLE = `
  :root { color-scheme: light; --ink: #222; --muted: #6b6b6b; --line: #e4e0d8; --paper: #fbf9f5; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.5 system-ui, sans-serif; color: var(--ink); background: var(--paper); }
  header { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 16px 24px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
  main { max-width: 860px; margin: 0 auto; padding: 32px 16px; }
  h1 { font-size: 32px; margin: 0 0 8px; }
  .muted { color: var(--muted); }
  .plans { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; margin-top: 24px; }
  .plan { background: #fff; border: 1px solid var(--line); border-radius: 16px; padding: 24px; display: flex; flex-direction: column; gap: 12px; }
  .plan h2 { margin: 0; font-size: 20px; }
  .price { font-size: 28px; }
  button, .button { font: inherit; padding: 10px 18px; border-radius: 999px; border: 0; background: var(--ink); color: #fff; cursor: pointer; text-decoration: none; text-align: center; }
  button.quiet { background: transparent; color: var(--ink); border: 1px solid var(--line); }
  button:disabled { opacity: .5; cursor: default; }
  .account { background: #fff; border: 1px solid var(--line); border-radius: 16px; padding: 16px 24px; margin-top: 24px; display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; }
  .banner { background: #fff4d6; border-radius: 12px; padding: 12px 16px; margin-top: 16px; }
  #status:empty { display: none; }
`;

const shipbillScript = (scripts) => `<script src="${html(scripts.shipbillJs)}"></script>`;

/** Inline because it's an example; in your app, part of your frontend. */
export function pricingPage({ products, publishableKey, scripts }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Atlas Maps · Pricing</title><style>${STYLE}</style></head>
<body>
<header>
  <strong>Atlas Maps</strong>
  <span id="who"></span>
</header>
<main>
  <h1>Plans</h1>
  <p class="muted">Hand-drawn maps for every city you visit.</p>
  <div id="account" class="account" hidden></div>
  <p id="status" class="banner" role="status"></p>
  <div class="plans">
    <section class="plan">
      <h2>Basic</h2><p class="price" data-price="${html(products.basic)}">&nbsp;</p>
      <p class="muted">Ten maps a month.</p>
      <button data-plan="basic">Choose Basic</button>
    </section>
    <section class="plan">
      <h2>Pro</h2><p class="price" data-price="${html(products.pro)}">&nbsp;</p>
      <p class="muted">Every map, printable.</p>
      <button data-plan="pro">Choose Pro</button>
    </section>
  </div>
</main>
${shipbillScript(scripts)}
<script type="module">
  const PUBLISHABLE_KEY = ${JSON.stringify(publishableKey ?? null)};
  const status = document.getElementById("status");
  const say = (text) => { status.textContent = text; };
  const post = (path, body) =>
    fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) })
      .then(async (response) => ({ ok: response.ok, ...(await response.json()) }));

  // Prices as the checkout will show this visitor (a preview: the checkout fixes the amount).
  if (PUBLISHABLE_KEY) {
    ShipBill.init(PUBLISHABLE_KEY, ${JSON.stringify(scripts.initOptions ?? {})});
    const cells = [...document.querySelectorAll("[data-price]")];
    ShipBill.prices.get(cells.map((cell) => cell.dataset.price)).then((prices) => {
      for (const price of prices) {
        const cell = cells.find((c) => c.dataset.price === price.product);
        if (cell && price.available) cell.textContent = price.display + (price.interval ? " / " + price.interval : "");
      }
    }, (error) => console.warn("Prices:", error.message));
  }

  let me = null;
  async function refresh() {
    me = await fetch("/api/me").then((r) => r.json());
    const who = document.getElementById("who");
    const account = document.getElementById("account");
    if (!me) {
      who.innerHTML = 'Sign in as <button class="quiet" data-user="user_ana">Ana</button> <button class="quiet" data-user="user_ben">Ben</button>';
      account.hidden = true;
    } else {
      who.innerHTML = "Signed in as <strong></strong> · <button class='quiet' data-user='user_ana'>Ana</button> <button class='quiet' data-user='user_ben'>Ben</button>";
      who.querySelector("strong").textContent = me.name;
      account.hidden = false;
      const until = me.activeUntil ? new Date(me.activeUntil * 1000).toLocaleDateString() : null;
      account.innerHTML = "";
      const line = document.createElement("span");
      line.id = "plan";
      line.textContent = me.plan === "free"
        ? "You're on Free."
        : "You're on " + me.plan[0].toUpperCase() + me.plan.slice(1)
          + (me.pastDue ? " until " : me.cancelled ? ", cancelled: access until " : ", renews ") + until + ".";
      account.append(line);
      if (me.pastDue) {
        const renew = document.createElement("button");
        renew.textContent = "Renew now";
        renew.onclick = () => openCheckout(post("/api/renew"));
        account.append(renew);
        say("Your payment is due. Renew to keep your plan.");
      }
      if (me.manageUrl) {
        const manage = document.createElement("a");
        manage.href = me.manageUrl;
        manage.textContent = "Manage subscription";
        account.append(manage);
      }
    }
    for (const button of document.querySelectorAll("[data-plan]")) {
      const plan = button.dataset.plan;
      button.disabled = !me || (me.plan === plan && !me.cancelled);
      button.textContent = me && me.plan === plan && !me.cancelled ? "Your plan"
        : me && me.plan !== "free" && !me.cancelled ? "Switch to " + plan[0].toUpperCase() + plan.slice(1)
        : "Choose " + plan[0].toUpperCase() + plan.slice(1);
    }
  }

  // The browser asks for a plan by name; the server creates the checkout for the signed-in user.
  async function openCheckout(created) {
    const { ok, clientToken, sessionId, error } = await created;
    if (!ok) return say(error);
    ShipBill.checkout.open(clientToken, {
      // A signal to check, not proof: the server asks ShipBill before anything changes.
      onComplete: () => confirm(sessionId),
      onClose: () => refresh(),
      onError: (problem) => say(problem.message),
    });
  }

  async function confirm(sessionId) {
    say("Confirming your payment…");
    for (let tries = 0; tries < 20; tries++) {
      const result = await fetch("/api/confirm?session_id=" + encodeURIComponent(sessionId)).then((r) => r.json());
      if (result.paid) { say(""); return refresh(); }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    say("Your payment is still being confirmed. This page updates when it is.");
  }

  document.addEventListener("click", async (event) => {
    const target = event.target.closest("button");
    if (!target) return;
    if (target.dataset.user) { await post("/api/signin", { user: target.dataset.user }); say(""); return refresh(); }
    if (target.dataset.plan) openCheckout(post("/api/checkout", { plan: target.dataset.plan }));
  });
  refresh();
  // Your server learns of payments from ShipBill; keep the page current while it does.
  setInterval(refresh, 4000);
</script>
</body></html>`;
}

/** success_url: where the checkout page sends the buyer back, with ?session_id=cs_… added. */
export function confirmPage() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Atlas Maps · Thanks</title><style>${STYLE}</style></head>
<body>
<header><strong>Atlas Maps</strong></header>
<main>
  <h1 id="title">Confirming your payment…</h1>
  <p id="detail" class="muted">This takes a moment.</p>
  <p><a class="button" href="/">Back to plans</a></p>
</main>
<script type="module">
  // The session ID in the address proves nothing on its own: the server asks ShipBill, and checks the
  // checkout belongs to the signed-in user.
  const sessionId = new URLSearchParams(location.search).get("session_id");
  for (let tries = 0; tries < 20 && sessionId; tries++) {
    const result = await fetch("/api/confirm?session_id=" + encodeURIComponent(sessionId)).then((r) => r.json());
    if (result.error) { document.getElementById("title").textContent = result.error; break; }
    if (result.paid) {
      document.getElementById("title").textContent = "You're on " + result.me.plan[0].toUpperCase() + result.me.plan.slice(1) + ".";
      document.getElementById("detail").textContent = "Thanks! A receipt is on its way.";
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
</script>
</body></html>`;
}
