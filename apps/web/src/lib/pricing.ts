"use client";

interface Pricing {
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

export function getPricing(): Pricing {
  return getCountry() === "IN" ? INR : USD;
}

export function formatTotal(quantity: number, pricing: Pricing): string {
  const total = quantity * pricing.amount;
  return `${pricing.symbol}${Number.isInteger(total) ? total : total.toFixed(2)}`;
}
