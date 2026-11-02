# Enterprise Master Services Agreement and Service Level Agreement

## $250,000 Annual Commercial License Exemption

**Procurement template — subject to completion and signature.** This document
provides general contractual information, not legal advice. Each party should
obtain qualified legal review before execution. Publication, an API request,
an L402 payment, or a purchase order alone does not execute this Agreement.

## 1. Agreement structure and execution

This Enterprise Master Services Agreement and Service Level Agreement
("Agreement") consists of the completed Order Form below, Sections 1–12 of this
document, and the unmodified
[Common Paper Cloud Service Agreement Standard Terms, Version 2.1](https://commonpaper.com/standards/cloud-service-agreement/2.1/)
("Standard Terms"), incorporated by reference. This document supplies the
Standard Terms' Key Terms and Order Form and expressly states the enterprise
additions and overrides. The parties must retain a copy of the incorporated
version with their executed Agreement; later website revisions do not amend it.

In a conflict, the following order controls: (1) a later amendment signed by both
parties that expressly identifies the provision changed; (2) this document;
(3) the Standard Terms; and (4) operational documentation. Any required data
processing agreement controls personal-data processing only and may not increase
the liability cap without an express signed amendment identifying Section 8.
Marketing statements, repository notices, token caveats, vendor portals, and
purchase-order boilerplate do not amend the Agreement.

### Order Form and Key Terms

Complete every bracketed field before signature.

| Item | Agreed term |
| --- | --- |
| Provider | [Exact contracting legal name; Charles R. Strogish if contracting personally], trading as Bitcoin Stratigraphy |
| Provider address | [Registered or business address] |
| Customer | [Exact contracting legal name] |
| Customer address | [Registered or business address] |
| Effective Date / Order Date | [Date of last authorized signature] |
| Service Start Date | [Agreed activation date following payment and provisioning] |
| Cloud Service | Bitcoin Stratigraphy L402 Oracle and the enterprise API deployment identified below |
| Covered API endpoints and production deployment | [Enumerated endpoint URLs, region, and dedicated Replit deployment identifier] |
| Authorized deployment and use scope | [Named entities, environments, integrations, and agreed capacity limits] |
| Subscription Period | Twelve consecutive months from the Service Start Date |
| Fees | **US $250,000 per twelve-month Subscription Period**, excluding applicable taxes |
| Payment Process | Annual invoice in advance; undisputed amounts due within 30 calendar days of invoice; activation requires payment |
| Renewal | By a new written order signed by both parties only; no automatic renewal |
| Technical Support / Provider Notice Address | **licensing@bitcoinstratigraphy.com** |
| Customer support and Notice Address | [Monitored business email and escalation contact] |
| General Cap Amount | **US $250,000 aggregate**, as further specified in Section 8 |
| Increased Claims / Increased Cap Amount | None / not applicable |
| Unlimited Claims | None, except liability that applicable law prohibits limiting |
| Provider Covered Claims | Third-party claims that authorized use of Provider-owned service software infringes copyright or trade-secret rights |
| Customer Covered Claims | Third-party claims that Customer Content infringes intellectual-property rights or that Customer's unlawful use violates a third party's rights |
| Governing Law | [Agreed state/country, excluding conflict-of-law rules] |
| Chosen Courts | [Agreed courts and exclusive venue] |
| Additional Warranties | The express commitments in Sections 3, 4, and 5 |

Provider represents that it owns or is authorized to license the rights granted.
The parties' authorized representatives must sign Section 12. No service
commitment takes effect before execution and the Service Start Date.

## 2. Commercial license, fees, and scope

For the paid Subscription Period, Provider grants Customer a non-exclusive,
non-transferable commercial license to use the covered service and Provider-owned
software within the expressly authorized scope. That scope may include
proprietary, closed-source enterprise swarm deployments and multi-tenant hosting
only where identified in the Order Form. This express grant overrides conflicting
internal-use-only and modification restrictions in Standard Terms Sections 1.1
and 2.1 solely to the extent necessary for the authorized deployment.

The **$250,000 Annual Commercial License Exemption** permits authorized
high-volume orchestrators, major LLM crawlers, and global AI trading desks to
bypass per-request L402 micro-transactions for covered API access. Provider shall
provision the exemption before activation. It is not a bearer-token bypass:
identity verification, authorization, revocation, agreed capacity controls, and
security enforcement remain applicable.

The annual fee does not fund wallet balances or purchase Bitcoin, Lightning
network fees, escrow principal, third-party services, or separately ordered
products. No additional usage charge applies to covered access without a
separate signed order. Increased capacity requires agreement, not unilateral
overage invoicing. Customer remains responsible for its own trading decisions,
wallet custody, and downstream systems.

Provider retains its pre-existing intellectual property. Third-party software,
datasets, and contributions retain their applicable licenses. This Agreement
does not revoke existing AGPLv3 grants or relicense rights Provider does not own.
Customer retains ownership of Customer Content. Standard Terms payment-dispute,
tax, and confidentiality provisions apply, subject to the overrides here.

## 3. 99.9% API Uptime Guarantee

### 3.1 Commitment and infrastructure

Provider guarantees **99.9% API uptime per calendar month**, backed by
Provider's dedicated Replit infrastructure identified in the Order Form.
Provider shall provision and maintain that dedicated production deployment,
monitor the covered APIs, and maintain incident-response and recovery procedures.
This is Provider's contractual service commitment; Replit is an infrastructure
supplier, not a party, guarantor, or direct support obligor under this Agreement.
This clause does not represent that Replit independently offers a 99.9% SLA.

### 3.2 Measurement

Monthly Uptime Percentage equals:

`100 × (Eligible Minutes − Unavailable Minutes) / Eligible Minutes`

Eligible Minutes are all minutes of the covered Subscription Period falling
within the applicable UTC calendar month, less only the exclusions in Section
3.3. Unavailable Minutes are eligible minutes during which valid, authorized
requests to a covered production endpoint cannot complete its documented
function because of Provider-side timeouts, connection failures, or server
errors. A failing covered endpoint counts as service unavailability even if
the health endpoint remains reachable. Overlapping incidents count only once.
If there are no Eligible Minutes, that month is not rated.

Provider shall retain availability measurements for at least twelve months and
provide the monthly calculation and relevant incident summary on request.
Customer may submit timestamped evidence to dispute the calculation.
Expected client errors, correct authorization denials, and correctly enforced
agreed capacity limits do not constitute downtime. Incorrect denials caused by
Provider defects do. In a fully eligible 30-day month, 99.9% permits no more than
43 minutes and 12 seconds of unavailability.

### 3.3 Limited exclusions

Only the following periods may be excluded, and Provider must document their
cause and duration:

- Scheduled maintenance notified at least 48 hours in advance, limited to
  60 minutes per calendar month. Excess or unannounced maintenance counts.
- Failures demonstrably caused solely by Customer-controlled infrastructure,
  unauthorized modifications, or use outside the agreed scope.
- Connectivity failures entirely outside Provider's and its hosting suppliers'
  networks, or external Bitcoin/Lightning settlement delays, **only where the
  covered API remains operational and performs its documented function**.
- A Force Majeure Event as narrowly defined in the Standard Terms, where Provider
  took reasonable preventative and mitigation measures.

Ordinary Replit hosting outages, Provider-controlled dependencies, deployment
errors, and insufficient provisioned capacity are not automatically excluded
as third-party failures.

### 3.4 Service credits and chronic failure

For a month below the guarantee, Customer is entitled to a service credit:

| Monthly Uptime Percentage | Credit against monthly allocated fee |
| --- | --- |
| At least 99.9% | None |
| At least 99.0% but below 99.9% | 5% |
| At least 95.0% but below 99.0% | 10% |
| Below 95.0% | 25% |

The monthly allocated fee is US $250,000 divided by twelve, prorated for a
partial month. Customer must request a credit at the support email within
30 calendar days after the affected month ends and identify the incident.
Provider shall determine the request within 15 calendar days using both parties'
evidence. Approved credits offset the next invoice; if there is no further
invoice, Provider shall refund the credit within 30 calendar days of approval.
Credits do not require renewal and may not exceed 25% of that month's allocation.

If uptime falls below 99.9% in three months within any rolling six-month period,
Customer may terminate the affected service by notice within 30 calendar days
after the third affected month and receive a prorated refund of prepaid fees for
the unused term. Credits and this termination/refund right are the exclusive
monetary remedies for failure of the uptime guarantee, without eliminating
remedies for a distinct breach of another express obligation. No double recovery
is permitted; all amounts remain subject to Section 8.

## 4. Severity 1 support and incident management

**Severity 1** means a complete production outage of a covered API, a confirmed
unauthorized production payment-routing event, or a critical security incident
that prevents safe production use, with no reasonable workaround.

Provider guarantees an initial substantive human response **within 24 elapsed
hours**, including weekends and holidays, after receipt of a Severity 1 report
at **licensing@bitcoinstratigraphy.com**. The subject should begin
`SEV1 — Enterprise Incident`. Reports should include the covered endpoint,
UTC timestamps, impact, and sanitized request identifiers. An automated email
acknowledgment does not satisfy the response commitment. Missing optional
diagnostic details does not restart the response clock.

The response shall identify an incident owner, acknowledge the impact, and state
the next investigative action. Provider shall use commercially reasonable efforts
to restore service, give updates at least every 24 hours while Severity 1 remains
open, and provide a written root-cause summary within ten business days after
resolution. The 24-hour commitment is a response window, not a guaranteed
resolution time. Support-response breaches are subject to the material-breach
process in Section 9; uptime credits apply only where Section 3 is also breached.

Customer must not email private keys, preimages, macaroons, complete prompts, or
other sensitive credentials. The parties shall agree on a secure incident channel
where protected diagnostic material is necessary.

## 5. Zero-Trust Data Guarantee

**The L402 Oracle routes payments without storing underlying corporate prompt
data.** Provider shall not require, persist, log, archive, or train models on
Customer's underlying corporate prompts, conversations, system instructions,
or proprietary model outputs as part of payment routing.

Customer shall keep that content within its own systems and submit only the
protocol inputs and cryptographic digests needed for the requested operation.
Provider shall configure the covered deployment's application logs, monitoring,
caches, webhooks, and backups consistently with this non-storage commitment.
Standard Terms Sections 1.4–1.6 do not authorize retention, disclosure, or
machine-learning use of underlying corporate prompt data; Section 1.6's
machine-learning permission is expressly disapplied to Customer Content and
Customer-identifiable Usage Data.

Non-storage of prompts does **not** mean absence of transaction records.
Provider may retain the minimum settlement, authorization, billing, security,
and proof metadata needed to operate and audit the service, including transaction
identifiers, amounts, timestamps, authenticated agent identifiers, cryptographic
commitments, and payment-verification records. Such metadata can be sensitive
even when it does not reveal prompt content; access must be restricted to
authorized personnel and service components. It is not permission to retain
underlying corporate prompts.

Customer-directed treasury webhooks are asynchronous, non-blocking, best-effort
monitoring. They transmit only the documented settlement summary to the configured
corporate receiver; native Datadog/Slack formats require a receiver adapter.
Delivery failures do not reverse settlement. Calculated yield notifications are
not proof of outgoing Treasury payment. Customer shall not include prompt content
in payment descriptions, support tickets, or public proof submissions.

Provider shall apply least-privilege access and protect retained confidential
metadata in transit and at rest. Provider shall notify Customer without undue
delay after confirming a security incident affecting Customer's retained data
and cooperate with containment and legally required notifications. No provision
authorizes public disclosure of Customer-identifying metadata without Customer's
authorization or a legal requirement.

Before submitting regulated personal data, the parties must execute any required
data processing agreement identifying processors, retention, deletion, transfers,
and security obligations. Zero-trust architecture is not a representation that
incidents are impossible or that cryptographic proofs establish legal compliance.

## 6. Confidentiality and authorized use

The Standard Terms' mutual confidentiality obligations apply to business,
technical, procurement, security, and permitted transaction information.
Provider may disclose such information only to personnel and subprocessors with
a need to know and binding protective obligations, or where legally required.
Each party remains responsible for its authorized recipients.

Customer shall protect its credentials, use the service lawfully, and not
circumvent access controls or disrupt other users. Security testing must be
coordinated in advance. Provider shall give reasonable notice before suspension
where practicable and limit emergency suspension to the affected access needed
to contain a documented security or legal risk. Unrelated covered access shall
not be suspended solely because an affected credential is revoked.

Standard Terms Section 12.8 is overridden: neither party may use the other's
name, logo, or procurement relationship in publicity without prior written consent.

## 7. Warranties and financial-risk allocation

Each party warrants that its signatory has authority to bind it. Provider
warrants professional performance of the express service obligations and shall
not materially reduce covered functionality during the Subscription Period.
Sections 3–5 are express commitments notwithstanding the general disclaimer in
Standard Terms Section 7.

Except for express commitments in this Agreement, services and data are supplied
"AS IS" and "AS AVAILABLE" to the maximum extent permitted by law. Provider does
not warrant investment results, profit, exchange rates, third-party settlement
finality, or regulatory approval. The service does not provide financial, legal,
or investment advice. Customer controls its own decisions and downstream
execution. Standard Terms indemnification procedures apply only to the defined
Covered Claims and are fully subject to Section 8.

## 8. Strict Limitation of Liability

**TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, EACH PARTY'S TOTAL AGGREGATE
LIABILITY FOR ALL DAMAGES, CLAIMS, LOSSES, COSTS, AND EXPENSES ARISING OUT OF OR
RELATING TO THIS AGREEMENT SHALL NOT EXCEED US $250,000, EQUAL TO THE ANNUAL
LICENSING FEE. PROVIDER AND ITS PERSONNEL, LICENSORS, AND SUPPLIERS SHARE ONE
COMBINED US $250,000 CAP; THERE IS NO SEPARATE CAP FOR EACH PERSON OR CLAIM.**

**THIS IS A SINGLE AGGREGATE CAP FOR THE AGREEMENT, NOT A PER-INCIDENT,
PER-CLAIMANT, PER-ENDPOINT, OR PER-YEAR CAP. RENEWALS, MULTIPLE LEGAL THEORIES,
AND MULTIPLE ORDER FORMS UNDER THIS AGREEMENT DO NOT MULTIPLY OR RESET IT.**

The cap covers contract, tort (including negligence), statutory claims, breach
of confidentiality, security or data incidents, intellectual-property claims,
indemnification, defense costs, service credits, refunds, and other monetary
remedies. There are no negotiated uncapped or increased-cap categories.
Ordinary payment of agreed fees and taxes is a payment obligation, not damages;
this sentence creates no exception for damages claims.

**NEITHER PARTY SHALL BE LIABLE FOR LOST PROFITS, LOST REVENUE, LOST TRADING
OPPORTUNITIES, LOSS OF GOODWILL, OR INDIRECT, CONSEQUENTIAL, SPECIAL, INCIDENTAL,
EXEMPLARY, OR PUNITIVE DAMAGES, EVEN IF ADVISED OF THEIR POSSIBILITY.**

These provisions supersede inconsistent liability exceptions, increased claims,
indemnity terms, or damages carve-outs in the Standard Terms. Nothing excludes
or limits liability to the extent such exclusion or limitation is prohibited by
applicable law. Any mandatory-law exception applies only to that legally
non-limitable liability and does not create a broader contractual carve-out.
The parties acknowledge that the fee and risk allocation rely on this Section.

## 9. Term, termination, and transition

The initial term is twelve months. Renewal requires a new signed written order;
Standard Terms Section 5.1's automatic renewal does not apply. Either party may
terminate for material breach not cured within 30 calendar days after written
notice, or immediately for an incurable material breach, subject to applicable
law. Section 3.4 provides the additional chronic-uptime-failure right.

On Customer's termination for Provider's uncured material breach, Provider shall
refund prepaid fees for the unused term within 30 calendar days. Otherwise,
fees are non-refundable except as expressly provided here or by mandatory law.
Upon expiration or termination, the commercial exemption and granted commercial
rights cease; independently granted open-source rights remain unaffected.

On request, Provider shall make retained Customer-specific records available
in a reasonably usable format within 30 calendar days and delete Customer Content
within 60 calendar days, except legally required retention and protected backups
under the Standard Terms. Retention exceptions do not authorize storing underlying
corporate prompts. Accrued payment obligations, confidentiality, ownership,
permitted retention restrictions, dispute terms, and Section 8 survive termination.

## 10. Procurement, amendments, and notices

Customer's legal and procurement teams should complete the Order Form, review
the fixed Standard Terms and these express overrides, attach any necessary DPA,
and obtain authorized signatures before service activation. The executed packet
must include the endpoint scope, infrastructure designation, agreed capacity,
and governing law and courts; no blank may be resolved by unilateral inference.

Legal and procurement notices to Provider must be sent to
**licensing@bitcoinstratigraphy.com**; Customer's notice address is in the Order
Form. Formal notices follow Standard Terms Section 12.9. Severity 1 support
timing is governed separately by receipt under Section 4.

Changes require both parties' written signatures. Neither publication of a
revised repository file nor an automated token or HTTP notice changes an
executed Agreement. Independent-contractor, assignment, export-control,
anti-bribery, severability, and counterpart provisions in the Standard Terms
remain applicable.

## 11. Initiation and standard-terms attribution

To initiate an enterprise license, contact the Central Bank Governor directly at
**licensing@bitcoinstratigraphy.com** or visit
**https://bitcoinstratigraphy.com** for procurement details.

The incorporated Common Paper Cloud Service Agreement Standard Terms Version 2.1
are provided by Common Paper under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
Source: https://commonpaper.com/standards/cloud-service-agreement/2.1/.
The Standard Terms are incorporated without edits; this enterprise cover document
adds and expressly overrides specified terms. Common Paper does not endorse
Bitcoin Stratigraphy or this enterprise offering.

## 12. Authorized signatures

By signing, the parties accept the completed Order Form, this Agreement's express
terms and SLA, and the identified Standard Terms, including the limitation of
liability in Section 8.

| Provider | Customer |
| --- | --- |
| Legal name: [Complete] | Legal name: [Complete] |
| Authorized signatory: [Complete] | Authorized signatory: [Complete] |
| Title / capacity: [Complete] | Title / capacity: [Complete] |
| Signature: ____________________ | Signature: ____________________ |
| Date: ____________________ | Date: ____________________ |
