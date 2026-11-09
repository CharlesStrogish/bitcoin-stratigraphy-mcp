import { QRCodeSVG } from "qrcode.react";

/** Render locally: invoice data is never sent to a third-party QR service. */
export default function InvoiceQr({ invoice }: { invoice: string }) {
  return (
    <QRCodeSVG
      value={`lightning:${invoice.toUpperCase()}`}
      size={256}
      level="M"
      marginSize={4}
      title="Scan this Lightning invoice with your phone wallet"
      style={{ width: "100%", maxWidth: 256, height: "auto", background: "#fff" }}
      data-testid="invoice-qr"
    />
  );
}
