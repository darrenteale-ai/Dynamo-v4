const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../db');
const { authMiddleware, requireRole } = require('../auth');

const router = express.Router();
router.use(authMiddleware);

router.get('/', async (req, res) => {
  const staff = await prisma.user.findMany({
    orderBy: { name: 'asc' },
    select: { id: true, name: true, email: true, role: true, qualification: true, active: true },
  });
  res.json(staff);
});

router.post('/', requireRole('ADMIN', 'MANAGER'), async (req, res) => {
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

router.put('/:id', requireRole('ADMIN', 'MANAGER'), async (req, res) => {
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

module.exports = router;
