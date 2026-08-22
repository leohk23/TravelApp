# Agent instructions

Read `CLAUDE.md` before changing this project; it contains the product goals,
architecture, and implementation rules.

Treat the mobile experience as the primary product surface. Design and verify
the narrow viewport first, then adapt it for desktop. Do not ship an interaction
that only works with a mouse, hover, or a wide screen.

This project is in early development. After completing and validating each
requested code change, commit it, push the same release directly to `main` and
`preview`, wait for the Pages workflow, and verify both live deployments unless
the user explicitly says not to deploy that change.
