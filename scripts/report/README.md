# Draft / power-rankings report

One-off post-draft report (2026-09-02), kept as the base for a weekly power-rankings page.

    bun scripts/report/postdraft.ts        # scores every roster under league rules → out/postdraft.json
    python3 scripts/report/build_report.py # renders out/ballers-draft-report.html (needs out/avatars.json)

Avatars: fetch `https://sleepercdn.com/avatars/thumbs/<avatar>` per league user and store as
data URIs in `out/avatars.json` (the artifact CSP blocks external images).

Published 2026-09-02: https://claude.ai/code/artifact/1f659510-5c7b-433f-95e2-1f05a675cc8c
