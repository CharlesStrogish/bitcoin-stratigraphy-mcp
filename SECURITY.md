# Vulnerability Disclosure Policy

## Purpose and scope

Bitcoin Stratigraphy welcomes good-faith, coordinated vulnerability reports.
This policy covers the currently maintained first-party source, Python and
TypeScript SDKs, cookbooks, and MCP/REST services operated by the maintainer.
The current main branch and latest maintained release are supported; older
versions may need to upgrade before a fix is provided.

Third-party registries, hosting platforms, Nostr relays, Lightning wallets,
payment providers, OpenTimestamps calendars and downstream deployments are not
authorized testing targets under this policy. Report their issues to their
respective owners. Test locally with synthetic data and mocked settlement
whenever possible.

## Report privately

Use the repository host's private vulnerability reporting feature when enabled
(on GitHub: **Security → Report a vulnerability**). Do not use an ordinary public
issue for technical details, exploitation steps or sensitive information.

If a private reporting feature is unavailable, create a minimal issue titled
**“Private security reporting channel requested”** or contact the maintainer
through the contact channel listed on their repository profile. Include only a
request for a confidential reporting method and a way to respond. Wait for the
maintainer to establish a private channel before sending vulnerability details.
No dedicated security email address or encryption key is currently designated
by this policy; do not send reports to guessed addresses.

Please provide privately:

- A concise description, affected version/commit and component.
- Impact, prerequisites and reproducible steps or a minimal proof of concept.
- Whether the finding affects production and any known active exploitation.
- Redacted logs or synthetic examples, not real customer records or credentials.
- Suggested mitigation, if known, and your preferred attribution or anonymity.

Never include wallet secrets, private keys, session tokens, macaroons or payment
preimages. If credentials are exposed, notify the maintainer privately and stop;
do not use the credentials to demonstrate additional access.

## Research guidelines

- Limit testing to systems you own or have explicit permission to assess.
- Use the minimum testing necessary to establish the issue. Respect rate limits
  and avoid service disruption, bulk scanning and resource exhaustion.
- Do not transfer real funds, create unauthorized invoices, bypass paid access
  on a live service, manipulate settlement, or forge production proof records.
- Do not access, modify, destroy or exfiltrate another person's data. If you
  encounter sensitive information inadvertently, stop immediately, notify the
  maintainer and follow agreed secure handling/deletion instructions.
- Do not perform social engineering, phishing, physical attacks, persistence,
  malware delivery or attacks against third-party infrastructure.
- Keep the report confidential while remediation and disclosure are coordinated.

## Response expectations

The maintainer aims to:

1. Acknowledge a private report within **3 business days**.
2. Provide an initial severity assessment or request for more information
   within **10 business days**.
3. Share progress at least every **7 business days** while a confirmed issue is
   being actively remediated, and agree on a mitigation and disclosure schedule.
4. Prioritize critical issues and active exploitation; provide mitigations
   before a permanent fix when feasible.

These are response targets, not contractual SLAs or guaranteed fix deadlines.
If no acknowledgement arrives, use the channel-request fallback above without
publishing technical details.

## Coordinated publication and credit

Target coordinated public disclosure within **90 calendar days** of receiving a
complete report. Agree on a shorter timeline for urgent risk, or a justified
extension for complex remediation. Notify the maintainer before publication;
aim to disclose after a fix or mitigation is available. Disclosure should state
affected/fixed versions and mitigations and omit credentials, customer data and
unnecessary exploit details. This policy does not prohibit lawful independent
disclosure or require indefinite confidentiality.

With consent, researchers will be credited in an advisory or release notes.
Anonymous reporting is welcome. No paid bug bounty or reward is promised.

## Good-faith protection and limits

The maintainer intends not to pursue legal action for good-faith research
performed in accordance with this policy and within permissions they can grant.
This is not permission to access others' systems, spend funds, or violate
applicable law; it cannot bind third parties or guarantee immunity. Ask privately
before testing if scope or authorization is unclear.

## Licensing is separate

Reporting a vulnerability does not transfer ownership of a researcher's work
or grant a commercial software license. See [LICENSE.md](https://github.com/CharlesStrogish/bitcoin-stratigraphy-mcp/blob/main/LICENSE.md) for the
AGPLv3/Commercial licensing framework.
