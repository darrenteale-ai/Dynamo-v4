const express = require('express');
const prisma = require('../db');
const { authMiddleware } = require('../auth');

const router = express.Router();
router.use(authMiddleware);

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
  const n = count + 1;
  return `BKE${String(n).padStart(3, '0')}`;
}

// GET /api/shifts?startFrom=&startTo=&vehicle=&area=&type=&q=
router.get('/', async (req, res) => {
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

router.get('/:id', async (req, res) => {
  const shift = await prisma.shift.findUnique({
    where: { id: req.params.id },
    include: { crew: { include: { user: true } } },
  });
  if (!shift) return res.status(404).json({ error: 'Shift not found' });
  res.json(serializeShift(shift));
});

router.post('/', async (req, res) => {
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

router.put('/:id', async (req, res) => {
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

router.delete('/:id', async (req, res) => {
  await prisma.shift.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

module.exports = router;
