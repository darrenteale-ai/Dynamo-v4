# Dynamo Rota

A shift-based rota system: each shift has a reference, date, time period, type,
vehicle, area, and two crew slots (each an assigned staff member with a role
label like PARA/ECA/TECH/NQP1) — matching the existing Dynamo shift-list UI.

This replaces the previous day/night entries-based rota model in this repo
with a shift-block model (ref/period/type/vehicle/area/2-crew), per the
current spec.

## Stack

- `backend/` — Node.js + Express + Prisma + PostgreSQL, JWT auth. Also builds
  and serves the frontend's static files, so only **one Railway service** is
  needed.
- `backend/frontend/` — React + Vite. It lives *inside* `backend/` (not next
  to it) on purpose: the Railway service is configured with
  `rootDirectory: backend`, which means the build only has access to files
  inside that folder — a sibling `../frontend` is invisible to it. Nesting it
  here is what lets `backend`'s build script reach it without any Railway
  config changes.

## Local development

```bash
cd backend
cp .env.example .env        # set DATABASE_URL to a local Postgres instance
npm install
npx prisma migrate dev --name init
npm run seed                # creates the admin user + a week of demo shifts
npm run dev                 # http://localhost:4000 (API only)

# in a second terminal, for frontend hot-reload:
cd backend/frontend
npm install
npm run dev                 # http://localhost:5173, proxies /api to :4000
```

For a production-style run: `cd backend && npm run build && npm start` builds
the frontend into `backend/public` and serves everything from one process.

## Deploying on Railway

This project is already connected to a Railway service (`Dynamo-Rota`,
`rootDirectory: backend`) with a Postgres database attached in the same
project. To ship this version:

Unzip so `backend/` (including the nested `backend/frontend/`) replaces the
existing `backend/` folder in the repo, then:

```bash
git add -A
git commit -m "Replace day/night rota with shift-block model (ref/period/type/vehicle/area/crew)"
git push origin main
```

Railway auto-deploys on push. Environment variables already set on the
service: `JWT_SECRET`, `DATABASE_URL` (references the Postgres service).
`npm start` runs `prisma migrate deploy` automatically before starting, so
the schema is applied on every deploy.

**One-off seed** (creates the admin login + a week of demo shifts) — run once
after the first deploy, from the Railway dashboard's service shell, or:

```bash
railway run --service Dynamo-Rota npm run seed
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
Dashboard, Vehicles/Documents management, Reports, Audit Log — see the
project description for the full target feature set.
