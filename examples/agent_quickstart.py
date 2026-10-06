import os

from sdk.python.bitcoin_stratigraphy import BitcoinStratigraphyClient


class AgentWallet:
    def pay_invoice(self, invoice: str):
        # Connect this method to your NWC library's pay_invoice call.
        return your_nwc_client.pay_invoice(invoice)


stratigraphy = BitcoinStratigraphyClient(
    os.environ.get("STRATIGRAPHY_URL", "https://your-node.example"),
    AgentWallet(),
)

# One-line retrieval for LangChain, CrewAI, AutoGPT, or custom agents.
latest = stratigraphy.get_latest()
print(latest[-1])
