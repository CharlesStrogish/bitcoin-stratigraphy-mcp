// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
const UTC_DATE_TIME = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});
const UTC_TIME = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});
const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

export function formatSats(value: number) {
  return `${value.toLocaleString("en-US")} ${value === 1 ? "sat" : "sats"}`;
}

export function formatUtcDateTime(value: string | number) {
  return `${UTC_DATE_TIME.format(new Date(value))} UTC`;
}

export function formatUtcTime(value: number) {
  return `${UTC_TIME.format(new Date(value))} UTC`;
}

export function formatUsd(value: number) {
  return USD.format(value);
}
