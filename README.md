# Dynamo Rota

A shift-based rota system: each shift has a reference, date, time period, type,
vehicle, area, and two crew slots (each an assigned staff member with a role
label like PARA/ECA/TECH/NQP1) — matching the existing Dynamo shift-list UI.

This replaces the previous day/night entries-based rota model in this repo
with a shift-block model (ref/period/type/vehicle/area/2-crew), per the
current spec.

## Structure (deliberately flat, for easy pushing)

```
backend/
├── package.json
├── prisma/          schema + seed script
├── src/              Express API
└── public/           pre-built React frontend (static HTML/CSS/JS —
                       nothing to build on Railway, just committed as-is)
```

There is **no separate frontend source folder in this deploy** — the React
app is already compiled into `backend/public`. This keeps the folder
structure shallow on purpose, since manually copying a repo (drag-and-drop,
zip upload, etc.) is where folder nesting tends to get lost. The React
source will be added back as its own tracked folder in a later pass once
the deploy pipeline is confirmed working; for now, edits to the UI mean
rebuilding and replacing `backend/public`.

Everything runs as **one Railway service**: Express serves both the API
(`/api/...`) and the static frontend from `backend/public`.

## Local development

```bash
cd backend
cp .env.example .env        # set DATABASE_URL to a local Postgres instance
npm install
npx prisma migrate dev --name init
npm run seed                # creates the admin user + a week of demo shifts
npm run dev                 # http://localhost:4000 — serves API + the app
```

## Deploying on Railway

The Railway service (`Dynamo-v4`) already has `rootDirectory: backend`, a
Postgres database attached in the same project, and `DATABASE_URL` /
`JWT_SECRET` set. To ship this version, replace the repo's `backend/` folder
with the one in this zip (via GitHub Desktop or git — see the conversation
this came from for exact steps), then push. Railway auto-deploys on push.
`npm start` runs `prisma migrate deploy` before starting, so the schema is
applied on every deploy.

**One-off seed** (creates the admin login + a week of demo shifts) — run once
after the first successful deploy, from the Railway dashboard's service
shell, or:

```bash
railway run --service Dynamo-v4 npm run seed
```

## Default login

Set via `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` before running the seed
script. Defaults to `darren.teale@medicalemergencysolutions.co.uk` /
`ChangeMe123!` — change the password after first login (there's no
change-password UI yet; update it via the database or add one).

## What's included (v1 / core rota)

- Login (JWT)
- Shifts: list with week/vehicle/area/type/ref filters, create, edit, delete.
  Each shift: date, start/end time, type, status, vehicle, area, notes, and
  two crew slots (staff member + role label).
- Staff: list of all staff with role and qualification.

Not yet built (next passes): Calendar view, Availability, Timesheets, Leave
Requests, Shift Swaps, Incident Reporting, Policy Centre, Training, KPI
Dashboard, Vehicles/Documents management, Reports, Audit Log, and bringing
the React source back as an editable folder in the repo — see the project
description for the full target feature set.
