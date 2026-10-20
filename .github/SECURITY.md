# Security

Please report a vulnerability in this SDK, or in ShipBill, privately: on this repository's **Security** tab, choose **Report a vulnerability**. Don't open a public issue. Include what you found, how to reproduce it, and what it affects.

Releases are published only by this repository's release workflow, after a maintainer approves the run:

- npm packages carry provenance: `npm audit signatures` checks which commit and workflow run built them.
- Each `shipbill.js` release has its own address (`https://js.shipbill.io/v1.4.0/shipbill.js`) that is never overwritten, and its integrity hash is in the GitHub release.
