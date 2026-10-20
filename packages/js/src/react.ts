import { useEffect, useState } from "react";
import { type LoadOptions, loadShipBill } from "./index.js";
import type { ShipBill } from "./types.js";

// @shipbill/js/react: the SDK in a component, null until it has loaded.
//
//   const shipbill = useShipBill("pk_live_…");
//   <button disabled={!shipbill} onClick={() => shipbill?.checkout.open({ product: "prod_…" })}>Buy</button>

export function useShipBill(publishableKey: string, options?: LoadOptions): ShipBill | null {
  const [shipbill, setShipBill] = useState<ShipBill | null>(null);
  const { apiUrl, checkoutUrl, scriptUrl, integrity } = options ?? {};
  useEffect(() => {
    let current = true;
    loadShipBill(publishableKey, {
      ...(apiUrl ? { apiUrl } : {}),
      ...(checkoutUrl ? { checkoutUrl } : {}),
      ...(scriptUrl ? { scriptUrl } : {}),
      ...(integrity ? { integrity } : {}),
    }).then(
      (loaded) => current && setShipBill(loaded),
      (error: unknown) => console.error("[ShipBill]", error),
    );
    return () => {
      current = false;
    };
  }, [publishableKey, apiUrl, checkoutUrl, scriptUrl, integrity]);
  return shipbill;
}

export type { LoadOptions } from "./index.js";
export type { ShipBill } from "./types.js";
