require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, name: user.name, role: user.role },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Not permitted' });
    }
    next();
  };
}

function serializeShift(shift) {
  const crew = [1, 2].map((position) => {
    const slot = shift.crew.find((c) => c.position === position);
    return {
      position,
      userId: slot?.userId || null,
      name: slot?.user?.name || null,
      roleLabel: slot?.roleLabel || slot?.user?.qualification || null,
    };
  });
  return {
    id: shift.id,
    ref: shift.ref,
    date: shift.date,
    startTime: shift.startTime,
    endTime: shift.endTime,
    type: shift.type,
    status: shift.status,
    vehicle: shift.vehicle,
    area: shift.area,
    notes: shift.notes,
    crew,
  };
}

async function nextRef() {
  const count = await prisma.shift.count();
  return `BKE${String(count + 1).padStart(3, '0')}`;
}

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---------- Auth ----------
const authRouter = express.Router();

authRouter.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
  if (!user || !user.active) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const token = signToken(user);
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

authRouter.get('/me', authMiddleware, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
});

app.use('/api/auth', authRouter);

// ---------- Staff ----------
const staffRouter = express.Router();
staffRouter.use(authMiddleware);

staffRouter.get('/', async (req, res) => {
  const staff = await prisma.user.findMany({
    orderBy: { name: 'asc' },
    select: { id: true, name: true, email: true, role: true, qualification: true, active: true },
  });
  res.json(staff);
});

staffRouter.post('/', requireRole('ADMIN', 'MANAGER'), async (req, res) => {
  const { name, email, password, role, qualification } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email and password are required' });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  try {
    const user = await prisma.user.create({
      data: {
        name,
        email: email.toLowerCase().trim(),
        passwordHash,
        role: role || 'STAFF',
        qualification: qualification || null,
      },
    });
    res.status(201).json({ id: user.id, name: user.name, email: user.email, role: user.role });
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'Email already in use' });
    throw err;
  }
});

staffRouter.put('/:id', requireRole('ADMIN', 'MANAGER'), async (req, res) => {
  const { name, role, qualification, active } = req.body || {};
  const user = await prisma.user.update({
    where: { id: req.params.id },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(role !== undefined ? { role } : {}),
      ...(qualification !== undefined ? { qualification } : {}),
      ...(active !== undefined ? { active } : {}),
    },
  });
  res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
});

app.use('/api/staff', staffRouter);

// ---------- Shifts ----------
const shiftsRouter = express.Router();
shiftsRouter.use(authMiddleware);

shiftsRouter.get('/', async (req, res) => {
  const { startFrom, startTo, vehicle, area, type, q } = req.query;
  const where = {};
  if (startFrom || startTo) {
    where.date = {};
    if (startFrom) where.date.gte = new Date(startFrom);
    if (startTo) where.date.lte = new Date(startTo);
  }
  if (vehicle) where.vehicle = { contains: vehicle, mode: 'insensitive' };
  if (area) where.area = { contains: area, mode: 'insensitive' };
  if (type && type !== 'All') where.type = type;
  if (q) where.ref = { contains: q, mode: 'insensitive' };

  const shifts = await prisma.shift.findMany({
    where,
    include: { crew: { include: { user: true } } },
    orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
  });
  res.json(shifts.map(serializeShift));
});

shiftsRouter.get('/:id', async (req, res) => {
  const shift = await prisma.shift.findUnique({
    where: { id: req.params.id },
    include: { crew: { include: { user: true } } },
  });
  if (!shift) return res.status(404).json({ error: 'Shift not found' });
  res.json(serializeShift(shift));
});

shiftsRouter.post('/', async (req, res) => {
  const { date, startTime, endTime, type, vehicle, area, notes, status, crew } = req.body || {};
  if (!date || !startTime || !endTime) {
    return res.status(400).json({ error: 'date, startTime and endTime are required' });
  }
  const ref = await nextRef();
  const shift = await prisma.shift.create({
    data: {
      ref,
      date: new Date(date),
      startTime: new Date(startTime),
      endTime: new Date(endTime),
      type: type || 'CORE',
      status: status || 'CONFIRMED',
      vehicle: vehicle || null,
      area: area || null,
      notes: notes || null,
      crew: {
        create: (crew || []).slice(0, 2).map((c, i) => ({
          position: i + 1,
          userId: c.userId || null,
          roleLabel: c.roleLabel || null,
        })),
      },
    },
    include: { crew: { include: { user: true } } },
  });
  res.status(201).json(serializeShift(shift));
});

shiftsRouter.put('/:id', async (req, res) => {
  const { date, startTime, endTime, type, vehicle, area, notes, status, crew } = req.body || {};
  const data = {
    ...(date !== undefined ? { date: new Date(date) } : {}),
    ...(startTime !== undefined ? { startTime: new Date(startTime) } : {}),
    ...(endTime !== undefined ? { endTime: new Date(endTime) } : {}),
    ...(type !== undefined ? { type } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(vehicle !== undefined ? { vehicle } : {}),
    ...(area !== undefined ? { area } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };

  await prisma.shift.update({ where: { id: req.params.id }, data });

  if (crew) {
    await prisma.shiftCrew.deleteMany({ where: { shiftId: req.params.id } });
    await prisma.shiftCrew.createMany({
      data: crew.slice(0, 2).map((c, i) => ({
        shiftId: req.params.id,
        position: i + 1,
        userId: c.userId || null,
        roleLabel: c.roleLabel || null,
      })),
    });
  }

  const shift = await prisma.shift.findUnique({
    where: { id: req.params.id },
    include: { crew: { include: { user: true } } },
  });
  res.json(serializeShift(shift));
});

shiftsRouter.delete('/:id', async (req, res) => {
  await prisma.shift.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

app.use('/api/shifts', shiftsRouter);

// ---------- Frontend (single self-contained index.html) ----------
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Dynamo server listening on :${PORT}`));
