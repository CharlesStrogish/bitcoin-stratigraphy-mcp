import time

import pytest

from bitcoinstratigraphy_agent_yield import FiduciaryError
from bitcoinstratigraphy_agent_yield.invoices import decode_invoice, verify_preimage
from bitcoinstratigraphy_agent_yield.receipts import terminal_receipt
from conftest import PAYMENT_HASH, PREIMAGE, make_invoice


@pytest.mark.parametrize("amount", [1, 21001, 100000])
def test_real_signed_mainnet_invoices(amount):
    invoice = decode_invoice(make_invoice(amount, explicit_payee=True))
    assert invoice.payment_hash == PAYMENT_HASH
    assert invoice.amount_msats == amount
    assert invoice.expires_at > time.time()
    assert verify_preimage(PREIMAGE, invoice.payment_hash)
    assert not verify_preimage("02" * 32, invoice.payment_hash)


@pytest.mark.parametrize(
    "text",
    [
        "bad",
        "",
        None,
        "a" * 4097,
        make_invoice(network="tb"),
        make_invoice(wrong_payee=True),
    ],
)
def test_invalid_invoices_fail_closed(text):
    with pytest.raises(FiduciaryError, match="INVALID_MAINNET_INVOICE"):
        decode_invoice(text)


def test_checksum_tampering():
    invoice = make_invoice()
    with pytest.raises(FiduciaryError):
        decode_invoice(invoice[:-1] + ("q" if invoice[-1] != "q" else "p"))


def test_receipt_precision_and_quiet(capsys, monkeypatch):
    terminal_receipt("allocated", 21001)
    assert "21.001 Sats" in capsys.readouterr().err
    monkeypatch.setenv("QUIET_STRATIGRAPHY", "TRUE")
    terminal_receipt("settled", 21001)
    assert not capsys.readouterr().err


def test_receipt_failure_is_observer_only(monkeypatch):
    class Broken:
        def write(self, data):
            raise OSError("closed")

    monkeypatch.setattr("sys.stderr", Broken())
    terminal_receipt("settled", 21000)


@pytest.mark.parametrize("amount", [-1, 0, True, "21000", None])
def test_invalid_receipts_are_silent(amount, capsys):
    terminal_receipt("settled", amount)
    captured = capsys.readouterr()
    assert not captured.err and not captured.out
