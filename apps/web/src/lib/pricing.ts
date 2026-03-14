"use client";

import { useState, useEffect } from "react";

export interface Pricing {
  currency: "usd" | "inr";
  amount: number;
  symbol: string;
  label: string;
}

const USD: Pricing = { currency: "usd", amount: 0.99, symbol: "$", label: "$0.99" };
const INR: Pricing = { currency: "inr", amount: 89, symbol: "₹", label: "₹89" };

function getCountry(): string {
  if (typeof document === "undefined") return "";
  const match = document.cookie.match(/(?:^|; )country=([^;]*)/);
  return match?.[1] ?? "";
}

/** Returns USD on first render (SSR-safe), then updates to INR if in India. */
export function usePricing(): Pricing {
  const [pricing, setPricing] = useState<Pricing>(USD);

  useEffect(() => {
    if (getCountry() === "IN") {
      setPricing(INR);
    }
  }, []);

  return pricing;
}

export function formatTotal(quantity: number, pricing: Pricing): string {
  const total = quantity * pricing.amount;
  return `${pricing.symbol}${Number.isInteger(total) ? total : total.toFixed(2)}`;
}
